'use strict';

import type * as vscode from 'vscode';

import type { AiSessionProviderId } from '../models';
import { sanitizeAiSessionAlias } from './aliasStore';
import type { AiSessionLaunchSpec } from './launchSpec';
import { isValidAiSessionRuntimeIdentityId } from './runtimeTypes';
import type {
    AiSessionCreateRuntimeRequest,
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeActionResult,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import type { AiSessionDirectoryScope, WorkspaceAiSessionActionTarget } from './types';

interface AiSessionCreationTarget {
    id: string;
    name: string;
    workspace: WorkspaceAiSessionActionTarget;
}

export interface NewAiSessionFields {
    title: string;
}

export interface AiSessionCreationProvider {
    label: string;
    terminalNamePrefix: string;
    buildNewSessionLaunchSpec?: (
        scope: AiSessionDirectoryScope,
        title: string,
        markerPath: string
    ) => AiSessionLaunchSpec;
}

export interface AiSessionCreationRuntimeCoordinator {
    create(request: AiSessionCreateRuntimeRequest): Promise<AiSessionRuntimeActionResult<vscode.Terminal>>;
    getActive(): AiSessionRuntimeSnapshot<vscode.Terminal>[];
    getPending(): AiSessionPendingRuntimeSnapshot<vscode.Terminal>[];
}

export interface AiSessionCreationControllerCommonOptions {
    isProviderId: (value: string) => value is AiSessionProviderId;
    getWorkspaceTarget: (cardId: string) => WorkspaceAiSessionActionTarget | null;
    pickWorkspaceRoot: (
        workspace: WorkspaceAiSessionActionTarget['workspace']
    ) => Thenable<string | undefined> | Promise<string | undefined>;
    pickProvider: () => Thenable<AiSessionProviderId | undefined>;
    getProviderLabel: (providerId: AiSessionProviderId) => string;
    getProvider: (providerId: AiSessionProviderId) => AiSessionCreationProvider;
    resolveWorkspaceDirectoryScope: (
        target: WorkspaceAiSessionActionTarget,
        providerId: AiSessionProviderId,
        explicitRootId?: string
    ) => AiSessionDirectoryScope | null | Thenable<AiSessionDirectoryScope | null> | Promise<AiSessionDirectoryScope | null>;
    rememberDirectoryScope?: (
        directoryScope: AiSessionDirectoryScope
    ) => Thenable<void> | Promise<void>;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showActiveTab: (projectId: string) => Thenable<unknown> | Promise<unknown>;
    showWarningMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
    refresh: () => void;
    getExistingSessionIdsForCwd: (providerId: AiSessionProviderId, cwd: string) => string[];
    getPendingMarkerPath: (providerId: AiSessionProviderId) => string;
    scheduleNewSessionRefresh: (providerId: AiSessionProviderId) => void;
    nowMs: () => number;
    showErrorMessage?: (message: string) => Thenable<unknown> | Promise<unknown>;
    logRuntimeFailure?: (
        operation: string,
        error: unknown,
        backend: 'vscode' | 'tmux'
    ) => void;
}

export interface AiSessionCreationRuntimeControllerOptions extends AiSessionCreationControllerCommonOptions {
    runtimeCoordinator: AiSessionCreationRuntimeCoordinator;
    createPendingId: () => string;
    announceStatus: (projectId: string, message: string) => Thenable<unknown> | Promise<unknown>;
}

export type AiSessionCreationControllerOptions = AiSessionCreationRuntimeControllerOptions;

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
        const workspace = this.options.getWorkspaceTarget(projectId);
        const target: AiSessionCreationTarget | null = workspace
            ? { id: workspace.cardId, name: workspace.workspace.displayName, workspace }
            : null;
        if (!target) {
            await this.options.showWarningMessage('Open workspace not found.');
            return;
        }
        this.creating = true;
        try {
            let explicitRootId: string | undefined;
            if (target.workspace.workspace.roots.length > 1) {
                explicitRootId = await this.options.pickWorkspaceRoot(target.workspace.workspace);
                if (!explicitRootId) {
                    return;
                }
            }
            const providerId = await this.options.pickProvider();
            if (!providerId || !this.options.isProviderId(providerId)) {
                return;
            }
            const fields = await this.queryNewSessionFields(providerId);
            if (!fields) {
                return;
            }
            await this.createProviderSession(providerId, target, fields, explicitRootId);
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
        target: AiSessionCreationTarget,
        fields: NewAiSessionFields,
        explicitRootId?: string
    ): Promise<void> {
        const directoryScope = await this.options.resolveWorkspaceDirectoryScope(
            target.workspace, providerId, explicitRootId
        );
        if (!directoryScope) {
            return;
        }
        await this.createRuntimeSession(providerId, target, fields, directoryScope, this.options);
    }

    private async createRuntimeSession(
        providerId: AiSessionProviderId,
        target: AiSessionCreationTarget,
        fields: NewAiSessionFields,
        directoryScope: AiSessionDirectoryScope,
        options: AiSessionCreationRuntimeControllerOptions
    ): Promise<void> {
        const coordinator = options.runtimeCoordinator;
        const sessionProvider = options.getProvider(providerId);
        if (!sessionProvider.buildNewSessionLaunchSpec) {
            throw new Error('AI session runtime creation is not configured.');
        }
        const cwd = directoryScope.primaryCwd;
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
        const terminalName = `${sessionProvider.terminalNamePrefix}: ${target.name || 'New Session'}`;
        const launch = cloneLaunchSpec(
            sessionProvider.buildNewSessionLaunchSpec(directoryScope, fields.title, markerPath)
        );
        const request: AiSessionCreateRuntimeRequest = {
            identity: {
                provider: providerId,
                workspaceScopeIdentity: directoryScope.workspaceScopeIdentity,
                workspaceNavigationIdentity: directoryScope.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...directoryScope.workspaceRootHostPaths],
                cwd,
                pendingId,
            },
            projectName: target.name || 'New Session',
            terminalName,
            createdAt,
            excludedSessionIds: existingSessionIds,
            title: fields.title,
            launch,
            directoryScope,
        };
        let result: AiSessionRuntimeActionResult<vscode.Terminal>;
        try {
            result = await coordinator.create(request);
        } catch (error) {
            options.logRuntimeFailure?.('create-runtime', error, 'tmux');
            if (options.showErrorMessage) {
                await options.showErrorMessage('Could not start the AI session runtime.');
            } else {
                await options.showWarningMessage('Could not start the AI session runtime.');
            }
            options.refresh();
            return;
        }
        if (result.status === 'cancelled' || result.status === 'settings') {
            return;
        }
        if (result.status === 'conflict') {
            options.refresh();
            await options.announceStatus(target.id, 'Multiple live runtimes match this AI session.');
            return;
        }
        if (result.status === 'blocked') {
            options.refresh();
            await options.announceStatus(
                target.id,
                'Runtime creation is still awaiting lifecycle acknowledgement.'
            );
            return;
        }
        if (result.status === 'started') {
            await options.rememberDirectoryScope?.(directoryScope);
        }
        await options.showActiveTab(target.id);
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

function validateControllerOptions(options: AiSessionCreationControllerOptions): void {
    const coordinator = options?.runtimeCoordinator;
    if (typeof coordinator.create !== 'function'
        || typeof coordinator.getActive !== 'function'
        || typeof coordinator.getPending !== 'function'
        || typeof options.getWorkspaceTarget !== 'function'
        || typeof options.pickWorkspaceRoot !== 'function'
        || typeof options.resolveWorkspaceDirectoryScope !== 'function'
        || typeof options.createPendingId !== 'function'
        || typeof options.announceStatus !== 'function') {
        throw new Error('AI session creation runtime controller options are invalid.');
    }
}
