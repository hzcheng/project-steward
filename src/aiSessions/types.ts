'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { BatchAiSessionArchiveResult } from './archiveBatch';
import type { AiSessionLifecycleRequest, AiSessionLifecycleSignal } from './lifecycle';
import type { DashboardSearchCatalog } from '../webview/dashboardViewModel';

export interface AiSessionTerminalEntry<TTerminal = unknown> {
    terminal: TTerminal;
    markerPath: string;
    runStartedAtMs: number;
}

export interface AiSessionReadResult {
    available: boolean;
    sessions: CodexSession[];
    scannedFiles: number;
    parsedFiles: number;
}

export interface AiSessionQueryOptions {
    forceRefresh?: boolean;
    candidatePaths?: string[];
    maxFiles?: number;
    reason?: string;
}

export interface AiSessionDisposable {
    dispose(): void;
}

export interface AiSessionService {
    getSessions(options?: boolean | AiSessionQueryOptions): AiSessionReadResult;
    getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal>;
    watchSessionChanges(onDidChange: () => void): AiSessionDisposable;
    archiveSession(sessionId: string): boolean;
    invalidateCache(): void;
}

export interface AiSessionProviderDefinition {
    id: AiSessionProviderId;
    label: string;
    terminalNamePrefix: string;
    terminalEnvKey: string;
    markerDirName: string;
    projectSessionsKey: 'codexSessions' | 'kimiSessions' | 'claudeSessions';
    projectSessionsUnavailableKey: 'codexSessionsUnavailable' | 'kimiSessionsUnavailable' | 'claudeSessionsUnavailable';
    terminalCwdFields: Array<'cwd' | 'workDir'>;
    buildResumeCommand: (sessionId: string, cwd: string, markerPath: string) => string;
    buildNewSessionCommand: (cwd: string, title: string, markerPath: string) => string;
}

export interface AiSessionProvider extends AiSessionProviderDefinition {
    service: AiSessionService;
}

export interface AiSessionProviderSummary {
    id: AiSessionProviderId;
    label: string;
    count: number;
    unavailable?: boolean;
}

export interface AiSessionViewModel {
    id: string;
    name: string;
    provider: AiSessionProviderId;
    updatedAt?: string;
    cwd?: string;
    workDir?: string;
    pinned?: boolean;
}

export interface OpenProjectAiSessionViewModel {
    projectId: string;
    projectKey: string;
    activeProvider: AiSessionProviderId;
    expanded: boolean;
    providers: AiSessionProviderSummary[];
    sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>>;
    unavailableProviders: AiSessionProviderId[];
    searchText?: string;
    aiSessionCount?: number;
    attentionCount?: number;
    sessionSectionHtml?: string;
}

export interface AiSessionsUpdatedMessage {
    type: 'ai-sessions-updated';
    version: 1;
    sequence: number;
    generatedAt: string;
    openProjects: OpenProjectAiSessionViewModel[];
    searchCatalog: DashboardSearchCatalog;
}

export interface AiSessionActiveTerminalChangedMessage {
    type: 'active-ai-session-terminal-changed';
    provider: AiSessionProviderId | null;
    sessionId: string | null;
}

export interface AiSessionAssignmentCandidate<TProject = { id: string }> {
    project: TProject;
    path: string;
}

export interface AiSessionBatchArchiveCompletedMessage {
    type: 'ai-session-batch-archive-completed';
    projectId: string;
    provider: AiSessionProviderId;
    status: 'cancelled' | 'rejected' | 'finished';
    result?: BatchAiSessionArchiveResult;
}
