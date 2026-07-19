'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
import {
    archiveBatchAiSessionItem,
    executeBatchAiSessionArchiveRequest,
    formatBatchAiSessionArchiveSummary,
    formatBatchAiSessionIdForLog,
    hasBatchAiSessionArchiveIssues,
    BatchAiSessionArchiveAttemptStatus,
    BatchAiSessionArchiveCompletion,
    BatchAiSessionArchiveResult,
    BatchAiSessionArchiveSelection,
} from './archiveBatch';

export interface AiSessionArchiveRuntimeEntry {
    state: 'pending' | 'active' | 'completed' | 'stopped' | 'conflict';
    markerPath: string;
}

export interface AiSessionArchiveProvider {
    label: string;
    service: {
        archiveSession(sessionId: string): boolean;
    };
}

export interface AiSessionArchiveControllerOptions<TRuntime extends AiSessionArchiveRuntimeEntry = AiSessionArchiveRuntimeEntry> {
    isProviderId: (value: string) => value is AiSessionProviderId;
    getProvider: (providerId: AiSessionProviderId) => AiSessionArchiveProvider;
    getProviderLabel: (providerId: AiSessionProviderId) => string;
    getOpenProjects: () => Project[];
    getProjectSessions: (project: Project, providerId: AiSessionProviderId) => CodexSession[];
    getRuntimeById: (providerId: AiSessionProviderId, sessionId: string) => TRuntime | null;
    isRuntimeComplete: (runtime: TRuntime) => boolean;
    focusRuntime: (runtime: TRuntime) => unknown;
    deleteRuntimeMarker: (runtime: TRuntime) => void;
    untrackRuntime: (providerId: AiSessionProviderId, sessionId: string) => void;
    deletePin: (providerId: AiSessionProviderId, sessionId: string) => void;
    deleteAlias: (providerId: AiSessionProviderId, sessionId: string) => void;
    confirmSingleArchive: (providerLabel: string) => Thenable<string | undefined>;
    confirmBatchArchive: (message: string) => Thenable<string | undefined>;
    showWarningMessage: (message: string) => unknown;
    showErrorMessage: (message: string) => unknown;
    showInformationMessage: (message: string) => unknown;
    appendLine: (message: string) => void;
    postCompletion: (completion: BatchAiSessionArchiveCompletion) => void;
    refresh: () => void;
    syncActiveRuntime: () => void;
    logUnexpectedError: (operation: string, error: unknown, failedSessionId?: string) => void;
}

export class AiSessionArchiveController<TRuntime extends AiSessionArchiveRuntimeEntry = AiSessionArchiveRuntimeEntry> {
    constructor(private readonly options: AiSessionArchiveControllerOptions<TRuntime>) {
    }

    async archiveSession(providerId: AiSessionProviderId | null, sessionId: string): Promise<void> {
        if (!providerId || !sessionId) {
            return;
        }

        const sessionProvider = this.options.getProvider(providerId);
        let runtime = this.options.getRuntimeById(providerId, sessionId);
        if (runtime && runtime.state !== 'stopped' && !this.options.isRuntimeComplete(runtime)) {
            this.options.showWarningMessage(`This ${sessionProvider.label} session has an active runtime. Exit the AI provider before archiving it.`);
            try {
                await this.options.focusRuntime(runtime);
            } catch (error) {
                this.options.logUnexpectedError('focus-runtime', error, sessionId);
                this.options.showErrorMessage('Could not focus the AI session terminal.');
                this.options.refresh();
            }
            return;
        }

        const accepted = await this.options.confirmSingleArchive(sessionProvider.label);
        if (!accepted) {
            return;
        }

        const status = this.archiveSessionItem(providerId, sessionId);
        if (status === 'running') {
            runtime = this.options.getRuntimeById(providerId, sessionId);
            this.options.showWarningMessage(`This ${sessionProvider.label} session has an active runtime. Exit the AI provider before archiving it.`);
            if (runtime) {
                try {
                    await this.options.focusRuntime(runtime);
                } catch (error) {
                    this.options.logUnexpectedError('focus-runtime', error, sessionId);
                    this.options.showErrorMessage('Could not focus the AI session terminal.');
                    this.options.refresh();
                }
            }
            return;
        }

        if (status === 'failed') {
            this.options.showErrorMessage(`Could not archive ${sessionProvider.label} session.`);
            return;
        }

        this.options.syncActiveRuntime();
        this.options.refresh();
    }

    archiveSessionItem(
        providerId: AiSessionProviderId,
        sessionId: string
    ): BatchAiSessionArchiveAttemptStatus {
        const sessionProvider = this.options.getProvider(providerId);
        const runtime = this.options.getRuntimeById(providerId, sessionId);
        return archiveBatchAiSessionItem(sessionId, {
            isRunning: () => Boolean(runtime && runtime.state !== 'stopped'
                && !this.options.isRuntimeComplete(runtime)),
            archiveSession: () => sessionProvider.service.archiveSession(sessionId),
            deleteEntryMarker: () => {
                if (runtime) {
                    this.options.deleteRuntimeMarker(runtime);
                }
            },
            untrackTerminal: () => this.options.untrackRuntime(providerId, sessionId),
            deletePin: () => this.options.deletePin(providerId, sessionId),
            deleteAlias: () => this.options.deleteAlias(providerId, sessionId),
        });
    }

    async archiveSessions(projectId: string, providerId: string, sessionIds: unknown): Promise<void> {
        const validProviderId = this.options.isProviderId(providerId) ? providerId : null;
        await executeBatchAiSessionArchiveRequest({ projectId, provider: providerId, sessionIds }, {
            resolveProject: requestedProjectId => validProviderId
                ? this.options.getOpenProjects().find(candidate => candidate.id === requestedProjectId)
                : null,
            getProjectSessions: project => validProviderId ? this.options.getProjectSessions(project as Project, validProviderId) : [],
            resolveCurrentSessions: () => {
                const currentProject = this.options.getOpenProjects().find(candidate => candidate.id === projectId);
                return currentProject && validProviderId && currentProject.activeAiSessionProvider === validProviderId
                    ? this.options.getProjectSessions(currentProject, validProviderId)
                    : [];
            },
            archiveSession: sessionId => validProviderId ? this.archiveSessionItem(validProviderId, sessionId) : 'failed',
            confirm: async confirmation => {
                const providerLabel = validProviderId ? this.options.getProviderLabel(validProviderId) : providerId;
                const pinnedText = confirmation.pinnedCount
                    ? ` ${confirmation.pinnedCount} selected ${confirmation.pinnedCount === 1 ? 'session is' : 'sessions are'} pinned.`
                    : '';
                const accepted = await this.options.confirmBatchArchive(
                    `Archive ${confirmation.eligibleCount} selected ${providerLabel} ${confirmation.eligibleCount === 1 ? 'session' : 'sessions'}?${pinnedText}`
                );
                return Boolean(accepted);
            },
            reportScopeRejected: () => {
                this.options.showWarningMessage('The selected AI sessions are no longer in the active project and provider.');
            },
            reportSelectionRejected: selection => {
                if (validProviderId) {
                    this.logRejectedBatchAiSessionSelections(validProviderId, selection);
                }
                this.options.showWarningMessage('No eligible AI sessions were selected.');
            },
            reportResult: result => {
                if (validProviderId) {
                    this.logBatchAiSessionArchiveResult(validProviderId, result);
                }
                const summary = formatBatchAiSessionArchiveSummary(result);
                if (hasBatchAiSessionArchiveIssues(result)) {
                    this.options.showWarningMessage(summary);
                } else {
                    this.options.showInformationMessage(summary);
                }
            },
            logUnexpectedError: (operation, error, failedSessionId) => {
                this.options.logUnexpectedError(operation, error, failedSessionId);
            },
            postCompletion: completion => this.options.postCompletion(completion),
            refresh: () => this.options.refresh(),
        });
        this.options.syncActiveRuntime();
    }

    private logRejectedBatchAiSessionSelections(
        providerId: AiSessionProviderId,
        selection: Pick<BatchAiSessionArchiveSelection, 'rejectedIds' | 'rejectedIdCount' | 'malformedCount'>
    ): void {
        const label = this.options.getProviderLabel(providerId);
        for (const sessionId of selection.rejectedIds) {
            this.options.appendLine(`[Batch Archive] ${label} rejected out-of-scope session: ${formatBatchAiSessionIdForLog(sessionId)}`);
        }
        if (selection.rejectedIdCount > selection.rejectedIds.length) {
            this.options.appendLine(`[Batch Archive] ${label} omitted ${selection.rejectedIdCount - selection.rejectedIds.length} additional out-of-scope session(s).`);
        }
        if (selection.malformedCount) {
            this.options.appendLine(`[Batch Archive] ${label} rejected ${selection.malformedCount} malformed selection(s).`);
        }
    }

    private logBatchAiSessionArchiveResult(
        providerId: AiSessionProviderId,
        result: BatchAiSessionArchiveResult
    ): void {
        const label = this.options.getProviderLabel(providerId);
        this.logRejectedBatchAiSessionSelections(providerId, result);
        for (const sessionId of result.runningIds) {
            this.options.appendLine(`[Batch Archive] ${label} skipped running session: ${formatBatchAiSessionIdForLog(sessionId)}`);
        }
        for (const sessionId of result.missingIds) {
            this.options.appendLine(`[Batch Archive] ${label} session no longer available: ${formatBatchAiSessionIdForLog(sessionId)}`);
        }
        for (const sessionId of result.failedIds) {
            this.options.appendLine(`[Batch Archive] ${label} archive failed: ${formatBatchAiSessionIdForLog(sessionId)}`);
        }
    }
}
