'use strict';

import type { AiSessionProviderId } from '../models';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import type { WorkspaceAiSessionActionTarget } from './types';
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
    getWorkspaceTarget: (cardId: string) => WorkspaceAiSessionActionTarget | null;
    showErrorMessage(message: string): Thenable<unknown> | Promise<unknown>;
    getProviderLabel(providerId: AiSessionProviderId): string;
    refresh(): void;
    focusTerminalView?(): Thenable<unknown> | Promise<unknown>;
    logRuntimeFailure?(
        operation: string,
        error: unknown,
        backend: 'vscode' | 'tmux'
    ): void;
    onRuntimeCloseStart?(runtime: AiSessionRuntimeSnapshot<unknown>): void;
    onRuntimeCloseEnd?(runtime: AiSessionRuntimeSnapshot<unknown>, succeeded: boolean): void;
}

export interface AiSessionTerminalCommandRuntimeControllerOptions<
    TTerminal extends { show(): void; dispose(): void }
> extends AiSessionTerminalCommandControllerCommonOptions {
    runtimeCoordinator: AiSessionTerminalCommandRuntimeCoordinator<TTerminal>;
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

export type AiSessionTerminalCommandControllerOptions<
    TTerminal extends { show(): void; dispose(): void }
> = AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>;

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
                await this.options.focusTerminalView?.();
            } catch (error) {
                await this.handleRuntimeActionFailure(
                    'focus-runtime', 'Could not focus the AI session terminal.',
                    runtime, error, this.options
                );
            }
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
            await options.focusTerminalView?.();
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
        const runtime = this.getScopedPendingRuntime(projectId, providerId, createdAt, this.options);
        if (runtime) {
            try {
                await this.options.runtimeCoordinator.focus({ ...runtime.identity });
                this.options.refresh();
                await this.options.focusTerminalView?.();
            } catch (error) {
                await this.handleRuntimeActionFailure(
                    'focus-runtime', 'Could not focus the AI session terminal.',
                    runtime, error, this.options
                );
            }
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
        const runtime = hasSessionId
            ? this.getScopedActiveRuntime(
                request.projectId, request.providerId, request.sessionId as string, this.options
            )
            : this.getScopedPendingRuntime(
                request.projectId, request.providerId, request.pendingCreatedAt as string, this.options
            );
        if (runtime && (!request.expectedBackend || runtime.backend === request.expectedBackend)) {
            await this.detachRuntime(request, request.providerId, runtime, this.options);
        }
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
        this.options.onRuntimeCloseStart?.(cloneRuntime(currentRuntime));
        try {
            const detach = options.runtimeCoordinator.detach({ ...currentRuntime.identity });
            await detach;
        } catch (error) {
            this.options.onRuntimeCloseEnd?.(cloneRuntime(currentRuntime), false);
            options.logRuntimeFailure?.('detach-runtime', error, runtime.backend);
            await options.showErrorMessage(runtime.backend === 'tmux'
                ? 'Could not detach the AI session terminal.'
                : 'Could not close the AI session terminal.');
            options.refresh();
            return;
        }
        this.options.onRuntimeCloseEnd?.(cloneRuntime(currentRuntime), true);
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
        const ownership = this.getRuntimeWorkspaceOwnership(projectId, options);
        const runtime = ownership ? options.runtimeCoordinator.getById(
            providerId, sessionId, ownership.workspaceScopeIdentity
        ) : null;
        return ownership && runtime && this.runtimeBelongsToWorkspace(
            ownership, providerId, sessionId, runtime
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
        const ownership = this.getRuntimeWorkspaceOwnership(projectId, options);
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
        return candidates.filter(runtime => this.runtimeBelongsToWorkspace(
            ownership, providerId, sessionId, runtime
        )).map(cloneRuntime);
    }

    private getScopedUnverifiedConflicts(
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): AiSessionRuntimeSnapshot<TTerminal>[] {
        const ownership = this.getRuntimeWorkspaceOwnership(projectId, options);
        if (!ownership || !options.runtimeCoordinator.getUnverifiedConflicts) {
            return [];
        }
        return options.runtimeCoordinator.getUnverifiedConflicts(
            providerId, sessionId, ownership.workspaceScopeIdentity
        )
            .filter(runtime => this.runtimeBelongsToWorkspace(
                ownership, providerId, sessionId, runtime
            )).map(cloneRuntime);
    }

    private getScopedPendingRuntime(
        projectId: string,
        providerId: AiSessionProviderId,
        createdAt: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): AiSessionPendingRuntimeSnapshot<TTerminal> | null {
        const ownership = this.getRuntimeWorkspaceOwnership(projectId, options);
        if (!ownership) {
            return null;
        }
        const matches = options.runtimeCoordinator.getPending().filter(runtime => {
            return runtime.identity.provider === providerId
                && runtime.createdAt === createdAt
                && this.runtimeBelongsToWorkspace(ownership, providerId, undefined, runtime);
        });
        return matches.length === 1 ? clonePendingRuntime(matches[0]) : null;
    }

    private getRuntimeWorkspaceOwnership(
        projectId: string,
        options: AiSessionTerminalCommandRuntimeControllerOptions<TTerminal>
    ): RuntimeWorkspaceOwnership | null {
        const workspaceTarget = options.getWorkspaceTarget(projectId);
        return workspaceTarget ? {
            workspaceTarget,
            workspaceScopeIdentity: workspaceTarget.workspace.scopeIdentity,
        } : null;
    }

    private runtimeBelongsToWorkspace(
        ownership: RuntimeWorkspaceOwnership,
        providerId: AiSessionProviderId,
        sessionId: string | undefined,
        runtime: AiSessionRuntimeSnapshot<TTerminal>
    ): boolean {
        if (runtime.identity.workspaceScopeIdentity !== ownership.workspaceScopeIdentity) {
            return false;
        }
        return !sessionId
            || (ownership.workspaceTarget.sessions.sessionsByProvider[providerId] || [])
                .some(session => session.id === sessionId)
            || ownership.workspaceTarget.sessions.activeSessions.some(session =>
                session.provider === providerId && session.sessionId === sessionId
            );
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

interface RuntimeWorkspaceOwnership {
    workspaceTarget: WorkspaceAiSessionActionTarget;
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

function validateControllerOptions<TTerminal extends { show(): void; dispose(): void }>(
    options: AiSessionTerminalCommandControllerOptions<TTerminal>
): void {
    const coordinator = options?.runtimeCoordinator;
    if (typeof coordinator.getById !== 'function'
        || typeof coordinator.getPending !== 'function'
        || typeof coordinator.focus !== 'function'
        || typeof coordinator.detach !== 'function'
        || typeof options.getWorkspaceTarget !== 'function'
        || typeof options.confirmRuntimeClose !== 'function'
        || typeof options.announceStatus !== 'function') {
        throw new Error('AI session terminal runtime controller options are invalid.');
    }
}
