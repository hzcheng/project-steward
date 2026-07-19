'use strict';

import { existsSync, statSync } from 'fs';

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
import type {
    TmuxInactiveRuntimeBinding,
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
    acknowledgeInactive?(provider: AiSessionRuntimeIdentity['provider'], sessionId: string): Promise<void>;
    reconcileKnown(live: readonly AiSessionRuntimeSnapshot[]): Promise<void>;
    removeKnown?(provider: AiSessionRuntimeIdentity['provider'], sessionId: string): Promise<void>;
}

export interface TmuxRuntimeDiscoveryOptions {
    client: TmuxDiscoveryClient;
    bindingStore: TmuxDiscoveryBindingStore;
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

    async acknowledgeInactive(identity: AiSessionRuntimeIdentity): Promise<void> {
        if (!identity?.sessionId) {
            return;
        }
        const key = finalIdentityKey(identity.provider, identity.sessionId);
        this.cacheGeneration++;
        this.successfulAtMs = null;
        if (this.options.bindingStore.acknowledgeInactive) {
            await this.options.bindingStore.acknowledgeInactive(identity.provider, identity.sessionId);
        } else if (this.options.bindingStore.removeKnown) {
            await this.options.bindingStore.removeKnown(identity.provider, identity.sessionId);
        }
        this.retainedInactive.delete(key);
        this.inactive = this.inactive.filter(runtime =>
            finalIdentityKey(runtime.identity.provider, runtime.identity.sessionId || '') !== key);
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
        this.active = result.active.map(cloneRuntime);
        this.pending = result.pending.map(clonePendingRuntime);
        this.inactive = result.inactive.map(cloneRuntime);
        this.diagnostics = result.diagnostics.map(cloneDiagnostic);
        this.retainedInactive.clear();
        for (const runtime of result.inactive) {
            const sessionId = runtime.identity.sessionId;
            if (sessionId) {
                this.retainedInactive.set(
                    finalIdentityKey(runtime.identity.provider, sessionId), cloneRuntime(runtime)
                );
            }
        }
        this.successfulAtMs = this.nowMs();
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
                projectKey: parsed.projectKey,
                cwd: pendingBinding ? pendingBinding.cwd : '',
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
            }
            if (!locatorsEqual(actual, expected)) {
                collisionIdentityKeys.add(parsedIdentityKey);
                const diagnostic: AiSessionTmuxDiscoveryDiagnostic = {
                    kind: 'tmux-locator-collision',
                    identity,
                    actual,
                    expected,
                };
                diagnosticsByKey.set(diagnosticKey(diagnostic), diagnostic);
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
                    ...(pendingBinding.title === undefined ? {} : { title: pendingBinding.title }),
                };
                pendingByKey.set(runtimeProjectionKey(snapshot), snapshot);
                continue;
            }

            const snapshot: AiSessionRuntimeSnapshot = {
                identity,
                backend: 'tmux',
                state: 'active',
                markerPath: parsed.marker || '',
                runStartedAtMs: parsed.createdAt ? Date.parse(parsed.createdAt) : 0,
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
                retainedInactive.set(finalIdentityKey(runtime.identity.provider, sessionId), cloneRuntime(runtime));
            }
        }
        for (const record of persistedInactiveBindings) {
            retainedInactive.set(finalIdentityKey(record.provider, record.sessionId),
                inactiveSnapshotFromBinding(record));
        }
        for (const runtime of liveActive) {
            if (runtime.identity.sessionId) {
                retainedInactive.delete(finalIdentityKey(
                    runtime.identity.provider, runtime.identity.sessionId
                ));
            }
        }
        for (const runtime of newlyInactive) {
            const sessionId = runtime.identity.sessionId;
            if (!sessionId) {
                continue;
            }
            const key = finalIdentityKey(runtime.identity.provider, sessionId);
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
                    retainedInactive.set(key, cloneRuntime(runtime));
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
            const completed = !!previous && !!previous.markerPath
                && await this.options.markerIsCurrent(previous.markerPath, previous.runStartedAtMs);
            terminal.push({
                identity: {
                    provider: known.provider,
                    projectKey: known.projectKey,
                    cwd: '',
                    sessionId: known.sessionId,
                },
                backend: 'tmux',
                state: completed ? 'completed' : 'stopped',
                markerPath: previous ? previous.markerPath : '',
                runStartedAtMs: previous ? previous.runStartedAtMs : known.lastSeenAtMs,
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
    sessionId: string
): AiSessionRuntimeSnapshot | null {
    const matches = diagnostics.filter(diagnostic =>
        diagnostic.kind === 'tmux-locator-collision'
        && diagnostic.identity.provider === provider
        && diagnostic.identity.sessionId === sessionId);
    if (!sessionId || matches.length === 0) {
        return null;
    }
    const diagnostic = matches[0];
    return {
        identity: { ...diagnostic.identity },
        backend: 'tmux',
        state: 'conflict',
        markerPath: '',
        runStartedAtMs: 0,
        attached: false,
        tmux: { ...diagnostic.expected },
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
                identity: { ...diagnostic.identity },
                backend: 'tmux',
                state: 'conflict',
                markerPath: '',
                runStartedAtMs: 0,
                attached: false,
                tmux: { ...diagnostic.expected },
            });
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
        version: 1,
        state: runtime.state,
        provider: runtime.identity.provider,
        sessionId: runtime.identity.sessionId,
        projectKey: runtime.identity.projectKey,
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
            projectKey: record.projectKey,
            cwd: record.cwd,
            sessionId: record.sessionId,
        },
        backend: 'tmux',
        state: record.state,
        markerPath: record.markerPath,
        runStartedAtMs: record.runStartedAtMs,
        attached: false,
        tmux: { ...record.locator },
    };
}

function finalIdentityKey(provider: AiSessionRuntimeIdentity['provider'], sessionId: string): string {
    return `${provider}:${sessionId}`;
}

function finalIdentitiesMatch(left: AiSessionRuntimeIdentity, right: AiSessionRuntimeIdentity): boolean {
    return !!left.sessionId && !!right.sessionId
        && left.provider === right.provider && left.sessionId === right.sessionId;
}

function parseRowMetadata(row: DiscoveryWindowRecord): AiSessionManagedTmuxMetadata | null {
    if (!row.sessionMetadata || !row.windowMetadata) {
        return null;
    }
    if (row.sessionMetadata.layout === 'project' && row.windowMetadata.layout === 'project') {
        if (!isProjectSessionOwnershipBase(row.sessionMetadata)
            || row.windowMetadata.projectKey !== undefined) {
            return null;
        }
        const windowProof = parseManagedTmuxMetadata({
            ...row.windowMetadata,
            projectKey: row.sessionMetadata.projectKey,
        });
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
    return values.managed === '1'
        && values.version === '1'
        && values.layout === 'project'
        && typeof values.projectKey === 'string'
        && values.provider === undefined
        && values.sessionId === undefined
        && values.pendingId === undefined
        && values.createdAt === undefined
        && values.marker === undefined;
}

function isSessionWindowOwnershipBase(values: Record<string, string>): boolean {
    return values.managed === '1'
        && values.version === '1'
        && values.layout === 'session'
        && values.projectKey === undefined
        && values.provider === undefined
        && values.sessionId === undefined
        && values.pendingId === undefined
        && values.createdAt === undefined
        && values.marker === undefined;
}

function actualLocator(
    row: DiscoveryWindowRecord,
    layout: 'project' | 'session' | null
): AiSessionTmuxLocator | null {
    if (!layout || typeof row.sessionName !== 'string' || !row.sessionName) {
        return null;
    }
    if (layout === 'session') {
        return { layout, sessionName: row.sessionName };
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
        && binding.projectKey === metadata.projectKey
        && binding.pendingId === metadata.pendingId
        && binding.layout === metadata.layout
        && locatorsEqual(binding.locator, locator));
}

function finalIdentityMatchesKnown(
    identity: AiSessionRuntimeIdentity,
    known: TmuxKnownRuntimeBinding
): boolean {
    return identity.provider === known.provider
        && identity.projectKey === known.projectKey
        && identity.sessionId === known.sessionId;
}

function identityKey(identity: AiSessionRuntimeIdentity): string {
    return JSON.stringify([
        identity.provider,
        identity.projectKey,
        identity.sessionId !== undefined ? 'session' : 'pending',
        identity.sessionId !== undefined ? identity.sessionId : identity.pendingId,
    ]);
}

function knownIdentityKey(known: TmuxKnownRuntimeBinding): string {
    return identityKey({
        provider: known.provider,
        projectKey: known.projectKey,
        cwd: '',
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
    if (!requested || runtime.provider !== requested.provider || runtime.projectKey !== requested.projectKey) {
        return false;
    }
    if (runtime.sessionId !== undefined) {
        return requested.sessionId === runtime.sessionId;
    }
    return requested.pendingId === runtime.pendingId
        && (!requested.cwd || requested.cwd === runtime.cwd);
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
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function clonePendingRuntime(runtime: AiSessionPendingRuntimeSnapshot): AiSessionPendingRuntimeSnapshot {
    return {
        ...runtime,
        identity: { ...runtime.identity },
        excludedSessionIds: [...runtime.excludedSessionIds],
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function cloneDiagnostic(diagnostic: AiSessionTmuxDiscoveryDiagnostic): AiSessionTmuxDiscoveryDiagnostic {
    return {
        ...diagnostic,
        identity: { ...diagnostic.identity },
        actual: { ...diagnostic.actual },
        expected: { ...diagnostic.expected },
    };
}
