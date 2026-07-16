'use strict';

import { Group, Project, StewardInfos } from '../models';
import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import { withAttentionProjects } from '../aiSessions/attentionProject';
import { buildOpenProjectsUpdatedMessage } from '../dashboard/webviewUpdateMessages';
import type { OpenProjectAggregate } from './protocol';
import { projectOpenProjectCards } from './projection';

export interface OpenProjectDashboardControllerOptions {
    getOpenProjects: () => Project[];
    getGroups: () => Group[];
    getStewardInfos: () => StewardInfos;
    getAttentionAggregate: () => AttentionAggregate;
    getBridgeInstanceId: () => string;
    postMessage: (message: unknown) => Thenable<boolean>;
    refresh: (reason: string) => void;
    isVisible: () => boolean;
    logDiagnostic: (source: string, event: Record<string, unknown>) => void;
    logError: (message: string, error: unknown) => void;
    nowMs?: () => number;
}

export class OpenProjectDashboardController {
    private aggregate: OpenProjectAggregate | null = null;
    private navigationCardsById = new Map<string, Project>();

    constructor(private readonly options: OpenProjectDashboardControllerOptions) {
    }

    setAggregate(aggregate: OpenProjectAggregate | null): boolean {
        if (aggregate?.semanticRevision === this.aggregate?.semanticRevision) {
            return false;
        }

        this.aggregate = aggregate;
        return true;
    }

    getCards(): Project[] {
        const startedAt = this.nowMs();
        const openProjects = this.options.getOpenProjects();
        const cards = withAttentionProjects(
            projectOpenProjectCards(
                openProjects,
                this.aggregate,
                this.options.getBridgeInstanceId()
            ),
            this.options.getAttentionAggregate()
        );
        this.navigationCardsById = new Map(
            cards
                .filter(card => card.openProjectCardKind === 'projectNavigation')
                .map(card => [card.id, card] as [string, Project])
        );
        this.options.logDiagnostic('Renderer', {
            event: 'open-project-cards-build',
            durationMs: this.nowMs() - startedAt,
            projectCount: openProjects.length,
            cardCount: cards.length,
            navigationCardCount: cards.filter(card => card.openProjectCardKind === 'projectNavigation').length,
            semanticRevision: this.aggregate?.semanticRevision || null,
        });
        return cards;
    }

    getNavigationCard(projectId: string): Project | undefined {
        return this.navigationCardsById.get(projectId);
    }

    postUpdated(): void {
        if (!this.options.isVisible() || !this.aggregate) {
            return;
        }

        const cards = this.getCards();
        const stewardInfos = this.options.getStewardInfos();
        const messageBuildStartedAt = this.nowMs();
        const message = buildOpenProjectsUpdatedMessage({
            groups: this.options.getGroups(),
            cards,
            collapsed: stewardInfos.openProjectsGroupCollapsed,
            stewardInfos,
            semanticRevision: this.aggregate.semanticRevision,
        });
        this.options.logDiagnostic('Renderer', {
            event: 'post-update-build',
            durationMs: this.nowMs() - messageBuildStartedAt,
            semanticRevision: message.semanticRevision,
            projectCount: message.projectCount,
            htmlBytes: Buffer.byteLength(message.html, 'utf8'),
        });
        this.options.logDiagnostic('Renderer', {
            event: 'post-update',
            semanticRevision: message.semanticRevision,
            projectCount: message.projectCount,
        });
        this.options.postMessage(message).then(delivered => {
            this.options.logDiagnostic('Renderer', {
                event: 'post-update-result',
                semanticRevision: message.semanticRevision,
                projectCount: message.projectCount,
                delivered,
            });
            if (!delivered && this.options.isVisible()) {
                this.options.refresh('open-project-update-not-delivered');
            }
        }, error => {
            this.options.logError('Failed to post OPEN PROJECT update message.', error);
            if (this.options.isVisible()) {
                this.options.refresh('open-project-update-post-error');
            }
        });
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }
}
