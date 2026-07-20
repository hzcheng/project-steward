'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import { compareAiSessionUpdatedAt } from './sessionHelpers';
import { normalizeAiSessionProjectPath } from './projectCandidates';
import { getAiSessionComparableCwd } from './sessionPaths';
import type { AiSessionPendingRuntimeSnapshot } from './runtimeTypes';
import type { AiSessionProviderDefinition, AiSessionReadResult } from './types';

type AiSessionPendingTerminalProvider = Pick<
    AiSessionProviderDefinition,
    'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'
>;

export type PendingAiSessionRuntimeMatchInput = Pick<
    AiSessionPendingRuntimeSnapshot,
    'identity' | 'createdAt' | 'excludedSessionIds'
>;

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
    pendingRuntime: PendingAiSessionRuntimeMatchInput,
    sessionResult: AiSessionReadResult,
    claimedSessionKeys: Set<string>,
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string,
    providers: readonly AiSessionPendingTerminalProvider[]
): CodexSession {
    if (!sessionResult.available) {
        return null;
    }

    const providerId = pendingRuntime.identity.provider;
    const comparableCwd = normalizeAiSessionProjectPath(pendingRuntime.identity.cwd);
    const createdAt = Date.parse(pendingRuntime.createdAt);
    if (!comparableCwd || !Number.isFinite(createdAt)) {
        return null;
    }
    return sessionResult.sessions
        .filter(session => {
            const sessionKey = getSessionKey(providerId, session.id);
            const sessionCwd = normalizeAiSessionProjectPath(getAiSessionComparableCwd(providerId, session, providers));
            const updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
            return sessionCwd === comparableCwd
                && !pendingRuntime.excludedSessionIds.includes(session.id)
                && !claimedSessionKeys.has(sessionKey)
                && !isNaN(updatedAt)
                && updatedAt >= createdAt;
        })
        .sort((a, b) => compareAiSessionUpdatedAt(a.updatedAt, b.updatedAt))[0] || null;
}
