'use strict';

import * as crypto from 'crypto';
import type { AttentionAggregate } from './attentionAggregate';
import { normalizeAiSessionComparablePath } from './sessionHelpers';

export interface AttentionProjectSummary {
    projectKey: string;
    attentionCount: number;
    eventIds: string[];
    sessions: Array<{ sessionKey: string; eventId: string; eventIds: string[] }>;
}

export function getAttentionProjectKey(projectPath: string): string {
    const canonicalPath = normalizeAiSessionComparablePath(projectPath);
    if (!canonicalPath) {
        return '';
    }

    return crypto.createHash('sha256').update(canonicalPath).digest('hex');
}

export function getAttentionProjectSummaries(aggregate: AttentionAggregate | null): AttentionProjectSummary[] {
    const summaries = new Map<string, AttentionProjectSummary>();
    for (const item of aggregate?.sessions || []) {
        let summary = summaries.get(item.projectId);
        if (!summary) {
            summary = { projectKey: item.projectId, attentionCount: 0, eventIds: [], sessions: [] };
            summaries.set(item.projectId, summary);
        }
        summary.attentionCount += 1;
        summary.eventIds.push(...item.eventIds);
        summary.sessions.push({
            sessionKey: item.sessionKey,
            eventId: item.eventIds[0] || `${item.sessionKey}:${item.observedAtMs}`,
            eventIds: item.eventIds.slice().sort(),
        });
    }

    return Array.from(summaries.values())
        .map(summary => ({
            ...summary,
            eventIds: summary.eventIds.sort(),
            sessions: summary.sessions.sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
        }))
        .sort((left, right) => left.projectKey.localeCompare(right.projectKey));
}

export function withAttentionProject<TProject extends { path?: string; attentionProjectPath?: string }>(
    project: TProject,
    aggregate: AttentionAggregate | null
): TProject & { aiSessionAttentionCount: number; aiSessionAttentionEventIds: string[] } {
    const projectKey = getAttentionProjectKey(project.attentionProjectPath || project.path);
    const summary = getAttentionProjectSummaries(aggregate).find(candidate => candidate.projectKey === projectKey);
    return {
        ...project,
        aiSessionAttentionCount: summary?.attentionCount || 0,
        aiSessionAttentionEventIds: summary?.eventIds.slice() || [],
    };
}
