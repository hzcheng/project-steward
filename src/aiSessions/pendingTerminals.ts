'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import { compareAiSessionUpdatedAt } from './sessionHelpers';
import { normalizeAiSessionProjectPath } from './projectCandidates';
import { getAiSessionComparableCwd } from './sessionPaths';
import type { AiSessionProviderDefinition, AiSessionReadResult } from './types';

type AiSessionPendingTerminalProvider = Pick<
    AiSessionProviderDefinition,
    'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'
>;

export interface PendingAiSessionTerminalMatchInput {
    provider: AiSessionProviderId;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
}

export function getAiSessionIdsForCwd(
    providerId: AiSessionProviderId,
    sessionResult: AiSessionReadResult,
    cwd: string,
    providers: readonly AiSessionPendingTerminalProvider[]
): string[] {
    let comparableCwd = normalizeAiSessionProjectPath(cwd);
    if (!sessionResult.available || !comparableCwd) {
        return [];
    }

    return sessionResult.sessions
        .filter(session => normalizeAiSessionProjectPath(getAiSessionComparableCwd(providerId, session, providers)) === comparableCwd)
        .map(session => session.id)
        .filter(id => !!id);
}

export function findPendingAiSessionTerminalMatch(
    pendingTerminal: PendingAiSessionTerminalMatchInput,
    sessionResult: AiSessionReadResult,
    claimedSessionKeys: Set<string>,
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string,
    providers: readonly AiSessionPendingTerminalProvider[]
): CodexSession {
    if (!sessionResult.available) {
        return null;
    }

    let createdAt = Date.parse(pendingTerminal.createdAt);
    return sessionResult.sessions
        .filter(session => {
            let sessionKey = getSessionKey(pendingTerminal.provider, session.id);
            let sessionCwd = normalizeAiSessionProjectPath(getAiSessionComparableCwd(pendingTerminal.provider, session, providers));
            let updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
            return sessionCwd === pendingTerminal.cwd
                && !pendingTerminal.excludedSessionIds.includes(session.id)
                && !claimedSessionKeys.has(sessionKey)
                && !isNaN(updatedAt)
                && updatedAt >= createdAt;
        })
        .sort((a, b) => compareAiSessionUpdatedAt(a.updatedAt, b.updatedAt))[0] || null;
}
