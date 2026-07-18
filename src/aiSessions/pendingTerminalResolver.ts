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
    promotePending(
        pendingId: string,
        sessionId: string
    ): AiSessionRuntimeSnapshot<TTerminal>[] | Promise<AiSessionRuntimeSnapshot<TTerminal>[]>;
}

export type PendingAiSessionPromotionFailureReason =
    | 'missing-runtime'
    | 'ambiguous-runtime'
    | 'conflict'
    | 'identity-mismatch'
    | 'promotion-error';

export interface PendingAiSessionPromotionIdentity {
    pendingId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface PendingAiSessionPromotionFailure extends PendingAiSessionPromotionIdentity {
    reason: PendingAiSessionPromotionFailureReason;
}

export interface ResolvePendingAiSessionTerminalsResult {
    attempted: number;
    promoted: PendingAiSessionPromotionIdentity[];
    failures: PendingAiSessionPromotionFailure[];
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
): Promise<ResolvePendingAiSessionTerminalsResult> {
    const pendingRuntimes = options.pendingRuntimes.map(clonePendingRuntime);
    const result: ResolvePendingAiSessionTerminalsResult = {
        attempted: 0,
        promoted: [],
        failures: [],
    };
    if (!pendingRuntimes.length) {
        return result;
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

        result.attempted++;
        const promotionIdentity = {
            pendingId,
            provider: pendingRuntime.identity.provider,
            sessionId: session.id,
        };
        let promotedRuntimes: AiSessionRuntimeSnapshot<TTerminal>[];
        try {
            const promotion = options.runtimeCoordinator.promotePending(pendingId, session.id);
            promotedRuntimes = isPromiseLike(promotion) ? await promotion : promotion;
        } catch (_error) {
            result.failures.push({ ...promotionIdentity, reason: 'promotion-error' });
            continue;
        }
        const failureReason = getPromotionFailureReason(
            promotedRuntimes,
            pendingRuntime.identity.provider,
            session.id
        );
        if (failureReason) {
            result.failures.push({ ...promotionIdentity, reason: failureReason });
            continue;
        }

        options.setAlias(pendingRuntime.identity.provider, session.id, pendingRuntime.title);
        claimedSessionKeys.add(options.getSessionKey(pendingRuntime.identity.provider, session.id));
        result.promoted.push(promotionIdentity);
    }

    if (result.promoted.length) {
        options.syncActiveRuntime();
    }
    return result;
}

function getPromotionFailureReason<TTerminal>(
    runtimes: readonly AiSessionRuntimeSnapshot<TTerminal>[],
    provider: AiSessionProviderId,
    sessionId: string
): PendingAiSessionPromotionFailureReason | null {
    if (!Array.isArray(runtimes) || runtimes.length === 0) {
        return 'missing-runtime';
    }
    if (runtimes.length !== 1) {
        return 'ambiguous-runtime';
    }
    const runtime = runtimes[0];
    if (runtime.state === 'conflict') {
        return 'conflict';
    }
    if (runtime.identity.provider !== provider || runtime.identity.sessionId !== sessionId) {
        return 'identity-mismatch';
    }
    return null;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return !!value && typeof (value as Promise<T>).then === 'function';
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
