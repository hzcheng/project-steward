'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type { AttentionAggregate } from './attentionAggregate';
import { aggregateAttentionSnapshots } from './attentionAggregate';
import type { AttentionPayloadItem } from './attentionPayload';
import AiSessionAttentionMonitor from './attentionMonitor';
import type { AiSessionAttentionSnapshot } from './attentionMonitor';
import type { AiSessionLifecycleRequest, AiSessionLifecycleSignal } from './lifecycle';
import { getAttentionProjectSummaries } from './attentionProject';
import type { AttentionProjectSummary } from './attentionProject';
import { getAiSessionKey } from './sessionHelpers';

export interface AiSessionAttentionRuntimeEntry {
    runStartedAtMs: number;
    state: 'pending' | 'active' | 'completed' | 'stopped' | 'conflict';
}

export interface AiSessionAttentionProvider {
    id: AiSessionProviderId;
    projectSessionsKey: 'codexSessions' | 'kimiSessions' | 'claudeSessions';
    service: {
        getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal>;
    };
}

export interface AiSessionAttentionControllerOptions<TRuntime extends AiSessionAttentionRuntimeEntry = AiSessionAttentionRuntimeEntry> {
    isEnabled: () => boolean;
    getOpenProjects: () => Project[];
    getProviders: () => AiSessionAttentionProvider[];
    getSessionKey?: (providerId: AiSessionProviderId, sessionId: string) => string;
    getProjectKey: (project: Project) => string;
    getRuntimeById: (providerId: AiSessionProviderId, sessionId: string) => TRuntime | null;
    isRuntimeComplete: (runtime: TRuntime) => boolean;
    publish: (items: AttentionPayloadItem[], forceHeartbeat?: boolean) => Promise<boolean>;
    scheduleRefresh: (reason: string) => void;
    postProjectsUpdated: (projects: AttentionProjectSummary[]) => void;
    nowMs: () => number;
}

export interface AiSessionAttentionEvaluation {
    enabled: boolean;
    published: boolean;
    inScopeSessionKeys: string[];
    eventIdsBySession: Record<string, string[]>;
}

export interface AiSessionAttentionRuntimeOverride<TRuntime> {
    providerId: AiSessionProviderId;
    sessionId: string;
    attentionKey?: string;
    runtime: TRuntime;
}

export class AiSessionAttentionController<TRuntime extends AiSessionAttentionRuntimeEntry = AiSessionAttentionRuntimeEntry> {
    private readonly monitor: AiSessionAttentionMonitor;
    private remoteAggregate: AttentionAggregate | null = null;
    private localItems: AttentionPayloadItem[] = [];
    private attentionKeysBySession = new Map<string, string[]>();

    constructor(private readonly options: AiSessionAttentionControllerOptions<TRuntime>) {
        this.monitor = new AiSessionAttentionMonitor({ now: options.nowMs });
    }

    async evaluate(
        runtimeOverrides: readonly AiSessionAttentionRuntimeOverride<TRuntime>[] = []
    ): Promise<AiSessionAttentionEvaluation> {
        if (!this.options.isEnabled()) {
            this.monitor.evaluate([]);
            this.remoteAggregate = null;
            this.localItems = [];
            this.attentionKeysBySession.clear();
            const published = await this.options.publish([], true);
            this.options.scheduleRefresh('attention');
            this.postProjectsUpdated();
            return {
                enabled: false,
                published,
                inScopeSessionKeys: [],
                eventIdsBySession: {},
            };
        }

        const projects = this.options.getOpenProjects();
        const providers = this.options.getProviders();
        const ownedSessions = this.getOwnedSessions(projects, providers, runtimeOverrides);
        this.attentionKeysBySession.clear();
        for (const [attentionKey, owned] of ownedSessions) {
            const keys = this.attentionKeysBySession.get(owned.baseSessionKey) || [];
            keys.push(attentionKey);
            this.attentionKeysBySession.set(owned.baseSessionKey, keys);
        }
        const signalsByProvider = this.getSignalsByProvider(providers, ownedSessions);
        const inputs = Array.from(ownedSessions, ([key, owned]) => {
            const signal = this.options.isRuntimeComplete(owned.runtime)
                ? {
                    token: `terminal-exit:${owned.runtime.runStartedAtMs}`,
                    phase: 'needsAttention' as const,
                    reason: 'completed' as const,
                    executionState: 'stopped' as const,
                    occurredAtMs: owned.runtime.runStartedAtMs,
                }
                : signalsByProvider[owned.providerId][owned.session.id];
            return {
                key,
                signal,
                observedAt: signal?.occurredAtMs,
            };
        });

        if (this.monitor.evaluate(inputs).length) {
            this.options.scheduleRefresh('attention');
        }

        this.localItems = this.buildLocalItems(projects, providers);
        if (!this.remoteAggregate) {
            this.postProjectsUpdated();
        }
        const published = await this.options.publish(this.localItems);
        return {
            enabled: true,
            published,
            inScopeSessionKeys: [...ownedSessions.keys()].sort(),
            eventIdsBySession: groupEventIdsBySession(this.localItems),
        };
    }

    acknowledge(eventIds: string[]): void {
        this.monitor.acknowledge(eventIds);
        this.localItems = this.buildLocalItems(this.options.getOpenProjects(), this.options.getProviders());
    }

    setRemoteAggregate(aggregate: AttentionAggregate): boolean {
        if (aggregate.aggregateRevision === this.remoteAggregate?.aggregateRevision) {
            return false;
        }

        this.remoteAggregate = aggregate;
        return true;
    }

    hasRemoteAggregate(): boolean {
        return Boolean(this.remoteAggregate);
    }

    getEffectiveAggregate(): AttentionAggregate {
        if (this.remoteAggregate) {
            return this.remoteAggregate;
        }

        const now = this.options.nowMs();
        return aggregateAttentionSnapshots([{
            version: 1,
            generatedAtMs: now,
            items: this.localItems,
            instanceId: '00000000000000000000000000000000',
            sequence: 0,
            heartbeat: 0,
        }], new Set<string>(), now);
    }

    getLocalSnapshot(): Record<string, AiSessionAttentionSnapshot> {
        return this.monitor.getSnapshot();
    }

    getRecoverySessionEvents(): Array<{ sessionKey: string; eventIds: string[] }> {
        const bySession = new Map<string, Set<string>>();
        const addEvent = (sessionKey: string, eventId: string) => {
            if (!sessionKey || !eventId) {
                return;
            }
            const eventIds = bySession.get(sessionKey) || new Set<string>();
            eventIds.add(eventId);
            bySession.set(sessionKey, eventIds);
        };

        Object.entries(this.monitor.getSnapshot()).forEach(([sessionKey, snapshot]) => {
            if (snapshot.event?.eventId) {
                addEvent(sessionKey, snapshot.event.eventId);
            }
        });
        this.getEffectiveAggregate().sessions.forEach(session => {
            session.eventIds.forEach(eventId => addEvent(session.sessionKey, eventId));
        });
        return Array.from(bySession.entries())
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .slice(0, 1000)
            .map(([sessionKey, eventIds]) => ({ sessionKey, eventIds: Array.from(eventIds).slice(0, 1000) }));
    }

    getAttentionEventIds(): string[] {
        return Array.from(new Set([
            ...Object.values(this.monitor.getSnapshot())
                .map(snapshot => snapshot.event?.eventId)
                .filter((id): id is string => Boolean(id)),
            ...this.getEffectiveAggregate().sessions
                .reduce((eventIds, item) => eventIds.concat(item.eventIds), [] as string[]),
        ]));
    }

    getProjectSummaries(): AttentionProjectSummary[] {
        return getAttentionProjectSummaries(this.getEffectiveAggregate());
    }

    private postProjectsUpdated(): void {
        this.options.postProjectsUpdated(this.getProjectSummaries());
    }

    private getOwnedSessions(
        projects: Project[],
        providers: AiSessionAttentionProvider[],
        runtimeOverrides: readonly AiSessionAttentionRuntimeOverride<TRuntime>[]
    ): Map<string, {
        providerId: AiSessionProviderId;
        session: CodexSession;
        runtime: TRuntime;
        baseSessionKey: string;
    }> {
        const ownedSessions = new Map<string, {
            providerId: AiSessionProviderId;
            session: CodexSession;
            runtime: TRuntime;
            baseSessionKey: string;
        }>();
        const overrides = new Map<string, Array<{ attentionKey: string; runtime: TRuntime }>>();
        for (const override of runtimeOverrides) {
            const baseSessionKey = override
                && this.getSessionKey(override.providerId, override.sessionId);
            if (baseSessionKey && override.runtime) {
                const entries = overrides.get(baseSessionKey) || [];
                entries.push({
                    attentionKey: override.attentionKey || baseSessionKey,
                    runtime: override.runtime,
                });
                overrides.set(baseSessionKey, entries);
            }
        }
        for (const project of projects) {
            for (const provider of providers) {
                for (const session of project[provider.projectSessionsKey] || []) {
                    const baseSessionKey = this.getSessionKey(provider.id, session.id);
                    const overridden = overrides.get(baseSessionKey);
                    if (overridden?.length) {
                        for (const entry of overridden) {
                            if (entry.runtime.state !== 'stopped'
                                && !ownedSessions.has(entry.attentionKey)) {
                                ownedSessions.set(entry.attentionKey, {
                                    providerId: provider.id,
                                    session,
                                    runtime: entry.runtime,
                                    baseSessionKey,
                                });
                            }
                        }
                        continue;
                    }
                    const runtime = this.options.getRuntimeById(provider.id, session.id);
                    if (!runtime || runtime.state === 'stopped' || ownedSessions.has(baseSessionKey)) {
                        continue;
                    }
                    ownedSessions.set(baseSessionKey, {
                        providerId: provider.id, session, runtime, baseSessionKey,
                    });
                }
            }
        }
        return ownedSessions;
    }

    private getSignalsByProvider(
        providers: AiSessionAttentionProvider[],
        ownedSessions: Map<string, {
            providerId: AiSessionProviderId;
            session: CodexSession;
            runtime: TRuntime;
            baseSessionKey: string;
        }>
    ): Record<AiSessionProviderId, Record<string, AiSessionLifecycleSignal>> {
        const requestsByProvider = providers.reduce((result, provider) => {
            result[provider.id] = [];
            return result;
        }, {} as Record<AiSessionProviderId, AiSessionLifecycleRequest[]>);
        for (const owned of ownedSessions.values()) {
            requestsByProvider[owned.providerId].push({
                sessionId: owned.session.id,
                runStartedAtMs: owned.runtime.runStartedAtMs,
            });
        }

        return providers.reduce((result, provider) => {
            const requests = requestsByProvider[provider.id];
            result[provider.id] = requests.length
                ? provider.service.getLifecycleSignals(requests)
                : {};
            return result;
        }, {} as Record<AiSessionProviderId, Record<string, AiSessionLifecycleSignal>>);
    }

    private buildLocalItems(projects: Project[], providers: AiSessionAttentionProvider[]): AttentionPayloadItem[] {
        const snapshot = this.monitor.getSnapshot();
        const items: AttentionPayloadItem[] = [];
        for (const project of projects) {
            const projectKey = this.options.getProjectKey(project);
            if (!projectKey) {
                continue;
            }
            for (const provider of providers) {
                for (const session of project[provider.projectSessionsKey] || []) {
                    const baseSessionKey = this.getSessionKey(provider.id, session.id);
                    const attentionKeys = this.attentionKeysBySession.get(baseSessionKey)
                        || [baseSessionKey];
                    for (const attentionKey of attentionKeys) {
                        const attention = snapshot[attentionKey];
                        if (!attention?.event) {
                            continue;
                        }
                        items.push({
                            projectId: projectKey,
                            sessionKey: attentionKey,
                            state: attention.state === 'needsAttention' ? 'needsAttention' : 'acknowledged',
                            eventId: attention.event.eventId,
                            reason: attention.event.reason,
                            observedAtMs: attention.stateChangedAt,
                        });
                    }
                }
            }
        }
        return items;
    }

    private getSessionKey(providerId: AiSessionProviderId, sessionId: string): string {
        return this.options.getSessionKey
            ? this.options.getSessionKey(providerId, sessionId)
            : getAiSessionKey(providerId, sessionId);
    }
}

function groupEventIdsBySession(items: readonly AttentionPayloadItem[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const item of items) {
        const eventIds = result[item.sessionKey] || [];
        if (!eventIds.includes(item.eventId)) {
            eventIds.push(item.eventId);
            eventIds.sort();
        }
        result[item.sessionKey] = eventIds;
    }
    return result;
}

export interface AiSessionRuntimeLifecycleCandidate {
    key: string;
    sessionKey?: string;
    state: 'completed' | 'stopped';
}

export type AiSessionRuntimeLifecycleFailureOperation =
    | 'evaluate'
    | 'acknowledge-published'
    | 'acknowledge-local'
    | 'release';

export interface SettleAiSessionRuntimeLifecyclesOptions<TCandidate extends AiSessionRuntimeLifecycleCandidate> {
    candidates: readonly TCandidate[];
    evaluateAttention: () => Promise<AiSessionAttentionEvaluation>;
    acknowledgePublished: (eventIds: string[]) => Promise<void>;
    acknowledgeLocal: (eventIds: string[]) => void;
    release: (candidate: TCandidate) => void | Promise<void>;
    reportFailure?: (
        operation: AiSessionRuntimeLifecycleFailureOperation,
        category: 'unexpected',
        key: string | undefined
    ) => void;
}

export interface AiSessionRuntimeLifecycleSettlementResult {
    releasedKeys: string[];
    retainedKeys: string[];
}

export function runAiSessionRuntimeLifecycleTask(
    operation: string,
    task: () => unknown | Promise<unknown>,
    reportFailure: (operation: string, category: 'unexpected') => unknown | Promise<unknown>
): Promise<void> {
    return Promise.resolve().then(task).then(() => undefined, async () => {
        try {
            await reportFailure(operation, 'unexpected');
        } catch (_reportError) {
            // A diagnostic reporter must not escape the safe lifecycle boundary.
        }
    });
}

export async function settleAiSessionRuntimeLifecycles<
    TCandidate extends AiSessionRuntimeLifecycleCandidate
>(
    options: SettleAiSessionRuntimeLifecyclesOptions<TCandidate>
): Promise<AiSessionRuntimeLifecycleSettlementResult> {
    const candidates = deduplicateLifecycleCandidates(options.candidates);
    let evaluation: AiSessionAttentionEvaluation;
    try {
        evaluation = await options.evaluateAttention();
    } catch (_error) {
        options.reportFailure?.('evaluate', 'unexpected', undefined);
        return {
            releasedKeys: [],
            retainedKeys: candidates.map(candidate => candidate.key).sort(),
        };
    }

    const inScope = new Set(evaluation.inScopeSessionKeys);
    const candidateSessionKey = (candidate: TCandidate): string => candidate.sessionKey || candidate.key;
    const safeToRelease = candidates.filter(candidate =>
        candidate.state === 'stopped' || !evaluation.enabled
        || !inScope.has(candidateSessionKey(candidate)));
    const completionWithEvents = candidates.filter(candidate => candidate.state === 'completed'
        && evaluation.enabled && inScope.has(candidateSessionKey(candidate))
        && evaluation.published
        && (evaluation.eventIdsBySession[candidateSessionKey(candidate)] || []).length > 0);
    const eventIds = Array.from(new Set(completionWithEvents.reduce((result, candidate) => {
        result.push(...evaluation.eventIdsBySession[candidateSessionKey(candidate)] || []);
        return result;
    }, [] as string[]))).sort();
    let acknowledgedCompletions: TCandidate[] = [];
    if (eventIds.length) {
        let publishedAcknowledged = false;
        try {
            await options.acknowledgePublished(eventIds);
            publishedAcknowledged = true;
        } catch (_error) {
            options.reportFailure?.('acknowledge-published', 'unexpected', undefined);
        }
        if (publishedAcknowledged) {
            try {
                options.acknowledgeLocal(eventIds);
                acknowledgedCompletions = completionWithEvents;
            } catch (_error) {
                options.reportFailure?.('acknowledge-local', 'unexpected', undefined);
            }
        }
    }

    const eligibleByKey = new Map<string, TCandidate>();
    for (const candidate of [...safeToRelease, ...acknowledgedCompletions]) {
        eligibleByKey.set(candidate.key, candidate);
    }
    const releasedKeys: string[] = [];
    for (const candidate of [...eligibleByKey.values()].sort((left, right) =>
        left.key.localeCompare(right.key))) {
        try {
            await options.release(candidate);
            releasedKeys.push(candidate.key);
        } catch (_error) {
            options.reportFailure?.('release', 'unexpected', candidate.key);
        }
    }
    const released = new Set(releasedKeys);
    return {
        releasedKeys,
        retainedKeys: candidates.map(candidate => candidate.key)
            .filter(key => !released.has(key)).sort(),
    };
}

function deduplicateLifecycleCandidates<TCandidate extends AiSessionRuntimeLifecycleCandidate>(
    candidates: readonly TCandidate[]
): TCandidate[] {
    const byKey = new Map<string, TCandidate>();
    for (const candidate of candidates) {
        if (candidate && candidate.key && (candidate.state === 'completed' || candidate.state === 'stopped')) {
            const existing = byKey.get(candidate.key);
            if (!existing || (existing.state === 'stopped' && candidate.state === 'completed')) {
                byKey.set(candidate.key, candidate);
            }
        }
    }
    return [...byKey.values()];
}
