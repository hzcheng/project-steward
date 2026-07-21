'use strict';

import type * as vscode from 'vscode';

import type { AiSessionProviderId, CodexSession } from '../models';
import type {
    ProviderDirectoryCapabilityProvider,
    ProviderDirectoryCapabilityResult,
} from './providerDirectoryCapability';
import { assignPathToWorkspaceRoot } from '../workspaces/sessionAssignment';
import {
    buildAiSessionDirectoryScope,
    WorkspaceDirectoryScopeError,
} from '../workspaces/sessionScope';
import type { ActiveEditorUri } from '../workspaces/sessionScope';
import type { OpenWorkspace } from '../workspaces/types';
import { sanitizeAiSessionAlias } from './aliasStore';
import type { AiSessionDirectoryScope, WorkspaceAiSessionActionTarget } from './types';

export type AiSessionWorkspaceLaunchAction = 'create' | 'resume';

export type AiSessionWorkspaceLaunchBlockReason =
    | 'workspace-missing'
    | 'restricted-mode'
    | 'provider-missing'
    | 'provider-unavailable'
    | 'capability-unsupported'
    | 'root-unavailable';

export type AiSessionWorkspaceLaunchPreflightResult =
    | { status: 'ready'; directoryScope: AiSessionDirectoryScope }
    | { status: 'blocked'; reason: AiSessionWorkspaceLaunchBlockReason; message: string }
    | { status: 'cancelled' };

export interface AiSessionWorkspaceLaunchPreflightOptions {
    workspace: OpenWorkspace | null;
    provider: ProviderDirectoryCapabilityProvider & { label: string } | null;
    action: AiSessionWorkspaceLaunchAction;
    isWorkspaceTrusted: boolean;
    getProviderDirectoryCapability: (
        provider: ProviderDirectoryCapabilityProvider
    ) => Promise<ProviderDirectoryCapabilityResult>;
    isDirectory: (hostPath: string) => boolean;
    pickWorkspaceRoot: (
        workspace: OpenWorkspace,
        action: AiSessionWorkspaceLaunchAction
    ) => string | undefined | Thenable<string | undefined> | Promise<string | undefined>;
    activeEditorUri?: ActiveEditorUri | string | null;
    explicitRootId?: string;
    historicalCwd?: string;
    lastUsedRootId?: string;
}

function blocked(
    reason: AiSessionWorkspaceLaunchBlockReason,
    message: string
): AiSessionWorkspaceLaunchPreflightResult {
    return { status: 'blocked', reason, message };
}

export async function preflightAiSessionDirectoryScope(
    options: AiSessionWorkspaceLaunchPreflightOptions
): Promise<AiSessionWorkspaceLaunchPreflightResult> {
    const workspace = options.workspace;
    if (!workspace || !workspace.roots?.length) {
        return blocked('workspace-missing', 'Open a workspace folder before starting an AI session.');
    }
    if (!options.isWorkspaceTrusted) {
        return blocked(
            'restricted-mode',
            'AI session launch is unavailable in Restricted Mode. Trust this workspace to continue.'
        );
    }
    if (!options.provider) {
        return blocked('provider-missing', 'The selected AI provider is no longer available.');
    }

    const capability = await options.getProviderDirectoryCapability(options.provider);
    if (capability.status === 'unavailable') {
        return blocked(
            'provider-unavailable',
            `${options.provider.label} is unavailable. Install it or add it to the Extension Host PATH.`
        );
    }
    if (workspace.roots.length > 1 && capability.status !== 'supported') {
        return blocked(
            'capability-unsupported',
            `${options.provider.label} cannot launch in this multi-root workspace. Upgrade it to a version with --add-dir support.`
        );
    }

    let explicitRootId = options.explicitRootId;
    if (options.action === 'resume') {
        const historicalRoot = assignPathToWorkspaceRoot(options.historicalCwd || '', workspace.roots);
        explicitRootId = historicalRoot?.id || explicitRootId;
        if (!explicitRootId) {
            explicitRootId = await options.pickWorkspaceRoot(workspace, 'resume');
            if (!explicitRootId) {
                return { status: 'cancelled' };
            }
        }
    }
    if (explicitRootId && !workspace.roots.some(root => root.id === explicitRootId)) {
        return blocked('root-unavailable', 'The selected workspace root is no longer available.');
    }

    try {
        const directoryScope = buildAiSessionDirectoryScope(workspace, {
            explicitRootId,
            activeEditorUri: options.action === 'create' ? options.activeEditorUri : null,
            lastUsedRootId: options.action === 'create' ? options.lastUsedRootId : null,
            isDirectory: options.isDirectory,
        });
        return { status: 'ready', directoryScope };
    } catch (error) {
        if (!(error instanceof WorkspaceDirectoryScopeError)) {
            throw error;
        }
        const rootNames = error.invalidRoots.map(root => root.name).join(', ');
        return blocked(
            'root-unavailable',
            rootNames
                ? `The following workspace roots are unavailable: ${rootNames}.`
                : 'No available workspace root can be used for this AI session.'
        );
    }
}

export interface AiSessionCommandControllerOptions {
    getWorkspaceTarget: (cardId: string) => WorkspaceAiSessionActionTarget | null;
    getOpenWorkspace?: () => OpenWorkspace | null;
    getActiveEditorUri?: () => ActiveEditorUri | string | null;
    isWorkspaceTrusted?: () => boolean;
    getProvider?: (
        providerId: AiSessionProviderId
    ) => ProviderDirectoryCapabilityProvider & { label: string } | null;
    getProviderDirectoryCapability?: (
        provider: ProviderDirectoryCapabilityProvider
    ) => Promise<ProviderDirectoryCapabilityResult>;
    getPrimaryRootId?: (workspace: OpenWorkspace) => string | null;
    setPrimaryRootId?: (workspaceScopeIdentity: string, rootId: string) => Thenable<void> | Promise<void>;
    pickWorkspaceRoot?: (
        workspace: OpenWorkspace,
        action: AiSessionWorkspaceLaunchAction
    ) => string | undefined | Thenable<string | undefined> | Promise<string | undefined>;
    isDirectory?: (hostPath: string) => boolean;
    showWarningMessage?: (message: string) => unknown;
    isProviderId: (value: string) => value is AiSessionProviderId;
    setExpanded: (workspaceScopeIdentity: string, expanded: boolean) => Thenable<unknown>;
    setActiveProvider: (workspaceScopeIdentity: string, providerId: AiSessionProviderId) => Thenable<unknown>;
    togglePin: (providerId: AiSessionProviderId, sessionId: string) => boolean;
    getAliases: () => Record<string, string>;
    saveAliases: (aliases: Record<string, string>) => unknown;
    getOriginalName: (providerId: AiSessionProviderId, sessionId: string) => string | null;
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    writeClipboard: (value: string) => Thenable<void>;
    showInformationMessage: (message: string) => unknown;
    refresh: () => void;
}

export class AiSessionCommandController {
    constructor(private readonly options: AiSessionCommandControllerOptions) {
    }

    async resolveWorkspaceDirectoryScope(
        workspace: OpenWorkspace,
        providerId: AiSessionProviderId,
        session?: CodexSession,
        explicitRootId?: string
    ): Promise<AiSessionDirectoryScope | null> {
        const result = await preflightAiSessionDirectoryScope({
            workspace,
            provider: this.options.getProvider?.(providerId) || null,
            action: session ? 'resume' : 'create',
            isWorkspaceTrusted: this.options.isWorkspaceTrusted?.() === true,
            getProviderDirectoryCapability: this.options.getProviderDirectoryCapability,
            isDirectory: this.options.isDirectory,
            pickWorkspaceRoot: this.options.pickWorkspaceRoot,
            activeEditorUri: this.options.getActiveEditorUri?.(),
            explicitRootId,
            historicalCwd: session?.cwd || session?.workDir,
            lastUsedRootId: this.options.getPrimaryRootId?.(workspace),
        });
        if (result.status === 'blocked') {
            this.options.showWarningMessage?.(result.message);
            return null;
        }
        return result.status === 'ready' ? result.directoryScope : null;
    }

    rememberDirectoryScope(directoryScope: AiSessionDirectoryScope): Thenable<void> | Promise<void> {
        if (!this.options.setPrimaryRootId) {
            return Promise.resolve();
        }
        return this.options.setPrimaryRootId(
            directoryScope.workspaceScopeIdentity,
            directoryScope.primaryRootId
        );
    }

    async toggleSessionsExpanded(projectId: string, expanded: boolean): Promise<void> {
        const workspaceTarget = this.options.getWorkspaceTarget(projectId);
        if (!workspaceTarget) {
            return;
        }
        await this.options.setExpanded(workspaceTarget.workspace.scopeIdentity, expanded);
    }

    async selectProvider(projectId: string, providerId: string): Promise<void> {
        if (!this.options.isProviderId(providerId)) {
            return;
        }

        const workspaceTarget = this.options.getWorkspaceTarget(projectId);
        if (!workspaceTarget) {
            return;
        }
        await this.options.setActiveProvider(workspaceTarget.workspace.scopeIdentity, providerId);
        this.options.refresh();
    }

    async togglePin(providerId: string, sessionId: string): Promise<void> {
        if (!this.options.isProviderId(providerId) || !sessionId) {
            return;
        }

        if (!this.options.togglePin(providerId, sessionId)) {
            return;
        }

        this.options.refresh();
    }

    async renameSession(providerId: string, sessionId: string): Promise<void> {
        if (!this.options.isProviderId(providerId) || !sessionId) {
            return;
        }

        const aliases = this.options.getAliases();
        const sessionKey = this.options.getSessionKey(providerId, sessionId);
        const originalName = this.options.getOriginalName(providerId, sessionId);
        const currentAlias = aliases[sessionKey] || '';
        const value = await this.options.showInputBox({
            prompt: 'Set a local display name for this chat. Leave empty to reset.',
            placeHolder: originalName || sessionId,
            value: currentAlias || originalName || '',
            ignoreFocusOut: true,
        });

        if (value === undefined) {
            return;
        }

        const alias = sanitizeAiSessionAlias(value);
        if (!alias || alias === originalName) {
            delete aliases[sessionKey];
        } else {
            aliases[sessionKey] = alias;
        }

        this.options.saveAliases(aliases);
        this.options.refresh();
    }

    async copySessionId(sessionId: string): Promise<void> {
        if (!sessionId) {
            return;
        }

        await this.options.writeClipboard(sessionId);
        this.options.showInformationMessage('Chat ID copied to clipboard.');
    }
}
