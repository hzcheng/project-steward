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

export interface AiSessionAttentionTerminalEntry {
    runStartedAtMs: number;
}

export interface AiSessionAttentionProvider {
    id: AiSessionProviderId;
    projectSessionsKey: 'codexSessions' | 'kimiSessions' | 'claudeSessions';
    service: {
        getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal>;
    };
}

export interface AiSessionAttentionControllerOptions<TEntry extends AiSessionAttentionTerminalEntry = AiSessionAttentionTerminalEntry> {
    isEnabled: () => boolean;
    getOpenProjects: () => Project[];
    getProviders: () => AiSessionAttentionProvider[];
    getSessionKey?: (providerId: AiSessionProviderId, sessionId: string) => string;
    getProjectKey: (project: Project) => string;
    getTerminalById: (providerId: AiSessionProviderId, sessionId: string) => TEntry | null;
    isTerminalComplete: (entry: TEntry) => boolean;
    publish: (items: AttentionPayloadItem[], forceHeartbeat?: boolean) => Promise<boolean>;
    scheduleRefresh: (reason: string) => void;
    postProjectsUpdated: (projects: AttentionProjectSummary[]) => void;
    nowMs: () => number;
}

export class AiSessionAttentionController<TEntry extends AiSessionAttentionTerminalEntry = AiSessionAttentionTerminalEntry> {
    private readonly monitor: AiSessionAttentionMonitor;
    private remoteAggregate: AttentionAggregate | null = null;
    private localItems: AttentionPayloadItem[] = [];

    constructor(private readonly options: AiSessionAttentionControllerOptions<TEntry>) {
        this.monitor = new AiSessionAttentionMonitor({ now: options.nowMs });
    }

    async evaluate(): Promise<void> {
        if (!this.options.isEnabled()) {
            this.monitor.evaluate([]);
            this.remoteAggregate = null;
            this.localItems = [];
            await this.options.publish([], true);
            this.options.scheduleRefresh('attention');
            this.postProjectsUpdated();
            return;
        }

        const projects = this.options.getOpenProjects();
        const providers = this.options.getProviders();
        const ownedSessions = this.getOwnedSessions(projects, providers);
        const signalsByProvider = this.getSignalsByProvider(providers, ownedSessions);
        const inputs = Array.from(ownedSessions, ([key, owned]) => {
            const signal = this.options.isTerminalComplete(owned.terminal)
                ? {
                    token: `terminal-exit:${owned.terminal.runStartedAtMs}`,
                    phase: 'needsAttention' as const,
                    reason: 'completed' as const,
                    occurredAtMs: owned.terminal.runStartedAtMs,
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
        await this.options.publish(this.localItems);
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
        providers: AiSessionAttentionProvider[]
    ): Map<string, {
        providerId: AiSessionProviderId;
        session: CodexSession;
        terminal: TEntry;
    }> {
        const ownedSessions = new Map<string, {
            providerId: AiSessionProviderId;
            session: CodexSession;
            terminal: TEntry;
        }>();
        for (const project of projects) {
            for (const provider of providers) {
                for (const session of project[provider.projectSessionsKey] || []) {
                    const key = this.getSessionKey(provider.id, session.id);
                    const terminal = this.options.getTerminalById(provider.id, session.id);
                    if (!terminal || ownedSessions.has(key)) {
                        continue;
                    }
                    ownedSessions.set(key, { providerId: provider.id, session, terminal });
                }
            }
        }
        return ownedSessions;
    }

    private getSignalsByProvider(
        providers: AiSessionAttentionProvider[],
        ownedSessions: Map<string, { providerId: AiSessionProviderId; session: CodexSession; terminal: TEntry }>
    ): Record<AiSessionProviderId, Record<string, AiSessionLifecycleSignal>> {
        const requestsByProvider = providers.reduce((result, provider) => {
            result[provider.id] = [];
            return result;
        }, {} as Record<AiSessionProviderId, AiSessionLifecycleRequest[]>);
        for (const owned of ownedSessions.values()) {
            requestsByProvider[owned.providerId].push({
                sessionId: owned.session.id,
                runStartedAtMs: owned.terminal.runStartedAtMs,
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
                    const attention = snapshot[this.getSessionKey(provider.id, session.id)];
                    if (!attention?.event) {
                        continue;
                    }
                    items.push({
                        projectId: projectKey,
                        sessionKey: this.getSessionKey(provider.id, session.id),
                        state: attention.state === 'needsAttention' ? 'needsAttention' : 'acknowledged',
                        eventId: attention.event.eventId,
                        reason: attention.event.reason,
                        observedAtMs: attention.stateChangedAt,
                    });
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
