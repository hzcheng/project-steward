'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { AiSessionAssignmentCandidate, AiSessionProvider, AiSessionQueryOptions, AiSessionReadResult } from './types';
import { assignAiSessionsToProjects } from './sessionHelpers';

export interface AiSessionScanDiagnosticEvent {
    [key: string]: unknown;
    event: 'ai-session-scan';
    provider: AiSessionProviderId;
    reason: string;
    durationMs: number;
    sessionCount: number;
    scannedFileCount: number;
    parsedFileCount: number;
    scanBudget: number | null;
    available: boolean;
}

export class AiSessionReadCoordinator {
    constructor(
        private readonly providers: readonly AiSessionProvider[],
        private readonly logDiagnostic: (event: AiSessionScanDiagnosticEvent) => void,
        private readonly now: () => number = Date.now,
    ) { }

    getResults(options: AiSessionQueryOptions): Record<AiSessionProviderId, AiSessionReadResult> {
        let results = {} as Record<AiSessionProviderId, AiSessionReadResult>;
        for (let { id: providerId } of this.providers) {
            results[providerId] = this.getProviderResult(providerId, options);
        }

        return results;
    }

    getProviderResult(providerId: AiSessionProviderId, options?: boolean | AiSessionQueryOptions): AiSessionReadResult {
        const startedAt = this.now();
        const provider = this.providers.find(candidate => candidate.id === providerId);
        if (!provider) {
            throw new Error(`AI session provider ${providerId} is not registered.`);
        }
        const result = provider.service.getSessions(options);
        const normalizedOptions = typeof options === 'boolean' ? { forceRefresh: options } : options || {};
        this.logDiagnostic({
            event: 'ai-session-scan',
            provider: providerId,
            reason: normalizedOptions.reason || (normalizedOptions.forceRefresh ? 'force-refresh' : 'refresh'),
            durationMs: this.now() - startedAt,
            sessionCount: result.sessions.length,
            scannedFileCount: result.scannedFiles,
            parsedFileCount: result.parsedFiles,
            scanBudget: normalizedOptions.maxFiles || null,
            available: result.available,
        });
        return result;
    }

    getAssignments<TProject extends { id: string }>(
        candidates: AiSessionAssignmentCandidate<TProject>[],
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>,
        getSessionPath: (providerId: AiSessionProviderId, session: CodexSession) => string,
    ): Record<AiSessionProviderId, Map<string, CodexSession[]>> {
        let assignments = {} as Record<AiSessionProviderId, Map<string, CodexSession[]>>;
        for (let { id: providerId } of this.providers) {
            let result = sessionResults[providerId];
            assignments[providerId] = this.getAssignmentsForProvider(
                candidates,
                providerId,
                result,
                session => getSessionPath(providerId, session)
            );
        }

        return assignments;
    }

    private getAssignmentsForProvider<TProject extends { id: string }>(
        candidates: AiSessionAssignmentCandidate<TProject>[],
        providerId: AiSessionProviderId,
        sessionResult: AiSessionReadResult,
        getSessionPath: (session: CodexSession) => string,
    ): Map<string, CodexSession[]> {
        if (!sessionResult.available || !sessionResult.sessions.length) {
            return new Map<string, CodexSession[]>();
        }

        return assignAiSessionsToProjects(candidates, sessionResult.sessions, getSessionPath);
    }
}
