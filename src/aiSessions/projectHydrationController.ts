'use strict';

import type * as vscode from 'vscode';
import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type { AttentionAggregate } from './attentionAggregate';
import { buildAttentionSessionIndex } from './attentionProject';
import type { AiSessionAttentionSnapshot } from './attentionMonitor';
import { getAiSessionCandidatePaths, getAiSessionOpenProjectCandidates } from './projectCandidates';
import { hydrateOpenProjectsWithAiSessions } from './projectHydration';
import { resolvePendingAiSessionTerminals } from './pendingTerminalResolver';
import type { PendingAiSessionRuntimeCoordinator } from './pendingTerminalResolver';
import { getAiSessionScanMaxFiles } from './scanOptions';
import type { AiSessionPendingRuntimeSnapshot, AiSessionRuntimeSnapshot } from './runtimeTypes';
import type {
    AiSessionAssignmentCandidate,
    AiSessionProviderDefinition,
    AiSessionReadResult,
} from './types';
import { sanitizeAiSessionAlias } from './aliasStore';

type HydrationProvider = Pick<
    AiSessionProviderDefinition,
    | 'id'
    | 'terminalNamePrefix'
    | 'projectSessionsKey'
    | 'projectSessionsUnavailableKey'
    | 'terminalCwdFields'
>;

interface LegacyPendingTerminalResolution<TTerminal> {
    provider: AiSessionProviderId;
    terminal: TTerminal;
    markerPath: string;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
}

interface LegacyPendingTerminalService<TTerminal> {
    getPendingTerminals(): LegacyPendingTerminalResolution<TTerminal>[];
    getTrackedSessionKeys(
        getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string
    ): Set<string>;
    track(providerId: AiSessionProviderId, sessionId: string, entry: {
        terminal: TTerminal;
        markerPath: string;
        runStartedAtMs: number;
        cwd?: string;
    }): void;
    replacePendingTerminals(pendingTerminals: LegacyPendingTerminalResolution<TTerminal>[]): void;
}

interface ProjectHydrationRuntimeCoordinator<TTerminal>
extends PendingAiSessionRuntimeCoordinator<TTerminal> {
    getActive(): AiSessionRuntimeSnapshot<TTerminal>[];
    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[];
}

export interface AiSessionProjectHydrationReadCoordinator {
    getResults(options: {
        candidatePaths: string[];
        reason: string;
        maxFiles: number;
    }): Record<AiSessionProviderId, AiSessionReadResult>;
    getAssignments<TProject extends { id: string }>(
        candidates: AiSessionAssignmentCandidate<TProject>[],
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>,
        getSessionPath: (providerId: AiSessionProviderId, session: CodexSession) => string,
    ): Record<AiSessionProviderId, Map<string, CodexSession[]>>;
}

export interface AiSessionProjectHydrationControllerOptions<TTerminal = unknown> {
    getWorkspaceFile: () => vscode.Uri | null | undefined;
    getWorkspaceFolders: () => readonly { uri: vscode.Uri }[] | null | undefined;
    getRefreshReason: () => string;
    incrementalScanMaxFiles: number;
    getProviders: () => readonly HydrationProvider[];
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    readCoordinator: AiSessionProjectHydrationReadCoordinator;
    terminalService: LegacyPendingTerminalService<TTerminal> & {
        trackPending(pending: {
            provider: AiSessionProviderId;
            terminal: TTerminal;
            markerPath: string;
            cwd: string;
            createdAt: string;
            excludedSessionIds: string[];
            title: string;
        }): void;
    };
    runtimeCoordinator?: ProjectHydrationRuntimeCoordinator<TTerminal>;
    setAlias: (providerId: AiSessionProviderId, sessionId: string, alias: string) => void;
    syncActiveTerminal: () => void;
    getSessionComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string;
    getExpandedProjects: () => ReadonlySet<string>;
    getActiveProviders: () => Record<string, AiSessionProviderId>;
    getPinnedSessions: () => Set<string>;
    getAliases: () => Record<string, string>;
    getAttentionAggregate: () => AttentionAggregate;
    getLocalAttentionBySession: () => Record<string, AiSessionAttentionSnapshot>;
    hasRemoteAttentionAggregate: () => boolean;
    getProjectKey: (project: Project) => string;
    normalizeProjectPath: (projectPath: string) => string;
    nowMs?: () => number;
    logDiagnostic?: (event: Record<string, unknown>) => void;
}

export class AiSessionProjectHydrationController<TTerminal = unknown> {
    private cache: {
        signature: string;
        generation: number;
        projects: Project[];
        diagnostic: Record<string, unknown>;
    } | null = null;
    private cacheClearScheduled = false;
    private hydrationGeneration = 0;
    private readonly pendingPromotionFlights = new Map<
        string,
        Promise<AiSessionRuntimeSnapshot<TTerminal>[]>
    >();

    constructor(private readonly options: AiSessionProjectHydrationControllerOptions<TTerminal>) {
    }

    hydrate(openProjects: Project[]): Project[] {
        const startedAt = this.nowMs();
        const reason = this.options.getRefreshReason();
        const providers = this.options.getProviders();
        if (!openProjects.length) {
            this.logDiagnostic({
                event: 'ai-session-hydration',
                reason,
                durationMs: this.nowMs() - startedAt,
                projectCount: 0,
                hydratedProjectCount: 0,
                candidatePathCount: 0,
                providerCount: providers.length,
                sessionCount: 0,
                pendingTerminalCount: 0,
                cacheHit: false,
            });
            return openProjects;
        }

        const workspaceFile = this.options.getWorkspaceFile();
        const workspaceFolders = this.options.getWorkspaceFolders();
        const candidatePaths = getAiSessionCandidatePaths(openProjects, workspaceFile, workspaceFolders);
        const assignmentCandidates = getAiSessionOpenProjectCandidates(openProjects, workspaceFile, workspaceFolders);
        const maxFiles = getAiSessionScanMaxFiles(reason, this.options.incrementalScanMaxFiles);
        const runtimeProjection = this.getRuntimeProjection();
        const pendingRuntimeCount = runtimeProjection.pendingRuntimes.length;
        const aggregate = this.options.getAttentionAggregate();
        const localAttentionBySession = this.options.getLocalAttentionBySession();
        const signature = this.getCacheSignature({
            openProjects,
            providers,
            candidatePaths,
            assignmentCandidates,
            reason,
            maxFiles,
            aggregate,
            localAttentionBySession,
            activeRuntimes: runtimeProjection.activeRuntimes,
            pendingRuntimes: runtimeProjection.pendingRuntimes,
        });
        if (this.cache?.signature === signature) {
            this.logDiagnostic({
                ...this.cache.diagnostic,
                durationMs: this.nowMs() - startedAt,
                cacheHit: true,
            });
            return this.cache.projects;
        }

        const generation = ++this.hydrationGeneration;
        const sessionResults = this.getAiSessionResults(candidatePaths, reason, maxFiles);
        const assignments = this.getAiSessionAssignments(assignmentCandidates, sessionResults);
        const hydrateProjects = (projects: Project[]) => hydrateOpenProjectsWithAiSessions({
            projects,
            providers,
            sessionResults,
            assignments,
            expandedProjects: this.options.getExpandedProjects(),
            activeProviders: this.options.getActiveProviders(),
            pinnedSessions: this.options.getPinnedSessions(),
            aliases: this.options.getAliases(),
            aggregateByProjectAndSession: buildAttentionSessionIndex(aggregate),
            localAttentionBySession,
            includeLocalAttention: !this.options.hasRemoteAttentionAggregate(),
            getProjectKey: this.options.getProjectKey,
        });
        let hydrated: Project[] = null;
        const resolution = resolvePendingAiSessionTerminals({
            activeRuntimes: runtimeProjection.activeRuntimes,
            pendingRuntimes: runtimeProjection.pendingRuntimes,
            sessionResults,
            providers,
            getSessionKey: this.options.getSessionKey,
            runtimeCoordinator: this.getSingleFlightRuntimeCoordinator(
                runtimeProjection.pendingRuntimes,
                runtimeProjection.runtimeCoordinator
            ),
            setAlias: this.options.setAlias,
            syncActiveRuntime: () => undefined,
            claimedSessionKeys: runtimeProjection.claimedSessionKeys,
        });
        hydrated = hydrateProjects(openProjects);
        const diagnostic = {
            event: 'ai-session-hydration',
            reason,
            projectCount: openProjects.length,
            hydratedProjectCount: hydrated.length,
            candidatePathCount: candidatePaths.length,
            providerCount: providers.length,
            sessionCount: Object.values(sessionResults)
                .reduce((count, result) => count + result.sessions.length, 0),
            pendingTerminalCount: pendingRuntimeCount,
        };
        this.cache = {
            signature,
            generation,
            projects: hydrated,
            diagnostic,
        };
        void resolution.then(result => {
            if (result.failures.length) {
                this.logDiagnostic({
                    event: 'ai-session-pending-runtime-promotion-result',
                    reason,
                    generation,
                    attempted: result.attempted,
                    promotedCount: result.promoted.length,
                    failureReasons: result.failures.map(failure => failure.reason),
                });
            }
            if (!result.promoted.length || generation !== this.hydrationGeneration) {
                return;
            }
            const refreshed = hydrateProjects(hydrated.map(project => ({ ...project } as Project)));
            replaceProjectProjection(hydrated, refreshed);
            if (this.cache?.generation === generation && this.cache.projects === hydrated) {
                this.cache = null;
            }
            this.options.syncActiveTerminal();
        }).catch(error => this.logDiagnostic({
            event: 'ai-session-pending-runtime-promotion-failed',
            reason,
            generation,
            category: error instanceof Error ? error.name : typeof error,
        }));
        this.scheduleCacheClear();
        this.logDiagnostic({
            ...diagnostic,
            durationMs: this.nowMs() - startedAt,
            cacheHit: false,
        });
        return hydrated;
    }

    trackPendingTerminal(
        providerId: AiSessionProviderId,
        terminal: TTerminal,
        markerPath: string,
        cwd: string,
        createdAt: string,
        excludedSessionIds: string[],
        title: string = null
    ): void {
        const comparableCwd = this.options.normalizeProjectPath(cwd);
        if (!terminal || !markerPath || !comparableCwd) {
            return;
        }

        this.options.terminalService.trackPending({
            provider: providerId,
            terminal,
            markerPath,
            cwd: comparableCwd,
            createdAt,
            excludedSessionIds: Array.isArray(excludedSessionIds) ? excludedSessionIds.filter(id => !!id) : [],
            title: sanitizeAiSessionAlias(title),
        });
    }

    private getRuntimeProjection(): {
        activeRuntimes: AiSessionRuntimeSnapshot<TTerminal>[];
        pendingRuntimes: AiSessionPendingRuntimeSnapshot<TTerminal>[];
        runtimeCoordinator: PendingAiSessionRuntimeCoordinator<TTerminal>;
        claimedSessionKeys: ReadonlySet<string>;
    } {
        if (this.options.runtimeCoordinator) {
            return {
                activeRuntimes: this.options.runtimeCoordinator.getActive().map(cloneRuntime),
                pendingRuntimes: this.options.runtimeCoordinator.getPending().map(clonePendingRuntime),
                runtimeCoordinator: this.options.runtimeCoordinator,
                claimedSessionKeys: new Set(),
            };
        }

        const legacyPendingTerminals = this.options.terminalService.getPendingTerminals();
        const pendingById = new Map<string, LegacyPendingTerminalResolution<TTerminal>>();
        const pendingRuntimes = legacyPendingTerminals.map((pending, index) => {
            const pendingId = `legacy:${pending.provider}:${pending.createdAt}:${index}`;
            pendingById.set(pendingId, pending);
            return {
                identity: {
                    provider: pending.provider,
                    projectKey: pending.cwd,
                    cwd: pending.cwd,
                    pendingId,
                },
                backend: 'vscode' as const,
                state: 'pending' as const,
                markerPath: pending.markerPath,
                runStartedAtMs: finiteTimestamp(pending.createdAt),
                attached: true,
                terminal: pending.terminal,
                createdAt: pending.createdAt,
                excludedSessionIds: [...pending.excludedSessionIds],
                ...(pending.title === undefined ? {} : { title: pending.title }),
            };
        });
        const runtimeCoordinator: PendingAiSessionRuntimeCoordinator<TTerminal> = {
            promotePending: (pendingId, sessionId) => {
                const pending = pendingById.get(pendingId);
                if (!pending) {
                    return [];
                }
                this.options.terminalService.track(pending.provider, sessionId, {
                    terminal: pending.terminal,
                    markerPath: pending.markerPath,
                    runStartedAtMs: finiteTimestamp(pending.createdAt),
                    cwd: pending.cwd,
                });
                this.options.terminalService.replacePendingTerminals(
                    this.options.terminalService.getPendingTerminals()
                        .filter(candidate => candidate.terminal !== pending.terminal)
                );
                return [{
                    identity: {
                        provider: pending.provider,
                        projectKey: pending.cwd,
                        cwd: pending.cwd,
                        sessionId,
                    },
                    backend: 'vscode',
                    state: 'active',
                    markerPath: pending.markerPath,
                    runStartedAtMs: finiteTimestamp(pending.createdAt),
                    attached: true,
                    terminal: pending.terminal,
                }];
            },
        };
        return {
            activeRuntimes: [],
            pendingRuntimes,
            runtimeCoordinator,
            claimedSessionKeys: this.options.terminalService.getTrackedSessionKeys(this.options.getSessionKey),
        };
    }

    private getSingleFlightRuntimeCoordinator(
        pendingRuntimes: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[],
        coordinator: PendingAiSessionRuntimeCoordinator<TTerminal>
    ): PendingAiSessionRuntimeCoordinator<TTerminal> {
        const pendingById = new Map<string, AiSessionPendingRuntimeSnapshot<TTerminal>>();
        for (const pending of pendingRuntimes) {
            if (pending.identity.pendingId && !pendingById.has(pending.identity.pendingId)) {
                pendingById.set(pending.identity.pendingId, pending);
            }
        }
        return {
            promotePending: (pendingId, sessionId) => {
                const pending = pendingById.get(pendingId);
                const flightKey = getPendingPromotionFlightKey(pending, pendingId, sessionId);
                const existing = this.pendingPromotionFlights.get(flightKey);
                if (existing) {
                    return existing.then(cloneRuntimeArray);
                }

                const promotion = coordinator.promotePending(pendingId, sessionId);
                if (!isPromiseLike(promotion)) {
                    return cloneRuntimeArray(promotion);
                }
                const flight = Promise.resolve(promotion).then(cloneRuntimeArray);
                this.pendingPromotionFlights.set(flightKey, flight);
                flight.then(
                    () => this.releasePendingPromotionFlight(flightKey, flight),
                    () => this.releasePendingPromotionFlight(flightKey, flight)
                );
                return flight.then(cloneRuntimeArray);
            },
        };
    }

    private releasePendingPromotionFlight(
        key: string,
        flight: Promise<AiSessionRuntimeSnapshot<TTerminal>[]>
    ): void {
        if (this.pendingPromotionFlights.get(key) === flight) {
            this.pendingPromotionFlights.delete(key);
        }
    }

    private getAiSessionResults(
        candidatePaths: string[],
        reason: string,
        maxFiles: number
    ): Record<AiSessionProviderId, AiSessionReadResult> {
        return this.options.readCoordinator.getResults({ candidatePaths, reason, maxFiles });
    }

    private getAiSessionAssignments(
        assignmentCandidates: AiSessionAssignmentCandidate<Project>[],
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>
    ): Record<AiSessionProviderId, Map<string, CodexSession[]>> {
        return this.options.readCoordinator.getAssignments(
            assignmentCandidates,
            sessionResults,
            this.options.getSessionComparableCwd
        );
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }

    private logDiagnostic(event: Record<string, unknown>): void {
        this.options.logDiagnostic?.(event);
    }

    private scheduleCacheClear(): void {
        if (this.cacheClearScheduled) {
            return;
        }

        this.cacheClearScheduled = true;
        Promise.resolve().then(() => {
            this.cache = null;
            this.cacheClearScheduled = false;
        });
    }

    private getCacheSignature(input: {
        openProjects: Project[];
        providers: readonly HydrationProvider[];
        candidatePaths: string[];
        assignmentCandidates: AiSessionAssignmentCandidate<Project>[];
        reason: string;
        maxFiles: number;
        aggregate: AttentionAggregate;
        localAttentionBySession: Record<string, AiSessionAttentionSnapshot>;
        activeRuntimes: readonly AiSessionRuntimeSnapshot<TTerminal>[];
        pendingRuntimes: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[];
    }): string {
        return JSON.stringify({
            reason: input.reason,
            maxFiles: input.maxFiles,
            candidatePaths: input.candidatePaths,
            assignmentCandidates: input.assignmentCandidates.map(candidate => ({
                projectId: candidate.project.id,
                path: candidate.path,
            })),
            providers: input.providers.map(provider => ({
                id: provider.id,
                terminalNamePrefix: provider.terminalNamePrefix,
                projectSessionsKey: provider.projectSessionsKey,
                projectSessionsUnavailableKey: provider.projectSessionsUnavailableKey,
                terminalCwdFields: provider.terminalCwdFields,
            })),
            projects: this.stableValue(input.openProjects),
            expandedProjects: Array.from(this.options.getExpandedProjects()).sort(),
            activeProviders: this.options.getActiveProviders(),
            pinnedSessions: Array.from(this.options.getPinnedSessions()).sort(),
            aliases: this.options.getAliases(),
            hasRemoteAttentionAggregate: this.options.hasRemoteAttentionAggregate(),
            aggregateRevision: input.aggregate.aggregateRevision,
            aggregateSessions: input.aggregate.sessions.map(session => ({
                projectId: session.projectId,
                sessionKey: session.sessionKey,
                reasons: session.reasons,
                eventIds: session.eventIds,
                observedAtMs: session.observedAtMs,
            })),
            localAttentionBySession: Object.entries(input.localAttentionBySession)
                .map(([sessionKey, snapshot]) => ({
                    sessionKey,
                    state: snapshot.state,
                    stateChangedAt: snapshot.stateChangedAt,
                    eventId: snapshot.event?.eventId,
                    reason: snapshot.event?.reason,
                }))
                .sort((left, right) => left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0),
            activeRuntimes: input.activeRuntimes.map(runtime => ({
                identity: { ...runtime.identity },
                backend: runtime.backend,
                state: runtime.state,
                conflict: runtime.state === 'conflict',
                markerPath: runtime.markerPath,
                runStartedAtMs: runtime.runStartedAtMs,
                attached: runtime.attached,
                ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
            })),
            pendingRuntimes: input.pendingRuntimes.map(pending => ({
                identity: { ...pending.identity },
                backend: pending.backend,
                state: pending.state,
                markerPath: pending.markerPath,
                runStartedAtMs: pending.runStartedAtMs,
                attached: pending.attached,
                ...(pending.tmux ? { tmux: { ...pending.tmux } } : {}),
                createdAt: pending.createdAt,
                excludedSessionIds: [...pending.excludedSessionIds],
                title: pending.title,
            })),
        });
    }

    private stableValue(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map(item => this.stableValue(item));
        }
        if (!value || typeof value !== 'object') {
            return value;
        }
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce((result, key) => {
                result[key] = this.stableValue((value as Record<string, unknown>)[key]);
                return result;
            }, {} as Record<string, unknown>);
    }
}

function cloneRuntime<TTerminal>(
    runtime: AiSessionRuntimeSnapshot<TTerminal>
): AiSessionRuntimeSnapshot<TTerminal> {
    return {
        ...runtime,
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function clonePendingRuntime<TTerminal>(
    runtime: AiSessionPendingRuntimeSnapshot<TTerminal>
): AiSessionPendingRuntimeSnapshot<TTerminal> {
    return {
        ...cloneRuntime(runtime),
        state: 'pending',
        createdAt: runtime.createdAt,
        excludedSessionIds: [...runtime.excludedSessionIds],
    };
}

function finiteTimestamp(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getPendingPromotionFlightKey<TTerminal>(
    pending: AiSessionPendingRuntimeSnapshot<TTerminal> | undefined,
    pendingId: string,
    sessionId: string
): string {
    const identity = pending?.identity;
    return JSON.stringify([
        identity?.provider || '',
        identity?.projectKey || '',
        identity?.cwd || '',
        pendingId,
        sessionId,
    ]);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return !!value && typeof (value as Promise<T>).then === 'function';
}

function cloneRuntimeArray<TTerminal>(
    runtimes: readonly AiSessionRuntimeSnapshot<TTerminal>[]
): AiSessionRuntimeSnapshot<TTerminal>[] {
    return (runtimes || []).map(cloneRuntime);
}

function replaceProjectProjection(target: Project[], replacement: Project[]): void {
    for (let index = 0; index < replacement.length; index++) {
        target[index] = replacement[index];
    }
    target.length = replacement.length;
}
