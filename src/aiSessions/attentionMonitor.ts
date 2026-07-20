'use strict';

import * as crypto from 'crypto';
import type { AiSessionAttentionReason, AiSessionLifecycleSignal } from './lifecycle';

export { AiSessionAttentionReason } from './lifecycle';
export type AiSessionAttentionState = 'pending' | 'running' | 'needsAttention' | 'acknowledged';

export interface AiSessionAttentionInput {
    key: string;
    signal?: AiSessionLifecycleSignal;
    observedAt?: number;
}

export interface AiSessionAttentionEvent {
    eventId: string;
    key: string;
    reason: AiSessionAttentionReason;
    generation: number;
    detectedAt: number;
}

export interface AiSessionAttentionSnapshot {
    state: AiSessionAttentionState;
    stateChangedAt: number;
    event?: AiSessionAttentionEvent;
}

interface Entry extends AiSessionAttentionSnapshot {
    lastSignalToken?: string;
    generation: number;
}

export interface AiSessionAttentionMonitorOptions {
    now?: () => number;
}

export default class AiSessionAttentionMonitor {
    private readonly entries = new Map<string, Entry>();
    private readonly now: () => number;

    constructor(options: AiSessionAttentionMonitorOptions = {}) {
        this.now = options.now ?? (() => Date.now());
    }

    evaluate(inputs: AiSessionAttentionInput[]): AiSessionAttentionEvent[] {
        const now = this.now();
        const seen = new Set<string>();
        const events: AiSessionAttentionEvent[] = [];
        for (const input of inputs || []) {
            if (!input?.key) {
                continue;
            }
            seen.add(input.key);
            let observedAt = input.observedAt ?? now;
            let entry = this.entries.get(input.key);
            if (!entry) {
                entry = { state: 'pending', stateChangedAt: observedAt, generation: 0 };
                this.entries.set(input.key, entry);
            }

            let signal = input.signal;
            if (!signal?.token || signal.token === entry.lastSignalToken) {
                continue;
            }
            entry.lastSignalToken = signal.token;
            entry.stateChangedAt = observedAt;

            if (signal.phase === 'running') {
                entry.state = 'running';
                entry.event = undefined;
                continue;
            }
            if (signal.phase !== 'needsAttention' || !signal.reason) {
                continue;
            }

            entry.generation += 1;
            entry.state = 'needsAttention';
            const event: AiSessionAttentionEvent = {
                eventId: `${input.key}:${signal.reason}:${crypto.createHash('sha256').update(signal.token).digest('hex')}`,
                key: input.key,
                reason: signal.reason,
                generation: entry.generation,
                detectedAt: now,
            };
            entry.event = event;
            events.push(event);
        }

        for (const [key, entry] of this.entries) {
            if (!seen.has(key) && entry.state !== 'needsAttention') {
                this.entries.delete(key);
            }
        }
        return events;
    }

    acknowledge(eventIds: string[]): void {
        const ids = new Set(eventIds || []);
        for (const entry of this.entries.values()) {
            if (entry.event && ids.has(entry.event.eventId) && entry.state === 'needsAttention') {
                entry.state = 'acknowledged';
                entry.stateChangedAt = this.now();
            }
        }
    }

    getSnapshot(): Record<string, AiSessionAttentionSnapshot> {
        const result: Record<string, AiSessionAttentionSnapshot> = {};
        for (const [key, entry] of this.entries) {
            result[key] = { state: entry.state, stateChangedAt: entry.stateChangedAt, event: entry.event };
        }
        return result;
    }
}
