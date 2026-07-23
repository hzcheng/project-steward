'use strict';

import { existsSync, statSync } from 'fs';

import type { CodexRootThreadObserver } from './codexRootThreadObserver';
import type {
    AiSessionManagedTmuxMetadata,
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
    AiSessionTmuxDiscoveryDiagnostic,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import {
    ProjectTmuxLayout,
    SessionTmuxLayout,
    parseManagedTmuxMetadata,
} from './tmuxLayout';
import { tmuxLocatorMatchesIdentity } from './tmuxNaming';
import {
    aiSessionRuntimeIdentitiesEqual,
    cloneAiSessionRuntimeIdentity,
} from './runtimeTypes';
import type {
    TmuxInactiveAcknowledgementResult,
    TmuxInactiveRuntimeBinding,
    TmuxKnownRebindResult,
    TmuxKnownRuntimeBinding,
    TmuxPendingRuntimeBinding,
} from './tmuxRuntimeBindingStore';

const DEFAULT_CACHE_TTL_MS = 500;
const MAX_DISCOVERY_ROWS = 10000;

interface DiscoveryWindowRecord {
    sessionName: string;
    windowName: string;
    windowId: string;
    active: boolean;
    panePid: number;
    metadata: Record<string, string>;
    sessionMetadata: Record<string, string>;
    windowMetadata: Record<string, string>;
}

interface TmuxDiscoveryClient {
    listWindows(): Promise<DiscoveryWindowRecord[]>;
}

interface TmuxDiscoveryBindingStore {
    listPending(): Promise<TmuxPendingRuntimeBinding[]>;
    listKnown(): Promise<TmuxKnownRuntimeBinding[]>;
    listInactive?(): Promise<TmuxInactiveRuntimeBinding[]>;
    setInactive?(record: TmuxInactiveRuntimeBinding): Promise<void>;
    transitionKnownToInactive?(
        record: TmuxInactiveRuntimeBinding,
        expectedLastSeenAtMs: number
    ): Promise<boolean>;
    acknowledgeInactive?(
        expected: TmuxInactiveRuntimeBinding
    ): Promise<TmuxInactiveAcknowledgementResult>;
    reconcileKnown(live: readonly AiSessionRuntimeSnapshot[]): Promise<void>;
    rebindKnown?(
        expected: TmuxKnownRuntimeBinding,
        nextSessionId: string
    ): Promise<TmuxKnownRebindResult>;
    removeKnown?(
        provider: AiSessionRuntimeIdentity['provider'],
        sessionId: string,
        workspaceScopeIdentity?: string
    ): Promise<void>;
}

export interface TmuxRuntimeDiscoveryOptions {
    client: TmuxDiscoveryClient;
    bindingStore: TmuxDiscoveryBindingStore;
    codexRootThreadObserver?: CodexRootThreadObserver;
    markerIsCurrent: (markerPath: string, runStartedAtMs: number) => boolean | Promise<boolean>;
    nowMs?: () => number;
    cacheTtlMs?: number;
}

interface DiscoveryResult {
    active: AiSessionRuntimeSnapshot[];
    pending: AiSessionPendingRuntimeSnapshot[];
    inactive: AiSessionRuntimeSnapshot[];
    diagnostics: AiSessionTmuxDiscoveryDiagnostic[];
}

export class TmuxRuntimeDiscovery {
    private readonly nowMs: () => number;
    private readonly cacheTtlMs: number;
    private active: AiSessionRuntimeSnapshot[] = [];
    private pending: AiSessionPendingRuntimeSnapshot[] = [];
    private inactive: AiSessionRuntimeSnapshot[] = [];
    private readonly retainedInactive = new Map<string, AiSessionRuntimeSnapshot>();
    private diagnostics: AiSessionTmuxDiscoveryDiagnostic[] = [];
    private successfulAtMs: number | null = null;
    private cacheGeneration = 0;
    private inFlight: Promise<void> | null = null;
    private forcedAfterInFlight: Promise<void> | null = null;

    constructor(private readonly options: TmuxRuntimeDiscoveryOptions) {
        this.nowMs = options.nowMs || (() => Date.now());
        this.cacheTtlMs = Number.isFinite(options.cacheTtlMs) && (options.cacheTtlMs as number) >= 0
            ? options.cacheTtlMs as number
            : DEFAULT_CACHE_TTL_MS;
    }

    refresh(force: boolean = false): Promise<void> {
        if (this.inFlight) {
            if (!force) {
                return this.inFlight;
            }
            if (!this.forcedAfterInFlight) {
                const joined = this.inFlight;
                let tracked: Promise<void>;
                const startFresh = () => {
                    if (this.forcedAfterInFlight === tracked) {
                        this.forcedAfterInFlight = null;
                    }
                    return this.startRefresh();
                };
                const forced = joined.then(startFresh, startFresh);
                tracked = forced.then(
                    () => {
                        if (this.forcedAfterInFlight === tracked) {
                            this.forcedAfterInFlight = null;
                        }
                    },
                    error => {
                        if (this.forcedAfterInFlight === tracked) {
                            this.forcedAfterInFlight = null;
                        }
                        throw error;
                    }
                );
                this.forcedAfterInFlight = tracked;
            }
            return this.forcedAfterInFlight;
        }
        if (!force && this.successfulAtMs !== null
            && this.nowMs() - this.successfulAtMs < this.cacheTtlMs) {
            return Promise.resolve();
        }

        return this.startRefresh();
    }

    private startRefresh(): Promise<void> {
        const refresh = this.refreshUncached(this.cacheGeneration);
        let tracked: Promise<void>;
        tracked = refresh.then(
            () => {
                if (this.inFlight === tracked) {
                    this.inFlight = null;
                }
            },
            error => {
                if (this.inFlight === tracked) {
                    this.inFlight = null;
                }
                this.markSnapshotsStale();
                throw error;
            }
        );
        this.inFlight = tracked;
        return tracked;
    }

    getActive(): AiSessionRuntimeSnapshot[] {
        return this.active.map(cloneRuntime);
    }

    getPending(): AiSessionPendingRuntimeSnapshot[] {
        return this.pending.map(clonePendingRuntime);
    }

    getInactive(): AiSessionRuntimeSnapshot[] {
        return this.inactive.map(cloneRuntime);
    }

    getDiagnostics(): AiSessionTmuxDiscoveryDiagnostic[] {
        return this.diagnostics.map(cloneDiagnostic);
    }

    async loadPersistedInactive(): Promise<void> {
        if (!this.options.bindingStore.listInactive) {
            return;
        }
        const generation = this.cacheGeneration;
        const records = await this.options.bindingStore.listInactive();
        if (this.cacheGeneration !== generation) {
            return;
        }
        const restored = new Map<string, AiSessionRuntimeSnapshot>();
        for (const runtime of this.inactive) {
            const sessionId = runtime.identity.sessionId;
            if (sessionId) {
                restored.set(finalIdentityKey(runtime.identity.provider, sessionId,
                    runtime.identity.workspaceScopeIdentity), cloneRuntime(runtime));
            }
        }
        for (const record of records) {
            restored.set(finalIdentityKey(record.provider, record.sessionId, record.workspaceScopeIdentity),
                inactiveSnapshotFromBinding(record));
        }
        for (const runtime of this.active) {
            if (runtime.identity.sessionId) {
                restored.delete(finalIdentityKey(runtime.identity.provider, runtime.identity.sessionId,
                    runtime.identity.workspaceScopeIdentity));
            }
        }
        this.retainedInactive.clear();
        for (const [key, runtime] of restored) {
            this.retainedInactive.set(key, cloneRuntime(runtime));
        }
        this.inactive = [...restored.values()].map(cloneRuntime);
    }

    async acknowledgeInactive(
        expected: AiSessionRuntimeSnapshot
    ): Promise<TmuxInactiveAcknowledgementResult> {
        const expectedBinding = inactiveBindingFromSnapshot(
            expected, expected.detectedAtMs as number
        );
        const expectedSnapshot = inactiveSnapshotFromBinding(expectedBinding);
        const key = finalIdentityKey(expectedBinding.provider, expectedBinding.sessionId,
            expectedBinding.workspaceScopeIdentity);
        this.cacheGeneration++;
        this.successfulAtMs = null;
        let result: TmuxInactiveAcknowledgementResult;
        if (this.options.bindingStore.acknowledgeInactive) {
            result = await this.options.bindingStore.acknowledgeInactive(expectedBinding);
        } else if (this.options.bindingStore.removeKnown) {
            await this.options.bindingStore.removeKnown(
                expectedBinding.provider, expectedBinding.sessionId,
                expectedBinding.workspaceScopeIdentity
            );
            result = 'acknowledged';
        } else {
            result = 'missing';
        }
        if (result === 'stale') {
            if (this.options.bindingStore.listInactive) {
                const current = (await this.options.bindingStore.listInactive()).find(record =>
                    record.provider === expectedBinding.provider
                    && record.sessionId === expectedBinding.sessionId
                    && record.workspaceScopeIdentity === expectedBinding.workspaceScopeIdentity);
                if (current) {
                    const currentSnapshot = inactiveSnapshotFromBinding(current);
                    this.retainedInactive.set(key, currentSnapshot);
                    this.inactive = this.inactive.filter(runtime =>
                        finalIdentityKey(runtime.identity.provider,
                            runtime.identity.sessionId || '', runtime.identity.workspaceScopeIdentity) !== key);
                    this.inactive.push(cloneRuntime(currentSnapshot));
                }
            }
            return result;
        }
        const retained = this.retainedInactive.get(key);
        if (retained && inactiveSnapshotsEqual(retained, expectedSnapshot)) {
            this.retainedInactive.delete(key);
            this.inactive = this.inactive.filter(runtime =>
                finalIdentityKey(runtime.identity.provider,
                    runtime.identity.sessionId || '', runtime.identity.workspaceScopeIdentity) !== key);
        }
        return result;
    }

    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot[] {
        return [...this.active, ...this.pending]
            .filter(runtime => identitiesMatch(runtime.identity, identity))
            .map(cloneRuntime);
    }

    invalidate(): void {
        this.successfulAtMs = null;
        this.cacheGeneration++;
    }

    private async refreshUncached(cacheGeneration: number): Promise<void> {
        const result = await this.enumerate();
        if (this.cacheGeneration !== cacheGeneration) {
            return;
        }
        this.active = result.active.map(cloneFreshRuntime);
        this.pending = result.pending.map(cloneFreshPendingRuntime);
        this.inactive = result.inactive.map(cloneFreshRuntime);
        this.diagnostics = result.diagnostics.map(cloneFreshDiagnostic);
        this.retainedInactive.clear();
        for (const runtime of result.inactive) {
            const sessionId = runtime.identity.sessionId;
            if (sessionId) {
                this.retainedInactive.set(
                    finalIdentityKey(runtime.identity.provider, sessionId,
                        runtime.identity.workspaceScopeIdentity), cloneFreshRuntime(runtime)
                );
            }
        }
        this.successfulAtMs = this.nowMs();
    }

    private markSnapshotsStale(): void {
        this.active = this.active.map(runtime => ({ ...cloneRuntime(runtime), stale: true }));
        this.pending = this.pending.map(runtime => ({ ...clonePendingRuntime(runtime), stale: true }));
        this.inactive = this.inactive.map(runtime => ({ ...cloneRuntime(runtime), stale: true }));
        this.diagnostics = this.diagnostics.map(diagnostic => ({
            ...cloneDiagnostic(diagnostic), stale: true,
        }));
    }

    private async enumerate(): Promise<DiscoveryResult> {
        const listed = await this.options.client.listWindows();
        if (!Array.isArray(listed) || listed.length > MAX_DISCOVERY_ROWS) {
            throw new Error('The tmux window enumeration exceeded its bounded row limit.');
        }
        const rows = listed.slice();
        const [pendingBindings, knownBindings, persistedInactiveBindings] = await Promise.all([
            this.options.bindingStore.listPending(),
            this.options.bindingStore.listKnown(),
            this.options.bindingStore.listInactive
                ? this.options.bindingStore.listInactive()
                : Promise.resolve([] as TmuxInactiveRuntimeBinding[]),
        ]);
        const pendingByLocator = groupPendingByLocator(pendingBindings);
        const previousActive = this.active.filter(runtime => runtime.state === 'active');
        const activeByKey = new Map<string, AiSessionRuntimeSnapshot>();
        const pendingByKey = new Map<string, AiSessionPendingRuntimeSnapshot>();
        const diagnosticsByKey = new Map<string, AiSessionTmuxDiscoveryDiagnostic>();
        const diagnosticIdentityKeys = new Set<string>();
        const collisionIdentityKeys = new Set<string>();
        const actualLocatorsByIdentity = new Map<string, Set<string>>();

        for (const row of rows) {
            const parsed = parseRowMetadata(row);
            const actual = actualLocator(row, parsed ? parsed.layout : null);
            if (!parsed || !actual) {
                continue;
            }
            const pendingBinding = parsed.pendingId !== undefined
                ? findPendingBinding(pendingByLocator, actual, parsed)
                : undefined;
            const identity: AiSessionRuntimeIdentity = {
                provider: parsed.provider,
                workspaceScopeIdentity: parsed.workspaceScopeIdentity,
                workspaceNavigationIdentity: parsed.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...parsed.workspaceRootHostPaths],
                cwd: parsed.cwd,
                ...(parsed.sessionId !== undefined
                    ? { sessionId: parsed.sessionId }
                    : { pendingId: parsed.pendingId }),
            };
            const expected = expectedLocator(identity, parsed.layout);
            const parsedIdentityKey = identityKey(identity);
            const actualLocators = actualLocatorsByIdentity.get(parsedIdentityKey) || new Set<string>();
            actualLocators.add(locatorKey(actual));
            actualLocatorsByIdentity.set(parsedIdentityKey, actualLocators);
            if (actualLocators.size > 1) {
                collisionIdentityKeys.add(parsedIdentityKey);
                if (!diagnosticIdentityKeys.has(parsedIdentityKey)) {
                    const diagnostic: AiSessionTmuxDiscoveryDiagnostic = {
                        kind: 'tmux-locator-collision',
                        identity,
                        actual,
                        expected,
                    };
                    diagnosticsByKey.set(diagnosticKey(diagnostic), diagnostic);
                    diagnosticIdentityKeys.add(parsedIdentityKey);
                }
            }
            if (!tmuxLocatorMatchesIdentity(actual, identity)) {
                collisionIdentityKeys.add(parsedIdentityKey);
                if (!diagnosticIdentityKeys.has(parsedIdentityKey)) {
                    const diagnostic: AiSessionTmuxDiscoveryDiagnostic = {
                        kind: 'tmux-locator-collision',
                        identity,
                        actual,
                        expected,
                    };
                    diagnosticsByKey.set(diagnosticKey(diagnostic), diagnostic);
                    diagnosticIdentityKeys.add(parsedIdentityKey);
                }
                continue;
            }

            if (parsed.pendingId !== undefined) {
                if (!pendingBinding) {
                    continue;
                }
                const snapshot: AiSessionPendingRuntimeSnapshot = {
                    identity,
                    backend: 'tmux',
                    state: 'pending',
                    markerPath: parsed.marker || '',
                    runStartedAtMs: Date.parse(pendingBinding.createdAt),
                    attached: false,
                    tmux: { ...actual },
                    createdAt: pendingBinding.createdAt,
                    excludedSessionIds: [...pendingBinding.excludedSessionIds],
                    ...(pendingBinding.projectName === undefined
                        ? {} : { projectName: pendingBinding.projectName }),
                    ...(pendingBinding.title === undefined ? {} : { title: pendingBinding.title }),
                };
                pendingByKey.set(runtimeProjectionKey(snapshot), snapshot);
                continue;
            }

            const locatorKnown = findKnownBindingForManagedRow(knownBindings, parsed, actual);
            let projectedIdentity = locatorKnown ? {
                ...identity,
                sessionId: locatorKnown.sessionId,
            } : identity;
            let markerPath = locatorKnown?.markerPath || parsed.marker || '';
            let runStartedAtMs = locatorKnown?.runStartedAtMs
                || (parsed.createdAt ? Date.parse(parsed.createdAt) : 0);

            if (locatorKnown
                && projectedIdentity.provider === 'codex'
                && Number.isSafeInteger(row.panePid)
                && row.panePid > 0
                && this.options.codexRootThreadObserver
                && this.options.bindingStore.rebindKnown) {
                let observedSessionId: string | null = null;
                try {
                    observedSessionId = await this.options.codexRootThreadObserver.observe({
                        panePid: row.panePid,
                        currentSessionId: locatorKnown.sessionId,
                        runStartedAtMs,
                    });
                } catch (e) {
                    observedSessionId = null;
                }
                if (observedSessionId && observedSessionId !== locatorKnown.sessionId) {
                    const rebound = await this.options.bindingStore.rebindKnown(
                        locatorKnown, observedSessionId
                    );
                    if (rebound === 'rebound') {
                        projectedIdentity = {
                            ...projectedIdentity,
                            sessionId: observedSessionId,
                        };
                    }
                }
            }

            const snapshot: AiSessionRuntimeSnapshot = {
                identity: projectedIdentity,
                backend: 'tmux',
                state: 'active',
                markerPath,
                runStartedAtMs,
                attached: false,
                tmux: { ...actual },
            };
            activeByKey.set(runtimeProjectionKey(snapshot), snapshot);
        }

        const active = [...activeByKey.values()];
        const pending = [...pendingByKey.values()];
        const liveActive = active.filter(runtime => !collisionIdentityKeys.has(identityKey(runtime.identity)));
        const livePending = pending.filter(runtime => !collisionIdentityKeys.has(identityKey(runtime.identity)));
        const newlyInactive = await this.classifyVanishedKnown(
            knownBindings.slice(0, Math.max(0, MAX_DISCOVERY_ROWS - liveActive.length)),
            liveActive,
            previousActive,
            collisionIdentityKeys
        );
        const retainedInactive = new Map<string, AiSessionRuntimeSnapshot>();
        for (const runtime of this.retainedInactive.values()) {
            const sessionId = runtime.identity.sessionId;
            if (sessionId) {
                retainedInactive.set(finalIdentityKey(runtime.identity.provider, sessionId,
                    runtime.identity.workspaceScopeIdentity), cloneRuntime(runtime));
            }
        }
        for (const record of persistedInactiveBindings) {
            retainedInactive.set(finalIdentityKey(record.provider, record.sessionId,
                record.workspaceScopeIdentity),
                inactiveSnapshotFromBinding(record));
        }
        for (const runtime of liveActive) {
            if (runtime.identity.sessionId) {
                retainedInactive.delete(finalIdentityKey(
                    runtime.identity.provider, runtime.identity.sessionId,
                    runtime.identity.workspaceScopeIdentity
                ));
            }
        }
        for (const runtime of newlyInactive) {
            const sessionId = runtime.identity.sessionId;
            if (!sessionId) {
                continue;
            }
            const key = finalIdentityKey(runtime.identity.provider, sessionId,
                runtime.identity.workspaceScopeIdentity);
            const retained = retainedInactive.get(key);
            if (!retained || (retained.state !== 'completed' && runtime.state === 'completed')) {
                const binding = inactiveBindingFromSnapshot(runtime, this.nowMs());
                const known = knownBindings.find(candidate =>
                    finalIdentityMatchesKnown(runtime.identity, candidate)
                    && !!runtime.tmux && locatorsEqual(runtime.tmux, candidate.locator));
                let persisted = true;
                if (known && this.options.bindingStore.transitionKnownToInactive) {
                    persisted = await this.options.bindingStore.transitionKnownToInactive(
                        binding, known.lastSeenAtMs
                    );
                } else if (this.options.bindingStore.setInactive) {
                    await this.options.bindingStore.setInactive(binding);
                }
                if (persisted) {
                    retainedInactive.set(key, inactiveSnapshotFromBinding(binding));
                }
            }
        }
        const inactive = [...retainedInactive.values()].filter(runtime =>
            !collisionIdentityKeys.has(identityKey(runtime.identity))
            && !liveActive.some(liveRuntime => finalIdentitiesMatch(
                liveRuntime.identity, runtime.identity
            )));
        await this.options.bindingStore.reconcileKnown(liveActive.map(cloneRuntime));
        return {
            active: liveActive,
            pending: livePending,
            inactive,
            diagnostics: [...diagnosticsByKey.values()],
        };
    }

    private async classifyVanishedKnown(
        knownBindings: readonly TmuxKnownRuntimeBinding[],
        live: readonly AiSessionRuntimeSnapshot[],
        previousActive: readonly AiSessionRuntimeSnapshot[],
        collisionIdentityKeys: ReadonlySet<string>
    ): Promise<AiSessionRuntimeSnapshot[]> {
        const terminal: AiSessionRuntimeSnapshot[] = [];
        const seenKnown = new Set<string>();
        for (const known of knownBindings) {
            const knownKey = knownProjectionKey(known);
            if (seenKnown.has(knownKey)) {
                continue;
            }
            seenKnown.add(knownKey);
            if (collisionIdentityKeys.has(knownIdentityKey(known))) {
                continue;
            }
            if (live.some(runtime => finalIdentityMatchesKnown(runtime.identity, known))) {
                continue;
            }
            const previous = previousActive.find(runtime => finalIdentityMatchesKnown(runtime.identity, known)
                && !!runtime.tmux && locatorsEqual(runtime.tmux, known.locator));
            const markerPath = previous?.markerPath || known.markerPath || '';
            const runStartedAtMs = previous?.runStartedAtMs
                || known.runStartedAtMs || known.lastSeenAtMs;
            const cwd = previous?.identity.cwd || known.cwd || '';
            const completed = !!markerPath
                && await this.options.markerIsCurrent(markerPath, runStartedAtMs);
            terminal.push({
                identity: {
                    provider: known.provider,
                    workspaceScopeIdentity: known.workspaceScopeIdentity,
                    workspaceNavigationIdentity: known.workspaceNavigationIdentity,
                    workspaceRootHostPaths: [...known.workspaceRootHostPaths],
                    cwd,
                    sessionId: known.sessionId,
                },
                backend: 'tmux',
                state: completed ? 'completed' : 'stopped',
                markerPath,
                runStartedAtMs,
                attached: false,
                tmux: { ...known.locator },
            });
        }
        return terminal;
    }
}

export function findTmuxCollisionRuntime(
    diagnostics: readonly AiSessionTmuxDiscoveryDiagnostic[],
    provider: AiSessionRuntimeIdentity['provider'],
    sessionId: string,
    workspaceScopeIdentity: string
): AiSessionRuntimeSnapshot | null {
    const matches = diagnostics.filter(diagnostic =>
        diagnostic.kind === 'tmux-locator-collision'
        && diagnostic.identity.provider === provider
        && diagnostic.identity.sessionId === sessionId
        && diagnostic.identity.workspaceScopeIdentity === workspaceScopeIdentity);
    if (!sessionId || !workspaceScopeIdentity || matches.length === 0) {
        return null;
    }
    const diagnostic = matches[0];
    return {
        identity: cloneAiSessionRuntimeIdentity(diagnostic.identity),
        backend: 'tmux',
        state: 'conflict',
        markerPath: '',
        runStartedAtMs: 0,
        attached: false,
        tmux: { ...diagnostic.expected },
        ...(matches.some(candidate => candidate.stale) ? { stale: true } : {}),
    };
}

export function getTmuxCollisionRuntimes(
    diagnostics: readonly AiSessionTmuxDiscoveryDiagnostic[]
): AiSessionRuntimeSnapshot[] {
    const byIdentity = new Map<string, AiSessionRuntimeSnapshot>();
    for (const diagnostic of diagnostics) {
        if (diagnostic.kind !== 'tmux-locator-collision') {
            continue;
        }
        const key = identityKey(diagnostic.identity);
        if (!byIdentity.has(key)) {
            byIdentity.set(key, {
                identity: cloneAiSessionRuntimeIdentity(diagnostic.identity),
                backend: 'tmux',
                state: 'conflict',
                markerPath: '',
                runStartedAtMs: 0,
                attached: false,
                tmux: { ...diagnostic.expected },
                ...(diagnostic.stale ? { stale: true } : {}),
            });
        } else if (diagnostic.stale) {
            byIdentity.set(key, { ...byIdentity.get(key) as AiSessionRuntimeSnapshot, stale: true });
        }
    }
    return [...byIdentity.values()].map(cloneRuntime);
}

export function isCurrentRuntimeMarker(markerPath: string, runStartedAtMs: number): boolean {
    if (!markerPath || !Number.isFinite(runStartedAtMs) || runStartedAtMs <= 0) {
        return false;
    }
    try {
        if (!existsSync(markerPath)) {
            return false;
        }
        const stat = statSync(markerPath);
        return stat.isFile() && stat.mtimeMs >= runStartedAtMs;
    } catch (_error) {
        return false;
    }
}

function inactiveBindingFromSnapshot(
    runtime: AiSessionRuntimeSnapshot,
    detectedAtMs: number
): TmuxInactiveRuntimeBinding {
    if (!runtime.identity.sessionId || !runtime.tmux
        || (runtime.state !== 'completed' && runtime.state !== 'stopped')) {
        throw new Error('An inactive tmux runtime requires a final managed identity.');
    }
    return {
        version: 2,
        state: runtime.state,
        provider: runtime.identity.provider,
        sessionId: runtime.identity.sessionId,
        workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: runtime.identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...runtime.identity.workspaceRootHostPaths],
        cwd: runtime.identity.cwd,
        layout: runtime.tmux.layout,
        locator: { ...runtime.tmux },
        markerPath: runtime.markerPath,
        runStartedAtMs: runtime.runStartedAtMs,
        detectedAtMs,
    };
}

function inactiveSnapshotFromBinding(
    record: TmuxInactiveRuntimeBinding
): AiSessionRuntimeSnapshot {
    return {
        identity: {
            provider: record.provider,
            workspaceScopeIdentity: record.workspaceScopeIdentity,
            workspaceNavigationIdentity: record.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...record.workspaceRootHostPaths],
            cwd: record.cwd,
            sessionId: record.sessionId,
        },
        backend: 'tmux',
        state: record.state,
        markerPath: record.markerPath,
        runStartedAtMs: record.runStartedAtMs,
        detectedAtMs: record.detectedAtMs,
        attached: false,
        tmux: { ...record.locator },
    };
}

function inactiveSnapshotsEqual(
    left: AiSessionRuntimeSnapshot,
    right: AiSessionRuntimeSnapshot
): boolean {
    return left.backend === 'tmux' && right.backend === 'tmux'
        && left.state === right.state
        && aiSessionRuntimeIdentitiesEqual(left.identity, right.identity)
        && left.markerPath === right.markerPath
        && left.runStartedAtMs === right.runStartedAtMs
        && left.detectedAtMs === right.detectedAtMs
        && !!left.tmux && !!right.tmux && locatorsEqual(left.tmux, right.tmux);
}

function finalIdentityKey(
    provider: AiSessionRuntimeIdentity['provider'],
    sessionId: string,
    workspaceScopeIdentity: string
): string {
    return `${workspaceScopeIdentity}:${provider}:${sessionId}`;
}

function finalIdentitiesMatch(left: AiSessionRuntimeIdentity, right: AiSessionRuntimeIdentity): boolean {
    return !!left.sessionId && !!right.sessionId
        && left.provider === right.provider && left.sessionId === right.sessionId
        && left.workspaceScopeIdentity === right.workspaceScopeIdentity;
}

function parseRowMetadata(row: DiscoveryWindowRecord): AiSessionManagedTmuxMetadata | null {
    if (!row.sessionMetadata || !row.windowMetadata) {
        return null;
    }
    if (row.sessionMetadata.layout === 'project' && row.windowMetadata.layout === 'project') {
        if (!isProjectSessionOwnershipBase(row.sessionMetadata)
            || row.windowMetadata.workspaceScopeIdentity !== row.sessionMetadata.workspaceScopeIdentity) {
            return null;
        }
        const windowProof = parseManagedTmuxMetadata(row.windowMetadata);
        return windowProof && windowProof.layout === 'project'
            ? windowProof
            : null;
    }
    if (row.sessionMetadata.layout === 'session' && row.windowMetadata.layout === 'session') {
        const sessionProof = parseManagedTmuxMetadata(row.sessionMetadata);
        return sessionProof && sessionProof.layout === 'session'
            && isSessionWindowOwnershipBase(row.windowMetadata)
            ? sessionProof
            : null;
    }
    return null;
}

function isProjectSessionOwnershipBase(values: Record<string, string>): boolean {
    return Object.keys(values).length === 4
        && values.managed === '1'
        && values.version === '2'
        && values.layout === 'project'
        && typeof values.workspaceScopeIdentity === 'string';
}

function isSessionWindowOwnershipBase(values: Record<string, string>): boolean {
    return Object.keys(values).length === 3
        && values.managed === '1'
        && values.version === '2'
        && values.layout === 'session';
}

function actualLocator(
    row: DiscoveryWindowRecord,
    layout: 'project' | 'session' | null
): AiSessionTmuxLocator | null {
    if (!layout || typeof row.sessionName !== 'string' || !row.sessionName) {
        return null;
    }
    if (layout === 'session') {
        return row.windowName === 'ai-session'
            ? { layout, sessionName: row.sessionName }
            : typeof row.windowName === 'string' && !!row.windowName
                ? { layout, sessionName: row.sessionName, windowName: row.windowName }
                : null;
    }
    return typeof row.windowName === 'string' && !!row.windowName
        ? { layout, sessionName: row.sessionName, windowName: row.windowName }
        : null;
}

function expectedLocator(identity: AiSessionRuntimeIdentity, layout: 'project' | 'session'): AiSessionTmuxLocator {
    if (layout === 'project') {
        const project = new ProjectTmuxLayout();
        return identity.sessionId ? project.getLocator(identity) : project.getPendingLocator(identity);
    }
    const session = new SessionTmuxLayout();
    return identity.sessionId ? session.getLocator(identity) : session.getPendingLocator(identity);
}

function groupPendingByLocator(
    bindings: readonly TmuxPendingRuntimeBinding[]
): Map<string, TmuxPendingRuntimeBinding[]> {
    const result = new Map<string, TmuxPendingRuntimeBinding[]>();
    for (const binding of bindings.slice(0, MAX_DISCOVERY_ROWS)) {
        const key = locatorKey(binding.locator);
        const values = result.get(key) || [];
        values.push(binding);
        result.set(key, values);
    }
    return result;
}

function findPendingBinding(
    bindings: Map<string, TmuxPendingRuntimeBinding[]>,
    locator: AiSessionTmuxLocator,
    metadata: NonNullable<ReturnType<typeof parseManagedTmuxMetadata>>
): TmuxPendingRuntimeBinding | undefined {
    if (metadata.pendingId === undefined) {
        return undefined;
    }
    return (bindings.get(locatorKey(locator)) || []).find(binding =>
        binding.provider === metadata.provider
        && binding.workspaceScopeIdentity === metadata.workspaceScopeIdentity
        && binding.workspaceNavigationIdentity === metadata.workspaceNavigationIdentity
        && JSON.stringify(binding.workspaceRootHostPaths.slice().sort())
            === JSON.stringify(metadata.workspaceRootHostPaths.slice().sort())
        && binding.cwd === metadata.cwd
        && binding.pendingId === metadata.pendingId
        && binding.layout === metadata.layout
        && locatorsEqual(binding.locator, locator));
}

function findKnownBindingForManagedRow(
    bindings: readonly TmuxKnownRuntimeBinding[],
    metadata: NonNullable<ReturnType<typeof parseManagedTmuxMetadata>>,
    locator: AiSessionTmuxLocator
): TmuxKnownRuntimeBinding | undefined {
    const matches = bindings.filter(binding =>
        binding.provider === metadata.provider
        && binding.workspaceScopeIdentity === metadata.workspaceScopeIdentity
        && binding.workspaceNavigationIdentity === metadata.workspaceNavigationIdentity
        && JSON.stringify(binding.workspaceRootHostPaths.slice().sort())
            === JSON.stringify(metadata.workspaceRootHostPaths.slice().sort())
        && binding.cwd === metadata.cwd
        && binding.layout === metadata.layout
        && locatorsEqual(binding.locator, locator));
    return matches.length === 1 ? matches[0] : undefined;
}

function finalIdentityMatchesKnown(
    identity: AiSessionRuntimeIdentity,
    known: TmuxKnownRuntimeBinding
): boolean {
    return identity.provider === known.provider
        && identity.workspaceScopeIdentity === known.workspaceScopeIdentity
        && identity.workspaceNavigationIdentity === known.workspaceNavigationIdentity
        && JSON.stringify(identity.workspaceRootHostPaths.slice().sort())
            === JSON.stringify(known.workspaceRootHostPaths.slice().sort())
        && identity.cwd === known.cwd
        && identity.sessionId === known.sessionId;
}

function identityKey(identity: AiSessionRuntimeIdentity): string {
    return JSON.stringify([
        identity.provider,
        identity.workspaceScopeIdentity,
        identity.workspaceNavigationIdentity,
        identity.workspaceRootHostPaths.slice().sort(),
        identity.cwd,
        identity.sessionId !== undefined ? 'session' : 'pending',
        identity.sessionId !== undefined ? identity.sessionId : identity.pendingId,
    ]);
}

function knownIdentityKey(known: TmuxKnownRuntimeBinding): string {
    return identityKey({
        provider: known.provider,
        workspaceScopeIdentity: known.workspaceScopeIdentity,
        workspaceNavigationIdentity: known.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...known.workspaceRootHostPaths],
        cwd: known.cwd,
        sessionId: known.sessionId,
    });
}

function runtimeProjectionKey(runtime: AiSessionRuntimeSnapshot): string {
    return JSON.stringify([
        identityKey(runtime.identity),
        runtime.tmux ? locatorKey(runtime.tmux) : '',
    ]);
}

function knownProjectionKey(known: TmuxKnownRuntimeBinding): string {
    return JSON.stringify([knownIdentityKey(known), locatorKey(known.locator)]);
}

function diagnosticKey(diagnostic: AiSessionTmuxDiscoveryDiagnostic): string {
    return JSON.stringify([
        identityKey(diagnostic.identity),
        locatorKey(diagnostic.actual),
        locatorKey(diagnostic.expected),
    ]);
}

function identitiesMatch(runtime: AiSessionRuntimeIdentity, requested: AiSessionRuntimeIdentity): boolean {
    return !!requested && aiSessionRuntimeIdentitiesEqual(runtime, requested);
}

function locatorKey(locator: AiSessionTmuxLocator): string {
    return JSON.stringify([locator.layout, locator.sessionName, locator.windowName || '']);
}

function locatorsEqual(left: AiSessionTmuxLocator, right: AiSessionTmuxLocator): boolean {
    return left.layout === right.layout
        && left.sessionName === right.sessionName
        && left.windowName === right.windowName;
}

function cloneRuntime(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot {
    if (runtime.state === 'pending') {
        return clonePendingRuntime(runtime as AiSessionPendingRuntimeSnapshot);
    }
    return {
        ...runtime,
        identity: cloneAiSessionRuntimeIdentity(runtime.identity),
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function clonePendingRuntime(runtime: AiSessionPendingRuntimeSnapshot): AiSessionPendingRuntimeSnapshot {
    return {
        ...runtime,
        identity: cloneAiSessionRuntimeIdentity(runtime.identity),
        excludedSessionIds: [...runtime.excludedSessionIds],
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function cloneFreshRuntime(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot {
    const clone = cloneRuntime(runtime);
    delete clone.stale;
    return clone;
}

function cloneFreshPendingRuntime(
    runtime: AiSessionPendingRuntimeSnapshot
): AiSessionPendingRuntimeSnapshot {
    const clone = clonePendingRuntime(runtime);
    delete clone.stale;
    return clone;
}

function cloneDiagnostic(diagnostic: AiSessionTmuxDiscoveryDiagnostic): AiSessionTmuxDiscoveryDiagnostic {
    return {
        ...diagnostic,
        identity: cloneAiSessionRuntimeIdentity(diagnostic.identity),
        actual: { ...diagnostic.actual },
        expected: { ...diagnostic.expected },
    };
}

function cloneFreshDiagnostic(
    diagnostic: AiSessionTmuxDiscoveryDiagnostic
): AiSessionTmuxDiscoveryDiagnostic {
    const clone = cloneDiagnostic(diagnostic);
    delete clone.stale;
    return clone;
}
