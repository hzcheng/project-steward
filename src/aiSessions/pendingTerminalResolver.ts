'use strict';

import type { AiSessionProviderId } from '../models';
import { findPendingAiSessionTerminalMatch, PendingAiSessionTerminalMatchInput } from './pendingTerminals';
import type { AiSessionProviderDefinition, AiSessionReadResult, AiSessionTerminalEntry } from './types';

type AiSessionPendingTerminalProvider = Pick<
    AiSessionProviderDefinition,
    'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'
>;

export interface PendingAiSessionTerminalResolution<TTerminal = unknown> extends PendingAiSessionTerminalMatchInput {
    terminal: TTerminal;
    markerPath: string;
    title?: string;
}

export interface PendingAiSessionTerminalService<TTerminal = unknown> {
    getPendingTerminals(): PendingAiSessionTerminalResolution<TTerminal>[];
    getTrackedSessionKeys(getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string): Set<string>;
    track(providerId: AiSessionProviderId, sessionId: string, entry: AiSessionTerminalEntry<TTerminal>): void;
    replacePendingTerminals(pendingTerminals: PendingAiSessionTerminalResolution<TTerminal>[]): void;
}

export interface ResolvePendingAiSessionTerminalsOptions<TTerminal = unknown> {
    terminalService: PendingAiSessionTerminalService<TTerminal>;
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>;
    providers: readonly AiSessionPendingTerminalProvider[];
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    setAlias: (providerId: AiSessionProviderId, sessionId: string, alias: string) => void;
    syncActiveTerminal: () => void;
}

export function resolvePendingAiSessionTerminals<TTerminal = unknown>(
    options: ResolvePendingAiSessionTerminalsOptions<TTerminal>
): boolean {
    let pendingTerminals = options.terminalService.getPendingTerminals();
    if (!pendingTerminals.length) {
        return false;
    }

    let remainingPendingTerminals: PendingAiSessionTerminalResolution<TTerminal>[] = [];
    let claimedSessionKeys = options.terminalService.getTrackedSessionKeys(options.getSessionKey);
    let matchedPendingTerminal = false;

    for (let pendingTerminal of pendingTerminals) {
        let sessionResult = options.sessionResults[pendingTerminal.provider];
        let session = findPendingAiSessionTerminalMatch(
            pendingTerminal,
            sessionResult,
            claimedSessionKeys,
            options.getSessionKey,
            options.providers
        );
        if (!session) {
            remainingPendingTerminals.push(pendingTerminal);
            continue;
        }

        options.terminalService.track(pendingTerminal.provider, session.id, {
            terminal: pendingTerminal.terminal,
            markerPath: pendingTerminal.markerPath,
            runStartedAtMs: Date.parse(pendingTerminal.createdAt),
        });
        options.setAlias(pendingTerminal.provider, session.id, pendingTerminal.title);
        claimedSessionKeys.add(options.getSessionKey(pendingTerminal.provider, session.id));
        matchedPendingTerminal = true;
    }

    options.terminalService.replacePendingTerminals(remainingPendingTerminals);
    if (matchedPendingTerminal) {
        options.syncActiveTerminal();
    }

    return matchedPendingTerminal;
}
