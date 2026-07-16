'use strict';

import type { AiSessionProviderId, Project } from '../models';
import type { AttentionProjectSummary } from '../aiSessions/attentionProject';
import type { AiSessionActiveTerminalChangedMessage, AiSessionBatchArchiveCompletedMessage } from '../aiSessions/types';
import type { ActiveAiSessionTerminalIdentity } from '../aiSessions/activeTerminalHighlight';

export interface DashboardRuntimeControllerOptions<TProject extends Project = Project> {
    isVisible: () => boolean;
    refreshProvider: () => void;
    logDashboardDiagnostic: (event: Record<string, unknown>) => void;
    executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown> | Promise<unknown>;
    viewType: string;
    publishOpenProjects: () => void;
    getOpenProjects: () => TProject[];
    syncProjectColorToCurrentWindow: (project: TProject | null) => Thenable<void> | Promise<void>;
    postMessage: (message: unknown) => Thenable<unknown> | Promise<unknown>;
    logError: (message: string, error: unknown) => void;
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
        this.options.publishOpenProjects();
        await this.revealSidebarSteward();
        this.refresh('show-steward');
    }

    refreshAfterMutation(reason = 'project-mutation'): void {
        this.applyProjectColorToCurrentWindow();
        this.refresh(reason);
        this.options.publishOpenProjects();
    }

    revealSidebarSteward(): Promise<void> {
        return this.runAsync(() => this.options.executeCommand('workbench.view.extension.project-steward'))
            .then(() => this.runAsync(() => this.options.executeCommand(`${this.options.viewType}.focus`)))
            .then(undefined, () => this.runAsync(() => this.options.executeCommand(`${this.options.viewType}.focus`)))
            .then(undefined, () => undefined);
    }

    postAttentionProjectsUpdated(projects: AttentionProjectSummary[]): void {
        if (!this.options.isVisible()) {
            return;
        }

        this.runAsync(() => this.options.postMessage({
            type: 'ai-session-attention-projects-updated',
            projects,
        })).then(undefined, error => {
            this.options.logError('Failed to post AI session attention projects.', error);
        });
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
        let targetProject: TProject | null = project || this.options.getOpenProjects()[0] || null;
        if (targetProject?.showSaveAction) {
            targetProject = null;
        }
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
