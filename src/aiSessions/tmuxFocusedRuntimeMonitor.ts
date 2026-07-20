'use strict';

import type { TmuxFocusedRuntimeSyncResult } from './tmuxRuntimeBackend';

export const TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS = 1000;

export interface TmuxFocusedRuntimeMonitorOptions<TTerminal> {
    isVisible(): boolean;
    getActiveTerminal(): TTerminal | null;
    syncFocusedRuntime(terminal: TTerminal): Promise<TmuxFocusedRuntimeSyncResult>;
    refresh(): void;
    onError(error: unknown): void;
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
}

export class TmuxFocusedRuntimeMonitor<TTerminal> {
    private interval: unknown = null;
    private inFlight: Promise<void> | null = null;
    private disposed = false;

    constructor(private readonly options: TmuxFocusedRuntimeMonitorOptions<TTerminal>) { }

    start(): void {
        if (this.disposed || this.interval !== null) {
            return;
        }
        this.interval = this.options.setInterval(
            () => { void this.request(); },
            TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS
        );
    }

    request(): Promise<void> {
        if (this.disposed || !this.options.isVisible()) {
            return Promise.resolve();
        }
        if (this.inFlight) {
            return this.inFlight;
        }
        const terminal = this.options.getActiveTerminal();
        if (!terminal) {
            return Promise.resolve();
        }
        let tracked: Promise<void>;
        const clear = () => {
            if (this.inFlight === tracked) {
                this.inFlight = null;
            }
        };
        tracked = this.options.syncFocusedRuntime(terminal).then(result => {
            if (!this.disposed && result.changed && this.options.isVisible()
                && this.options.getActiveTerminal() === terminal) {
                this.options.refresh();
            }
        }, error => {
            try {
                this.options.onError(error);
            } catch (_reportError) {
                // Monitoring failures and diagnostic failures remain non-fatal.
            }
        }).then(clear, clear);
        this.inFlight = tracked;
        return tracked;
    }

    dispose(): void {
        this.disposed = true;
        if (this.interval !== null) {
            this.options.clearInterval(this.interval);
            this.interval = null;
        }
    }
}
