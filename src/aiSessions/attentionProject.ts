'use strict';

import * as crypto from 'crypto';
import type { AggregatedAttentionSession, AttentionAggregate } from './attentionAggregate';
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

export function getAttentionProjectPath(projectPath: string): string {
    const uri = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/[^?#]*)?(?:[?#].*)?$/.exec(projectPath || '');
    if (!uri) {
        return projectPath;
    }

    let uriPath = uri[3] || '/';
    if (uri[1].toLowerCase() === 'file' && uri[2] && uri[2].toLowerCase() !== 'localhost') {
        uriPath = `//${uri[2]}${uriPath}`;
    } else if (/^\/[A-Za-z]:\//.test(uriPath)) {
        uriPath = uriPath.slice(1);
    }
    return uriPath;
}

export function resolveAttentionProjectKey(project: { path?: string }): string {
    return getAttentionProjectKey(getAttentionProjectPath(project?.path));
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

export function getAttentionSessionLookupKey(projectKey: string, sessionKey: string): string {
    return `${projectKey}\n${sessionKey}`;
}

export function buildAttentionSessionIndex(
    aggregate: AttentionAggregate | null
): Map<string, AggregatedAttentionSession> {
    return new Map((aggregate?.sessions || []).map(session => [
        getAttentionSessionLookupKey(session.projectId, session.sessionKey),
        session,
    ] as [string, AggregatedAttentionSession]));
}

export function withAttentionProjects<TProject extends { path?: string }>(
    projects: TProject[],
    aggregate: AttentionAggregate | null
): Array<TProject & { aiSessionAttentionCount: number; aiSessionAttentionEventIds: string[] }> {
    const summaries = new Map(
        getAttentionProjectSummaries(aggregate).map(summary => [summary.projectKey, summary] as const)
    );
    return (projects || []).map(project => {
        const summary = summaries.get(resolveAttentionProjectKey(project));
        return {
            ...project,
            aiSessionAttentionCount: summary?.attentionCount || 0,
            aiSessionAttentionEventIds: summary?.eventIds.slice() || [],
        };
    });
}

export function withAttentionProject<TProject extends { path?: string }>(
    project: TProject,
    aggregate: AttentionAggregate | null
): TProject & { aiSessionAttentionCount: number; aiSessionAttentionEventIds: string[] } {
    const projectKey = resolveAttentionProjectKey(project);
    const summary = getAttentionProjectSummaries(aggregate).find(candidate => candidate.projectKey === projectKey);
    return {
        ...project,
        aiSessionAttentionCount: summary?.attentionCount || 0,
        aiSessionAttentionEventIds: summary?.eventIds.slice() || [],
    };
}
