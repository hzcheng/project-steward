'use strict';

import * as crypto from 'crypto';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import type { WorkspaceAiSessionViewModel } from '../aiSessions/types';
import type { Group, WorkspaceCardViewModel } from '../models';
import { buildOpenWorkspacesUpdatedMessage } from '../dashboard/webviewUpdateMessages';
import type { TodoSearchCatalogItem } from '../todos/types';
import { getWorkspaceAttentionSummary } from '../workspaces/attentionProjection';
import type { OpenWorkspace } from '../workspaces/types';
import { projectOpenWorkspaceCards } from './projection';
import type { OpenWorkspaceAggregate } from './protocol';

export interface OpenWorkspaceDashboardControllerOptions {
    getCurrentWorkspace: () => OpenWorkspace | null;
    getCurrentWorkspaceAiSessions: (workspace: OpenWorkspace) => WorkspaceAiSessionViewModel | null;
    getGroups: () => Group[];
    getTodoSearchItems: () => TodoSearchCatalogItem[];
    getCollapsed: () => boolean;
    getAttentionAggregate: () => AttentionAggregate | null;
    getBridgeInstanceId: () => string;
    postMessage: (message: unknown) => Thenable<boolean>;
    refresh: (reason: string) => void;
    isVisible: () => boolean;
    logDiagnostic: (source: string, event: Record<string, unknown>) => void;
    logError: (message: string, error: unknown) => void;
    nowMs?: () => number;
}

export class OpenWorkspaceDashboardController {
    private aggregate: OpenWorkspaceAggregate | null = null;
    private lastPostedSemanticRevision: string | null = null;

    constructor(private readonly options: OpenWorkspaceDashboardControllerOptions) {
    }

    setAggregate(aggregate: OpenWorkspaceAggregate | null): boolean {
        if (aggregate?.semanticRevision === this.aggregate?.semanticRevision) { return false; }
        this.aggregate = aggregate;
        return true;
    }

    getCards(): WorkspaceCardViewModel[] {
        const startedAt = this.nowMs();
        const currentWorkspace = this.options.getCurrentWorkspace();
        const attentionAggregate = this.options.getAttentionAggregate();
        const currentCard = currentWorkspace
            ? this.createCurrentCard(currentWorkspace, attentionAggregate)
            : null;
        const navigationCards = projectOpenWorkspaceCards(
            currentWorkspace,
            this.aggregate,
            this.options.getBridgeInstanceId(),
            attentionAggregate,
        );
        const cards = currentCard ? [currentCard, ...navigationCards] : navigationCards;
        this.options.logDiagnostic('Renderer', {
            event: 'open-workspace-cards-build',
            durationMs: this.nowMs() - startedAt,
            currentWorkspaceCount: currentCard ? 1 : 0,
            navigationWorkspaceCount: navigationCards.length,
            semanticRevision: this.aggregate?.semanticRevision || null,
        });
        return cards;
    }

    postUpdated(): void {
        if (!this.options.isVisible() || !this.aggregate) { return; }
        if (this.aggregate.semanticRevision === this.lastPostedSemanticRevision) { return; }
        const message = buildOpenWorkspacesUpdatedMessage({
            groups: this.options.getGroups(),
            cards: this.getCards(),
            collapsed: this.options.getCollapsed(),
            semanticRevision: this.aggregate.semanticRevision,
            todoSearchItems: this.options.getTodoSearchItems(),
        });
        this.lastPostedSemanticRevision = message.semanticRevision;
        this.options.postMessage(message).then(delivered => {
            if (!delivered) {
                this.clearPostedSemanticRevision(message.semanticRevision);
                if (this.options.isVisible()) { this.options.refresh('open-workspace-update-not-delivered'); }
            }
        }, error => {
            this.clearPostedSemanticRevision(message.semanticRevision);
            this.options.logError('Failed to post OPEN WORKSPACE update message.', error);
            if (this.options.isVisible()) { this.options.refresh('open-workspace-update-post-error'); }
        });
    }

    private createCurrentCard(
        workspace: OpenWorkspace,
        attentionAggregate: AttentionAggregate | null,
    ): WorkspaceCardViewModel {
        const digest = crypto.createHash('sha256').update(workspace.navigationIdentity).digest('hex').slice(0, 24);
        return {
            id: `__currentWorkspace-${digest}`,
            kind: 'current',
            navigationIdentity: workspace.navigationIdentity,
            scopeIdentity: workspace.scopeIdentity,
            name: workspace.displayName,
            environmentLabel: this.getEnvironmentLabel(workspace.environment),
            roots: workspace.roots
                .slice()
                .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
                .map(root => ({ id: root.id, name: root.name, ordinal: root.ordinal })),
            aiSessions: this.options.getCurrentWorkspaceAiSessions(workspace) || undefined,
            attentionCount: getWorkspaceAttentionSummary(workspace, attentionAggregate).attentionCount,
        };
    }

    private getEnvironmentLabel(environment: OpenWorkspace['environment']): string {
        switch (environment) {
            case 'ssh': return 'SSH';
            case 'wsl': return 'WSL';
            case 'devContainer': return 'Dev Container';
            case 'remote': return 'Remote';
            case 'local':
            default: return 'Local';
        }
    }

    private clearPostedSemanticRevision(semanticRevision: string): void {
        if (this.lastPostedSemanticRevision === semanticRevision) {
            this.lastPostedSemanticRevision = null;
        }
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }
}
