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
    refresh: (reason: string) => void;
    logError: (message: string, error: unknown) => void;
    logDiagnostic?: (event: Record<string, unknown>) => void;
    nowMs?: () => number;
    beforeRefresh?: (reason: string) => void;
    afterRefresh?: () => void;
    debounceMs: number;
    watcherRefreshMinIntervalMs?: number;
    newSessionRefreshDelaysMs: number[];
    setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimeout: (handle: NodeJS.Timeout) => void;
}

export class AiSessionDashboardController {
    private refreshTimeout: NodeJS.Timeout = null;
    private newSessionRefreshTimeouts: NodeJS.Timeout[] = [];
    private watcherDisposables: DisposableLike[] = [];
    private pendingRefreshReason = 'refresh';
    private lastWatcherRefreshAtMs: number | null = null;

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
        }, this.getRefreshDelayMs(reason));
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
            const message = this.getUpdatedMessage(reason);
            this.options.postMessage(message).then(delivered => {
                if (!delivered) {
                    this.options.refresh('ai-session-update-not-delivered');
                }
            }, error => {
                this.options.logError('Failed to post AI session update message.', error);
                this.options.refresh('ai-session-update-post-error');
            });
        } catch (error) {
            this.options.logError('Failed to update AI sessions incrementally.', error);
            this.options.refresh('ai-session-update-build-error');
        } finally {
            if (reason === 'watcher') {
                this.lastWatcherRefreshAtMs = this.nowMs();
            }
            this.options.afterRefresh?.();
        }
    }

    getUpdatedMessage(reason = 'refresh'): AiSessionsUpdatedMessage {
        const startedAt = this.nowMs();
        const cards = this.options.getCards();
        const openProjects = cards
            .filter(project => project.openProjectCardKind !== 'projectNavigation');
        const message = buildAiSessionsUpdatedMessage({
            groups: this.options.getGroups(),
            cards,
            sequence: this.options.nextSequence(),
            generatedAt: new Date().toISOString(),
            openProjects: openProjects.map(project => this.options.getOpenProjectAiSessionViewModel(project)),
        });
        this.options.logDiagnostic?.({
            event: 'ai-session-message-build',
            reason,
            durationMs: this.nowMs() - startedAt,
            cardCount: cards.length,
            openProjectCount: openProjects.length,
        });
        return message;
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

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }

    private getRefreshDelayMs(reason: string): number {
        if (reason !== 'watcher' || this.lastWatcherRefreshAtMs === null) {
            return this.options.debounceMs;
        }

        const minIntervalMs = Math.max(this.options.watcherRefreshMinIntervalMs || 0, this.options.debounceMs);
        const elapsedMs = Math.max(0, this.nowMs() - this.lastWatcherRefreshAtMs);
        return Math.max(this.options.debounceMs, minIntervalMs - elapsedMs);
    }
}
