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
}

export class AiSessionProjectHydrationController<TTerminal = unknown> {
    constructor(private readonly options: AiSessionProjectHydrationControllerOptions<TTerminal>) {
    }

    hydrate(openProjects: Project[]): Project[] {
        if (!openProjects.length) {
            return openProjects;
        }

        const providers = this.options.getProviders();
        const sessionResults = this.getAiSessionResults(openProjects);
        resolvePendingAiSessionTerminals({
            terminalService: this.options.terminalService,
            sessionResults,
            providers,
            getSessionKey: this.options.getSessionKey,
            setAlias: this.options.setAlias,
            syncActiveTerminal: this.options.syncActiveTerminal,
        });
        const assignments = this.getAiSessionAssignments(openProjects, sessionResults);
        const aggregate = this.options.getAttentionAggregate();
        return hydrateOpenProjectsWithAiSessions({
            projects: openProjects,
            providers,
            sessionResults,
            assignments,
            expandedProjects: this.options.getExpandedProjects(),
            activeProviders: this.options.getActiveProviders(),
            pinnedSessions: this.options.getPinnedSessions(),
            aliases: this.options.getAliases(),
            aggregateByProjectAndSession: buildAttentionSessionIndex(aggregate),
            localAttentionBySession: this.options.getLocalAttentionBySession(),
            includeLocalAttention: !this.options.hasRemoteAttentionAggregate(),
            getProjectKey: this.options.getProjectKey,
        });
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

    private getAiSessionResults(openProjects: Project[]): Record<AiSessionProviderId, AiSessionReadResult> {
        const reason = this.options.getRefreshReason();
        const candidatePaths = getAiSessionCandidatePaths(
            openProjects,
            this.options.getWorkspaceFile(),
            this.options.getWorkspaceFolders()
        );
        const maxFiles = getAiSessionScanMaxFiles(reason, this.options.incrementalScanMaxFiles);
        return this.options.readCoordinator.getResults({ candidatePaths, reason, maxFiles });
    }

    private getAiSessionAssignments(
        openProjects: Project[],
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>
    ): Record<AiSessionProviderId, Map<string, CodexSession[]>> {
        return this.options.readCoordinator.getAssignments(
            getAiSessionOpenProjectCandidates(
                openProjects,
                this.options.getWorkspaceFile(),
                this.options.getWorkspaceFolders()
            ),
            sessionResults,
            this.options.getSessionComparableCwd
        );
    }
}
