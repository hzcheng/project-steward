'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';

export interface AiSessionTerminalCommandRuntimeCoordinator<TTerminal> {
    getById(provider: AiSessionProviderId, sessionId: string): AiSessionRuntimeSnapshot<TTerminal> | null;
    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[];
    focus(identity: AiSessionRuntimeIdentity): Promise<void>;
    detach(identity: AiSessionRuntimeIdentity): Promise<void>;
}

export interface AiSessionTerminalCommandControllerCommonOptions {
    isProviderId(value: string): value is AiSessionProviderId;
    getOpenProjects(): Project[];
    getProjectSessions(project: Project, providerId: AiSessionProviderId): CodexSession[];
    getProjectCwd(project: Project): string;
    normalizePath(value: string): string;
    showErrorMessage(message: string): Thenable<unknown> | Promise<unknown>;
    getProviderLabel(providerId: AiSessionProviderId): string;
    refresh(): void;
    logRuntimeFailure?(
        operation: string,
        error: unknown,
        backend: 'vscode' | 'tmux'
    ): void;
}

export interface AiSessionTerminalCommandRuntimeControllerOptions<
    TTerminal extends { show(): void; dispose(): void }
> extends AiSessionTerminalCommandControllerCommonOptions {
    runtimeCoordinator: AiSessionTerminalCommandRuntimeCoordinator<TTerminal>;
    getProjectKey: (project: Project) => string;
    confirmRuntimeClose(
        message: string,
        action: 'Close Terminal' | 'Detach Terminal'
    ): Thenable<string | undefined> | Promise<string | undefined>;
    announceStatus(projectId: string, message: string): Thenable<unknown> | Promise<unknown>;
}

export interface AiSessionTerminalCommandLegacyControllerOptions<
    TTerminal extends { show(): void; dispose(): void }
> extends AiSessionTerminalCommandControllerCommonOptions {
    runtimeCoordinator?: undefined;
    getActiveTerminal(
        providerId: AiSessionProviderId,
        sessionId: string
    ): { terminal: TTerminal; cwd?: string } | null;
    getPendingTerminals(): Array<{
        provider: AiSessionProviderId;
        terminal: TTerminal;
        cwd: string;
        createdAt: string;
    }>;
    confirmClose(providerLabel: string): Thenable<string | undefined> | Promise<string | undefined>;
}

export type AiSessionTerminalCommandControllerOptions<
    TTerminal extends { show(): void; dispose(): void }
> = AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    | AiSessionTerminalCommandLegacyControllerOptions<TTerminal>;

export interface CloseAiSessionTerminalRequest {
    projectId: string;
    providerId: string;
    sessionId?: string;
    pendingCreatedAt?: string;
    expectedBackend?: 'vscode' | 'tmux';
}

export class AiSessionTerminalCommandController<
    TTerminal extends { show(): void; dispose(): void }
> {
    private readonly options: AiSessionTerminalCommandControllerOptions<TTerminal>;

    constructor(options: AiSessionTerminalCommandControllerOptions<TTerminal>) {
        validateControllerOptions(options);
        this.options = options;
    }

    async focusActive(projectId: string, providerId: string, sessionId: string): Promise<void> {
        if (!sessionId || !this.options.isProviderId(providerId)) {
            return;
        }
        if (isRuntimeOptions(this.options)) {
            const runtime = this.getScopedActiveRuntime(projectId, providerId, sessionId, this.options);
            if (runtime) {
                try {
                    await this.options.runtimeCoordinator.focus({ ...runtime.identity });
                } catch (error) {
                    await this.handleRuntimeActionFailure(
                        'focus-runtime', 'Could not focus the AI session terminal.',
                        runtime, error, this.options
                    );
                }
            }
            return;
        }
        this.getScopedActiveTerminal(projectId, providerId, sessionId, this.options)?.show();
    }

    async focusPending(projectId: string, providerId: string, createdAt: string): Promise<void> {
        if (!createdAt || !this.options.isProviderId(providerId)) {
            return;
        }
        if (isRuntimeOptions(this.options)) {
            const runtime = this.getScopedPendingRuntime(projectId, providerId, createdAt, this.options);
            if (runtime) {
                try {
                    await this.options.runtimeCoordinator.focus({ ...runtime.identity });
                } catch (error) {
                    await this.handleRuntimeActionFailure(
                        'focus-runtime', 'Could not focus the AI session terminal.',
                        runtime, error, this.options
                    );
                }
            }
            return;
        }
        this.getScopedPendingTerminal(projectId, providerId, createdAt, this.options)?.show();
    }

    async closeTerminal(request: CloseAiSessionTerminalRequest): Promise<void> {
        if (!request || !this.options.isProviderId(request.providerId)) {
            return;
        }
        const hasSessionId = Boolean(request.sessionId);
        const hasPendingCreatedAt = Boolean(request.pendingCreatedAt);
        if (hasSessionId === hasPendingCreatedAt) {
            return;
        }
        if (isRuntimeOptions(this.options)) {
            const runtime = hasSessionId
                ? this.getScopedActiveRuntime(
                    request.projectId, request.providerId, request.sessionId as string, this.options
                )
                : this.getScopedPendingRuntime(
                    request.projectId,
                    request.providerId,
                    request.pendingCreatedAt as string,
                    this.options
                );
            if (runtime && (!request.expectedBackend || runtime.backend === request.expectedBackend)) {
                await this.detachRuntime(request, request.providerId, runtime, this.options);
            }
            return;
        }
        if (request.expectedBackend && request.expectedBackend !== 'vscode') {
            return;
        }
        const terminal = hasSessionId
            ? this.getScopedActiveTerminal(
                request.projectId, request.providerId, request.sessionId, this.options
            )
            : this.getScopedPendingTerminal(
                request.projectId, request.providerId, request.pendingCreatedAt, this.options
            );
        if (!terminal) {
            return;
        }
        const confirmation = await this.options.confirmClose(
            this.options.getProviderLabel(request.providerId)
        );
        if (confirmation !== 'Close Terminal') {
            return;
        }
        try {
            terminal.dispose();
        } catch (error) {
            await this.options.showErrorMessage('Could not close the AI session terminal.');
            return;
        }
        this.options.refresh();
    }

    private async detachRuntime(
        request: CloseAiSessionTerminalRequest,
        providerId: AiSessionProviderId,
        runtime: AiSessionRuntimeSnapshot<TTerminal>,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): Promise<void> {
        const selectionToken = createSelectionToken(runtime);
        if (!selectionToken) {
            await this.handleChangedRuntime(request.projectId, options);
            return;
        }
        const action = runtime.backend === 'tmux' ? 'Detach Terminal' : 'Close Terminal';
        const providerLabel = options.getProviderLabel(providerId);
        const message = runtime.backend === 'tmux'
            ? `Detaching this ${providerLabel} terminal will leave the AI task running in tmux.`
            : `Closing this ${providerLabel} terminal may interrupt a running AI task.`;
        let confirmation: string | undefined;
        try {
            confirmation = await options.confirmRuntimeClose(message, action);
        } catch (error) {
            await options.showErrorMessage('Could not confirm the AI session terminal action.');
            return;
        }
        if (confirmation !== action) {
            return;
        }
        const currentRuntime = request.sessionId
            ? this.getScopedActiveRuntime(
                request.projectId, providerId, request.sessionId, options
            )
            : this.getScopedPendingRuntime(
                request.projectId, providerId, request.pendingCreatedAt as string, options
            );
        const currentToken = currentRuntime ? createSelectionToken(currentRuntime) : null;
        if (!currentRuntime || !currentToken || !selectionTokensEqual(selectionToken, currentToken)) {
            await this.handleChangedRuntime(request.projectId, options);
            return;
        }
        try {
            const detach = options.runtimeCoordinator.detach({ ...currentRuntime.identity });
            await detach;
        } catch (error) {
            options.logRuntimeFailure?.('detach-runtime', error, runtime.backend);
            await options.showErrorMessage(runtime.backend === 'tmux'
                ? 'Could not detach the AI session terminal.'
                : 'Could not close the AI session terminal.');
            options.refresh();
            return;
        }
        options.refresh();
    }

    private async handleRuntimeActionFailure(
        operation: string,
        message: string,
        runtime: AiSessionRuntimeSnapshot<TTerminal>,
        error: unknown,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): Promise<void> {
        options.logRuntimeFailure?.(operation, error, runtime.backend);
        await options.showErrorMessage(message);
        options.refresh();
    }

    private async handleChangedRuntime(
        projectId: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): Promise<void> {
        options.refresh();
        await options.announceStatus(
            projectId,
            'The AI session runtime changed before terminal confirmation.'
        );
    }

    private getScopedActiveRuntime(
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): AiSessionRuntimeSnapshot<TTerminal> | null {
        const ownership = this.getRuntimeProjectOwnership(projectId, options);
        const runtime = options.runtimeCoordinator.getById(providerId, sessionId);
        return ownership && runtime && this.runtimeBelongsToProject(
            ownership, providerId, sessionId, runtime, options
        )
            ? cloneRuntime(runtime)
            : null;
    }

    private getScopedPendingRuntime(
        projectId: string,
        providerId: AiSessionProviderId,
        createdAt: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): AiSessionPendingRuntimeSnapshot<TTerminal> | null {
        const ownership = this.getRuntimeProjectOwnership(projectId, options);
        if (!ownership) {
            return null;
        }
        const matches = options.runtimeCoordinator.getPending().filter(runtime => {
            return runtime.identity.provider === providerId
                && runtime.createdAt === createdAt
                && this.runtimeBelongsToProject(ownership, providerId, undefined, runtime, options);
        });
        return matches.length === 1 ? clonePendingRuntime(matches[0]) : null;
    }

    private getRuntimeProjectOwnership(
        projectId: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): RuntimeProjectOwnership | null {
        const openProjects = options.getOpenProjects().map(project => ({
            project,
            canonicalKey: options.getProjectKey(project),
            normalizedCwd: options.normalizePath(options.getProjectCwd(project)),
        }));
        const requested = openProjects.find(candidate => candidate.project.id === projectId);
        return requested ? { requested, openProjects } : null;
    }

    private runtimeBelongsToProject(
        ownership: RuntimeProjectOwnership,
        providerId: AiSessionProviderId,
        sessionId: string | undefined,
        runtime: AiSessionRuntimeSnapshot<TTerminal>,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): boolean {
        if (runtime.identity.projectKey) {
            const projectKeyOwner = ownership.openProjects.find(candidate => {
                return candidate.canonicalKey === runtime.identity.projectKey;
            });
            if (projectKeyOwner) {
                return projectKeyOwner === ownership.requested;
            }
        }
        const runtimeCwd = options.normalizePath(runtime.identity.cwd);
        if (runtimeCwd) {
            const cwdOwner = ownership.openProjects.find(candidate => {
                return candidate.normalizedCwd === runtimeCwd;
            });
            if (cwdOwner) {
                return cwdOwner === ownership.requested;
            }
        }
        return !!sessionId
            && (options.getProjectSessions(ownership.requested.project, providerId) || [])
                .some(session => session.id === sessionId);
    }

    private getScopedActiveTerminal(
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string,
        options: AiSessionTerminalCommandLegacyControllerOptions<TTerminal>
    ): TTerminal | null {
        const project = options.getOpenProjects().find(candidate => candidate.id === projectId);
        const entry = options.getActiveTerminal(providerId, sessionId);
        if (!project || !entry?.terminal) {
            return null;
        }
        const belongsToHistory = (options.getProjectSessions(project, providerId) || [])
            .some(session => session.id === sessionId);
        const projectCwd = options.normalizePath(options.getProjectCwd(project));
        const bindingCwd = entry.cwd ? options.normalizePath(entry.cwd) : '';
        return belongsToHistory || (projectCwd && bindingCwd === projectCwd)
            ? entry.terminal
            : null;
    }

    private getScopedPendingTerminal(
        projectId: string,
        providerId: AiSessionProviderId,
        createdAt: string,
        options: AiSessionTerminalCommandLegacyControllerOptions<TTerminal>
    ): TTerminal | null {
        const project = options.getOpenProjects().find(candidate => candidate.id === projectId);
        if (!project) {
            return null;
        }
        const projectCwd = options.normalizePath(options.getProjectCwd(project));
        const pending = options.getPendingTerminals().find(candidate => {
            return candidate.provider === providerId
                && candidate.createdAt === createdAt
                && options.normalizePath(candidate.cwd) === projectCwd;
        });
        return pending?.terminal || null;
    }
}

function cloneRuntime<TTerminal>(
    runtime: AiSessionRuntimeSnapshot<TTerminal>
): AiSessionRuntimeSnapshot<TTerminal> {
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
    };
}

interface RuntimeProjectDescriptor {
    project: Project;
    canonicalKey: string;
    normalizedCwd: string;
}

interface RuntimeProjectOwnership {
    requested: RuntimeProjectDescriptor;
    openProjects: RuntimeProjectDescriptor[];
}

interface RuntimeIdentityToken {
    provider: AiSessionProviderId;
    projectKey: string;
    cwd: string;
    sessionId?: string;
    pendingId?: string;
}

type RuntimeSelectionToken<TTerminal> = {
    backend: 'vscode';
    identity: RuntimeIdentityToken;
    terminal: TTerminal;
} | {
    backend: 'tmux';
    identity: RuntimeIdentityToken;
    tmux: {
        layout: 'project' | 'session';
        sessionName: string;
        windowName?: string;
    };
};

function createSelectionToken<TTerminal>(
    runtime: AiSessionRuntimeSnapshot<TTerminal>
): RuntimeSelectionToken<TTerminal> | null {
    const identity = { ...runtime.identity };
    if (runtime.backend === 'vscode') {
        return runtime.terminal
            ? { backend: 'vscode', identity, terminal: runtime.terminal }
            : null;
    }
    return runtime.tmux
        ? { backend: 'tmux', identity, tmux: { ...runtime.tmux } }
        : null;
}

function selectionTokensEqual<TTerminal>(
    left: RuntimeSelectionToken<TTerminal>,
    right: RuntimeSelectionToken<TTerminal>
): boolean {
    if (left.backend !== right.backend || !identitiesEqual(left.identity, right.identity)) {
        return false;
    }
    if (left.backend === 'vscode' && right.backend === 'vscode') {
        return left.terminal === right.terminal;
    }
    return left.backend === 'tmux' && right.backend === 'tmux'
        && left.tmux.layout === right.tmux.layout
        && left.tmux.sessionName === right.tmux.sessionName
        && left.tmux.windowName === right.tmux.windowName;
}

function identitiesEqual(left: RuntimeIdentityToken, right: RuntimeIdentityToken): boolean {
    return left.provider === right.provider
        && left.projectKey === right.projectKey
        && left.cwd === right.cwd
        && left.sessionId === right.sessionId
        && left.pendingId === right.pendingId;
}

function isRuntimeOptions<TTerminal extends { show(): void; dispose(): void }>(
    options: AiSessionTerminalCommandControllerOptions<TTerminal>
): options is AiSessionTerminalCommandRuntimeControllerOptions<TTerminal> {
    return options.runtimeCoordinator !== undefined;
}

function validateControllerOptions<TTerminal extends { show(): void; dispose(): void }>(
    options: AiSessionTerminalCommandControllerOptions<TTerminal>
): void {
    if (options?.runtimeCoordinator === undefined) {
        return;
    }
    const coordinator = options.runtimeCoordinator;
    const runtimeOptions = options as AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>;
    if (typeof coordinator.getById !== 'function'
        || typeof coordinator.getPending !== 'function'
        || typeof coordinator.focus !== 'function'
        || typeof coordinator.detach !== 'function'
        || typeof runtimeOptions.getOpenProjects !== 'function'
        || typeof runtimeOptions.getProjectKey !== 'function'
        || typeof runtimeOptions.confirmRuntimeClose !== 'function'
        || typeof runtimeOptions.announceStatus !== 'function') {
        throw new Error('AI session terminal runtime controller options are invalid.');
    }
}
