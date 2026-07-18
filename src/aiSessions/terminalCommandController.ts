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

export interface AiSessionTerminalCommandControllerOptions<
    TTerminal extends { show(): void; dispose(): void }
> {
    isProviderId(value: string): value is AiSessionProviderId;
    getOpenProjects(): Project[];
    getProjectSessions(project: Project, providerId: AiSessionProviderId): CodexSession[];
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
    runtimeCoordinator?: AiSessionTerminalCommandRuntimeCoordinator<TTerminal>;
    getProjectKey?: (project: Project) => string;
    getProjectCwd(project: Project): string;
    normalizePath(value: string): string;
    confirmClose(providerLabel: string): Thenable<string | undefined> | Promise<string | undefined>;
    confirmRuntimeClose?: (
        message: string,
        action: 'Close Terminal' | 'Detach Terminal'
    ) => Thenable<string | undefined> | Promise<string | undefined>;
    showErrorMessage(message: string): Thenable<unknown> | Promise<unknown>;
    getProviderLabel(providerId: AiSessionProviderId): string;
    refresh(): void;
}

export interface CloseAiSessionTerminalRequest {
    projectId: string;
    providerId: string;
    sessionId?: string;
    pendingCreatedAt?: string;
}

export class AiSessionTerminalCommandController<
    TTerminal extends { show(): void; dispose(): void }
> {
    constructor(private readonly options: AiSessionTerminalCommandControllerOptions<TTerminal>) { }

    async focusActive(projectId: string, providerId: string, sessionId: string): Promise<void> {
        if (!sessionId || !this.options.isProviderId(providerId)) {
            return;
        }
        if (this.options.runtimeCoordinator) {
            const runtime = this.getScopedActiveRuntime(projectId, providerId, sessionId);
            if (runtime) {
                await this.options.runtimeCoordinator.focus({ ...runtime.identity });
            }
            return;
        }
        this.getScopedActiveTerminal(projectId, providerId, sessionId)?.show();
    }

    async focusPending(projectId: string, providerId: string, createdAt: string): Promise<void> {
        if (!createdAt || !this.options.isProviderId(providerId)) {
            return;
        }
        if (this.options.runtimeCoordinator) {
            const runtime = this.getScopedPendingRuntime(projectId, providerId, createdAt);
            if (runtime) {
                await this.options.runtimeCoordinator.focus({ ...runtime.identity });
            }
            return;
        }
        this.getScopedPendingTerminal(projectId, providerId, createdAt)?.show();
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
        if (this.options.runtimeCoordinator) {
            const runtime = hasSessionId
                ? this.getScopedActiveRuntime(request.projectId, request.providerId, request.sessionId as string)
                : this.getScopedPendingRuntime(
                    request.projectId,
                    request.providerId,
                    request.pendingCreatedAt as string
                );
            if (runtime) {
                await this.detachRuntime(request.providerId, runtime);
            }
            return;
        }
        const terminal = hasSessionId
            ? this.getScopedActiveTerminal(request.projectId, request.providerId, request.sessionId)
            : this.getScopedPendingTerminal(request.projectId, request.providerId, request.pendingCreatedAt);
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
        providerId: AiSessionProviderId,
        runtime: AiSessionRuntimeSnapshot<TTerminal>
    ): Promise<void> {
        const action = runtime.backend === 'tmux' ? 'Detach Terminal' : 'Close Terminal';
        const providerLabel = this.options.getProviderLabel(providerId);
        const message = runtime.backend === 'tmux'
            ? `Detaching this ${providerLabel} terminal will leave the AI task running in tmux.`
            : `Closing this ${providerLabel} terminal may interrupt a running AI task.`;
        const confirmation = this.options.confirmRuntimeClose
            ? await this.options.confirmRuntimeClose(message, action)
            : await this.options.confirmClose(providerLabel);
        if (confirmation !== action) {
            return;
        }
        try {
            await this.options.runtimeCoordinator!.detach({ ...runtime.identity });
        } catch (error) {
            await this.options.showErrorMessage(runtime.backend === 'tmux'
                ? 'Could not detach the AI session terminal.'
                : 'Could not close the AI session terminal.');
            return;
        }
        this.options.refresh();
    }

    private getScopedActiveRuntime(
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string
    ): AiSessionRuntimeSnapshot<TTerminal> | null {
        const project = this.options.getOpenProjects().find(candidate => candidate.id === projectId);
        const runtime = this.options.runtimeCoordinator?.getById(providerId, sessionId) || null;
        return project && runtime && this.runtimeBelongsToProject(project, providerId, sessionId, runtime)
            ? cloneRuntime(runtime)
            : null;
    }

    private getScopedPendingRuntime(
        projectId: string,
        providerId: AiSessionProviderId,
        createdAt: string
    ): AiSessionPendingRuntimeSnapshot<TTerminal> | null {
        const project = this.options.getOpenProjects().find(candidate => candidate.id === projectId);
        if (!project) {
            return null;
        }
        const matches = (this.options.runtimeCoordinator?.getPending() || []).filter(runtime => {
            return runtime.identity.provider === providerId
                && runtime.createdAt === createdAt
                && this.runtimeBelongsToProject(project, providerId, undefined, runtime);
        });
        return matches.length === 1 ? clonePendingRuntime(matches[0]) : null;
    }

    private runtimeBelongsToProject(
        project: Project,
        providerId: AiSessionProviderId,
        sessionId: string | undefined,
        runtime: AiSessionRuntimeSnapshot<TTerminal>
    ): boolean {
        const belongsToHistory = !!sessionId
            && (this.options.getProjectSessions(project, providerId) || [])
                .some(session => session.id === sessionId);
        const projectCwd = this.options.normalizePath(this.options.getProjectCwd(project));
        const runtimeCwd = this.options.normalizePath(runtime.identity.cwd);
        const projectKey = this.options.getProjectKey
            ? this.options.getProjectKey(project)
            : projectCwd || project.id;
        return belongsToHistory
            || (!!projectKey && runtime.identity.projectKey === projectKey)
            || (!!projectCwd && runtimeCwd === projectCwd);
    }

    private getScopedActiveTerminal(
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string
    ): TTerminal | null {
        const project = this.options.getOpenProjects().find(candidate => candidate.id === projectId);
        const entry = this.options.getActiveTerminal(providerId, sessionId);
        if (!project || !entry?.terminal) {
            return null;
        }
        const belongsToHistory = (this.options.getProjectSessions(project, providerId) || [])
            .some(session => session.id === sessionId);
        const projectCwd = this.options.normalizePath(this.options.getProjectCwd(project));
        const bindingCwd = entry.cwd ? this.options.normalizePath(entry.cwd) : '';
        return belongsToHistory || (projectCwd && bindingCwd === projectCwd)
            ? entry.terminal
            : null;
    }

    private getScopedPendingTerminal(
        projectId: string,
        providerId: AiSessionProviderId,
        createdAt: string
    ): TTerminal | null {
        const project = this.options.getOpenProjects().find(candidate => candidate.id === projectId);
        if (!project) {
            return null;
        }
        const projectCwd = this.options.normalizePath(this.options.getProjectCwd(project));
        const pending = this.options.getPendingTerminals().find(candidate => {
            return candidate.provider === providerId
                && candidate.createdAt === createdAt
                && this.options.normalizePath(candidate.cwd) === projectCwd;
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
