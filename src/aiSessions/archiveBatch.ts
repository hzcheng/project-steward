'use strict';

import type { CodexSession } from '../models';

export type BatchAiSessionArchiveAttemptStatus = 'archived' | 'running' | 'failed';

export const MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES = 100;
export const MAX_BATCH_AI_SESSION_ID_LENGTH = 512;
export const MAX_RETAINED_BATCH_AI_SESSION_REJECTED_IDS = 20;
export const MAX_BATCH_AI_SESSION_LOG_ID_LENGTH = 160;

export interface BatchAiSessionArchiveSelection {
    eligibleSessions: CodexSession[];
    rejectedIds: string[];
    rejectedIdCount: number;
    malformedCount: number;
}

export interface BatchAiSessionArchiveDependencies {
    resolveCurrentSessions: () => readonly CodexSession[];
    archiveSession: (sessionId: string) => BatchAiSessionArchiveAttemptStatus;
}

export interface BatchAiSessionArchiveResult {
    archivedIds: string[];
    runningIds: string[];
    missingIds: string[];
    rejectedIds: string[];
    rejectedIdCount: number;
    failedIds: string[];
    malformedCount: number;
}

export interface BatchAiSessionArchiveRequest {
    projectId: string;
    provider: string;
    sessionIds: unknown;
}

export interface BatchAiSessionArchiveProject {
    id: string;
    activeAiSessionProvider?: string;
}

export interface BatchAiSessionArchiveConfirmation {
    projectId: string;
    provider: string;
    eligibleCount: number;
    pinnedCount: number;
}

export interface BatchAiSessionArchiveCompletion {
    type: 'ai-session-batch-archive-completed';
    projectId: string;
    provider: string;
    status: 'cancelled' | 'rejected' | 'finished';
    result?: BatchAiSessionArchiveResult;
}

export interface BatchAiSessionArchiveRequestDependencies {
    resolveProject: (projectId: string) => BatchAiSessionArchiveProject | null;
    getProjectSessions: (project: BatchAiSessionArchiveProject, provider: string) => readonly CodexSession[];
    resolveCurrentSessions: () => readonly CodexSession[];
    confirm: (confirmation: BatchAiSessionArchiveConfirmation) => Promise<boolean>;
    archiveSession: (sessionId: string) => BatchAiSessionArchiveAttemptStatus;
    reportScopeRejected: () => void;
    reportSelectionRejected: (selection: BatchAiSessionArchiveSelection) => void;
    reportResult: (result: BatchAiSessionArchiveResult) => void;
    logUnexpectedError: (context: string, error: unknown, sessionId?: string) => void;
    postCompletion: (completion: BatchAiSessionArchiveCompletion) => void;
    refresh: () => void;
}

export interface BatchAiSessionArchiveItemDependencies {
    isRunning: (sessionId: string) => boolean;
    archiveSession: (sessionId: string) => boolean;
    deleteEntryMarker: (sessionId: string) => void;
    untrackTerminal: (sessionId: string) => void;
    deletePin: (sessionId: string) => void;
    deleteAlias: (sessionId: string) => void;
}

export function resolveBatchAiSessionSelection(
    sessionIds: unknown,
    availableSessions: readonly CodexSession[]
): BatchAiSessionArchiveSelection {
    let allValues = Array.isArray(sessionIds) ? sessionIds : [];
    let values = allValues.slice(0, MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES);
    let malformedCount = Array.isArray(sessionIds)
        ? Math.max(0, allValues.length - MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES)
        : 1;
    let requestedIds: string[] = [];
    let seen = new Set<string>();

    for (let value of values) {
        if (typeof value !== 'string' || value.length > MAX_BATCH_AI_SESSION_ID_LENGTH || !value.trim()) {
            malformedCount++;
            continue;
        }

        let sessionId = value.trim();
        if (!seen.has(sessionId)) {
            seen.add(sessionId);
            requestedIds.push(sessionId);
        }
    }

    let sessionsById = new Map((availableSessions || []).map(session => [session.id, session]));
    let rejectedIds = requestedIds.filter(sessionId => !sessionsById.has(sessionId));
    return {
        eligibleSessions: requestedIds.map(sessionId => sessionsById.get(sessionId)).filter(session => !!session),
        rejectedIds: rejectedIds.slice(0, MAX_RETAINED_BATCH_AI_SESSION_REJECTED_IDS),
        rejectedIdCount: rejectedIds.length,
        malformedCount,
    };
}

export function archiveBatchAiSessions(
    selection: BatchAiSessionArchiveSelection,
    dependencies: BatchAiSessionArchiveDependencies
): BatchAiSessionArchiveResult {
    let currentSessions = new Map(dependencies.resolveCurrentSessions().map(session => [session.id, session]));
    let result: BatchAiSessionArchiveResult = {
        archivedIds: [],
        runningIds: [],
        missingIds: [],
        rejectedIds: [...selection.rejectedIds],
        rejectedIdCount: selection.rejectedIdCount,
        failedIds: [],
        malformedCount: selection.malformedCount,
    };

    for (let session of selection.eligibleSessions) {
        if (!currentSessions.has(session.id)) {
            result.missingIds.push(session.id);
            continue;
        }

        let status = dependencies.archiveSession(session.id);
        if (status === 'archived') {
            result.archivedIds.push(session.id);
        } else if (status === 'running') {
            result.runningIds.push(session.id);
        } else {
            result.failedIds.push(session.id);
        }
    }

    return result;
}

export function archiveBatchAiSessionItem(
    sessionId: string,
    dependencies: BatchAiSessionArchiveItemDependencies
): BatchAiSessionArchiveAttemptStatus {
    if (dependencies.isRunning(sessionId)) {
        return 'running';
    }
    if (!dependencies.archiveSession(sessionId)) {
        return 'failed';
    }

    dependencies.deleteEntryMarker(sessionId);
    dependencies.untrackTerminal(sessionId);
    dependencies.deletePin(sessionId);
    dependencies.deleteAlias(sessionId);
    return 'archived';
}

export async function executeBatchAiSessionArchiveRequest(
    request: BatchAiSessionArchiveRequest,
    dependencies: BatchAiSessionArchiveRequestDependencies
): Promise<void> {
    let completed = false;
    let executionStarted = false;
    let refreshed = false;
    let result: BatchAiSessionArchiveResult = null;
    let complete = (status: 'cancelled' | 'rejected' | 'finished', completionResult?: BatchAiSessionArchiveResult) => {
        if (completed) {
            return;
        }
        completed = true;
        dependencies.postCompletion({
            type: 'ai-session-batch-archive-completed',
            projectId: request.projectId,
            provider: request.provider,
            status,
            result: completionResult,
        });
    };
    let refresh = () => {
        if (refreshed) {
            return;
        }
        refreshed = true;
        dependencies.refresh();
    };

    try {
        let project = dependencies.resolveProject(request.projectId);
        if (!project || project.activeAiSessionProvider !== request.provider) {
            dependencies.reportScopeRejected();
            complete('rejected');
            return;
        }

        let selection = resolveBatchAiSessionSelection(
            request.sessionIds,
            dependencies.getProjectSessions(project, request.provider)
        );
        if (!selection.eligibleSessions.length) {
            dependencies.reportSelectionRejected(selection);
            complete('rejected');
            return;
        }

        let accepted = await dependencies.confirm({
            projectId: request.projectId,
            provider: request.provider,
            eligibleCount: selection.eligibleSessions.length,
            pinnedCount: selection.eligibleSessions.filter(session => session.pinned).length,
        });
        if (!accepted) {
            complete('cancelled');
            return;
        }

        executionStarted = true;
        result = archiveBatchAiSessions(selection, {
            resolveCurrentSessions: dependencies.resolveCurrentSessions,
            archiveSession: sessionId => {
                try {
                    return dependencies.archiveSession(sessionId);
                } catch (error) {
                    dependencies.logUnexpectedError('archive-session', error, sessionId);
                    return 'failed';
                }
            },
        });
        try {
            dependencies.reportResult(result);
        } catch (error) {
            dependencies.logUnexpectedError('report-result', error);
        }
        complete('finished', result);
        refresh();
    } catch (error) {
        dependencies.logUnexpectedError(executionStarted ? 'execute-request' : 'prepare-request', error);
        complete(executionStarted ? 'finished' : 'rejected', result || undefined);
        if (executionStarted) {
            refresh();
        }
    }
}

export function hasBatchAiSessionArchiveIssues(result: BatchAiSessionArchiveResult): boolean {
    return Boolean(
        result.runningIds.length
        || result.missingIds.length
        || result.rejectedIds.length
        || result.failedIds.length
        || result.malformedCount
    );
}

export function formatBatchAiSessionArchiveSummary(result: BatchAiSessionArchiveResult): string {
    let parts = [formatCount('Archived', result.archivedIds.length, 'session')];
    if (result.runningIds.length) {
        parts.push(formatCount('skipped', result.runningIds.length, 'running session'));
    }
    if (result.missingIds.length) {
        parts.push(formatCount('', result.missingIds.length, 'session', 'was', 'were') + ' no longer available');
    }
    let rejectedCount = result.rejectedIdCount + result.malformedCount;
    if (rejectedCount) {
        parts.push(formatCount('rejected', rejectedCount, 'invalid or out-of-scope selection'));
    }
    if (result.failedIds.length) {
        parts.push(formatCount('', result.failedIds.length, 'session') + ' failed');
    }
    return parts.join('; ') + '.';
}

export function formatBatchAiSessionIdForLog(sessionId: string): string {
    let sanitized = sessionId.replace(/[\u0000-\u001f\u007f]/g, character => {
        switch (character) {
            case '\n': return '\\n';
            case '\r': return '\\r';
            case '\t': return '\\t';
            default: return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
        }
    });
    return sanitized.length > MAX_BATCH_AI_SESSION_LOG_ID_LENGTH
        ? `${sanitized.substring(0, MAX_BATCH_AI_SESSION_LOG_ID_LENGTH)}…`
        : sanitized;
}

function formatCount(
    prefix: string,
    count: number,
    noun: string,
    singularVerb: string = '',
    pluralVerb: string = ''
): string {
    let words = [prefix, String(count), `${noun}${count === 1 ? '' : 's'}`].filter(value => !!value);
    let verb = count === 1 ? singularVerb : pluralVerb;
    return [...words, verb].filter(value => !!value).join(' ');
}
