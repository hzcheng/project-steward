'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { AiSessionAssignmentCandidate, AiSessionReadResult } from './types';

export function getAiSessionKey(providerId: AiSessionProviderId, sessionId: string): string {
    return `${providerId}:${sessionId}`;
}

export function getAiSessionProviderIdFromKey(sessionKey: string, isProviderId: (value: string) => value is AiSessionProviderId): AiSessionProviderId {
    let separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) {
        return null;
    }

    let providerId = sessionKey.substring(0, separatorIndex);
    return isProviderId(providerId) ? providerId : null;
}

export function normalizeAiSessionComparablePath(value: string): string {
    if (!value) {
        return '';
    }

    return decodeAiSessionPath(value)
        .replace(/\\/g, '/')
        .replace(/\/+$/g, '');
}

function decodeAiSessionPath(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value;
    }
}

export function aiSessionPathContains(projectPath: string, sessionPath: string): boolean {
    projectPath = normalizeAiSessionComparablePath(projectPath);
    sessionPath = normalizeAiSessionComparablePath(sessionPath);
    if (!projectPath || !sessionPath) {
        return false;
    }

    return sessionPath === projectPath || sessionPath.startsWith(`${projectPath}/`);
}

export function assignAiSessionsToProjects<TProject extends { id: string }>(
    candidates: AiSessionAssignmentCandidate<TProject>[],
    sessions: CodexSession[],
    getSessionPath: (session: CodexSession) => string
): Map<string, CodexSession[]> {
    let assignments = new Map<string, CodexSession[]>();
    if (!sessions.length || !candidates.length) {
        return assignments;
    }

    let normalizedCandidates = candidates
        .map(candidate => ({
            ...candidate,
            path: normalizeAiSessionComparablePath(candidate.path),
        }))
        .filter(candidate => !!candidate.path);

    for (let session of sessions) {
        let sessionPath = normalizeAiSessionComparablePath(getSessionPath(session));
        if (!sessionPath) {
            continue;
        }

        let bestMatch = normalizedCandidates
            .filter(candidate => aiSessionPathContains(candidate.path, sessionPath))
            .sort((a, b) => b.path.length - a.path.length)[0];

        if (!bestMatch) {
            continue;
        }

        let projectSessions = assignments.get(bestMatch.project.id) || [];
        projectSessions.push(session);
        assignments.set(bestMatch.project.id, projectSessions);
    }

    return assignments;
}

export function normalizeAiSessionCandidatePaths(candidatePaths: string[] = []): string[] {
    let seen = new Set<string>();

    return candidatePaths
        .map(candidatePath => normalizeAiSessionComparablePath(candidatePath))
        .filter(candidatePath => {
            if (!candidatePath || seen.has(candidatePath)) {
                return false;
            }

            seen.add(candidatePath);
            return true;
        });
}

export function filterAiSessionsByCandidatePaths(result: AiSessionReadResult, candidatePaths: string[], getSessionPath: (session: CodexSession) => string): AiSessionReadResult {
    let normalizedCandidates = normalizeAiSessionCandidatePaths(candidatePaths);
    if (!normalizedCandidates.length) {
        return result;
    }

    return {
        available: result.available,
        sessions: result.sessions.filter(session => {
            let sessionPath = normalizeAiSessionComparablePath(getSessionPath(session));
            return !!sessionPath && normalizedCandidates.some(candidatePath => aiSessionPathContains(candidatePath, sessionPath));
        }),
    };
}

export function prepareAiSessionsForDisplay(sessions: CodexSession[], providerId: AiSessionProviderId, pinnedSessions: Set<string>, aliases: Record<string, string>, limit: number = 20): CodexSession[] {
    let sortedSessions = sessions
        .map(session => {
            let sessionKey = getAiSessionKey(providerId, session.id);
            return {
                ...session,
                name: aliases[sessionKey] || session.name,
                provider: providerId,
                pinned: pinnedSessions.has(sessionKey),
            };
        })
        .sort((a, b) => {
            if (a.pinned !== b.pinned) {
                return a.pinned ? -1 : 1;
            }

            return compareAiSessionUpdatedAt(b.updatedAt, a.updatedAt);
        });

    let pinned = sortedSessions.filter(session => session.pinned);
    let recent = sortedSessions.filter(session => !session.pinned).slice(0, Math.max(limit - pinned.length, 0));

    return pinned.concat(recent);
}

export function compareAiSessionUpdatedAt(a: string, b: string): number {
    let aTime = a ? Date.parse(a) : 0;
    let bTime = b ? Date.parse(b) : 0;

    if (isNaN(aTime) && isNaN(bTime)) {
        return 0;
    }

    if (isNaN(aTime)) {
        return -1;
    }

    if (isNaN(bTime)) {
        return 1;
    }

    return aTime - bTime;
}
