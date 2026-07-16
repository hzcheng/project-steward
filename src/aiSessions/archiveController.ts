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

interface TerminalLike {
    show(): void;
}

export interface AiSessionArchiveTerminalEntry {
    terminal: TerminalLike;
}

export interface AiSessionArchiveProvider {
    label: string;
    service: {
        archiveSession(sessionId: string): boolean;
    };
}

export interface AiSessionArchiveControllerOptions<TEntry extends AiSessionArchiveTerminalEntry = AiSessionArchiveTerminalEntry> {
    isProviderId: (value: string) => value is AiSessionProviderId;
    getProvider: (providerId: AiSessionProviderId) => AiSessionArchiveProvider;
    getProviderLabel: (providerId: AiSessionProviderId) => string;
    getOpenProjects: () => Project[];
    getProjectSessions: (project: Project, providerId: AiSessionProviderId) => CodexSession[];
    getExistingTerminal: (providerId: AiSessionProviderId, sessionId: string) => TEntry | null;
    isTerminalComplete: (terminal: TEntry) => boolean;
    deleteEntryMarker: (terminal: TEntry) => void;
    untrackTerminal: (providerId: AiSessionProviderId, sessionId: string) => void;
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
    syncActiveTerminal: () => void;
    logUnexpectedError: (operation: string, error: unknown, failedSessionId?: string) => void;
}

export class AiSessionArchiveController<TEntry extends AiSessionArchiveTerminalEntry = AiSessionArchiveTerminalEntry> {
    constructor(private readonly options: AiSessionArchiveControllerOptions<TEntry>) {
    }

    async archiveSession(providerId: AiSessionProviderId | null, sessionId: string): Promise<void> {
        if (!providerId || !sessionId) {
            return;
        }

        const sessionProvider = this.options.getProvider(providerId);
        let existingTerminal = this.options.getExistingTerminal(providerId, sessionId);
        if (existingTerminal && !this.options.isTerminalComplete(existingTerminal)) {
            this.options.showWarningMessage(`This ${sessionProvider.label} session is open in a terminal. Exit or close that terminal before archiving it.`);
            existingTerminal.terminal.show();
            return;
        }

        const accepted = await this.options.confirmSingleArchive(sessionProvider.label);
        if (!accepted) {
            return;
        }

        const status = this.archiveSessionItem(providerId, sessionId);
        if (status === 'running') {
            existingTerminal = this.options.getExistingTerminal(providerId, sessionId);
            this.options.showWarningMessage(`This ${sessionProvider.label} session is open in a terminal. Exit or close that terminal before archiving it.`);
            existingTerminal?.terminal.show();
            return;
        }

        if (status === 'failed') {
            this.options.showErrorMessage(`Could not archive ${sessionProvider.label} session.`);
            return;
        }

        this.options.syncActiveTerminal();
        this.options.refresh();
    }

    archiveSessionItem(
        providerId: AiSessionProviderId,
        sessionId: string
    ): BatchAiSessionArchiveAttemptStatus {
        const sessionProvider = this.options.getProvider(providerId);
        const existingTerminal = this.options.getExistingTerminal(providerId, sessionId);
        return archiveBatchAiSessionItem(sessionId, {
            isRunning: () => Boolean(existingTerminal && !this.options.isTerminalComplete(existingTerminal)),
            archiveSession: () => sessionProvider.service.archiveSession(sessionId),
            deleteEntryMarker: () => {
                if (existingTerminal) {
                    this.options.deleteEntryMarker(existingTerminal);
                }
            },
            untrackTerminal: () => this.options.untrackTerminal(providerId, sessionId),
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
        this.options.syncActiveTerminal();
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
