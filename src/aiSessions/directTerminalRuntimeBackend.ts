'use strict';

import type * as vscode from 'vscode';
import type { AiSessionProviderId } from '../models';
import type { AiSessionLaunchSpec } from './launchSpec';
import type {
    AiSessionCreateRuntimeRequest,
    AiSessionExecutableRuntimeBackend,
    AiSessionPendingRuntimeSnapshot,
    AiSessionResumeRuntimeRequest,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';

interface DirectTerminalEntry<TTerminal> {
    provider: AiSessionProviderId;
    sessionId: string;
    terminal: TTerminal;
    markerPath: string;
    runStartedAtMs: number;
    cwd?: string;
    released?: boolean;
}

interface DirectPendingTerminalEntry<TTerminal> {
    provider: AiSessionProviderId;
    terminal: TTerminal;
    markerPath: string;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
}

interface DirectTerminalService<TTerminal> {
    getTrackedTerminalEntries(): DirectTerminalEntry<TTerminal>[];
    getPendingTerminals(): DirectPendingTerminalEntry<TTerminal>[];
    isComplete(entry: {
        terminal: TTerminal;
        markerPath: string;
        runStartedAtMs: number;
        released?: boolean;
    }): boolean;
    createTerminal(options: {
        name: string;
        cwd?: string;
        env?: Record<string, string>;
        cwdFailureMessage: string;
        cwdWarningMessage: string;
        logError: (message: string, error: unknown) => void;
    }): { terminal: TTerminal; cwdAccepted: boolean };
    getProviderTerminalEnvironment(provider: AiSessionProviderId, sessionId: string): Record<string, string>;
    sendRuntimeLaunch(
        terminal: TTerminal,
        launch: AiSessionLaunchSpec,
        options: { deleteMarkerBeforeLaunch?: boolean; persistPendingBeforeLaunch?: boolean }
    ): Promise<void>;
    track(provider: AiSessionProviderId, sessionId: string, entry: {
        terminal: TTerminal;
        markerPath: string;
        runStartedAtMs: number;
        cwd?: string;
    }): void;
    trackPending(entry: DirectPendingTerminalEntry<TTerminal>): void;
    replacePendingTerminals(entries: DirectPendingTerminalEntry<TTerminal>[]): void;
    focusTerminal(terminal: TTerminal): void;
    closeTerminal(terminal: TTerminal): void;
    handleClosedTerminal(terminal: TTerminal): unknown;
}

interface DirectRuntimeMetadata {
    projectKey: string;
    cwd: string;
}

interface DirectPendingRuntimeMetadata extends DirectRuntimeMetadata {
    pendingId: string;
}

export class DirectTerminalRuntimeBackend<TTerminal = vscode.Terminal>
implements AiSessionExecutableRuntimeBackend<TTerminal> {
    private readonly activeMetadata = new Map<string, DirectRuntimeMetadata>();
    private readonly pendingMetadata = new Map<TTerminal, DirectPendingRuntimeMetadata>();

    constructor(
        private readonly terminalService: DirectTerminalService<TTerminal>,
        private readonly nowMs: () => number = () => Date.now()
    ) { }

    async refresh(_force: boolean = false): Promise<void> {
        // Direct runtimes are already refreshed by the terminal service's live projection.
    }

    getActive(): AiSessionRuntimeSnapshot<TTerminal>[] {
        return this.terminalService.getTrackedTerminalEntries()
            .filter(entry => !entry.released && !this.terminalService.isComplete(entry))
            .map(entry => this.activeSnapshot(entry));
    }

    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[] {
        return this.terminalService.getPendingTerminals().map(entry => this.pendingSnapshot(entry));
    }

    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[] {
        if (!identity?.provider || !identity.sessionId) {
            return [];
        }
        return this.getActive().filter(runtime => runtime.identity.provider === identity.provider
            && runtime.identity.sessionId === identity.sessionId);
    }

    async ensureResume(request: AiSessionResumeRuntimeRequest): Promise<AiSessionRuntimeSnapshot<TTerminal>> {
        const input = snapshotResumeRequest(request);
        const existing = this.find(input.identity);
        if (existing.length === 1) {
            await this.focus(existing[0]);
            return cloneRuntime(existing[0]);
        }
        if (existing.length > 1) {
            throw new Error('Multiple Direct Terminal runtimes match this AI session.');
        }

        const created = this.terminalService.createTerminal({
            name: input.terminalName,
            cwd: input.identity.cwd || undefined,
            env: this.terminalService.getProviderTerminalEnvironment(
                input.identity.provider, input.identity.sessionId
            ),
            cwdFailureMessage: 'Failed to create the AI session terminal with cwd.',
            cwdWarningMessage: 'Could not open the AI session terminal at the session directory. Resuming without a working directory.',
            logError: () => undefined,
        });
        this.terminalService.focusTerminal(created.terminal);
        await this.terminalService.sendRuntimeLaunch(created.terminal, input.launch, {
            deleteMarkerBeforeLaunch: true,
        });
        const runStartedAtMs = this.nowMs();
        this.terminalService.track(input.identity.provider, input.identity.sessionId, {
            terminal: created.terminal,
            markerPath: input.launch.markerPath || '',
            runStartedAtMs,
            cwd: input.identity.cwd,
        });
        this.activeMetadata.set(activeKey(input.identity.provider, input.identity.sessionId), {
            projectKey: input.identity.projectKey,
            cwd: input.identity.cwd,
        });
        return this.activeSnapshot({
            provider: input.identity.provider,
            sessionId: input.identity.sessionId,
            terminal: created.terminal,
            markerPath: input.launch.markerPath || '',
            runStartedAtMs,
            cwd: input.identity.cwd,
        });
    }

    async ensurePending(request: AiSessionCreateRuntimeRequest): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>> {
        const input = snapshotCreateRequest(request);
        const duplicate = this.getPending().filter(runtime =>
            runtime.identity.pendingId === input.identity.pendingId);
        if (duplicate.length === 1) {
            await this.focus(duplicate[0]);
            return clonePendingRuntime(duplicate[0]);
        }
        if (duplicate.length > 1) {
            throw new Error('Multiple Direct Terminal runtimes use this pending ID.');
        }

        const created = this.terminalService.createTerminal({
            name: input.terminalName,
            cwd: input.identity.cwd || undefined,
            cwdFailureMessage: 'Failed to create the AI session terminal with cwd.',
            cwdWarningMessage: 'Could not open the AI session terminal at the project directory. Starting without a working directory.',
            logError: () => undefined,
        });
        const pending: DirectPendingTerminalEntry<TTerminal> = {
            provider: input.identity.provider,
            terminal: created.terminal,
            markerPath: input.launch.markerPath || '',
            cwd: input.identity.cwd,
            createdAt: input.createdAt,
            excludedSessionIds: input.excludedSessionIds.slice(),
            ...(input.title === undefined ? {} : { title: input.title }),
        };
        this.pendingMetadata.set(created.terminal, {
            pendingId: input.identity.pendingId,
            projectKey: input.identity.projectKey,
            cwd: input.identity.cwd,
        });
        this.terminalService.trackPending(pending);
        this.terminalService.focusTerminal(created.terminal);
        await this.terminalService.sendRuntimeLaunch(created.terminal, input.launch, {
            persistPendingBeforeLaunch: true,
        });
        return this.pendingSnapshot(pending);
    }

    async promotePending(pendingId: string, sessionId: string): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        const matches = this.terminalService.getPendingTerminals().filter(entry =>
            this.getPendingIdentity(entry).pendingId === pendingId);
        if (matches.length !== 1 || !sessionId) {
            return matches.map(entry => ({ ...this.pendingSnapshot(entry), state: 'conflict' }));
        }
        const pending = matches[0];
        const metadata = this.getPendingIdentity(pending);
        const runStartedAtMs = Date.parse(pending.createdAt);
        this.terminalService.track(pending.provider, sessionId, {
            terminal: pending.terminal,
            markerPath: pending.markerPath,
            runStartedAtMs: Number.isFinite(runStartedAtMs) ? runStartedAtMs : this.nowMs(),
            cwd: pending.cwd,
        });
        this.terminalService.replacePendingTerminals(
            this.terminalService.getPendingTerminals().filter(entry => entry.terminal !== pending.terminal)
        );
        this.pendingMetadata.delete(pending.terminal);
        this.activeMetadata.set(activeKey(pending.provider, sessionId), {
            projectKey: metadata.projectKey,
            cwd: metadata.cwd,
        });
        return [this.activeSnapshot({
            provider: pending.provider,
            sessionId,
            terminal: pending.terminal,
            markerPath: pending.markerPath,
            runStartedAtMs: Number.isFinite(runStartedAtMs) ? runStartedAtMs : this.nowMs(),
            cwd: pending.cwd,
        })];
    }

    async focus(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (runtime?.backend === 'vscode' && runtime.terminal) {
            this.terminalService.focusTerminal(runtime.terminal);
        }
    }

    async detach(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (runtime?.backend === 'vscode' && runtime.terminal) {
            this.terminalService.closeTerminal(runtime.terminal);
        }
    }

    handleClosedTerminal(terminal: TTerminal): void {
        this.pendingMetadata.delete(terminal);
        this.terminalService.handleClosedTerminal(terminal);
    }

    private activeSnapshot(entry: DirectTerminalEntry<TTerminal>): AiSessionRuntimeSnapshot<TTerminal> {
        const metadata = this.activeMetadata.get(activeKey(entry.provider, entry.sessionId));
        const cwd = metadata?.cwd || entry.cwd || '';
        return {
            identity: {
                provider: entry.provider,
                projectKey: metadata?.projectKey || cwd,
                cwd,
                sessionId: entry.sessionId,
            },
            backend: 'vscode',
            state: 'active',
            markerPath: entry.markerPath,
            runStartedAtMs: entry.runStartedAtMs,
            attached: true,
            terminal: entry.terminal,
        };
    }

    private pendingSnapshot(entry: DirectPendingTerminalEntry<TTerminal>): AiSessionPendingRuntimeSnapshot<TTerminal> {
        const identity = this.getPendingIdentity(entry);
        return {
            identity: {
                provider: entry.provider,
                projectKey: identity.projectKey,
                cwd: identity.cwd,
                pendingId: identity.pendingId,
            },
            backend: 'vscode',
            state: 'pending',
            markerPath: entry.markerPath,
            runStartedAtMs: finiteDate(entry.createdAt),
            attached: true,
            terminal: entry.terminal,
            createdAt: entry.createdAt,
            excludedSessionIds: entry.excludedSessionIds.slice(),
            ...(entry.title === undefined ? {} : { title: entry.title }),
        };
    }

    private getPendingIdentity(entry: DirectPendingTerminalEntry<TTerminal>): DirectPendingRuntimeMetadata {
        return this.pendingMetadata.get(entry.terminal) || {
            pendingId: entry.createdAt,
            projectKey: entry.cwd,
            cwd: entry.cwd,
        };
    }
}

function activeKey(provider: AiSessionProviderId, sessionId: string): string {
    return `${provider}:${sessionId}`;
}

function finiteDate(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotResumeRequest(request: AiSessionResumeRuntimeRequest): AiSessionResumeRuntimeRequest {
    return {
        ...request,
        identity: { ...request.identity },
        launch: { ...request.launch, args: [...request.launch.args] },
    };
}

function snapshotCreateRequest(request: AiSessionCreateRuntimeRequest): AiSessionCreateRuntimeRequest {
    return {
        ...request,
        identity: { ...request.identity },
        excludedSessionIds: [...request.excludedSessionIds],
        launch: { ...request.launch, args: [...request.launch.args] },
    };
}

function cloneRuntime<TTerminal>(runtime: AiSessionRuntimeSnapshot<TTerminal>): AiSessionRuntimeSnapshot<TTerminal> {
    return {
        ...runtime,
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function clonePendingRuntime<TTerminal>(
    runtime: AiSessionPendingRuntimeSnapshot<TTerminal>
): AiSessionPendingRuntimeSnapshot<TTerminal> {
    return {
        ...cloneRuntime(runtime),
        state: 'pending',
        createdAt: runtime.createdAt,
        excludedSessionIds: [...runtime.excludedSessionIds],
        ...(runtime.title === undefined ? {} : { title: runtime.title }),
    };
}
