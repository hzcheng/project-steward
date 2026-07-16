'use strict';

import type { AiSessionProviderId, Group, Project } from '../models';
import type { AiSessionsUpdatedMessage, OpenProjectAiSessionViewModel } from './types';
import { buildAiSessionsUpdatedMessage } from '../dashboard/webviewUpdateMessages';

interface DisposableLike {
    dispose(): void;
}

export interface AiSessionDashboardControllerOptions {
    providerIds: AiSessionProviderId[];
    isVisible: () => boolean;
    invalidateCache: (providerId: AiSessionProviderId) => void;
    watchSessionChanges: (providerId: AiSessionProviderId, onDidChange: () => void) => DisposableLike;
    getGroups: () => Group[];
    getCards: () => Project[];
    getOpenProjectAiSessionViewModel: (project: Project) => OpenProjectAiSessionViewModel;
    nextSequence: () => number;
    postMessage: (message: unknown) => Thenable<boolean>;
    refresh: () => void;
    logError: (message: string, error: unknown) => void;
    beforeRefresh?: (reason: string) => void;
    afterRefresh?: () => void;
    debounceMs: number;
    newSessionRefreshDelaysMs: number[];
    setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimeout: (handle: NodeJS.Timeout) => void;
}

export class AiSessionDashboardController {
    private refreshTimeout: NodeJS.Timeout = null;
    private newSessionRefreshTimeouts: NodeJS.Timeout[] = [];
    private watcherDisposables: DisposableLike[] = [];
    private pendingRefreshReason = 'refresh';

    constructor(private readonly options: AiSessionDashboardControllerOptions) {
    }

    scheduleRefresh(reason = 'refresh'): void {
        if (!this.options.isVisible()) {
            return;
        }

        this.pendingRefreshReason = reason;
        if (this.refreshTimeout) {
            this.options.clearTimeout(this.refreshTimeout);
        }

        this.refreshTimeout = this.options.setTimeout(() => {
            this.refreshTimeout = null;
            void this.refreshNow(this.pendingRefreshReason);
        }, this.options.debounceMs);
    }

    setWatchersActive(active: boolean): void {
        if (active) {
            this.startWatchers();
        } else {
            this.stopWatchers();
        }
    }

    scheduleNewSessionRefresh(providerId: AiSessionProviderId): void {
        for (let delay of this.options.newSessionRefreshDelaysMs) {
            let timeout: NodeJS.Timeout = null;
            let firedSynchronously = false;
            const callback = () => {
                if (timeout) {
                    this.newSessionRefreshTimeouts = this.newSessionRefreshTimeouts.filter(handle => handle !== timeout);
                } else {
                    firedSynchronously = true;
                }
                this.options.invalidateCache(providerId);
                void this.refreshNow('new-session');
            };
            timeout = this.options.setTimeout(callback, delay);
            if (!firedSynchronously) {
                this.newSessionRefreshTimeouts.push(timeout);
            }
        }
    }

    async refreshNow(reason = 'refresh'): Promise<void> {
        if (!this.options.isVisible()) {
            return;
        }

        this.options.beforeRefresh?.(reason);
        try {
            const message = this.getUpdatedMessage();
            this.options.postMessage(message).then(delivered => {
                if (!delivered) {
                    this.options.refresh();
                }
            }, error => {
                this.options.logError('Failed to post AI session update message.', error);
                this.options.refresh();
            });
        } catch (error) {
            this.options.logError('Failed to update AI sessions incrementally.', error);
            this.options.refresh();
        } finally {
            this.options.afterRefresh?.();
        }
    }

    getUpdatedMessage(): AiSessionsUpdatedMessage {
        const cards = this.options.getCards();
        const openProjects = cards
            .filter(project => project.openProjectCardKind !== 'projectNavigation');
        return buildAiSessionsUpdatedMessage({
            groups: this.options.getGroups(),
            cards,
            sequence: this.options.nextSequence(),
            generatedAt: new Date().toISOString(),
            openProjects: openProjects.map(project => this.options.getOpenProjectAiSessionViewModel(project)),
        });
    }

    dispose(): void {
        this.stopWatchers();
        for (let timeout of this.newSessionRefreshTimeouts) {
            this.options.clearTimeout(timeout);
        }
        this.newSessionRefreshTimeouts = [];
    }

    private startWatchers(): void {
        if (this.watcherDisposables.length) {
            return;
        }

        this.watcherDisposables = this.options.providerIds
            .map(providerId => this.options.watchSessionChanges(providerId, () => this.scheduleRefresh('watcher')));
    }

    private stopWatchers(): void {
        for (let disposable of this.watcherDisposables) {
            disposable.dispose();
        }

        this.watcherDisposables = [];
        if (this.refreshTimeout) {
            this.options.clearTimeout(this.refreshTimeout);
            this.refreshTimeout = null;
        }
    }
}
