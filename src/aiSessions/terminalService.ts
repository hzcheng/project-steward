'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';

import type { AiSessionProviderId, CodexSession } from '../models';
import type {
    ActiveAiSessionTerminalIdentity,
    ActiveAiSessionTerminalResolution,
} from './activeTerminalHighlight';
import AiSessionTerminalBindingStore from './terminalBindingStore';
import type { AiSessionRuntimeIdentity } from './runtimeTypes';
import { cloneAiSessionRuntimeIdentity, isValidAiSessionRuntimeIdentity } from './runtimeTypes';
import { getAiSessionTerminalName } from './sessionPaths';
import { AiSessionLaunchSpec, serializeDirectLaunchCommand } from './launchSpec';
import type { AiSessionActiveTerminalRuntime, AiSessionDirectoryScope, AiSessionProviderDefinition, AiSessionTerminalEntry } from './types';

export interface AiSessionTerminalCreateOptions {
    name: string;
    cwd?: string;
    env?: Record<string, string>;
    cwdFailureMessage: string;
    cwdWarningMessage: string;
    logError: (message: string, error: unknown) => void;
}

export interface AiSessionTerminalCreateResult {
    terminal: vscode.Terminal;
    cwdAccepted: boolean;
}

export interface PendingAiSessionTerminal {
    provider: AiSessionProviderId;
    terminal: vscode.Terminal;
    markerPath: string;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    projectName?: string;
    title?: string;
    runtimeIdentity?: AiSessionRuntimeIdentity;
}

export interface TrackedAiSessionTerminal {
    provider: AiSessionProviderId;
    sessionId: string;
    terminal: vscode.Terminal;
    markerPath: string;
    runStartedAtMs: number;
    cwd?: string;
    released?: boolean;
    runtimeIdentity?: AiSessionRuntimeIdentity;
}

export interface AiSessionRuntimeLaunchOptions {
    deleteMarkerBeforeLaunch?: boolean;
    persistPendingBeforeLaunch?: boolean;
}

export default class AiSessionTerminalService {
    private readonly providers: readonly AiSessionProviderDefinition[];
    private readonly providersById = new Map<AiSessionProviderId, AiSessionProviderDefinition>();
    private readonly terminals: Partial<Record<AiSessionProviderId, Map<string, AiSessionTerminalEntry<vscode.Terminal>>>> = {};
    private readonly resumesInFlight: Partial<Record<AiSessionProviderId, Set<string>>> = {};
    private readonly releasedTerminalSessions = new Map<
        vscode.Terminal,
        Map<string, AiSessionRuntimeIdentity & { sessionId: string }>
    >();
    private pendingTerminals: PendingAiSessionTerminal[] = [];

    constructor(
        private readonly globalStoragePath: string,
        providers: readonly AiSessionProviderDefinition[],
        private readonly terminalStartupDelayMs = 1000,
        private readonly pendingTerminalTtlMs = 24 * 60 * 60 * 1000,
        private readonly bindingStore: AiSessionTerminalBindingStore = null,
        private readonly terminalProcessIdTimeoutMs = 2000
    ) {
        this.providers = (providers || []).slice();
        for (let provider of this.providers) {
            this.providersById.set(provider.id, provider);
            this.terminals[provider.id] = new Map<string, AiSessionTerminalEntry<vscode.Terminal>>();
            this.resumesInFlight[provider.id] = new Set<string>();
        }
    }

    createTerminal(options: AiSessionTerminalCreateOptions): AiSessionTerminalCreateResult {
        let env = { ...(options.env || {}) };
        try {
            return {
                terminal: vscode.window.createTerminal({
                    name: options.name,
                    cwd: options.cwd || undefined,
                    env,
                }),
                cwdAccepted: true,
            };
        } catch (error) {
            options.logError(options.cwdFailureMessage, error);
            vscode.window.showWarningMessage(options.cwdWarningMessage);
            return {
                terminal: vscode.window.createTerminal({
                    name: options.name,
                    env,
                }),
                cwdAccepted: false,
            };
        }
    }

    private async waitForReady(terminal: vscode.Terminal) {
        try {
            await terminal.processId;
            await new Promise(resolve => setTimeout(resolve, this.terminalStartupDelayMs));
        } catch (e) {
            // Best effort only; sendText can still work if VS Code cannot resolve the process id.
        }
    }

    async sendNewSessionCommand(providerId: AiSessionProviderId, terminal: vscode.Terminal, scope: AiSessionDirectoryScope, title: string, markerPath: string) {
        let provider = this.getProvider(providerId);
        await this.sendRuntimeLaunch(terminal, provider.buildNewSessionLaunchSpec(scope, title, markerPath), {
            persistPendingBeforeLaunch: true,
        });
    }

    async sendResumeCommand(providerId: AiSessionProviderId, terminal: vscode.Terminal, sessionId: string, scope: AiSessionDirectoryScope, markerPath: string) {
        let provider = this.getProvider(providerId);
        await this.sendRuntimeLaunch(terminal, provider.buildResumeLaunchSpec(sessionId, scope, markerPath), {
            deleteMarkerBeforeLaunch: true,
        });
    }

    async sendRuntimeLaunch(
        terminal: vscode.Terminal,
        launch: AiSessionLaunchSpec,
        options: AiSessionRuntimeLaunchOptions = {}
    ): Promise<void> {
        if (options.deleteMarkerBeforeLaunch) {
            this.deleteMarker(launch?.markerPath);
        }
        await this.waitForReady(terminal);
        if (options.persistPendingBeforeLaunch) {
            await this.persistReadyPendingTerminal(terminal);
        }
        terminal.sendText(serializeDirectLaunchCommand(launch));
    }

    getProviderTerminalEnvironment(providerId: AiSessionProviderId, sessionId: string): Record<string, string> {
        let provider = this.getProvider(providerId);
        return provider?.terminalEnvKey && sessionId
            ? { [provider.terminalEnvKey]: sessionId }
            : {};
    }

    focusTerminal(terminal: vscode.Terminal): void {
        terminal?.show();
    }

    closeTerminal(terminal: vscode.Terminal): void {
        terminal?.dispose();
    }

    track(providerId: AiSessionProviderId, sessionId: string, entry: AiSessionTerminalEntry<vscode.Terminal>, persist = true) {
        const runtimeIdentity = entry?.runtimeIdentity;
        if (!runtimeIdentity || runtimeIdentity.provider !== providerId
            || runtimeIdentity.sessionId !== sessionId
            || !isValidAiSessionRuntimeIdentity(runtimeIdentity)) {
            return;
        }
        let normalizedEntry = {
            ...entry,
            ...(entry.runtimeIdentity
                ? { runtimeIdentity: cloneAiSessionRuntimeIdentity(entry.runtimeIdentity) }
                : {}),
            runStartedAtMs: Number.isFinite(entry?.runStartedAtMs) ? entry.runStartedAtMs : Date.now(),
        };
        const sessionKey = scopedSessionKey(providerId, sessionId, runtimeIdentity.workspaceScopeIdentity);
        let releasedSessions = this.releasedTerminalSessions.get(normalizedEntry.terminal);
        releasedSessions?.delete(sessionKey);
        if (releasedSessions?.size === 0) {
            this.releasedTerminalSessions.delete(normalizedEntry.terminal);
        }
        this.getTerminalMap(providerId).set(sessionKey, normalizedEntry);
        if (persist && normalizedEntry.runtimeIdentity) {
            const identity = normalizedEntry.runtimeIdentity;
            this.bindingStore?.setBound(normalizedEntry.terminal.processId, {
                providerId,
                sessionId,
                workspaceScopeIdentity: identity.workspaceScopeIdentity,
                workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
                cwd: identity.cwd,
                markerPath: normalizedEntry.markerPath,
                runStartedAtMs: normalizedEntry.runStartedAtMs,
            });
        }
    }

    untrack(providerId: AiSessionProviderId, sessionId: string, workspaceScopeIdentity: string) {
        const sessionKey = scopedSessionKey(providerId, sessionId, workspaceScopeIdentity);
        let entry = this.getTerminalMap(providerId).get(sessionKey);
        this.getTerminalMap(providerId).delete(sessionKey);
        if (entry?.terminal) {
            this.bindingStore?.remove(entry.terminal.processId);
        }
    }

    releaseCompletedSession(
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ) {
        const sessionKey = scopedSessionKey(providerId, sessionId, workspaceScopeIdentity);
        let entry = this.getTerminalMap(providerId).get(sessionKey);
        if (!entry?.terminal) {
            return;
        }
        this.markTerminalSessionReleased(
            entry.terminal,
            cloneAiSessionRuntimeIdentity(entry.runtimeIdentity) as AiSessionRuntimeIdentity & { sessionId: string }
        );
        this.deleteEntryMarker(entry);
        this.getTerminalMap(providerId).delete(sessionKey);
        if (entry.runtimeIdentity) {
            this.bindingStore?.setReleased(entry.terminal.processId, {
                providerId,
                sessionId,
                workspaceScopeIdentity: entry.runtimeIdentity.workspaceScopeIdentity,
                workspaceNavigationIdentity: entry.runtimeIdentity.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...entry.runtimeIdentity.workspaceRootHostPaths],
                cwd: entry.runtimeIdentity.cwd,
                markerPath: entry.markerPath,
            });
        }
    }

    trackPending(entry: PendingAiSessionTerminal, persist = true) {
        if (!entry || !entry.terminal || !entry.markerPath || !entry.cwd || !entry.createdAt) {
            return;
        }

        this.pendingTerminals.push({
            ...entry,
            ...(entry.runtimeIdentity
                ? { runtimeIdentity: cloneAiSessionRuntimeIdentity(entry.runtimeIdentity) }
                : {}),
            excludedSessionIds: Array.isArray(entry.excludedSessionIds) ? entry.excludedSessionIds.filter(id => !!id) : [],
        });
        this.pendingTerminals = this.trimPendingTerminals(this.pendingTerminals);
        if (persist) {
            this.persistPendingBinding(entry, entry.terminal.processId);
        }
    }

    private async persistReadyPendingTerminal(terminal: vscode.Terminal): Promise<void> {
        let pendingTerminal = this.pendingTerminals.find(entry => entry.terminal === terminal);
        if (!pendingTerminal || !this.bindingStore) {
            return;
        }
        let processId = await this.resolveTerminalProcessId(terminal);
        if (processId === null) {
            return;
        }
        this.persistPendingBinding(pendingTerminal, processId);
        await this.bindingStore.flush();
    }

    private persistPendingBinding(entry: PendingAiSessionTerminal, processId: number | PromiseLike<number | undefined>) {
        if (!entry.runtimeIdentity?.pendingId) {
            return;
        }
        this.bindingStore?.setPending(processId, {
            providerId: entry.provider,
            pendingId: entry.runtimeIdentity.pendingId,
            workspaceScopeIdentity: entry.runtimeIdentity.workspaceScopeIdentity,
            workspaceNavigationIdentity: entry.runtimeIdentity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...entry.runtimeIdentity.workspaceRootHostPaths],
            markerPath: entry.markerPath,
            cwd: entry.runtimeIdentity.cwd,
            createdAt: entry.createdAt,
            excludedSessionIds: entry.excludedSessionIds || [],
            ...(entry.projectName === undefined ? {} : { projectName: entry.projectName }),
            ...(entry.title === undefined ? {} : { title: entry.title }),
        });
    }

    getPendingTerminals(): PendingAiSessionTerminal[] {
        this.pendingTerminals = this.trimPendingTerminals(this.pendingTerminals);
        return this.pendingTerminals.map(entry => ({
            ...entry,
            excludedSessionIds: [...entry.excludedSessionIds],
            ...(entry.runtimeIdentity
                ? { runtimeIdentity: cloneAiSessionRuntimeIdentity(entry.runtimeIdentity) }
                : {}),
        }));
    }

    getTrackedTerminalEntries(): TrackedAiSessionTerminal[] {
        let result: TrackedAiSessionTerminal[] = [];
        for (let provider of this.getProviderIds()) {
            for (let entry of this.getTerminalMap(provider).values()) {
                const sessionId = entry.runtimeIdentity?.sessionId;
                if (!sessionId) {
                    continue;
                }
                result.push({
                    provider,
                    sessionId,
                    terminal: entry.terminal,
                    markerPath: entry.markerPath,
                    runStartedAtMs: entry.runStartedAtMs,
                    ...(entry.cwd ? { cwd: entry.cwd } : {}),
                    ...(entry.released ? { released: true } : {}),
                    ...(entry.runtimeIdentity
                        ? { runtimeIdentity: cloneAiSessionRuntimeIdentity(entry.runtimeIdentity) }
                        : {}),
                });
            }
        }
        return result;
    }

    hasPending(providerId: AiSessionProviderId, createdAt: string): boolean {
        return this.getPendingTerminals().some(entry => {
            return entry.provider === providerId && entry.createdAt === createdAt;
        });
    }

    removePending(providerId: AiSessionProviderId, createdAt: string): void {
        const removed = this.pendingTerminals.filter(entry => {
            return entry.provider === providerId && entry.createdAt === createdAt;
        });
        this.pendingTerminals = this.pendingTerminals.filter(entry => {
            return entry.provider !== providerId || entry.createdAt !== createdAt;
        });
        for (const entry of removed) {
            this.deleteMarker(entry.markerPath);
            this.bindingStore?.remove(entry.terminal.processId);
        }
    }

    getActiveSessions(): AiSessionActiveTerminalRuntime[] {
        let result: AiSessionActiveTerminalRuntime[] = [];
        for (let providerId of this.getProviderIds()) {
            for (let entry of this.getTerminalMap(providerId).values()) {
                const identity = entry.runtimeIdentity;
                if (!identity?.sessionId) {
                    continue;
                }
                if (!entry.released && !this.isComplete(entry)) {
                    result.push({
                        provider: providerId,
                        sessionId: identity.sessionId,
                        workspaceScopeIdentity: identity.workspaceScopeIdentity,
                        ...(entry.cwd ? { cwd: entry.cwd } : {}),
                        runStartedAtMs: entry.runStartedAtMs,
                    });
                }
            }
        }
        return result;
    }

    findPendingTerminalForSession(
        providerId: AiSessionProviderId,
        sessionId: string,
        sessionCwd: string,
        sessionUpdatedAt: string
    ): PendingAiSessionTerminal | null {
        this.pendingTerminals = this.trimPendingTerminals(this.pendingTerminals);
        let updatedAt = sessionUpdatedAt ? Date.parse(sessionUpdatedAt) : NaN;
        if (isNaN(updatedAt)) {
            return null;
        }
        return this.pendingTerminals.find(entry => {
            if (entry.provider !== providerId) {
                return false;
            }
            if (entry.excludedSessionIds.indexOf(sessionId) !== -1) {
                return false;
            }
            if (entry.cwd !== sessionCwd) {
                return false;
            }
            return updatedAt >= Date.parse(entry.createdAt);
        }) || null;
    }

    replacePendingTerminals(entries: PendingAiSessionTerminal[]) {
        this.pendingTerminals = this.trimPendingTerminals(entries || []);
    }

    removePendingForTerminal(terminal: vscode.Terminal) {
        this.pendingTerminals = this.pendingTerminals.filter(entry => {
            if (entry.terminal !== terminal) {
                return true;
            }

            this.deleteMarker(entry.markerPath);
            return false;
        });
        this.bindingStore?.remove(terminal.processId);
    }

    async restorePersistedTerminals(terminals: readonly vscode.Terminal[]): Promise<void> {
        if (!this.bindingStore) {
            return;
        }
        await Promise.all((terminals || []).map(async terminal => {
            let resolvedProcessId = await this.resolveTerminalProcessId(terminal);
            if (resolvedProcessId === null) {
                return;
            }
            let binding = this.bindingStore.get(resolvedProcessId);
            if (binding && !this.terminalMatchesProvider(binding.providerId, terminal)) {
                this.bindingStore.remove(resolvedProcessId);
                return;
            }
            if (binding?.state === 'bound') {
                this.track(binding.providerId, binding.sessionId, {
                    terminal,
                    markerPath: binding.markerPath,
                    runStartedAtMs: binding.runStartedAtMs,
                    cwd: binding.cwd,
                    runtimeIdentity: {
                        provider: binding.providerId,
                        sessionId: binding.sessionId,
                        workspaceScopeIdentity: binding.workspaceScopeIdentity,
                        workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
                        workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
                        cwd: binding.cwd,
                    },
                }, false);
                return;
            }
            if (binding?.state === 'released') {
                this.markTerminalSessionReleased(terminal, {
                    provider: binding.providerId,
                    sessionId: binding.sessionId,
                    workspaceScopeIdentity: binding.workspaceScopeIdentity,
                    workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
                    workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
                    cwd: binding.cwd,
                });
                return;
            }
            if (binding?.state === 'pending') {
                if (Date.parse(binding.createdAt) < Date.now() - this.pendingTerminalTtlMs) {
                    this.bindingStore.remove(resolvedProcessId);
                    return;
                }
                this.trackPending({
                    provider: binding.providerId,
                    terminal,
                    markerPath: binding.markerPath,
                    cwd: binding.cwd,
                    runtimeIdentity: {
                        provider: binding.providerId,
                        pendingId: binding.pendingId,
                        workspaceScopeIdentity: binding.workspaceScopeIdentity,
                        workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
                        workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
                        cwd: binding.cwd,
                    },
                    createdAt: binding.createdAt,
                    excludedSessionIds: binding.excludedSessionIds,
                    ...(binding.projectName === undefined ? {} : { projectName: binding.projectName }),
                    ...(binding.title === undefined ? {} : { title: binding.title }),
                }, false);
            }
        }));
    }

    private terminalMatchesProvider(providerId: AiSessionProviderId, terminal: vscode.Terminal): boolean {
        let terminalNamePrefix = this.getProvider(providerId)?.terminalNamePrefix;
        return !!terminalNamePrefix && terminal.name.startsWith(`${terminalNamePrefix}: `);
    }

    private resolveTerminalProcessId(terminal: vscode.Terminal): Promise<number | null> {
        return new Promise(resolve => {
            let settled = false;
            let settle = (value: number | undefined) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                resolve(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);
            };
            let timeout = setTimeout(() => settle(undefined), this.terminalProcessIdTimeoutMs);
            Promise.resolve(terminal.processId).then(settle, () => settle(undefined));
        });
    }

    beginResume(providerId: AiSessionProviderId, sessionId: string): boolean {
        let resumesInFlight = this.getResumesInFlight(providerId);
        if (resumesInFlight.has(sessionId)) {
            return false;
        }

        resumesInFlight.add(sessionId);
        return true;
    }

    finishResume(providerId: AiSessionProviderId, sessionId: string) {
        this.getResumesInFlight(providerId).delete(sessionId);
    }

    get(
        providerId: AiSessionProviderId,
        session: CodexSession,
        workspaceScopeIdentity: string
    ): AiSessionTerminalEntry<vscode.Terminal> {
        return this.getById(providerId, session.id, workspaceScopeIdentity);
    }

    getById(
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionTerminalEntry<vscode.Terminal> {
        const key = scopedSessionKey(providerId, sessionId, workspaceScopeIdentity);
        const trackedTerminal = this.getTerminalMap(providerId).get(key);
        if (trackedTerminal) {
            return trackedTerminal;
        }
        const released = [...this.releasedTerminalSessions.entries()].find(([, sessions]) =>
            sessions.has(key));
        const releasedIdentity = released?.[1].get(key);
        const releasedTerminal = released?.[0];
        return releasedTerminal ? {
            terminal: releasedTerminal,
            markerPath: this.getMarkerPath(providerId, sessionId),
            runStartedAtMs: Date.now(),
            released: true,
            ...(releasedIdentity
                ? { runtimeIdentity: cloneAiSessionRuntimeIdentity(releasedIdentity) }
                : {}),
        } : null;
    }

    getActiveById(
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionTerminalEntry<vscode.Terminal> {
        let entry = this.getById(providerId, sessionId, workspaceScopeIdentity);
        return entry?.released ? null : entry;
    }

    getCompletedSessions(): Array<ActiveAiSessionTerminalResolution<
        vscode.Terminal,
        AiSessionTerminalEntry<vscode.Terminal>
    >> {
        let completed: Array<ActiveAiSessionTerminalResolution<
            vscode.Terminal,
            AiSessionTerminalEntry<vscode.Terminal>
        >> = [];
        for (let providerId of this.getProviderIds()) {
            for (let entry of this.getTerminalMap(providerId).values()) {
                const identity = entry.runtimeIdentity;
                if (identity?.sessionId && this.isComplete(entry)) {
                    completed.push({
                        provider: providerId,
                        sessionId: identity.sessionId,
                        workspaceScopeIdentity: identity.workspaceScopeIdentity,
                        terminal: entry.terminal,
                        entry,
                    });
                }
            }
        }
        return completed;
    }

    getReleasedSessions(): ActiveAiSessionTerminalIdentity[] {
        let released = new Map<string, ActiveAiSessionTerminalIdentity>();
        for (let sessions of this.releasedTerminalSessions.values()) {
            for (let [sessionKey, identity] of sessions) {
                released.set(sessionKey, {
                    provider: identity.provider,
                    sessionId: identity.sessionId,
                    workspaceScopeIdentity: identity.workspaceScopeIdentity,
                });
            }
        }
        return Array.from(released.values());
    }

    resolveTerminalSession(
        terminal: vscode.Terminal,
        _getProviderCandidates: (providerId: AiSessionProviderId) => readonly CodexSession[]
    ): ActiveAiSessionTerminalResolution<vscode.Terminal, AiSessionTerminalEntry<vscode.Terminal>> {
        if (!terminal) {
            return null;
        }

        for (let providerId of this.getProviderIds()) {
            for (let entry of this.getTerminalMap(providerId).values()) {
                const identity = entry.runtimeIdentity;
                if (entry.terminal === terminal && identity?.sessionId) {
                    return {
                        provider: providerId,
                        sessionId: identity.sessionId,
                        workspaceScopeIdentity: identity.workspaceScopeIdentity,
                        terminal,
                        entry,
                    };
                }
            }
        }
        return null;
    }

    getTrackedSessionKeys(getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string): Set<string> {
        let sessionKeys = new Set<string>();
        for (let providerId of this.getProviderIds()) {
            for (let entry of this.getTerminalMap(providerId).values()) {
                if (entry.runtimeIdentity?.sessionId) {
                    sessionKeys.add(getSessionKey(providerId, entry.runtimeIdentity.sessionId));
                }
            }
        }

        return sessionKeys;
    }

    getTerminalName(providerId: AiSessionProviderId, session: CodexSession): string {
        return getAiSessionTerminalName(providerId, session, this.providers);
    }

    getMarkerPath(providerId: AiSessionProviderId, sessionId: string): string {
        let markerDir = path.join(this.globalStoragePath, this.getProvider(providerId).markerDirName);
        try {
            mkdirSync(markerDir, { recursive: true });
        } catch (e) {
            // Fall through; the terminal command will still run without relying on the marker.
        }

        return path.join(markerDir, `${sessionId}.done`);
    }

    getPendingMarkerPath(providerId: AiSessionProviderId): string {
        let markerDir = path.join(this.globalStoragePath, 'pending-ai-session-terminals');
        try {
            mkdirSync(markerDir, { recursive: true });
        } catch (e) {
            // Fall through; the terminal command will still run without relying on the marker.
        }

        let uniqueId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return path.join(markerDir, `${providerId}-${uniqueId}.done`);
    }

    isComplete(entry: AiSessionTerminalEntry<vscode.Terminal>): boolean {
        if (entry?.released) {
            return true;
        }
        try {
            if (!entry?.markerPath || !existsSync(entry.markerPath)) {
                return false;
            }
            let stat = statSync(entry.markerPath);
            return stat.isFile()
                && (!Number.isFinite(entry.runStartedAtMs) || stat.mtimeMs >= entry.runStartedAtMs);
        } catch (e) {
            return false;
        }
    }

    deleteEntryMarker(entry: Pick<AiSessionTerminalEntry<vscode.Terminal>, 'markerPath'>) {
        this.deleteMarker(entry.markerPath);
    }

    deleteMarker(markerPath: string) {
        try {
            if (markerPath && existsSync(markerPath)) {
                unlinkSync(markerPath);
            }
        } catch (e) {
            // Ignore marker cleanup failures; they only affect best-effort terminal reuse.
        }
    }

    handleClosedTerminal(terminal: vscode.Terminal): ActiveAiSessionTerminalIdentity[] {
        let closedSessions: ActiveAiSessionTerminalIdentity[] = [];
        for (let providerId of this.getProviderIds()) {
            for (let entry of [...this.getTerminalMap(providerId).values()]) {
                const identity = entry.runtimeIdentity;
                if (entry.terminal === terminal && identity?.sessionId) {
                    closedSessions.push({
                        provider: providerId,
                        sessionId: identity.sessionId,
                        workspaceScopeIdentity: identity.workspaceScopeIdentity,
                    });
                    this.deleteEntryMarker(entry);
                    this.untrack(providerId, identity.sessionId, identity.workspaceScopeIdentity);
                }
            }
        }
        this.releasedTerminalSessions.delete(terminal);
        this.removePendingForTerminal(terminal);
        return closedSessions;
    }

    private trimPendingTerminals(pendingTerminals: PendingAiSessionTerminal[]): PendingAiSessionTerminal[] {
        let cutoff = Date.now() - this.pendingTerminalTtlMs;
        return pendingTerminals.filter(entry => {
            return entry
                && entry.terminal
                && !!entry.markerPath
                && !!entry.cwd
                && !!entry.createdAt
                && !isNaN(Date.parse(entry.createdAt))
                && Date.parse(entry.createdAt) >= cutoff;
        });
    }

    private markTerminalSessionReleased(
        terminal: vscode.Terminal,
        identity: AiSessionRuntimeIdentity & { sessionId: string }
    ): void {
        let releasedSessions = this.releasedTerminalSessions.get(terminal);
        if (!releasedSessions) {
            releasedSessions = new Map<string, AiSessionRuntimeIdentity & { sessionId: string }>();
            this.releasedTerminalSessions.set(terminal, releasedSessions);
        }
        releasedSessions.set(
            scopedSessionKey(identity.provider, identity.sessionId, identity.workspaceScopeIdentity),
            cloneAiSessionRuntimeIdentity(identity)
        );
    }

    private getProviderIds(): AiSessionProviderId[] {
        return this.providers.map(provider => provider.id);
    }

    private getProvider(providerId: AiSessionProviderId): AiSessionProviderDefinition | null {
        return this.providersById.get(providerId) || null;
    }

    private getTerminalMap(providerId: AiSessionProviderId): Map<string, AiSessionTerminalEntry<vscode.Terminal>> {
        let terminalMap = this.terminals[providerId];
        if (!terminalMap) {
            terminalMap = new Map<string, AiSessionTerminalEntry<vscode.Terminal>>();
            this.terminals[providerId] = terminalMap;
        }

        return terminalMap;
    }

    private getResumesInFlight(providerId: AiSessionProviderId): Set<string> {
        let resumesInFlight = this.resumesInFlight[providerId];
        if (!resumesInFlight) {
            resumesInFlight = new Set<string>();
            this.resumesInFlight[providerId] = resumesInFlight;
        }

        return resumesInFlight;
    }

}

function scopedSessionKey(
    providerId: AiSessionProviderId,
    sessionId: string,
    workspaceScopeIdentity: string
): string {
    return JSON.stringify([workspaceScopeIdentity, providerId, sessionId]);
}
