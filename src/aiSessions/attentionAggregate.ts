'use strict';

import * as crypto from 'crypto';
import type { AttentionOwnerSnapshot } from './attentionPayload';
import type { AiSessionAttentionReason } from './lifecycle';

export interface AggregatedAttentionSession {
    projectId: string;
    sessionKey: string;
    reasons: AiSessionAttentionReason[];
    eventIds: string[];
    observedAtMs: number;
}

export interface AttentionAggregate {
    protocolVersion: 1;
    aggregateRevision: string;
    generatedAtMs: number;
    sessions: AggregatedAttentionSession[];
}

const MAX_AGGREGATE_SESSIONS = 1000;
const MAX_AGGREGATE_EVENTS_PER_SESSION = 1000;
const MAX_AGGREGATE_ID_LENGTH = 1024;

function createAggregateRevision(sessions: AggregatedAttentionSession[]): string {
    const semantic = JSON.stringify(sessions.map(session => [
        session.projectId,
        session.sessionKey,
        session.reasons,
        session.eventIds,
        session.observedAtMs,
    ]));
    return crypto.createHash('sha256').update(semantic).digest('hex');
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
    if (Object.keys(value).sort().join('\n') !== expected.slice().sort().join('\n')) throw new Error(`${label} has unexpected fields`);
}

export function validateAttentionAggregate(value: unknown): AttentionAggregate {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attention aggregate must be an object');
    const record = value as Record<string, unknown>;
    exactKeys(record, ['protocolVersion', 'aggregateRevision', 'generatedAtMs', 'sessions'], 'attention aggregate');
    if (record.protocolVersion !== 1) throw new Error('attention aggregate protocol is incompatible');
    if (typeof record.aggregateRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.aggregateRevision)) throw new Error('attention aggregate revision is invalid');
    if (typeof record.generatedAtMs !== 'number' || !Number.isFinite(record.generatedAtMs) || record.generatedAtMs < 0) throw new Error('attention aggregate timestamp is invalid');
    if (!Array.isArray(record.sessions) || record.sessions.length > MAX_AGGREGATE_SESSIONS) throw new Error('attention aggregate sessions are invalid');
    const sessions = record.sessions.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attention aggregate session is invalid');
        const session = value as Record<string, unknown>;
        exactKeys(session, ['projectId', 'sessionKey', 'reasons', 'eventIds', 'observedAtMs'], 'attention aggregate session');
        if (typeof session.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(session.projectId)
            || typeof session.sessionKey !== 'string' || !session.sessionKey || session.sessionKey.length > MAX_AGGREGATE_ID_LENGTH) {
            throw new Error('attention aggregate session identity is invalid');
        }
        if (!Array.isArray(session.reasons) || session.reasons.length < 1 || session.reasons.length > 4
            || session.reasons.some(reason => reason !== 'completed' && reason !== 'aborted'
                && reason !== 'failed' && reason !== 'input-required')) throw new Error('attention aggregate reasons are invalid');
        if (!Array.isArray(session.eventIds) || session.eventIds.length < 1 || session.eventIds.length > MAX_AGGREGATE_EVENTS_PER_SESSION
            || session.eventIds.some(eventId => typeof eventId !== 'string' || !eventId || eventId.length > MAX_AGGREGATE_ID_LENGTH)) {
            throw new Error('attention aggregate eventIds are invalid');
        }
        if (typeof session.observedAtMs !== 'number' || !Number.isFinite(session.observedAtMs) || session.observedAtMs < 0) throw new Error('attention aggregate observation is invalid');
        return {
            projectId: session.projectId,
            sessionKey: session.sessionKey,
            reasons: Array.from(new Set(session.reasons as AiSessionAttentionReason[])).sort(),
            eventIds: Array.from(new Set(session.eventIds as string[])).sort(),
            observedAtMs: session.observedAtMs,
        };
    }).sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
    return { protocolVersion: 1, aggregateRevision: record.aggregateRevision, generatedAtMs: record.generatedAtMs, sessions };
}

export function aggregateAttentionSnapshots(
    snapshots: AttentionOwnerSnapshot[],
    acknowledgedEventIds: ReadonlySet<string> = new Set<string>(),
    nowMs = Date.now()
): AttentionAggregate {
    const bySession = new Map<string, {
        projectId: string;
        projectObservedAtMs: number;
        observedAtMs: number;
        events: Map<string, AiSessionAttentionReason>;
    }>();
    for (const snapshot of snapshots || []) {
        for (const item of snapshot.items) {
            if (!item.eventId || !item.reason || item.state === 'acknowledged' || acknowledgedEventIds.has(item.eventId)) continue;
            let logical = bySession.get(item.sessionKey);
            if (!logical) {
                logical = {
                    projectId: item.projectId,
                    projectObservedAtMs: item.observedAtMs,
                    observedAtMs: item.observedAtMs,
                    events: new Map(),
                };
                bySession.set(item.sessionKey, logical);
            }
            logical.events.set(item.eventId, item.reason);
            logical.observedAtMs = Math.max(logical.observedAtMs, item.observedAtMs);
            if (item.observedAtMs > logical.projectObservedAtMs
                || (item.observedAtMs === logical.projectObservedAtMs && item.projectId < logical.projectId)) {
                logical.projectId = item.projectId;
                logical.projectObservedAtMs = item.observedAtMs;
            }
        }
    }
    const sessions: AggregatedAttentionSession[] = Array.from(bySession, ([sessionKey, logical]) => {
        const events = Array.from(logical.events.entries())
            .sort((left, right) => left[0].localeCompare(right[0]))
            .slice(0, MAX_AGGREGATE_EVENTS_PER_SESSION);
        return {
            projectId: logical.projectId,
            sessionKey,
            reasons: Array.from(new Set(events.map(event => event[1]))).sort(),
            eventIds: events.map(event => event[0]),
            observedAtMs: logical.observedAtMs,
        };
    }).sort((left, right) => left.sessionKey.localeCompare(right.sessionKey))
        .slice(0, MAX_AGGREGATE_SESSIONS);
    return {
        protocolVersion: 1,
        aggregateRevision: createAggregateRevision(sessions),
        generatedAtMs: nowMs,
        sessions,
    };
}

export function filterAcknowledgedAttentionAggregate(
    aggregate: AttentionAggregate,
    acknowledgedEventIds: ReadonlySet<string>
): AttentionAggregate {
    if (!acknowledgedEventIds.size) {
        return aggregate;
    }
    const sessions = aggregate.sessions.filter(session =>
        !session.eventIds.every(eventId => acknowledgedEventIds.has(eventId))
    );
    if (sessions.length === aggregate.sessions.length) {
        return aggregate;
    }
    return {
        ...aggregate,
        aggregateRevision: createAggregateRevision(sessions),
        sessions,
    };
}
