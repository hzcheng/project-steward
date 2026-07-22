'use strict';

import type { AiSessionProviderId } from '../models';
import {
    resolvePendingAiSessionTerminals,
} from '../aiSessions/pendingTerminalResolver';
import type {
    PendingAiSessionRuntimeCoordinator,
} from '../aiSessions/pendingTerminalResolver';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeSnapshot,
} from '../aiSessions/runtimeTypes';
import type {
    AiSessionProviderDefinition,
    AiSessionReadResult,
} from '../aiSessions/types';
import type { OpenWorkspace } from './types';

type PromotionProvider = Pick<
    AiSessionProviderDefinition,
    'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'
>;

interface WorkspacePromotionRuntimeCoordinator<TTerminal>
extends PendingAiSessionRuntimeCoordinator<TTerminal> {
    getActive(): AiSessionRuntimeSnapshot<TTerminal>[];
    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[];
    getPendingForPromotion(): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>[]>;
}

interface PromotionRequest {
    workspace: OpenWorkspace;
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>;
    reason: string;
}

export interface WorkspacePendingSessionPromotionControllerOptions<TTerminal = unknown> {
    providers: readonly PromotionProvider[];
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    runtimeCoordinator: WorkspacePromotionRuntimeCoordinator<TTerminal>;
    setAlias: (providerId: AiSessionProviderId, sessionId: string, alias: string) => void;
    syncActiveRuntime: () => void;
    evaluateExecution: () => void;
    scheduleRefresh: (reason: string) => void;
    logDiagnostic?: (event: Record<string, unknown>) => void;
}

export class WorkspacePendingSessionPromotionController<TTerminal = unknown> {
    private readonly queuedByScope = new Map<string, PromotionRequest>();
    private readonly inFlightByScope = new Map<string, Promise<void>>();

    constructor(
        private readonly options: WorkspacePendingSessionPromotionControllerOptions<TTerminal>
    ) {
    }

    promote(
        workspace: OpenWorkspace,
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>,
        reason: string
    ): Promise<void> {
        const scope = workspace.scopeIdentity;
        this.queuedByScope.set(scope, { workspace, sessionResults, reason });
        const existing = this.inFlightByScope.get(scope);
        if (existing) {
            return existing;
        }
        const running = this.drain(scope).finally(() => {
            if (this.inFlightByScope.get(scope) === running) {
                this.inFlightByScope.delete(scope);
            }
        });
        this.inFlightByScope.set(scope, running);
        return running;
    }

    private async drain(scope: string): Promise<void> {
        while (this.queuedByScope.has(scope)) {
            const request = this.queuedByScope.get(scope) as PromotionRequest;
            this.queuedByScope.delete(scope);
            try {
                await this.promoteOnce(request);
            } catch (error) {
                this.logDiagnostic({
                    event: 'workspace-ai-session-promotion-failed',
                    reason: request.reason,
                    category: error instanceof Error ? error.name : typeof error,
                });
            }
        }
    }

    private async promoteOnce(request: PromotionRequest): Promise<void> {
        const pendingRuntimes = (await this.options.runtimeCoordinator.getPendingForPromotion())
            .filter(runtime => runtime.identity.workspaceScopeIdentity
                === request.workspace.scopeIdentity);
        if (!pendingRuntimes.length) {
            return;
        }
        const activeRuntimes = this.options.runtimeCoordinator.getActive()
            .filter(runtime => runtime.identity.workspaceScopeIdentity
                === request.workspace.scopeIdentity
                || runtime.identity.workspaceNavigationIdentity
                    === request.workspace.navigationIdentity);
        const result = await resolvePendingAiSessionTerminals({
            pendingRuntimes,
            activeRuntimes,
            sessionResults: request.sessionResults,
            providers: this.options.providers,
            getSessionKey: this.options.getSessionKey,
            runtimeCoordinator: this.options.runtimeCoordinator,
            setAlias: this.options.setAlias,
            syncActiveRuntime: this.options.syncActiveRuntime,
        });
        if (result.promoted.length) {
            this.options.evaluateExecution();
            this.options.scheduleRefresh('pending-promotion');
        }
        if (result.failures.length) {
            this.logDiagnostic({
                event: 'workspace-ai-session-promotion',
                reason: request.reason,
                attempted: result.attempted,
                promotedCount: result.promoted.length,
                failureReasons: result.failures.map(failure => failure.reason),
            });
        }
    }

    private logDiagnostic(event: Record<string, unknown>): void {
        try {
            this.options.logDiagnostic?.(event);
        } catch {
            // Diagnostics must not break pending promotion or later retries.
        }
    }
}
