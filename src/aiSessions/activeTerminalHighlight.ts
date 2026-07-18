'use strict';

import type { AiSessionProviderId } from '../models';

export const ACTIVE_AI_SESSION_TERMINAL_CHECK_INTERVAL_MS = 1000;

export interface ActiveAiSessionTerminalIdentity {
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface ActiveAiSessionTerminalResolution<TTerminal, TEntry>
    extends ActiveAiSessionTerminalIdentity {
    terminal: TTerminal;
    entry: TEntry;
}

export interface ActiveAiSessionTerminalHighlightDependencies<TTerminal, TEntry> {
    isVisible: () => boolean;
    getActiveTerminal: () => TTerminal | null;
    resolveTerminal: (terminal: TTerminal) => ActiveAiSessionTerminalResolution<TTerminal, TEntry> | null;
    isComplete: (resolution: ActiveAiSessionTerminalResolution<TTerminal, TEntry>) => boolean;
    publish: (identity: ActiveAiSessionTerminalIdentity | null) => void;
    onComplete?: (resolution: ActiveAiSessionTerminalResolution<TTerminal, TEntry>) => void;
    setInterval: (callback: () => void, intervalMs: number) => unknown;
    clearInterval: (handle: unknown) => void;
}

export default class ActiveAiSessionTerminalHighlighter<TTerminal, TEntry> {
    private timer: unknown = null;
    private resolution: ActiveAiSessionTerminalResolution<TTerminal, TEntry> = null;
    private currentIdentity: ActiveAiSessionTerminalIdentity = null;

    constructor(private readonly dependencies: ActiveAiSessionTerminalHighlightDependencies<TTerminal, TEntry>) { }

    sync(forcePublish: boolean = false) {
        this.stopTimer();
        this.resolution = null;
        if (!this.dependencies.isVisible()) {
            this.currentIdentity = null;
            return;
        }

        let terminal = this.dependencies.getActiveTerminal();
        let resolution = terminal ? this.dependencies.resolveTerminal(terminal) : null;
        if (!resolution) {
            this.setIdentity(null, forcePublish);
            return;
        }
        if (this.dependencies.isComplete(resolution)) {
            this.setIdentity(null, forcePublish);
            this.dependencies.onComplete?.(resolution);
            return;
        }

        this.resolution = resolution;
        this.setIdentity({ provider: resolution.provider, sessionId: resolution.sessionId }, forcePublish);
        this.timer = this.dependencies.setInterval(
            () => this.checkCompletion(),
            ACTIVE_AI_SESSION_TERMINAL_CHECK_INTERVAL_MS
        );
    }

    request() {
        this.sync(true);
    }

    getIdentity(): ActiveAiSessionTerminalIdentity | null {
        return this.currentIdentity ? { ...this.currentIdentity } : null;
    }

    setVisible(visible: boolean) {
        if (visible) {
            this.sync(true);
            return;
        }
        this.stopTimer();
        this.resolution = null;
        this.currentIdentity = null;
    }

    handleTerminalClosed(terminal: TTerminal) {
        if (!this.resolution || this.resolution.terminal !== terminal) {
            return;
        }
        this.stopTimer();
        this.resolution = null;
        this.setIdentity(null);
    }

    dispose() {
        this.stopTimer();
        this.resolution = null;
        this.currentIdentity = null;
    }

    private checkCompletion() {
        if (!this.resolution
            || !this.dependencies.isVisible()
            || this.dependencies.getActiveTerminal() !== this.resolution.terminal) {
            this.sync();
            return;
        }
        if (this.dependencies.isComplete(this.resolution)) {
            const completedResolution = this.resolution;
            this.stopTimer();
            this.resolution = null;
            this.setIdentity(null);
            this.dependencies.onComplete?.(completedResolution);
        }
    }

    private setIdentity(identity: ActiveAiSessionTerminalIdentity | null, forcePublish: boolean = false) {
        let currentKey = this.currentIdentity
            ? `${this.currentIdentity.provider}:${this.currentIdentity.sessionId}`
            : '';
        let nextKey = identity ? `${identity.provider}:${identity.sessionId}` : '';
        this.currentIdentity = identity;
        if (forcePublish || currentKey !== nextKey) {
            this.dependencies.publish(identity);
        }
    }

    private stopTimer() {
        if (this.timer !== null) {
            this.dependencies.clearInterval(this.timer);
            this.timer = null;
        }
    }
}
