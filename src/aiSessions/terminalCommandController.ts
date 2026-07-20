'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import { aiSessionRuntimeIdentitiesEqual, cloneAiSessionRuntimeIdentity } from './runtimeTypes';

export interface AiSessionTerminalCommandRuntimeCoordinator<TTerminal> {
    getById(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<TTerminal> | null;
    getActiveCandidates?(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<TTerminal>[];
    getUnverifiedConflicts?(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<TTerminal>[];
    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[];
    focus(identity: AiSessionRuntimeIdentity): Promise<void>;
    focusSelected?(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<boolean>;
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
    getWorkspaceScopeIdentity: () => string | null;
    confirmRuntimeClose(
        message: string,
        action: 'Close Terminal' | 'Detach Terminal'
    ): Thenable<string | undefined> | Promise<string | undefined>;
    announceStatus(projectId: string, message: string): Thenable<unknown> | Promise<unknown>;
    chooseRuntimeConflict?(
        runtimes: AiSessionRuntimeSnapshot<TTerminal>[]
    ): Thenable<AiSessionRuntimeSnapshot<TTerminal> | undefined>
        | Promise<AiSessionRuntimeSnapshot<TTerminal> | undefined>;
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
            const candidates = this.getScopedActiveCandidates(
                projectId, providerId, sessionId, this.options
            );
            const hasUnverifiedConflict = this.getScopedUnverifiedConflicts(
                projectId, providerId, sessionId, this.options
            ).length > 0;
            if (!candidates.length && hasUnverifiedConflict) {
                await this.options.announceStatus(
                    projectId,
                    'The conflicting AI session target could not be verified as a managed runtime and was not focused.'
                );
                return;
            }
            if (candidates.length > 1 || candidates.some(runtime => runtime.state === 'conflict')) {
                await this.chooseAndFocusConflict(projectId, candidates, this.options);
                return;
            }
            if (candidates.length === 1 && hasUnverifiedConflict) {
                await this.focusVerifiedSelection(projectId, candidates[0], this.options);
                return;
            }
            const runtime = this.getScopedActiveRuntime(projectId, providerId, sessionId, this.options);
            if (runtime) {
                try {
                    await this.options.runtimeCoordinator.focus({ ...runtime.identity });
                    this.options.refresh();
                } catch (error) {
                    await this.handleRuntimeActionFailure(
                        'focus-runtime', 'Could not focus the AI session terminal.',
                        runtime, error, this.options
                    );
                }
            }
            return;
        }
        const terminal = this.getScopedActiveTerminal(projectId, providerId, sessionId, this.options);
        if (terminal) {
            terminal.show();
            this.options.refresh();
        }
    }

    private async chooseAndFocusConflict(
        projectId: string,
        candidates: AiSessionRuntimeSnapshot<TTerminal>[],
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): Promise<void> {
        if (!options.chooseRuntimeConflict || !options.runtimeCoordinator.focusSelected) {
            return;
        }
        let selected: AiSessionRuntimeSnapshot<TTerminal> | undefined;
        try {
            selected = await options.chooseRuntimeConflict(candidates.map(cloneRuntime));
        } catch (error) {
            await options.showErrorMessage('Could not choose an AI session runtime.');
            return;
        }
        if (!selected) {
            return;
        }
        await this.focusVerifiedSelection(projectId, selected, options);
    }

    private async focusVerifiedSelection(
        projectId: string,
        selected: AiSessionRuntimeSnapshot<TTerminal>,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): Promise<void> {
        try {
            const focused = await options.runtimeCoordinator.focusSelected(cloneRuntime(selected));
            if (!focused) {
                options.refresh();
                await options.announceStatus(
                    projectId,
                    'The selected AI session runtime changed before it could be focused.'
                );
                return;
            }
            options.refresh();
        } catch (error) {
            await this.handleRuntimeActionFailure(
                'focus-selected-runtime', 'Could not focus the selected AI session runtime.',
                selected, error, options
            );
        }
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
                    this.options.refresh();
                } catch (error) {
                    await this.handleRuntimeActionFailure(
                        'focus-runtime', 'Could not focus the AI session terminal.',
                        runtime, error, this.options
                    );
                }
            }
            return;
        }
        const terminal = this.getScopedPendingTerminal(projectId, providerId, createdAt, this.options);
        if (terminal) {
            terminal.show();
            this.options.refresh();
        }
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
        const runtime = ownership ? options.runtimeCoordinator.getById(
            providerId, sessionId, ownership.workspaceScopeIdentity
        ) : null;
        return ownership && runtime && this.runtimeBelongsToProject(
            ownership, providerId, sessionId, runtime, options
        )
            ? cloneRuntime(runtime)
            : null;
    }

    private getScopedActiveCandidates(
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): AiSessionRuntimeSnapshot<TTerminal>[] {
        const ownership = this.getRuntimeProjectOwnership(projectId, options);
        if (!ownership) {
            return [];
        }
        const coordinator = options.runtimeCoordinator;
        const candidates = coordinator.getActiveCandidates
            ? coordinator.getActiveCandidates(
                providerId, sessionId, ownership.workspaceScopeIdentity
            )
            : [coordinator.getById(
                providerId, sessionId, ownership.workspaceScopeIdentity
            )].filter(Boolean) as AiSessionRuntimeSnapshot<TTerminal>[];
        return candidates.filter(runtime => this.runtimeBelongsToProject(
            ownership, providerId, sessionId, runtime, options
        )).map(cloneRuntime);
    }

    private getScopedUnverifiedConflicts(
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): AiSessionRuntimeSnapshot<TTerminal>[] {
        const ownership = this.getRuntimeProjectOwnership(projectId, options);
        if (!ownership || !options.runtimeCoordinator.getUnverifiedConflicts) {
            return [];
        }
        return options.runtimeCoordinator.getUnverifiedConflicts(
            providerId, sessionId, ownership.workspaceScopeIdentity
        )
            .filter(runtime => this.runtimeBelongsToProject(
                ownership, providerId, sessionId, runtime, options
            )).map(cloneRuntime);
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
            normalizedCwd: options.normalizePath(options.getProjectCwd(project)),
        }));
        const requested = openProjects.find(candidate => candidate.project.id === projectId);
        const workspaceScopeIdentity = options.getWorkspaceScopeIdentity();
        return requested && workspaceScopeIdentity
            ? { requested, openProjects, workspaceScopeIdentity }
            : null;
    }

    private runtimeBelongsToProject(
        ownership: RuntimeProjectOwnership,
        providerId: AiSessionProviderId,
        sessionId: string | undefined,
        runtime: AiSessionRuntimeSnapshot<TTerminal>,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): boolean {
        if (runtime.identity.workspaceScopeIdentity !== ownership.workspaceScopeIdentity) {
            return false;
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
        identity: cloneAiSessionRuntimeIdentity(runtime.identity),
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
    normalizedCwd: string;
}

interface RuntimeProjectOwnership {
    requested: RuntimeProjectDescriptor;
    openProjects: RuntimeProjectDescriptor[];
    workspaceScopeIdentity: string;
}

type RuntimeIdentityToken = AiSessionRuntimeIdentity;

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
    const identity = cloneAiSessionRuntimeIdentity(runtime.identity);
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
    return aiSessionRuntimeIdentitiesEqual(left, right);
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
        || typeof runtimeOptions.getWorkspaceScopeIdentity !== 'function'
        || typeof runtimeOptions.confirmRuntimeClose !== 'function'
        || typeof runtimeOptions.announceStatus !== 'function') {
        throw new Error('AI session terminal runtime controller options are invalid.');
    }
}
