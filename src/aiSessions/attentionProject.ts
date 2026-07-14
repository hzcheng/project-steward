'use strict';

import * as crypto from 'crypto';
import type { AttentionAggregate } from './attentionAggregate';
import { normalizeAiSessionComparablePath } from './sessionHelpers';

export interface AttentionProjectSummary {
    projectKey: string;
    attentionCount: number;
    eventIds: string[];
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
    for (const item of aggregate?.items || []) {
        if (item.state !== 'needsAttention') {
            continue;
        }

        let summary = summaries.get(item.projectId);
        if (!summary) {
            summary = { projectKey: item.projectId, attentionCount: 0, eventIds: [] };
            summaries.set(item.projectId, summary);
        }
        summary.attentionCount += 1;
        if (item.eventId) {
            summary.eventIds.push(item.eventId);
        }
    }

    return Array.from(summaries.values())
        .map(summary => ({ ...summary, eventIds: summary.eventIds.sort() }))
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
