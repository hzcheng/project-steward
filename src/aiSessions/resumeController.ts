'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
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
    project?: Project;
    workspace?: WorkspaceAiSessionActionTarget;
}

export interface AiSessionResumeTerminal {
    show(): void;
}

export interface AiSessionResumeTerminalEntry<TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal> {
    terminal: TTerminal;
    markerPath: string;
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

export interface AiSessionResumeCreateTerminalOptions {
    name: string;
    cwd: string | null;
    env: Record<string, string>;
    cwdFailureMessage: string;
    cwdWarningMessage: string;
    logError: (message: string, error: unknown) => void;
}

export interface AiSessionResumeCreateTerminalResult<TTerminal extends AiSessionResumeTerminal> {
    terminal: TTerminal;
    cwdAccepted: boolean;
}

export interface AiSessionResumePendingTerminal<TTerminal extends AiSessionResumeTerminal> {
    terminal: TTerminal;
    markerPath: string;
}

export interface AiSessionResumeTrackEntry<TTerminal extends AiSessionResumeTerminal> {
    terminal: TTerminal;
    markerPath: string;
    runStartedAtMs: number;
    cwd?: string;
}

export interface AiSessionResumeControllerCommonOptions {
    getOpenProjects: () => Project[];
    getWorkspaceTarget?: (cardId: string) => WorkspaceAiSessionActionTarget | null;
    getProvider: (providerId: AiSessionProviderId) => AiSessionResumeProvider | null;
    getProjectSession: (project: Project, providerId: AiSessionProviderId, sessionId: string) => CodexSession | null | undefined;
    resolveDirectoryScope: (
        project: Project,
        session: CodexSession,
        providerId: AiSessionProviderId,
        explicitRootId?: string
    ) => AiSessionDirectoryScope | null | Thenable<AiSessionDirectoryScope | null> | Promise<AiSessionDirectoryScope | null>;
    resolveWorkspaceDirectoryScope?: (
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

export interface AiSessionResumeLegacyControllerOptions<
    TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal,
    TEntry extends AiSessionResumeTerminalEntry<TTerminal> = AiSessionResumeTerminalEntry<TTerminal>
> extends AiSessionResumeControllerCommonOptions {
    runtimeCoordinator?: undefined;
    getComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string;
    getUsableTerminalCwd: (cwd: string) => string | null;
    normalizeProjectPath: (cwd: string) => string | null;
    getExistingTerminal: (providerId: AiSessionProviderId, session: CodexSession) => TEntry | null;
    isTerminalComplete: (entry: TEntry) => boolean;
    beginResume: (providerId: AiSessionProviderId, sessionId: string) => boolean;
    finishResume: (providerId: AiSessionProviderId, sessionId: string) => void;
    findPendingTerminalForSession: (
        providerId: AiSessionProviderId,
        sessionId: string,
        cwd: string,
        updatedAt: string
    ) => AiSessionResumePendingTerminal<TTerminal> | null;
    createTerminal: (
        options: AiSessionResumeCreateTerminalOptions
    ) => AiSessionResumeCreateTerminalResult<TTerminal>;
    track: (
        providerId: AiSessionProviderId,
        sessionId: string,
        entry: AiSessionResumeTrackEntry<TTerminal>
    ) => void;
    claimPendingTerminal: (terminal: TTerminal) => void;
    sendResumeCommand: (
        providerId: AiSessionProviderId,
        terminal: TTerminal,
        sessionId: string,
        scope: AiSessionDirectoryScope,
        markerPath: string
    ) => Thenable<void> | Promise<void>;
    syncActiveTerminal: () => void;
    logError: (message: string, error: unknown) => void;
    nowMs: () => number;
}

export type AiSessionResumeControllerOptions<
    TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal,
    TEntry extends AiSessionResumeTerminalEntry<TTerminal> = AiSessionResumeTerminalEntry<TTerminal>
> = AiSessionResumeRuntimeControllerOptions<TTerminal>
    | AiSessionResumeLegacyControllerOptions<TTerminal, TEntry>;

export class AiSessionResumeController<
    TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal,
    TEntry extends AiSessionResumeTerminalEntry<TTerminal> = AiSessionResumeTerminalEntry<TTerminal>
> {
    private readonly options: AiSessionResumeControllerOptions<TTerminal, TEntry>;

    constructor(options: AiSessionResumeControllerOptions<TTerminal, TEntry>) {
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

        const workspace = this.options.getWorkspaceTarget?.(projectId) || null;
        const workspaceSession = workspace
            ? (workspace.sessions.sessionsByProvider[providerId] || [])
                .find(candidate => candidate.id === sessionId)
            : null;
        const project = workspace ? null : this.options.getOpenProjects().find(candidate => candidate.id === projectId);
        const projectSession = project ? this.options.getProjectSession(project, providerId, sessionId) : null;
        const target: AiSessionResumeTarget | null = workspace && workspaceSession
            ? { id: workspace.cardId, name: workspace.workspace.displayName, session: workspaceSession, workspace }
            : project && projectSession
                ? { id: project.id, name: project.name, session: projectSession, project }
                : null;
        const sessionProvider = this.options.getProvider(providerId);
        if (!target) {
            this.options.showWarningMessage(`Selected ${sessionProvider?.label || 'AI'} session not found.`);
            return;
        }

        const session = target.session;
        const directoryScope = target.workspace
            ? await this.options.resolveWorkspaceDirectoryScope?.(
                target.workspace, session, providerId, explicitRootId
            )
            : await this.options.resolveDirectoryScope(
                target.project, session, providerId, explicitRootId
            );
        if (!directoryScope || !sessionProvider) {
            return;
        }

        if (isRuntimeOptions(this.options)) {
            await this.resumeRuntime(
                target, providerId, sessionProvider, directoryScope, this.options
            );
            return;
        }

        const existingTerminal = this.options.getExistingTerminal(providerId, session);
        if (existingTerminal && !this.options.isTerminalComplete(existingTerminal)) {
            existingTerminal.terminal.show();
            await this.options.showActiveTab(target.id);
            this.options.refresh();
            return;
        }

        if (!this.options.beginResume(providerId, session.id)) {
            return;
        }
        let cwd = this.options.getUsableTerminalCwd(directoryScope.primaryCwd);

        const terminalName = this.options.getTerminalName(providerId, session);
        let terminal = existingTerminal?.terminal;
        let usedPendingTerminal = false;
        const terminalEnv = { [sessionProvider.terminalEnvKey]: session.id };
        let markerPath = existingTerminal?.markerPath || this.options.getMarkerPath(providerId, session.id);

        try {
            if (!terminal) {
                const sessionCwd = this.options.normalizeProjectPath(this.options.getComparableCwd(providerId, session));
                const pendingTerminal = sessionCwd
                    ? this.options.findPendingTerminalForSession(providerId, session.id, sessionCwd, session.updatedAt)
                    : null;
                if (pendingTerminal) {
                    terminal = pendingTerminal.terminal;
                    markerPath = pendingTerminal.markerPath;
                    usedPendingTerminal = true;
                } else {
                    const createResult = this.options.createTerminal({
                        name: terminalName,
                        cwd,
                        env: terminalEnv,
                        cwdFailureMessage: `Failed to create ${sessionProvider.label} terminal with cwd.`,
                        cwdWarningMessage: `Could not open the ${sessionProvider.label} terminal at the session directory. Resuming without a working directory.`,
                        logError: this.options.logError,
                    });
                    terminal = createResult.terminal;
                    if (!createResult.cwdAccepted) {
                        cwd = null;
                    }
                }
            }

            terminal.show();
            await this.options.sendResumeCommand(providerId, terminal, session.id, directoryScope, markerPath);
            await this.options.rememberDirectoryScope?.(directoryScope);
            if (usedPendingTerminal) {
                this.options.claimPendingTerminal(terminal);
            }
            this.options.track(providerId, session.id, {
                terminal,
                markerPath,
                runStartedAtMs: this.options.nowMs(),
                cwd: this.options.normalizeProjectPath(
                    this.options.getComparableCwd(providerId, session)
                ) || undefined,
            });
            this.options.syncActiveTerminal();
            await this.options.showActiveTab(target.id);
            this.options.refresh();
        } finally {
            this.options.finishResume(providerId, session.id);
        }
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

function isRuntimeOptions<
    TTerminal extends AiSessionResumeTerminal,
    TEntry extends AiSessionResumeTerminalEntry<TTerminal>
>(options: AiSessionResumeControllerOptions<TTerminal, TEntry>):
options is AiSessionResumeRuntimeControllerOptions<TTerminal> {
    return options.runtimeCoordinator !== undefined;
}

function validateControllerOptions<
    TTerminal extends AiSessionResumeTerminal,
    TEntry extends AiSessionResumeTerminalEntry<TTerminal>
>(options: AiSessionResumeControllerOptions<TTerminal, TEntry>): void {
    if (options?.getWorkspaceTarget && typeof options.resolveWorkspaceDirectoryScope !== 'function') {
        throw new Error('AI session workspace resume routing is incomplete.');
    }
    if (options?.runtimeCoordinator === undefined) {
        return;
    }
    if (typeof options.runtimeCoordinator.resume !== 'function'
        || typeof options.resolveDirectoryScope !== 'function'
        || typeof (options as AiSessionResumeRuntimeControllerOptions<TTerminal>).announceStatus !== 'function') {
        throw new Error('AI session resume runtime controller options are invalid.');
    }
}
