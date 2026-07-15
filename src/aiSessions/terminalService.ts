'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { ActiveAiSessionTerminalResolution } from './activeTerminalHighlight';
import { AI_SESSION_PROVIDER_IDS } from './providers';
import AiSessionTerminalBindingStore from './terminalBindingStore';
import type { AiSessionProvider, AiSessionTerminalEntry } from './types';

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
    title?: string;
}

export default class AiSessionTerminalService {
    private readonly terminals: Record<AiSessionProviderId, Map<string, AiSessionTerminalEntry<vscode.Terminal>>> = {
        codex: new Map<string, AiSessionTerminalEntry<vscode.Terminal>>(),
        kimi: new Map<string, AiSessionTerminalEntry<vscode.Terminal>>(),
        claude: new Map<string, AiSessionTerminalEntry<vscode.Terminal>>(),
    };
    private readonly resumesInFlight: Record<AiSessionProviderId, Set<string>> = {
        codex: new Set<string>(),
        kimi: new Set<string>(),
        claude: new Set<string>(),
    };
    private pendingTerminals: PendingAiSessionTerminal[] = [];

    constructor(
        private readonly globalStoragePath: string,
        private readonly getProvider: (providerId: AiSessionProviderId) => AiSessionProvider,
        private readonly terminalStartupDelayMs = 1000,
        private readonly pendingTerminalTtlMs = 24 * 60 * 60 * 1000,
        private readonly bindingStore: AiSessionTerminalBindingStore = null,
        private readonly terminalProcessIdTimeoutMs = 2000
    ) { }

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

    async sendNewSessionCommand(providerId: AiSessionProviderId, terminal: vscode.Terminal, cwd: string, title: string, markerPath: string) {
        let provider = this.getProvider(providerId);
        await this.waitForReady(terminal);
        await this.persistReadyPendingTerminal(terminal);
        terminal.sendText(provider.buildNewSessionCommand(cwd, title, markerPath));
    }

    async sendResumeCommand(providerId: AiSessionProviderId, terminal: vscode.Terminal, sessionId: string, cwd: string, markerPath: string) {
        let provider = this.getProvider(providerId);
        this.deleteEntryMarker({ markerPath });
        await this.waitForReady(terminal);
        terminal.sendText(provider.buildResumeCommand(sessionId, cwd, markerPath));
    }

    track(providerId: AiSessionProviderId, sessionId: string, entry: AiSessionTerminalEntry<vscode.Terminal>, persist = true) {
        let normalizedEntry = {
            ...entry,
            runStartedAtMs: Number.isFinite(entry?.runStartedAtMs) ? entry.runStartedAtMs : Date.now(),
        };
        this.terminals[providerId].set(sessionId, normalizedEntry);
        if (persist) {
            this.bindingStore?.setBound(normalizedEntry.terminal.processId, {
                providerId,
                sessionId,
                markerPath: normalizedEntry.markerPath,
                runStartedAtMs: normalizedEntry.runStartedAtMs,
            });
        }
    }

    untrack(providerId: AiSessionProviderId, sessionId: string) {
        let entry = this.terminals[providerId].get(sessionId);
        this.terminals[providerId].delete(sessionId);
        if (entry?.terminal) {
            this.bindingStore?.remove(entry.terminal.processId);
        }
    }

    trackPending(entry: PendingAiSessionTerminal, persist = true) {
        if (!entry || !entry.terminal || !entry.markerPath || !entry.cwd || !entry.createdAt) {
            return;
        }

        this.pendingTerminals.push({
            ...entry,
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
        this.bindingStore?.setPending(processId, {
            providerId: entry.provider,
            markerPath: entry.markerPath,
            cwd: entry.cwd,
            createdAt: entry.createdAt,
            excludedSessionIds: entry.excludedSessionIds || [],
            ...(entry.title === undefined ? {} : { title: entry.title }),
        });
    }

    getPendingTerminals(): PendingAiSessionTerminal[] {
        this.pendingTerminals = this.trimPendingTerminals(this.pendingTerminals);
        return [...this.pendingTerminals];
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
                }, false);
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
                    createdAt: binding.createdAt,
                    excludedSessionIds: binding.excludedSessionIds,
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
        let resumesInFlight = this.resumesInFlight[providerId];
        if (resumesInFlight.has(sessionId)) {
            return false;
        }

        resumesInFlight.add(sessionId);
        return true;
    }

    finishResume(providerId: AiSessionProviderId, sessionId: string) {
        this.resumesInFlight[providerId].delete(sessionId);
    }

    get(providerId: AiSessionProviderId, session: CodexSession): AiSessionTerminalEntry<vscode.Terminal> {
        return this.getById(providerId, session.id);
    }

    getById(providerId: AiSessionProviderId, sessionId: string): AiSessionTerminalEntry<vscode.Terminal> {
        let trackedTerminal = this.terminals[providerId].get(sessionId);
        if (trackedTerminal) {
            return trackedTerminal;
        }

        let terminal = vscode.window.terminals.find(candidate => this.terminalMatchesSession(providerId, candidate, sessionId));
        if (!terminal) {
            return null;
        }

        let entry = {
            terminal,
            markerPath: this.getMarkerPath(providerId, sessionId),
            runStartedAtMs: Date.now(),
        };
        this.track(providerId, sessionId, entry);

        return entry;
    }

    resolveTerminalSession(
        terminal: vscode.Terminal,
        getProviderCandidates: (providerId: AiSessionProviderId) => readonly CodexSession[]
    ): ActiveAiSessionTerminalResolution<vscode.Terminal, AiSessionTerminalEntry<vscode.Terminal>> {
        if (!terminal) {
            return null;
        }

        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            for (let [sessionId, entry] of this.terminals[providerId]) {
                if (entry.terminal === terminal) {
                    return { provider: providerId, sessionId, terminal, entry };
                }
            }
        }

        let providerId = this.getTerminalProvider(terminal);
        if (!providerId) {
            return null;
        }

        for (let session of getProviderCandidates(providerId) || []) {
            if (!this.terminalMatchesSession(providerId, terminal, session.id)) {
                continue;
            }
            let entry = { terminal, markerPath: this.getMarkerPath(providerId, session.id), runStartedAtMs: Date.now() };
            this.track(providerId, session.id, entry);
            return { provider: providerId, sessionId: session.id, terminal, entry };
        }

        return null;
    }

    getTrackedSessionKeys(getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string): Set<string> {
        let sessionKeys = new Set<string>();
        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            for (let sessionId of this.terminals[providerId].keys()) {
                sessionKeys.add(getSessionKey(providerId, sessionId));
            }
        }

        return sessionKeys;
    }

    getTerminalName(providerId: AiSessionProviderId, session: CodexSession): string {
        let provider = this.getProvider(providerId);
        return `${provider.terminalNamePrefix}: ${session.name || session.id} [${session.id.substring(0, 8)}]`;
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

    handleClosedTerminal(terminal: vscode.Terminal) {
        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            for (let [sessionId, entry] of this.terminals[providerId]) {
                if (entry.terminal === terminal) {
                    this.deleteEntryMarker(entry);
                    this.untrack(providerId, sessionId);
                }
            }
        }
        this.removePendingForTerminal(terminal);
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

    private terminalMatchesSession(providerId: AiSessionProviderId, terminal: vscode.Terminal, sessionId: string): boolean {
        let provider = this.getProvider(providerId);
        let creationOptions = terminal.creationOptions;
        if ('env' in creationOptions && creationOptions.env?.[provider.terminalEnvKey] === sessionId) {
            return true;
        }

        return terminal.name.startsWith(`${provider.terminalNamePrefix}: `)
            && terminal.name.endsWith(` [${sessionId.substring(0, 8)}]`);
    }

    private getTerminalProvider(terminal: vscode.Terminal): AiSessionProviderId {
        let creationOptions = terminal.creationOptions;
        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            let provider = this.getProvider(providerId);
            if ('env' in creationOptions && creationOptions.env?.[provider.terminalEnvKey]) {
                return providerId;
            }
        }

        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            let provider = this.getProvider(providerId);
            if (terminal.name.startsWith(`${provider.terminalNamePrefix}: `)) {
                return providerId;
            }
        }

        return null;
    }

}
