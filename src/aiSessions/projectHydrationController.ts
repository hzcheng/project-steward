'use strict';

import type * as vscode from 'vscode';
import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type { AttentionAggregate } from './attentionAggregate';
import { buildAttentionSessionIndex } from './attentionProject';
import type { AiSessionAttentionSnapshot } from './attentionMonitor';
import { getAiSessionCandidatePaths, getAiSessionOpenProjectCandidates } from './projectCandidates';
import { hydrateOpenProjectsWithAiSessions } from './projectHydration';
import { resolvePendingAiSessionTerminals } from './pendingTerminalResolver';
import type { PendingAiSessionTerminalService } from './pendingTerminalResolver';
import { getAiSessionScanMaxFiles } from './scanOptions';
import type {
    AiSessionAssignmentCandidate,
    AiSessionProviderDefinition,
    AiSessionReadResult,
} from './types';
import { sanitizeAiSessionAlias } from './aliasStore';

type HydrationProvider = Pick<
    AiSessionProviderDefinition,
    | 'id'
    | 'terminalNamePrefix'
    | 'projectSessionsKey'
    | 'projectSessionsUnavailableKey'
    | 'terminalCwdFields'
>;

export interface AiSessionProjectHydrationReadCoordinator {
    getResults(options: {
        candidatePaths: string[];
        reason: string;
        maxFiles: number;
    }): Record<AiSessionProviderId, AiSessionReadResult>;
    getAssignments<TProject extends { id: string }>(
        candidates: AiSessionAssignmentCandidate<TProject>[],
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>,
        getSessionPath: (providerId: AiSessionProviderId, session: CodexSession) => string,
    ): Record<AiSessionProviderId, Map<string, CodexSession[]>>;
}

export interface AiSessionProjectHydrationControllerOptions<TTerminal = unknown> {
    getWorkspaceFile: () => vscode.Uri | null | undefined;
    getWorkspaceFolders: () => readonly { uri: vscode.Uri }[] | null | undefined;
    getRefreshReason: () => string;
    incrementalScanMaxFiles: number;
    getProviders: () => readonly HydrationProvider[];
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    readCoordinator: AiSessionProjectHydrationReadCoordinator;
    terminalService: PendingAiSessionTerminalService<TTerminal> & {
        trackPending(pending: {
            provider: AiSessionProviderId;
            terminal: TTerminal;
            markerPath: string;
            cwd: string;
            createdAt: string;
            excludedSessionIds: string[];
            title: string;
        }): void;
    };
    setAlias: (providerId: AiSessionProviderId, sessionId: string, alias: string) => void;
    syncActiveTerminal: () => void;
    getSessionComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string;
    getExpandedProjects: () => ReadonlySet<string>;
    getActiveProviders: () => Record<string, AiSessionProviderId>;
    getPinnedSessions: () => Set<string>;
    getAliases: () => Record<string, string>;
    getAttentionAggregate: () => AttentionAggregate;
    getLocalAttentionBySession: () => Record<string, AiSessionAttentionSnapshot>;
    hasRemoteAttentionAggregate: () => boolean;
    getProjectKey: (project: Project) => string;
    normalizeProjectPath: (projectPath: string) => string;
    nowMs?: () => number;
    logDiagnostic?: (event: Record<string, unknown>) => void;
}

export class AiSessionProjectHydrationController<TTerminal = unknown> {
    private cache: {
        signature: string;
        projects: Project[];
        diagnostic: Record<string, unknown>;
    } | null = null;
    private cacheClearScheduled = false;

    constructor(private readonly options: AiSessionProjectHydrationControllerOptions<TTerminal>) {
    }

    hydrate(openProjects: Project[]): Project[] {
        const startedAt = this.nowMs();
        const reason = this.options.getRefreshReason();
        const providers = this.options.getProviders();
        if (!openProjects.length) {
            this.logDiagnostic({
                event: 'ai-session-hydration',
                reason,
                durationMs: this.nowMs() - startedAt,
                projectCount: 0,
                hydratedProjectCount: 0,
                candidatePathCount: 0,
                providerCount: providers.length,
                sessionCount: 0,
                pendingTerminalCount: 0,
                cacheHit: false,
            });
            return openProjects;
        }

        const workspaceFile = this.options.getWorkspaceFile();
        const workspaceFolders = this.options.getWorkspaceFolders();
        const candidatePaths = getAiSessionCandidatePaths(openProjects, workspaceFile, workspaceFolders);
        const assignmentCandidates = getAiSessionOpenProjectCandidates(openProjects, workspaceFile, workspaceFolders);
        const maxFiles = getAiSessionScanMaxFiles(reason, this.options.incrementalScanMaxFiles);
        const pendingTerminals = this.options.terminalService.getPendingTerminals();
        const pendingTerminalCount = pendingTerminals.length;
        const aggregate = this.options.getAttentionAggregate();
        const localAttentionBySession = this.options.getLocalAttentionBySession();
        const signature = this.getCacheSignature({
            openProjects,
            providers,
            candidatePaths,
            assignmentCandidates,
            reason,
            maxFiles,
            aggregate,
            localAttentionBySession,
            pendingTerminals,
        });
        if (this.cache?.signature === signature) {
            this.logDiagnostic({
                ...this.cache.diagnostic,
                durationMs: this.nowMs() - startedAt,
                cacheHit: true,
            });
            return this.cache.projects;
        }

        const sessionResults = this.getAiSessionResults(candidatePaths, reason, maxFiles);
        resolvePendingAiSessionTerminals({
            terminalService: this.options.terminalService,
            sessionResults,
            providers,
            getSessionKey: this.options.getSessionKey,
            setAlias: this.options.setAlias,
            syncActiveTerminal: this.options.syncActiveTerminal,
        });
        const assignments = this.getAiSessionAssignments(assignmentCandidates, sessionResults);
        const hydrated = hydrateOpenProjectsWithAiSessions({
            projects: openProjects,
            providers,
            sessionResults,
            assignments,
            expandedProjects: this.options.getExpandedProjects(),
            activeProviders: this.options.getActiveProviders(),
            pinnedSessions: this.options.getPinnedSessions(),
            aliases: this.options.getAliases(),
            aggregateByProjectAndSession: buildAttentionSessionIndex(aggregate),
            localAttentionBySession,
            includeLocalAttention: !this.options.hasRemoteAttentionAggregate(),
            getProjectKey: this.options.getProjectKey,
        });
        const diagnostic = {
            event: 'ai-session-hydration',
            reason,
            projectCount: openProjects.length,
            hydratedProjectCount: hydrated.length,
            candidatePathCount: candidatePaths.length,
            providerCount: providers.length,
            sessionCount: Object.values(sessionResults)
                .reduce((count, result) => count + result.sessions.length, 0),
            pendingTerminalCount,
        };
        this.cache = {
            signature,
            projects: hydrated,
            diagnostic,
        };
        this.scheduleCacheClear();
        this.logDiagnostic({
            ...diagnostic,
            durationMs: this.nowMs() - startedAt,
            cacheHit: false,
        });
        return hydrated;
    }

    trackPendingTerminal(
        providerId: AiSessionProviderId,
        terminal: TTerminal,
        markerPath: string,
        cwd: string,
        createdAt: string,
        excludedSessionIds: string[],
        title: string = null
    ): void {
        const comparableCwd = this.options.normalizeProjectPath(cwd);
        if (!terminal || !markerPath || !comparableCwd) {
            return;
        }

        this.options.terminalService.trackPending({
            provider: providerId,
            terminal,
            markerPath,
            cwd: comparableCwd,
            createdAt,
            excludedSessionIds: Array.isArray(excludedSessionIds) ? excludedSessionIds.filter(id => !!id) : [],
            title: sanitizeAiSessionAlias(title),
        });
    }

    private getAiSessionResults(
        candidatePaths: string[],
        reason: string,
        maxFiles: number
    ): Record<AiSessionProviderId, AiSessionReadResult> {
        return this.options.readCoordinator.getResults({ candidatePaths, reason, maxFiles });
    }

    private getAiSessionAssignments(
        assignmentCandidates: AiSessionAssignmentCandidate<Project>[],
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>
    ): Record<AiSessionProviderId, Map<string, CodexSession[]>> {
        return this.options.readCoordinator.getAssignments(
            assignmentCandidates,
            sessionResults,
            this.options.getSessionComparableCwd
        );
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }

    private logDiagnostic(event: Record<string, unknown>): void {
        this.options.logDiagnostic?.(event);
    }

    private scheduleCacheClear(): void {
        if (this.cacheClearScheduled) {
            return;
        }

        this.cacheClearScheduled = true;
        Promise.resolve().then(() => {
            this.cache = null;
            this.cacheClearScheduled = false;
        });
    }

    private getCacheSignature(input: {
        openProjects: Project[];
        providers: readonly HydrationProvider[];
        candidatePaths: string[];
        assignmentCandidates: AiSessionAssignmentCandidate<Project>[];
        reason: string;
        maxFiles: number;
        aggregate: AttentionAggregate;
        localAttentionBySession: Record<string, AiSessionAttentionSnapshot>;
        pendingTerminals: ReturnType<PendingAiSessionTerminalService<TTerminal>['getPendingTerminals']>;
    }): string {
        return JSON.stringify({
            reason: input.reason,
            maxFiles: input.maxFiles,
            candidatePaths: input.candidatePaths,
            assignmentCandidates: input.assignmentCandidates.map(candidate => ({
                projectId: candidate.project.id,
                path: candidate.path,
            })),
            providers: input.providers.map(provider => ({
                id: provider.id,
                terminalNamePrefix: provider.terminalNamePrefix,
                projectSessionsKey: provider.projectSessionsKey,
                projectSessionsUnavailableKey: provider.projectSessionsUnavailableKey,
                terminalCwdFields: provider.terminalCwdFields,
            })),
            projects: this.stableValue(input.openProjects),
            expandedProjects: Array.from(this.options.getExpandedProjects()).sort(),
            activeProviders: this.options.getActiveProviders(),
            pinnedSessions: Array.from(this.options.getPinnedSessions()).sort(),
            aliases: this.options.getAliases(),
            hasRemoteAttentionAggregate: this.options.hasRemoteAttentionAggregate(),
            aggregateRevision: input.aggregate.aggregateRevision,
            aggregateSessions: input.aggregate.sessions.map(session => ({
                projectId: session.projectId,
                sessionKey: session.sessionKey,
                reasons: session.reasons,
                eventIds: session.eventIds,
                observedAtMs: session.observedAtMs,
            })),
            localAttentionBySession: Object.entries(input.localAttentionBySession)
                .map(([sessionKey, snapshot]) => ({
                    sessionKey,
                    state: snapshot.state,
                    stateChangedAt: snapshot.stateChangedAt,
                    eventId: snapshot.event?.eventId,
                    reason: snapshot.event?.reason,
                }))
                .sort((left, right) => left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0),
            pendingTerminals: input.pendingTerminals.map(pending => ({
                provider: pending.provider,
                markerPath: pending.markerPath,
                cwd: pending.cwd,
                createdAt: pending.createdAt,
                excludedSessionIds: pending.excludedSessionIds,
                title: pending.title,
            })),
        });
    }

    private stableValue(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map(item => this.stableValue(item));
        }
        if (!value || typeof value !== 'object') {
            return value;
        }
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce((result, key) => {
                result[key] = this.stableValue((value as Record<string, unknown>)[key]);
                return result;
            }, {} as Record<string, unknown>);
    }
}
