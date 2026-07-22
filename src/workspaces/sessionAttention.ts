'use strict';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import {
    getAttentionProjectKeys,
    getAttentionSessionLookupKey,
} from '../aiSessions/attentionProject';
import { getAiSessionKey } from '../aiSessions/sessionHelpers';
import type { AiSessionViewModel } from '../aiSessions/types';
import type { AiSessionProviderId } from '../models';

type IndexedAttention = NonNullable<AiSessionViewModel['attention']> & {
    observedAtMs: number;
    sourceKey: string;
};

export type WorkspaceSessionAttentionIndex = ReadonlyMap<string, IndexedAttention>;

export function getLogicalAttentionSessionKey(sessionKey: string): string {
    const match = /^(codex|kimi|claude):(.+):\d+:(?:vscode|tmux)$/.exec(sessionKey || '');
    return match ? match[1] + ':' + match[2] : sessionKey;
}

export function buildWorkspaceSessionAttentionIndex(
    aggregate: AttentionAggregate | null
): WorkspaceSessionAttentionIndex {
    const result = new Map<string, IndexedAttention>();
    for (const session of aggregate?.sessions || []) {
        const lookupKey = getAttentionSessionLookupKey(
            session.projectId,
            getLogicalAttentionSessionKey(session.sessionKey)
        );
        const eventId = session.eventIds.slice().sort()[0];
        const reason = session.reasons.slice().sort()[0];
        if (!eventId || !reason) {
            continue;
        }
        const candidate: IndexedAttention = {
            eventId,
            reason,
            unread: true,
            observedAtMs: session.observedAtMs,
            sourceKey: session.sessionKey,
        };
        const current = result.get(lookupKey);
        if (!current
            || candidate.observedAtMs > current.observedAtMs
            || candidate.observedAtMs === current.observedAtMs
                && candidate.sourceKey.localeCompare(current.sourceKey) > 0) {
            result.set(lookupKey, candidate);
        }
    }
    return result;
}

export function getWorkspaceSessionAttention(
    index: WorkspaceSessionAttentionIndex,
    rootUri: string,
    providerId: AiSessionProviderId,
    sessionId: string
): AiSessionViewModel['attention'] | undefined {
    const indexed = index.get(getAttentionSessionLookupKey(
        getAttentionProjectKeys([rootUri])[0] || '',
        getAiSessionKey(providerId, sessionId)
    ));
    return indexed ? {
        eventId: indexed.eventId,
        reason: indexed.reason,
        unread: indexed.unread,
    } : undefined;
}
