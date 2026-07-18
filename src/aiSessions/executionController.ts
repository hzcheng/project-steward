'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionLifecycleRequest, AiSessionLifecycleSignal } from './lifecycle';
import AiSessionExecutionMonitor from './executionMonitor';
import type { AiSessionExecutionSnapshot } from './executionMonitor';
import { getAiSessionKey } from './sessionHelpers';
import type { AiSessionActiveTerminalRuntime } from './types';

export interface AiSessionExecutionProvider {
    id: AiSessionProviderId;
    service: {
        getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal>;
    };
}

export interface AiSessionExecutionControllerOptions {
    getActiveSessions: () => AiSessionActiveTerminalRuntime[];
    getProviders: () => AiSessionExecutionProvider[];
    getSessionKey?: (providerId: AiSessionProviderId, sessionId: string) => string;
    scheduleRefresh: (reason: string) => void;
    nowMs: () => number;
}

export class AiSessionExecutionController {
    private readonly monitor: AiSessionExecutionMonitor;

    constructor(private readonly options: AiSessionExecutionControllerOptions) {
        this.monitor = new AiSessionExecutionMonitor({ now: options.nowMs });
    }

    evaluate(): void {
        const activeSessions = this.options.getActiveSessions();
        const providers = this.options.getProviders();
        const requestsByProvider = new Map<AiSessionProviderId, AiSessionLifecycleRequest[]>(
            providers.map(provider => [provider.id, []])
        );
        for (const session of activeSessions) {
            requestsByProvider.get(session.provider)?.push({
                sessionId: session.sessionId,
                runStartedAtMs: session.runStartedAtMs,
            });
        }

        const signalsByProvider = new Map<AiSessionProviderId, Record<string, AiSessionLifecycleSignal>>();
        for (const provider of providers) {
            const requests = requestsByProvider.get(provider.id) || [];
            signalsByProvider.set(
                provider.id,
                requests.length ? provider.service.getLifecycleSignals(requests) : {}
            );
        }

        const changedKeys = this.monitor.evaluate(activeSessions.map(session => ({
            key: this.getSessionKey(session.provider, session.sessionId),
            signal: signalsByProvider.get(session.provider)?.[session.sessionId],
        })));
        if (changedKeys.length) {
            this.options.scheduleRefresh('execution');
        }
    }

    getSnapshot(): Record<string, AiSessionExecutionSnapshot> {
        return this.monitor.getSnapshot();
    }

    private getSessionKey(providerId: AiSessionProviderId, sessionId: string): string {
        return this.options.getSessionKey
            ? this.options.getSessionKey(providerId, sessionId)
            : getAiSessionKey(providerId, sessionId);
    }
}
