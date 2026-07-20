'use strict';

import type { AiSessionProviderId } from '../models';
import { findPendingAiSessionTerminalMatch } from './pendingTerminals';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import {
    aiSessionRuntimeIdentitiesEqual,
    cloneAiSessionRuntimeIdentity,
    isValidAiSessionRuntimeIdentity,
} from './runtimeTypes';
import type { AiSessionProviderDefinition, AiSessionReadResult } from './types';

type AiSessionPendingRuntimeProvider = Pick<
    AiSessionProviderDefinition,
    'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'
>;

export interface PendingAiSessionRuntimeCoordinator<TTerminal = unknown> {
    promotePending(
        identity: AiSessionPendingRuntimeSnapshot<TTerminal>['identity'] & { pendingId: string },
        sessionId: string
    ): AiSessionRuntimeSnapshot<TTerminal>[] | Promise<AiSessionRuntimeSnapshot<TTerminal>[]>;
}

export type PendingAiSessionPromotionFailureReason =
    | 'missing-runtime'
    | 'ambiguous-runtime'
    | 'conflict'
    | 'invalid-runtime'
    | 'non-active-runtime'
    | 'identity-mismatch'
    | 'stale-pending'
    | 'promotion-error';

export interface PendingAiSessionPromotionSettlement {
    failureReason: PendingAiSessionPromotionFailureReason | null;
}

export type PendingAiSessionPromotionSettler<TTerminal = unknown> = (
    pendingRuntime: AiSessionPendingRuntimeSnapshot<TTerminal>,
    sessionId: string
) => PendingAiSessionPromotionSettlement | Promise<PendingAiSessionPromotionSettlement>;

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
    settlePending?: PendingAiSessionPromotionSettler<TTerminal>;
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
    const attemptedPendingIdentityKeys = new Set<string>();
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
        const pendingIdentityKey = getPendingIdentityKey(pendingRuntime);
        if (attemptedPendingIdentityKeys.has(pendingIdentityKey)) {
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

        attemptedPendingIdentityKeys.add(pendingIdentityKey);
        result.attempted++;
        const promotionIdentity = {
            pendingId,
            provider: pendingRuntime.identity.provider,
            sessionId: session.id,
        };
        let settlement: PendingAiSessionPromotionSettlement;
        try {
            const pendingSettlement = options.settlePending
                ? options.settlePending(pendingRuntime, session.id)
                : settlePendingAiSessionPromotion(options, pendingRuntime, session.id);
            settlement = isPromiseLike(pendingSettlement) ? await pendingSettlement : pendingSettlement;
        } catch (_error) {
            result.failures.push({ ...promotionIdentity, reason: 'promotion-error' });
            continue;
        }
        if (settlement.failureReason) {
            result.failures.push({ ...promotionIdentity, reason: settlement.failureReason });
            continue;
        }

        claimedSessionKeys.add(options.getSessionKey(pendingRuntime.identity.provider, session.id));
        result.promoted.push(promotionIdentity);
    }

    if (result.promoted.length) {
        options.syncActiveRuntime();
    }
    return result;
}

function getPendingIdentityKey<TTerminal>(runtime: AiSessionPendingRuntimeSnapshot<TTerminal>): string {
    return JSON.stringify([
        runtime.identity.provider,
        runtime.identity.workspaceScopeIdentity,
        runtime.identity.workspaceNavigationIdentity,
        runtime.identity.workspaceRootHostPaths.slice().sort(),
        runtime.identity.cwd,
        runtime.identity.pendingId || '',
    ]);
}

function settlePendingAiSessionPromotion<TTerminal>(
    options: ResolvePendingAiSessionTerminalsOptions<TTerminal>,
    pendingRuntime: AiSessionPendingRuntimeSnapshot<TTerminal>,
    sessionId: string
): PendingAiSessionPromotionSettlement | Promise<PendingAiSessionPromotionSettlement> {
    const promotion = options.runtimeCoordinator.promotePending(
        cloneAiSessionRuntimeIdentity(pendingRuntime.identity) as typeof pendingRuntime.identity & { pendingId: string },
        sessionId
    );
    const settle = (runtimes: unknown): PendingAiSessionPromotionSettlement => {
        const failureReason = getPendingAiSessionPromotionFailureReason(
            runtimes,
            pendingRuntime.identity,
            sessionId
        );
        if (!failureReason) {
            options.setAlias(pendingRuntime.identity.provider, sessionId, pendingRuntime.title);
        }
        return { failureReason };
    };
    return isPromiseLike(promotion) ? promotion.then(settle) : settle(promotion);
}

export function getPendingAiSessionPromotionFailureReason(
    runtimes: unknown,
    pendingIdentity: AiSessionPendingRuntimeSnapshot['identity'],
    sessionId: string
): PendingAiSessionPromotionFailureReason | null {
    if (!Array.isArray(runtimes) || runtimes.length === 0) {
        return 'missing-runtime';
    }
    if (runtimes.some(runtime => isRecord(runtime) && runtime.state === 'conflict')) {
        return 'conflict';
    }
    if (runtimes.length !== 1) {
        return 'ambiguous-runtime';
    }
    const runtime = runtimes[0];
    if (!isRuntimeSnapshot(runtime)) {
        return 'invalid-runtime';
    }
    if (runtime.state !== 'active') {
        return 'non-active-runtime';
    }
    const expectedIdentity = {
        ...cloneAiSessionRuntimeIdentity(pendingIdentity),
        pendingId: undefined,
        sessionId,
    };
    if (!aiSessionRuntimeIdentitiesEqual(runtime.identity, expectedIdentity)) {
        return 'identity-mismatch';
    }
    return null;
}

function isRuntimeSnapshot(value: unknown): value is AiSessionRuntimeSnapshot<unknown> {
    if (!isRecord(value) || !isRecord(value.identity)) {
        return false;
    }
    return isValidAiSessionRuntimeIdentity(value.identity)
        && typeof value.identity.sessionId === 'string'
        && (value.backend === 'vscode' || value.backend === 'tmux')
        && typeof value.state === 'string'
        && typeof value.markerPath === 'string'
        && typeof value.runStartedAtMs === 'number'
        && typeof value.attached === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object';
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return !!value && typeof (value as Promise<T>).then === 'function';
}

function clonePendingRuntime<TTerminal>(
    runtime: AiSessionPendingRuntimeSnapshot<TTerminal>
): AiSessionPendingRuntimeSnapshot<TTerminal> {
    return {
        ...runtime,
        identity: cloneAiSessionRuntimeIdentity(runtime.identity),
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        state: 'pending',
        excludedSessionIds: [...runtime.excludedSessionIds],
    };
}
