'use strict';

export type AiSessionAttentionReason = 'quiet' | 'completed';
export type AiSessionAttentionState = 'pending' | 'running' | 'needsAttention' | 'acknowledged';

export interface AiSessionAttentionInput {
    key: string;
    activityToken?: string;
    completed?: boolean;
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
    event?: AiSessionAttentionEvent;
}

interface Entry extends AiSessionAttentionSnapshot {
    baselineToken?: string;
    lastToken?: string;
    lastActivityAt: number;
    generation: number;
}

export interface AiSessionAttentionMonitorOptions {
    quietThresholdMs?: number;
    now?: () => number;
}

export default class AiSessionAttentionMonitor {
    private readonly entries = new Map<string, Entry>();
    private readonly quietThresholdMs: number;
    private readonly now: () => number;

    constructor(options: AiSessionAttentionMonitorOptions = {}) {
        this.quietThresholdMs = options.quietThresholdMs ?? 30_000;
        this.now = options.now ?? (() => Date.now());
    }

    evaluate(inputs: AiSessionAttentionInput[]): AiSessionAttentionEvent[] {
        const now = this.now();
        const seen = new Set<string>();
        const events: AiSessionAttentionEvent[] = [];
        for (const input of inputs || []) {
            if (!input?.key) continue;
            seen.add(input.key);
            const observedAt = input.observedAt ?? now;
            let entry = this.entries.get(input.key);
            if (!entry) {
                entry = { state: 'pending', baselineToken: input.activityToken, lastToken: input.activityToken, lastActivityAt: observedAt, generation: 0 };
                this.entries.set(input.key, entry);
                continue;
            }
            const changed = input.activityToken !== undefined && input.activityToken !== entry.lastToken;
            if (changed) {
                entry.lastToken = input.activityToken;
                entry.lastActivityAt = observedAt;
                if (entry.state === 'pending' || entry.state === 'acknowledged' || entry.state === 'needsAttention') entry.state = 'running';
            }
            if (entry.state === 'running' && (input.completed || now - entry.lastActivityAt >= this.quietThresholdMs)) {
                entry.state = 'needsAttention';
                entry.generation += 1;
                const event: AiSessionAttentionEvent = {
                    eventId: `${input.key}:${entry.generation}:${input.completed ? 'completed' : 'quiet'}`,
                    key: input.key,
                    reason: input.completed ? 'completed' : 'quiet',
                    generation: entry.generation,
                    detectedAt: now,
                };
                entry.event = event;
                events.push(event);
            }
        }
        for (const key of this.entries.keys()) {
            if (!seen.has(key)) this.entries.delete(key);
        }
        return events;
    }

    acknowledge(eventIds: string[]): void {
        const ids = new Set(eventIds || []);
        for (const entry of this.entries.values()) {
            if (entry.event && ids.has(entry.event.eventId) && entry.state === 'needsAttention') entry.state = 'acknowledged';
        }
    }

    getSnapshot(): Record<string, AiSessionAttentionSnapshot> {
        const result: Record<string, AiSessionAttentionSnapshot> = {};
        for (const [key, entry] of this.entries) result[key] = { state: entry.state, event: entry.event };
        return result;
    }
}
