'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';

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
    getProjectCwd(project: Project): string;
    normalizePath(value: string): string;
    confirmClose(providerLabel: string): Thenable<string | undefined> | Promise<string | undefined>;
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
        const target = this.getScopedActiveTerminal(projectId, providerId, sessionId);
        target?.show();
    }

    async focusPending(projectId: string, providerId: string, createdAt: string): Promise<void> {
        if (!createdAt || !this.options.isProviderId(providerId)) {
            return;
        }
        const target = this.getScopedPendingTerminal(projectId, providerId, createdAt);
        target?.show();
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
