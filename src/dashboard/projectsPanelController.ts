'use strict';

import type { Group } from '../models';
import { getFavoriteProjectsInOrder } from '../projects/favoriteProjectOrder';
import type { DashboardWorkspaceSearchCatalog } from '../webview/dashboardViewModel';
import {
    buildProjectsPanelUpdatedMessage,
    ProjectsPanelUpdateMode,
} from './webviewUpdateMessages';

export interface ProjectsPanelControllerOptions {
    getGroups: () => Group[];
    getSearchCatalog: () => DashboardWorkspaceSearchCatalog;
    renderHtml: (groups: Group[]) => string;
    postMessage: (message: unknown) => Thenable<boolean>;
    refresh: (reason: string) => void;
    isVisible: () => boolean;
    logError: (message: string, error: unknown) => void;
}

export class ProjectsPanelController {
    private sequence = 0;
    private deliveryGeneration = 0;

    constructor(private readonly options: ProjectsPanelControllerOptions) {
    }

    postUpdated(mode: ProjectsPanelUpdateMode = 'replace'): void {
        if (!this.options.isVisible()) {
            return;
        }
        const groups = this.options.getGroups();
        const projects = groups.reduce(
            (all, group) => all.concat(group.projects || []),
            []
        );
        const message = buildProjectsPanelUpdatedMessage({
            sequence: ++this.sequence,
            mode,
            html: this.options.renderHtml(groups),
            searchCatalog: this.options.getSearchCatalog(),
            groupOrders: groups.map(group => ({
                groupId: group.id,
                projectIds: (group.projects || []).map(project => project.id),
            })),
            favoriteProjectIds: getFavoriteProjectsInOrder(projects)
                .map(project => project.id),
        });
        const deliveryGeneration = this.deliveryGeneration;
        this.options.postMessage(message).then(delivered => {
            if (!delivered
                && this.isCurrentDelivery(message.sequence, deliveryGeneration)
                && this.options.isVisible()) {
                this.options.refresh('projects-panel-update-not-delivered');
            }
        }, error => {
            this.options.logError('Failed to post Projects panel update message.', error);
            if (this.isCurrentDelivery(message.sequence, deliveryGeneration)
                && this.options.isVisible()) {
                this.options.refresh('projects-panel-update-post-error');
            }
        });
    }

    invalidatePendingUpdates(): void {
        this.deliveryGeneration += 1;
    }

    private isCurrentDelivery(sequence: number, deliveryGeneration: number): boolean {
        return sequence === this.sequence
            && deliveryGeneration === this.deliveryGeneration;
    }
}
