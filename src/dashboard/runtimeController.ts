'use strict';

import type { AiSessionProviderId, Project } from '../models';
import type { AiSessionActiveTerminalChangedMessage, AiSessionBatchArchiveCompletedMessage } from '../aiSessions/types';
import type { ActiveAiSessionTerminalIdentity } from '../aiSessions/activeTerminalHighlight';

export interface DashboardRuntimeControllerOptions<TProject extends Project = Project> {
    isVisible: () => boolean;
    refreshProvider: () => void;
    logDashboardDiagnostic: (event: Record<string, unknown>) => void;
    executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown> | Promise<unknown>;
    viewType: string;
    publishOpenWorkspace: () => void;
    getCurrentSavedProject: () => TProject | null;
    syncProjectColorToCurrentWindow: (project: TProject | null) => Thenable<void> | Promise<void>;
    postMessage: (message: unknown) => Thenable<unknown> | Promise<unknown>;
    logError: (message: string, error: unknown) => void;
    refreshAiSessionRuntimes?: (reason: string, force: boolean) => Thenable<void> | Promise<void>;
    logAiSessionRuntimeFailure?: (operation: string, error: unknown) => void;
}

export class DashboardRuntimeController<TProject extends Project = Project> {
    constructor(private readonly options: DashboardRuntimeControllerOptions<TProject>) {
    }

    refresh(reason = 'refresh'): void {
        if (!this.options.isVisible()) {
            return;
        }

        this.options.logDashboardDiagnostic({
            event: 'full-refresh',
            reason,
        });
        this.options.refreshProvider();
    }

    async showSteward(): Promise<void> {
        this.options.publishOpenWorkspace();
        await this.revealSidebarSteward();
        this.refresh('show-steward');
    }

    async handleAiSessionViewVisibilityChanged(visible: boolean): Promise<void> {
        if (!visible || !this.options.refreshAiSessionRuntimes) {
            return;
        }
        try {
            await this.runAsync(() => this.options.refreshAiSessionRuntimes('dashboard-visible', true));
        } catch (error) {
            this.options.logAiSessionRuntimeFailure?.('dashboard-visible', error);
            throw error;
        }
    }

    refreshAfterMutation(reason = 'project-mutation'): void {
        this.applyProjectColorToCurrentWindow();
        this.refresh(reason);
        this.options.publishOpenWorkspace();
    }

    revealSidebarSteward(): Promise<void> {
        return this.runAsync(() => this.options.executeCommand('workbench.view.extension.project-steward'))
            .then(() => this.runAsync(() => this.options.executeCommand(`${this.options.viewType}.focus`)))
            .then(undefined, () => this.runAsync(() => this.options.executeCommand(`${this.options.viewType}.focus`)))
            .then(undefined, () => undefined);
    }

    postBatchArchiveCompletion(message: AiSessionBatchArchiveCompletedMessage): void {
        this.runAsync(() => this.options.postMessage(message)).then(undefined, error => {
            this.options.logError('Failed to post batch AI session archive completion.', error);
        });
    }

    postActiveAiSessionTerminalChanged(identity: ActiveAiSessionTerminalIdentity | null): void {
        const message: AiSessionActiveTerminalChangedMessage = {
            type: 'active-ai-session-terminal-changed',
            provider: identity?.provider as AiSessionProviderId || null,
            sessionId: identity?.sessionId || null,
        };
        this.runAsync(() => this.options.postMessage(message)).then(undefined, error => {
            this.options.logError('Failed to post the active AI session terminal.', error);
        });
    }

    applyProjectColorToCurrentWindow(project: TProject = null): void {
        const targetProject: TProject | null = project || this.options.getCurrentSavedProject();
        this.runAsync(() => this.options.syncProjectColorToCurrentWindow(targetProject)).then(undefined, error => {
            this.options.logError('Failed to apply project color to current window.', error);
        });
    }

    async openSettings(query = '@ext:hzcheng.project-steward'): Promise<void> {
        await this.runAsync(() => this.options.executeCommand('workbench.action.openSettings', query));
    }

    private runAsync<T>(operation: () => Thenable<T> | Promise<T> | T): Promise<T> {
        try {
            return Promise.resolve(operation());
        } catch (error) {
            return Promise.reject(error);
        }
    }
}
