'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { BatchAiSessionArchiveResult } from './archiveBatch';
import type { AiSessionExecutionState, AiSessionLifecycleRequest, AiSessionLifecycleSignal } from './lifecycle';
import type { DashboardSearchCatalog } from '../webview/dashboardViewModel';

export interface AiSessionTerminalEntry<TTerminal = unknown> {
    terminal: TTerminal;
    markerPath: string;
    runStartedAtMs: number;
    cwd?: string;
    released?: boolean;
}

export type AiSessionTabId = 'active' | 'sessions';
export type ActiveAiSessionStatus = 'starting' | 'running' | 'focused' | 'needsAttention';
export type ActiveAiSessionExecutionState = 'starting' | AiSessionExecutionState;

export interface AiSessionActiveTerminalRuntime {
    provider: AiSessionProviderId;
    sessionId: string;
    cwd?: string;
    runStartedAtMs: number;
}

export interface ActiveAiSessionViewModel {
    key: string;
    provider: AiSessionProviderId;
    sessionId?: string;
    name: string;
    status: ActiveAiSessionStatus;
    executionState: ActiveAiSessionExecutionState;
    focused: boolean;
    needsAttention: boolean;
    pending: boolean;
    updatedAt?: string;
    createdAt?: string;
    pinned?: boolean;
    attentionEventId?: string;
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
    commandName: string;
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
    active?: boolean;
    focused?: boolean;
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
    defaultTab: AiSessionTabId;
    activeSessions: ActiveAiSessionViewModel[];
    activeSessionCount: number;
    activeAttentionCount: number;
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
