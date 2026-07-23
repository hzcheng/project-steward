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

export type AttentionSummary = Pick<AttentionProjectSummary, 'attentionCount' | 'eventIds' | 'sessions'>;

export function getLogicalAttentionSessionKey(sessionKey: string): string {
    const match = /^(codex|kimi|claude):(.+):\d+:(?:vscode|tmux)$/.exec(sessionKey || '');
    return match ? `${match[1]}:${match[2]}` : sessionKey;
}

function summarizeAttentionSessions(
    sourceSessions: readonly AggregatedAttentionSession[]
): AttentionSummary {
    const allEventIds = new Set<string>();
    const sessionEventIds = new Map<string, Set<string>>();
    for (const session of sourceSessions) {
        const sessionKey = getLogicalAttentionSessionKey(session.sessionKey);
        let events = sessionEventIds.get(sessionKey);
        if (!events) {
            events = new Set<string>();
            sessionEventIds.set(sessionKey, events);
        }
        for (const eventId of session.eventIds || []) {
            if (eventId) {
                events.add(eventId);
                allEventIds.add(eventId);
            }
        }
    }

    const sessions = Array.from(sessionEventIds.entries())
        .map(([sessionKey, events]) => {
            const eventIds = Array.from(events).sort();
            return {
                sessionKey,
                eventId: eventIds[0] || sessionKey,
                eventIds,
            };
        })
        .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));

    return {
        attentionCount: sessions.length,
        eventIds: Array.from(allEventIds).sort(),
        sessions,
    };
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

export function getAttentionProjectKeys(projectPaths: readonly string[]): string[] {
    return Array.from(new Set((projectPaths || [])
        .map(projectPath => getAttentionProjectKey(getAttentionProjectPath(projectPath)))
        .filter(Boolean)))
        .sort();
}

export function getAttentionSummaryForProjectKeys(
    projectKeys: readonly string[],
    aggregate: AttentionAggregate | null
): AttentionSummary {
    const selectedProjectKeys = new Set((projectKeys || []).filter(Boolean));
    return summarizeAttentionSessions(
        (aggregate?.sessions || []).filter(session => selectedProjectKeys.has(session.projectId))
    );
}

export function getAttentionProjectSummaries(aggregate: AttentionAggregate | null): AttentionProjectSummary[] {
    const sessionsByProject = new Map<string, AggregatedAttentionSession[]>();
    for (const session of aggregate?.sessions || []) {
        let projectSessions = sessionsByProject.get(session.projectId);
        if (!projectSessions) {
            projectSessions = [];
            sessionsByProject.set(session.projectId, projectSessions);
        }
        projectSessions.push(session);
    }

    return Array.from(sessionsByProject.entries())
        .map(([projectKey, sessions]) => ({
            projectKey,
            ...summarizeAttentionSessions(sessions),
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
