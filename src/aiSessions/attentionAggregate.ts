'use strict';

import * as crypto from 'crypto';
import type { AttentionOwnerSnapshot, AttentionPayloadItem } from './attentionPayload';

export interface AttentionAggregate {
    revision: string;
    generatedAtMs: number;
    items: AttentionPayloadItem[];
}

export function aggregateAttentionSnapshots(
    snapshots: AttentionOwnerSnapshot[],
    acknowledgedEventIds: ReadonlySet<string> = new Set<string>(),
    nowMs = Date.now(),
    leaseMs = 90_000
): AttentionAggregate {
    const bySession = new Map<string, AttentionPayloadItem>();
    for (const snapshot of snapshots || []) {
        if (nowMs - snapshot.leaseUpdatedAtMs > leaseMs) continue;
        for (const item of snapshot.items) {
            const acknowledged = item.eventId ? acknowledgedEventIds.has(item.eventId) : false;
            const candidate: AttentionPayloadItem = acknowledged ? { ...item, state: 'acknowledged' } : { ...item };
            const previous = bySession.get(item.sessionKey);
            if (!previous || candidate.observedAtMs > previous.observedAtMs
                || (candidate.observedAtMs === previous.observedAtMs && candidate.projectId < previous.projectId)) {
                bySession.set(item.sessionKey, candidate);
            }
        }
    }
    const items = Array.from(bySession.values()).sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
    const semantic = JSON.stringify(items.map(item => [item.projectId, item.sessionKey, item.state, item.eventId || '', item.reason || '', item.observedAtMs]));
    return { revision: crypto.createHash('sha256').update(semantic).digest('hex'), generatedAtMs: nowMs, items };
}
