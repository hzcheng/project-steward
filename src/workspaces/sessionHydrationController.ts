'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { ActiveAiSessionTerminalIdentity } from '../aiSessions/activeTerminalHighlight';
import type { AiSessionExecutionSnapshot } from '../aiSessions/executionMonitor';
import { getAiSessionScanMaxFiles } from '../aiSessions/scanOptions';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from '../aiSessions/runtimeTypes';
import type {
    AiSessionProviderDefinition,
    AiSessionReadResult,
    WorkspaceAiSessionViewModel,
} from '../aiSessions/types';
import type { OpenWorkspace } from './types';
import { getWorkspaceAiSessionCandidatePaths, hydrateWorkspaceAiSessions } from './sessionHydration';

type HydrationProvider = Pick<AiSessionProviderDefinition, 'id' | 'label' | 'terminalCwdFields'>;

export interface WorkspaceSessionHydrationReadCoordinator {
    getResults(options: {
        candidatePaths: string[];
        reason: string;
        maxFiles: number;
    }): Record<AiSessionProviderId, AiSessionReadResult>;
}

export interface WorkspaceSessionHydrationControllerOptions<TTerminal = unknown> {
    providers: readonly HydrationProvider[];
    readCoordinator: WorkspaceSessionHydrationReadCoordinator;
    incrementalScanMaxFiles: number;
    getRefreshReason: () => string;
    getSessionComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string;
    getPinnedSessions: () => ReadonlySet<string>;
    getAliases: () => Readonly<Record<string, string>>;
    getActiveProvider: (workspaceScopeIdentity: string) => AiSessionProviderId | undefined;
    getExpanded: (workspaceScopeIdentity: string) => boolean;
    getActiveRuntimes: () => readonly AiSessionRuntimeSnapshot<TTerminal>[];
    getPendingRuntimes: () => readonly AiSessionPendingRuntimeSnapshot<TTerminal>[];
    getExecutionSnapshot: () => Readonly<Record<string, AiSessionExecutionSnapshot>>;
    getFocusedIdentity: () => AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null;
    nowMs?: () => number;
    logDiagnostic?: (event: Record<string, unknown>) => void;
}

export class WorkspaceSessionHydrationController<TTerminal = unknown> {
    constructor(private readonly options: WorkspaceSessionHydrationControllerOptions<TTerminal>) {
    }

    hydrate(workspace: OpenWorkspace | null): WorkspaceAiSessionViewModel | null {
        const startedAt = this.nowMs();
        const reason = this.options.getRefreshReason();
        if (!workspace) {
            this.logDiagnostic({
                event: 'workspace-ai-session-hydration',
                reason,
                durationMs: this.nowMs() - startedAt,
                workspaceCount: 0,
                candidatePathCount: 0,
                providerCount: this.options.providers.length,
                sessionCount: 0,
            });
            return null;
        }

        const candidatePaths = getWorkspaceAiSessionCandidatePaths(workspace);
        const maxFiles = getAiSessionScanMaxFiles(reason, this.options.incrementalScanMaxFiles);
        const sessionResults = this.options.readCoordinator.getResults({ candidatePaths, reason, maxFiles });
        const result = hydrateWorkspaceAiSessions({
            workspace,
            providers: this.options.providers,
            sessionResults,
            getSessionComparableCwd: this.options.getSessionComparableCwd,
            pinnedSessions: this.options.getPinnedSessions(),
            aliases: this.options.getAliases(),
            activeRuntimes: this.options.getActiveRuntimes(),
            pendingRuntimes: this.options.getPendingRuntimes(),
            executionSnapshot: this.options.getExecutionSnapshot(),
            focusedIdentity: this.options.getFocusedIdentity(),
            activeProvider: this.options.getActiveProvider(workspace.scopeIdentity),
            expanded: this.options.getExpanded(workspace.scopeIdentity),
        });
        this.logDiagnostic({
            event: 'workspace-ai-session-hydration',
            reason,
            durationMs: this.nowMs() - startedAt,
            workspaceCount: 1,
            candidatePathCount: candidatePaths.length,
            providerCount: this.options.providers.length,
            sessionCount: result.aiSessionCount,
            activeSessionCount: result.activeSessionCount,
            unavailableProviderCount: result.unavailableProviders.length,
        });
        return result;
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }

    private logDiagnostic(event: Record<string, unknown>): void {
        this.options.logDiagnostic?.(event);
    }
}
