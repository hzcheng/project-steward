'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { AiSessionLaunchSpec } from './launchSpec';
import type {
    AiSessionResumeRuntimeRequest,
    AiSessionRuntimeActionResult,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import type { AiSessionDirectoryScope, WorkspaceAiSessionActionTarget } from './types';

interface AiSessionResumeTarget {
    id: string;
    name: string;
    session: CodexSession;
    workspace: WorkspaceAiSessionActionTarget;
}

export interface AiSessionResumeTerminal {
    show(): void;
}

export interface AiSessionResumeProvider {
    label: string;
    terminalEnvKey: string;
    buildResumeLaunchSpec?: (
        sessionId: string,
        scope: AiSessionDirectoryScope,
        markerPath: string
    ) => AiSessionLaunchSpec;
}

export interface AiSessionResumeRuntimeCoordinator<TTerminal> {
    resume(request: AiSessionResumeRuntimeRequest): Promise<AiSessionRuntimeActionResult<TTerminal>>;
}

export interface AiSessionResumeControllerCommonOptions {
    getWorkspaceTarget: (cardId: string) => WorkspaceAiSessionActionTarget | null;
    getProvider: (providerId: AiSessionProviderId) => AiSessionResumeProvider | null;
    resolveWorkspaceDirectoryScope: (
        target: WorkspaceAiSessionActionTarget,
        session: CodexSession,
        providerId: AiSessionProviderId,
        explicitRootId?: string
    ) => AiSessionDirectoryScope | null | Thenable<AiSessionDirectoryScope | null> | Promise<AiSessionDirectoryScope | null>;
    rememberDirectoryScope?: (
        directoryScope: AiSessionDirectoryScope
    ) => Thenable<void> | Promise<void>;
    getTerminalName: (providerId: AiSessionProviderId, session: CodexSession) => string;
    getMarkerPath: (providerId: AiSessionProviderId, sessionId: string) => string;
    showWarningMessage: (message: string) => unknown;
    refresh: () => void;
    showActiveTab: (projectId: string) => unknown;
    showErrorMessage?: (message: string) => Thenable<unknown> | Promise<unknown>;
    logRuntimeFailure?: (
        operation: string,
        error: unknown,
        backend: 'vscode' | 'tmux'
    ) => void;
}

export interface AiSessionResumeRuntimeControllerOptions<
    TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal
> extends AiSessionResumeControllerCommonOptions {
    runtimeCoordinator: AiSessionResumeRuntimeCoordinator<TTerminal>;
    announceStatus: (projectId: string, message: string) => Thenable<unknown> | Promise<unknown>;
    getRuntimeConflict?: (
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ) => AiSessionRuntimeSnapshot<TTerminal> | null;
}

export type AiSessionResumeControllerOptions<
    TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal
> = AiSessionResumeRuntimeControllerOptions<TTerminal>;

export class AiSessionResumeController<
    TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal
> {
    private readonly options: AiSessionResumeControllerOptions<TTerminal>;

    constructor(options: AiSessionResumeControllerOptions<TTerminal>) {
        validateControllerOptions(options);
        this.options = options;
    }

    async resumeProjectSession(
        projectId: string,
        providerId: AiSessionProviderId | null,
        sessionId: string,
        explicitRootId?: string
    ): Promise<void> {
        if (!providerId) {
            return;
        }

        const workspace = this.options.getWorkspaceTarget(projectId);
        const workspaceSession = workspace
            ? (workspace.sessions.sessionsByProvider[providerId] || []).find(candidate => candidate.id === sessionId)
            : null;
        const target: AiSessionResumeTarget | null = workspace && workspaceSession
            ? { id: workspace.cardId, name: workspace.workspace.displayName, session: workspaceSession, workspace }
            : null;
        const sessionProvider = this.options.getProvider(providerId);
        if (!target) {
            this.options.showWarningMessage(`Selected ${sessionProvider?.label || 'AI'} session not found.`);
            return;
        }

        const session = target.session;
        const directoryScope = await this.options.resolveWorkspaceDirectoryScope(
            target.workspace, session, providerId, explicitRootId
        );
        if (!directoryScope || !sessionProvider) {
            return;
        }

        await this.resumeRuntime(target, providerId, sessionProvider, directoryScope, this.options);
    }

    private async resumeRuntime(
        target: AiSessionResumeTarget,
        providerId: AiSessionProviderId,
        sessionProvider: AiSessionResumeProvider,
        directoryScope: AiSessionDirectoryScope,
        options: AiSessionResumeRuntimeControllerOptions<TTerminal>
    ): Promise<void> {
        const session = target.session;
        if (options.getRuntimeConflict?.(
            providerId, session.id, directoryScope.workspaceScopeIdentity
        )) {
            options.refresh();
            await options.announceStatus(
                target.id,
                'Multiple live runtimes match this AI session.'
            );
            return;
        }
        if (!sessionProvider.buildResumeLaunchSpec) {
            throw new Error('AI session runtime resume is not configured.');
        }
        const cwd = directoryScope.primaryCwd;
        const markerPath = options.getMarkerPath(providerId, session.id);
        const launch = cloneLaunchSpec(
            sessionProvider.buildResumeLaunchSpec(session.id, directoryScope, markerPath)
        );
        const request: AiSessionResumeRuntimeRequest = {
            identity: {
                provider: providerId,
                sessionId: session.id,
                workspaceScopeIdentity: directoryScope.workspaceScopeIdentity,
                workspaceNavigationIdentity: directoryScope.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...directoryScope.workspaceRootHostPaths],
                cwd,
            },
            projectName: target.name || 'AI Session',
            terminalName: options.getTerminalName(providerId, session),
            launch,
            directoryScope,
        };
        let result: AiSessionRuntimeActionResult<TTerminal>;
        try {
            result = await options.runtimeCoordinator.resume(request);
        } catch (error) {
            options.logRuntimeFailure?.('resume-runtime', error, 'tmux');
            if (options.showErrorMessage) {
                await options.showErrorMessage('Could not resume the AI session runtime.');
            } else {
                options.showWarningMessage('Could not resume the AI session runtime.');
            }
            options.refresh();
            return;
        }
        if (result.status === 'cancelled' || result.status === 'settings') {
            return;
        }
        if (result.status === 'conflict') {
            options.refresh();
            await options.announceStatus(
                target.id,
                'Multiple live runtimes match this AI session.'
            );
            return;
        }
        if (result.status === 'blocked') {
            options.refresh();
            await options.announceStatus(
                target.id,
                'The previous runtime is still awaiting lifecycle acknowledgement.'
            );
            return;
        }
        if (result.status === 'started') {
            await options.rememberDirectoryScope?.(directoryScope);
        }
        await options.showActiveTab(target.id);
        options.refresh();
    }
}

function cloneLaunchSpec(launch: AiSessionLaunchSpec): AiSessionLaunchSpec {
    return {
        ...launch,
        args: [...launch.args],
    };
}

function validateControllerOptions<TTerminal extends AiSessionResumeTerminal>(
    options: AiSessionResumeControllerOptions<TTerminal>
): void {
    if (typeof options?.runtimeCoordinator?.resume !== 'function'
        || typeof options.getWorkspaceTarget !== 'function'
        || typeof options.resolveWorkspaceDirectoryScope !== 'function'
        || typeof options.announceStatus !== 'function') {
        throw new Error('AI session resume runtime controller options are invalid.');
    }
}
