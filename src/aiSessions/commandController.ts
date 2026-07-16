'use strict';

import type * as vscode from 'vscode';

import type { AiSessionProviderId, Project } from '../models';
import { sanitizeAiSessionAlias } from './aliasStore';

export interface AiSessionCommandControllerOptions {
    getOpenProjects: () => Project[];
    getProjectKey: (project: Project) => string;
    isProviderId: (value: string) => value is AiSessionProviderId;
    setExpanded: (projectKey: string, expanded: boolean) => Thenable<unknown>;
    setActiveProvider: (projectKey: string, providerId: AiSessionProviderId) => Thenable<unknown>;
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

    async toggleSessionsExpanded(projectId: string, expanded: boolean): Promise<void> {
        const project = this.options.getOpenProjects().find(p => p.id === projectId);
        if (!project) {
            return;
        }

        await this.options.setExpanded(this.options.getProjectKey(project), expanded);
    }

    async selectProvider(projectId: string, providerId: string): Promise<void> {
        if (!this.options.isProviderId(providerId)) {
            return;
        }

        const project = this.options.getOpenProjects().find(p => p.id === projectId);
        if (!project) {
            return;
        }

        await this.options.setActiveProvider(this.options.getProjectKey(project), providerId);
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
