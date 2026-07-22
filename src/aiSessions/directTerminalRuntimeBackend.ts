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
import { AiSessionRuntimeLifecycleBlockedError } from './runtimeTypes';
import {
    cloneAiSessionRuntimeIdentity,
} from './runtimeTypes';

const MAX_DISPLAY_NAME_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

interface DirectTerminalEntry<TTerminal> {
    provider: AiSessionProviderId;
    sessionId: string;
    terminal: TTerminal;
    markerPath: string;
    runStartedAtMs: number;
    cwd?: string;
    released?: boolean;
    runtimeIdentity?: AiSessionRuntimeIdentity;
}

interface DirectPendingTerminalEntry<TTerminal> {
    provider: AiSessionProviderId;
    terminal: TTerminal;
    markerPath: string;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    projectName?: string;
    title?: string;
    runtimeIdentity?: AiSessionRuntimeIdentity;
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
        runtimeIdentity?: AiSessionRuntimeIdentity;
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
        runtimeIdentity?: AiSessionRuntimeIdentity;
    }): void;
    trackPending(entry: DirectPendingTerminalEntry<TTerminal>): void;
    replacePendingTerminals(entries: DirectPendingTerminalEntry<TTerminal>[]): void;
    focusTerminal(terminal: TTerminal): void;
    closeTerminal(terminal: TTerminal): void;
    handleClosedTerminal(terminal: TTerminal): unknown;
}

type DirectRuntimeMetadata = AiSessionRuntimeIdentity & { sessionId: string };
type DirectPendingRuntimeMetadata = AiSessionRuntimeIdentity & { pendingId: string };

export class DirectTerminalRuntimeBackend<TTerminal = vscode.Terminal>
implements AiSessionExecutableRuntimeBackend<TTerminal> {
    private readonly activeMetadata = new Map<TTerminal, DirectRuntimeMetadata>();
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
            .map(entry => this.activeSnapshot(entry))
            .filter(Boolean) as AiSessionRuntimeSnapshot<TTerminal>[];
    }

    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[] {
        return this.terminalService.getPendingTerminals()
            .map(entry => this.pendingSnapshot(entry))
            .filter(Boolean) as AiSessionPendingRuntimeSnapshot<TTerminal>[];
    }

    getLifecycleBlockers(): AiSessionRuntimeSnapshot<TTerminal>[] {
        return this.terminalService.getTrackedTerminalEntries()
            .filter(entry => !entry.released && this.terminalService.isComplete(entry))
            .map(entry => this.activeSnapshot(entry))
            .filter(Boolean)
            .map(entry => ({ ...(entry as AiSessionRuntimeSnapshot<TTerminal>), state: 'completed' }));
    }

    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[] {
        if (!identity?.provider || !identity.sessionId) {
            return [];
        }
        return this.getActive().filter(runtime => runtime.identity.provider === identity.provider
            && runtime.identity.sessionId === identity.sessionId
            && runtime.identity.workspaceScopeIdentity === identity.workspaceScopeIdentity);
    }

    async ensureResume(request: AiSessionResumeRuntimeRequest): Promise<AiSessionRuntimeSnapshot<TTerminal>> {
        const input = snapshotResumeRequest(request);
        const blockers = this.getLifecycleBlockers().filter(runtime =>
            runtime.identity.provider === input.identity.provider
            && runtime.identity.sessionId === input.identity.sessionId
            && runtime.identity.workspaceScopeIdentity === input.identity.workspaceScopeIdentity);
        if (blockers.length) {
            throw new AiSessionRuntimeLifecycleBlockedError(blockers);
        }
        const tracked = this.terminalService.getTrackedTerminalEntries().filter(entry =>
            entry.provider === input.identity.provider && entry.sessionId === input.identity.sessionId
            && this.getActiveIdentity(entry)?.workspaceScopeIdentity
                === input.identity.workspaceScopeIdentity);
        if (tracked.length > 1) {
            throw new Error('Multiple Direct Terminal runtimes match this AI session.');
        }
        if (tracked.length === 1) {
            const existing = tracked[0];
            const completed = existing.released || this.terminalService.isComplete(existing);
            if (!completed) {
                const runtime = this.activeSnapshot(existing) as AiSessionRuntimeSnapshot<TTerminal>;
                await this.focus(runtime);
                return cloneRuntime(runtime);
            }
            this.terminalService.focusTerminal(existing.terminal);
            await this.terminalService.sendRuntimeLaunch(existing.terminal, input.launch, {
                deleteMarkerBeforeLaunch: true,
            });
            return this.retrackResume(input, existing.terminal);
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
        await this.terminalService.sendRuntimeLaunch(created.terminal,
            input.launch, {
            deleteMarkerBeforeLaunch: true,
        });
        return this.retrackResume(input, created.terminal);
    }

    private retrackResume(
        input: AiSessionResumeRuntimeRequest,
        terminal: TTerminal
    ): AiSessionRuntimeSnapshot<TTerminal> {
        const runStartedAtMs = this.nowMs();
        this.terminalService.track(input.identity.provider, input.identity.sessionId, {
            terminal,
            markerPath: input.launch.markerPath || '',
            runStartedAtMs,
            cwd: input.identity.cwd,
            runtimeIdentity: cloneAiSessionRuntimeIdentity(input.identity),
        });
        this.activeMetadata.set(terminal,
            cloneAiSessionRuntimeIdentity(input.identity));
        return this.activeSnapshot({
            provider: input.identity.provider,
            sessionId: input.identity.sessionId,
            terminal,
            markerPath: input.launch.markerPath || '',
            runStartedAtMs,
            cwd: input.identity.cwd,
        });
    }

    async ensurePending(request: AiSessionCreateRuntimeRequest): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>> {
        const input = snapshotCreateRequest(request);
        const duplicate = this.getPending().filter(runtime =>
            pendingIdentitiesEqual(runtime.identity, input.identity));
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
            projectName: input.projectName,
            ...(input.title === undefined ? {} : { title: input.title }),
            runtimeIdentity: cloneAiSessionRuntimeIdentity(input.identity),
        };
        this.pendingMetadata.set(created.terminal, cloneAiSessionRuntimeIdentity(input.identity));
        this.terminalService.trackPending(pending);
        this.terminalService.focusTerminal(created.terminal);
        await this.terminalService.sendRuntimeLaunch(created.terminal,
            input.launch, {
            persistPendingBeforeLaunch: true,
        });
        return this.pendingSnapshot(pending);
    }

    async promotePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string },
        sessionId: string,
        sessionName: string
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        if (!isPromotionDisplayName(sessionName)) {
            return [];
        }
        const expectedIdentity = cloneAiSessionRuntimeIdentity(identity);
        const matches = this.terminalService.getPendingTerminals().filter(entry =>
            pendingIdentitiesEqual(this.getPendingIdentity(entry), expectedIdentity));
        if (matches.length !== 1 || !sessionId) {
            return matches.map(entry => ({ ...this.pendingSnapshot(entry), state: 'conflict' }));
        }
        const pending = matches[0];
        const metadata = this.getPendingIdentity(pending) as DirectPendingRuntimeMetadata;
        const runStartedAtMs = Date.parse(pending.createdAt);
        this.terminalService.track(pending.provider, sessionId, {
            terminal: pending.terminal,
            markerPath: pending.markerPath,
            runStartedAtMs: Number.isFinite(runStartedAtMs) ? runStartedAtMs : this.nowMs(),
            cwd: pending.cwd,
            runtimeIdentity: {
                ...cloneAiSessionRuntimeIdentity(metadata),
                pendingId: undefined,
                sessionId,
            },
        });
        this.terminalService.replacePendingTerminals(
            this.terminalService.getPendingTerminals().filter(entry => entry.terminal !== pending.terminal)
        );
        this.pendingMetadata.delete(pending.terminal);
        this.activeMetadata.set(pending.terminal, {
            ...cloneAiSessionRuntimeIdentity(metadata),
            pendingId: undefined,
            sessionId,
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
        this.activeMetadata.delete(terminal);
        this.pendingMetadata.delete(terminal);
        this.terminalService.handleClosedTerminal(terminal);
    }

    private activeSnapshot(entry: DirectTerminalEntry<TTerminal>): AiSessionRuntimeSnapshot<TTerminal> | null {
        const identity = this.getActiveIdentity(entry);
        if (!identity) {
            return null;
        }
        return {
            identity: cloneAiSessionRuntimeIdentity(identity),
            backend: 'vscode',
            state: 'active',
            markerPath: entry.markerPath,
            runStartedAtMs: entry.runStartedAtMs,
            attached: true,
            terminal: entry.terminal,
        };
    }

    private pendingSnapshot(entry: DirectPendingTerminalEntry<TTerminal>): AiSessionPendingRuntimeSnapshot<TTerminal> | null {
        const identity = this.getPendingIdentity(entry);
        if (!identity) {
            return null;
        }
        return {
            identity: cloneAiSessionRuntimeIdentity(identity),
            backend: 'vscode',
            state: 'pending',
            markerPath: entry.markerPath,
            runStartedAtMs: finiteDate(entry.createdAt),
            attached: true,
            terminal: entry.terminal,
            createdAt: entry.createdAt,
            excludedSessionIds: entry.excludedSessionIds.slice(),
            ...(entry.projectName === undefined ? {} : { projectName: entry.projectName }),
            ...(entry.title === undefined ? {} : { title: entry.title }),
        };
    }

    private getActiveIdentity(entry: DirectTerminalEntry<TTerminal>): DirectRuntimeMetadata | null {
        const identity = this.activeMetadata.get(entry.terminal)
            || entry.runtimeIdentity;
        return identity?.sessionId === entry.sessionId && identity.provider === entry.provider
            ? cloneAiSessionRuntimeIdentity(identity) as DirectRuntimeMetadata
            : null;
    }

    private getPendingIdentity(entry: DirectPendingTerminalEntry<TTerminal>): DirectPendingRuntimeMetadata | null {
        const identity = this.pendingMetadata.get(entry.terminal) || entry.runtimeIdentity;
        return identity?.pendingId && identity.provider === entry.provider
            ? cloneAiSessionRuntimeIdentity(identity) as DirectPendingRuntimeMetadata
            : null;
    }
}

function isPromotionDisplayName(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
        && value.length <= MAX_DISPLAY_NAME_LENGTH && !CONTROL_CHARACTERS.test(value);
}

function pendingIdentitiesEqual(
    left: AiSessionRuntimeIdentity | null,
    right: AiSessionRuntimeIdentity
): boolean {
    return !!left?.pendingId && !!right?.pendingId
        && left.pendingId === right.pendingId
        && left.provider === right.provider
        && left.workspaceScopeIdentity === right.workspaceScopeIdentity
        && left.workspaceNavigationIdentity === right.workspaceNavigationIdentity
        && left.cwd === right.cwd
        && JSON.stringify(left.workspaceRootHostPaths.slice().sort())
            === JSON.stringify(right.workspaceRootHostPaths.slice().sort());
}

function finiteDate(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotResumeRequest(request: AiSessionResumeRuntimeRequest): AiSessionResumeRuntimeRequest {
    return {
        ...request,
        identity: cloneAiSessionRuntimeIdentity(request.identity),
        directoryScope: cloneDirectoryScope(request.directoryScope),
        launch: { ...request.launch, args: [...request.launch.args] },
    };
}

function snapshotCreateRequest(request: AiSessionCreateRuntimeRequest): AiSessionCreateRuntimeRequest {
    return {
        ...request,
        identity: cloneAiSessionRuntimeIdentity(request.identity),
        directoryScope: cloneDirectoryScope(request.directoryScope),
        excludedSessionIds: [...request.excludedSessionIds],
        launch: { ...request.launch, args: [...request.launch.args] },
    };
}

function cloneRuntime<TTerminal>(runtime: AiSessionRuntimeSnapshot<TTerminal>): AiSessionRuntimeSnapshot<TTerminal> {
    return {
        ...runtime,
        identity: cloneAiSessionRuntimeIdentity(runtime.identity),
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function cloneDirectoryScope(scope: AiSessionResumeRuntimeRequest['directoryScope']): AiSessionResumeRuntimeRequest['directoryScope'] {
    return {
        ...scope,
        workspaceRootHostPaths: [...scope.workspaceRootHostPaths],
        additionalDirectories: [...scope.additionalDirectories],
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
