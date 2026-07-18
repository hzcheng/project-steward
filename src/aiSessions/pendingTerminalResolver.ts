'use strict';

import type { AiSessionProviderId } from '../models';
import { findPendingAiSessionTerminalMatch } from './pendingTerminals';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import type { AiSessionProviderDefinition, AiSessionReadResult } from './types';

type AiSessionPendingRuntimeProvider = Pick<
    AiSessionProviderDefinition,
    'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'
>;

export interface PendingAiSessionRuntimeCoordinator<TTerminal = unknown> {
    promotePending(pendingId: string, sessionId: string): Promise<AiSessionRuntimeSnapshot<TTerminal>[]>;
}

export interface ResolvePendingAiSessionTerminalsOptions<TTerminal = unknown> {
    pendingRuntimes: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[];
    activeRuntimes: readonly AiSessionRuntimeSnapshot<TTerminal>[];
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>;
    providers: readonly AiSessionPendingRuntimeProvider[];
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    runtimeCoordinator: PendingAiSessionRuntimeCoordinator<TTerminal>;
    setAlias: (providerId: AiSessionProviderId, sessionId: string, alias: string) => void;
    syncActiveRuntime: () => void;
    claimedSessionKeys?: ReadonlySet<string>;
}

export async function resolvePendingAiSessionTerminals<TTerminal = unknown>(
    options: ResolvePendingAiSessionTerminalsOptions<TTerminal>
): Promise<boolean> {
    const pendingRuntimes = options.pendingRuntimes.map(clonePendingRuntime);
    if (!pendingRuntimes.length) {
        return false;
    }

    const claimedSessionKeys = new Set(options.claimedSessionKeys || []);
    for (const runtime of options.activeRuntimes) {
        if (runtime.identity.sessionId) {
            claimedSessionKeys.add(options.getSessionKey(
                runtime.identity.provider,
                runtime.identity.sessionId
            ));
        }
    }

    let matchedPendingRuntime = false;
    for (const pendingRuntime of pendingRuntimes) {
        const pendingId = pendingRuntime.identity.pendingId;
        const sessionResult = options.sessionResults[pendingRuntime.identity.provider];
        if (!pendingId || !sessionResult) {
            continue;
        }
        const session = findPendingAiSessionTerminalMatch(
            pendingRuntime,
            sessionResult,
            claimedSessionKeys,
            options.getSessionKey,
            options.providers
        );
        if (!session) {
            continue;
        }

        await options.runtimeCoordinator.promotePending(pendingId, session.id);
        options.setAlias(pendingRuntime.identity.provider, session.id, pendingRuntime.title);
        claimedSessionKeys.add(options.getSessionKey(pendingRuntime.identity.provider, session.id));
        matchedPendingRuntime = true;
    }

    if (matchedPendingRuntime) {
        options.syncActiveRuntime();
    }
    return matchedPendingRuntime;
}

function clonePendingRuntime<TTerminal>(
    runtime: AiSessionPendingRuntimeSnapshot<TTerminal>
): AiSessionPendingRuntimeSnapshot<TTerminal> {
    return {
        ...runtime,
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        state: 'pending',
        excludedSessionIds: [...runtime.excludedSessionIds],
    };
}
