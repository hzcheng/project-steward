'use strict';

import type * as vscode from 'vscode';

import type { AiSessionProviderId, Project } from '../models';
import { sanitizeAiSessionAlias } from './aliasStore';
import type { AiSessionLaunchSpec } from './launchSpec';
import { isValidAiSessionRuntimeIdentityId } from './runtimeTypes';
import type {
    AiSessionCreateRuntimeRequest,
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeActionResult,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';

export interface NewAiSessionFields {
    title: string;
}

export interface AiSessionCreationProvider {
    label: string;
    terminalNamePrefix: string;
    buildNewSessionLaunchSpec?: (cwd: string, title: string, markerPath: string) => AiSessionLaunchSpec;
}

export interface CreatedAiSessionTerminal {
    terminal: vscode.Terminal;
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

export interface AiSessionCreationRuntimeCoordinator {
    create(request: AiSessionCreateRuntimeRequest): Promise<AiSessionRuntimeActionResult<vscode.Terminal>>;
    getActive(): AiSessionRuntimeSnapshot<vscode.Terminal>[];
    getPending(): AiSessionPendingRuntimeSnapshot<vscode.Terminal>[];
}

export interface AiSessionCreationControllerCommonOptions {
    isProviderId: (value: string) => value is AiSessionProviderId;
    getOpenProjects: () => Project[];
    pickProvider: () => Thenable<AiSessionProviderId | undefined>;
    getProviderLabel: (providerId: AiSessionProviderId) => string;
    getProvider: (providerId: AiSessionProviderId) => AiSessionCreationProvider;
    getTerminalCwd: (project: Project) => string;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showActiveTab: (projectId: string) => Thenable<unknown> | Promise<unknown>;
    showWarningMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
    refresh: () => void;
    getExistingSessionIdsForCwd: (providerId: AiSessionProviderId, cwd: string) => string[];
    getPendingMarkerPath: (providerId: AiSessionProviderId) => string;
    scheduleNewSessionRefresh: (providerId: AiSessionProviderId) => void;
    nowMs: () => number;
}

export interface AiSessionCreationRuntimeControllerOptions extends AiSessionCreationControllerCommonOptions {
    runtimeCoordinator: AiSessionCreationRuntimeCoordinator;
    getProjectKey: (project: Project) => string;
    createPendingId: () => string;
    announceStatus: (projectId: string, message: string) => Thenable<unknown> | Promise<unknown>;
}

export interface AiSessionCreationLegacyControllerOptions extends AiSessionCreationControllerCommonOptions {
    runtimeCoordinator?: undefined;
    getUsableTerminalCwd: (cwd: string) => string | null;
    createTerminal: (options: {
        name: string;
        cwd: string | null;
        cwdFailureMessage: string;
        cwdWarningMessage: string;
    }) => CreatedAiSessionTerminal;
    trackPendingTerminal: (pending: PendingAiSessionTerminal) => void;
    sendNewSessionCommand: (
        providerId: AiSessionProviderId,
        terminal: vscode.Terminal,
        cwd: string | null,
        title: string,
        markerPath: string
    ) => Thenable<unknown>;
}

export type AiSessionCreationControllerOptions = AiSessionCreationRuntimeControllerOptions
    | AiSessionCreationLegacyControllerOptions;

export class AiSessionCreationController {
    private creating = false;
    private readonly options: AiSessionCreationControllerOptions;

    constructor(options: AiSessionCreationControllerOptions) {
        validateControllerOptions(options);
        this.options = options;
    }

    async createSession(projectId: string): Promise<void> {
        if (this.creating) {
            return;
        }
        const project = this.options.getOpenProjects().find(p => p.id === projectId);
        if (!project) {
            await this.options.showWarningMessage('Open project not found.');
            return;
        }
        this.creating = true;
        try {
            const providerId = await this.options.pickProvider();
            if (!providerId || !this.options.isProviderId(providerId)) {
                return;
            }
            const fields = await this.queryNewSessionFields(providerId);
            if (!fields) {
                return;
            }
            await this.createProviderSession(providerId, project, fields);
        } finally {
            this.creating = false;
        }
    }

    private async queryNewSessionFields(providerId: AiSessionProviderId): Promise<NewAiSessionFields | null> {
        const providerLabel = this.options.getProviderLabel(providerId);
        const title = await this.options.showInputBox({
            prompt: `New ${providerLabel} chat title (optional)`,
            placeHolder: 'Leave empty to use the session ID',
            ignoreFocusOut: true,
        });
        if (title === undefined) {
            return null;
        }

        return {
            title: sanitizeAiSessionAlias(title),
        };
    }

    private async createProviderSession(
        providerId: AiSessionProviderId,
        project: Project,
        fields: NewAiSessionFields
    ): Promise<void> {
        if (isRuntimeOptions(this.options)) {
            await this.createRuntimeSession(providerId, project, fields, this.options);
            return;
        }

        const sessionProvider = this.options.getProvider(providerId);
        const cwd = this.options.getUsableTerminalCwd(this.options.getTerminalCwd(project));
        const pendingTerminalCwd = cwd || this.options.getTerminalCwd(project);
        const terminalName = `${sessionProvider.terminalNamePrefix}: ${project.name || 'New Session'}`;
        const terminal = this.options.createTerminal({
            name: terminalName,
            cwd,
            cwdFailureMessage: `Failed to create ${sessionProvider.label} terminal with cwd.`,
            cwdWarningMessage: `Could not open the ${sessionProvider.label} terminal at the project directory. Starting without a working directory.`,
        }).terminal;
        const existingSessionIds = this.options.getExistingSessionIdsForCwd(providerId, pendingTerminalCwd);
        const createdAt = new Date(this.options.nowMs()).toISOString();
        const markerPath = this.options.getPendingMarkerPath(providerId);
        this.options.trackPendingTerminal({
            provider: providerId,
            terminal,
            markerPath,
            cwd: pendingTerminalCwd,
            createdAt,
            excludedSessionIds: existingSessionIds,
            title: fields.title,
        });

        await this.options.showActiveTab(project.id);
        this.options.refresh();
        terminal.show();
        await this.options.sendNewSessionCommand(providerId, terminal, cwd, fields.title, markerPath);
        this.options.scheduleNewSessionRefresh(providerId);
    }

    private async createRuntimeSession(
        providerId: AiSessionProviderId,
        project: Project,
        fields: NewAiSessionFields,
        options: AiSessionCreationRuntimeControllerOptions
    ): Promise<void> {
        const coordinator = options.runtimeCoordinator;
        const sessionProvider = options.getProvider(providerId);
        if (!sessionProvider.buildNewSessionLaunchSpec) {
            throw new Error('AI session runtime creation is not configured.');
        }
        const cwd = options.getTerminalCwd(project);
        const projectKey = options.getProjectKey(project);
        const pendingId = options.createPendingId();
        if (!isValidAiSessionRuntimeIdentityId(pendingId)) {
            throw new Error('AI session pending identity is invalid.');
        }
        const pendingIdInUse = [
            ...coordinator.getPending(),
            ...coordinator.getActive(),
        ].some(runtime => runtime?.identity.pendingId === pendingId);
        if (pendingIdInUse) {
            throw new Error('AI session pending identity is already in use.');
        }
        const existingSessionIds = options.getExistingSessionIdsForCwd(providerId, cwd).slice();
        const createdAt = new Date(options.nowMs()).toISOString();
        const markerPath = options.getPendingMarkerPath(providerId);
        const terminalName = `${sessionProvider.terminalNamePrefix}: ${project.name || 'New Session'}`;
        const launch = cloneLaunchSpec(
            sessionProvider.buildNewSessionLaunchSpec(cwd, fields.title, markerPath)
        );
        const request: AiSessionCreateRuntimeRequest = {
            identity: { provider: providerId, projectKey, cwd, pendingId },
            projectName: project.name || 'New Session',
            terminalName,
            createdAt,
            excludedSessionIds: existingSessionIds,
            title: fields.title,
            launch,
        };
        const result = await coordinator.create(request);
        if (result.status === 'cancelled' || result.status === 'settings') {
            return;
        }
        if (result.status === 'conflict') {
            options.refresh();
            await options.announceStatus(project.id, 'Multiple live runtimes match this AI session.');
            return;
        }
        await options.showActiveTab(project.id);
        options.refresh();
        options.scheduleNewSessionRefresh(providerId);
    }
}

function cloneLaunchSpec(launch: AiSessionLaunchSpec): AiSessionLaunchSpec {
    return {
        ...launch,
        args: [...launch.args],
    };
}

function isRuntimeOptions(
    options: AiSessionCreationControllerOptions
): options is AiSessionCreationRuntimeControllerOptions {
    return options.runtimeCoordinator !== undefined;
}

function validateControllerOptions(options: AiSessionCreationControllerOptions): void {
    if (options?.runtimeCoordinator === undefined) {
        return;
    }
    const runtimeOptions = options as AiSessionCreationRuntimeControllerOptions;
    const coordinator = runtimeOptions.runtimeCoordinator;
    if (typeof coordinator.create !== 'function'
        || typeof coordinator.getActive !== 'function'
        || typeof coordinator.getPending !== 'function'
        || typeof runtimeOptions.getProjectKey !== 'function'
        || typeof runtimeOptions.createPendingId !== 'function'
        || typeof runtimeOptions.announceStatus !== 'function') {
        throw new Error('AI session creation runtime controller options are invalid.');
    }
}
