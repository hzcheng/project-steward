'use strict';

import type * as vscode from 'vscode';
import type { AiSessionProviderId } from '../models';
import type {
    AiSessionCreateRuntimeRequest,
    AiSessionExecutableRuntimeBackend,
    AiSessionPendingRuntimeSnapshot,
    AiSessionResumeRuntimeRequest,
    AiSessionRuntimeActionResult,
    AiSessionRuntimeConfiguration,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import {
    aiSessionRuntimeIdentitiesEqual,
    AiSessionRuntimeConflictError,
    AiSessionRuntimeLifecycleBlockedError,
    AiSessionRuntimeTargetChangedError,
    cloneAiSessionRuntimeIdentity,
    TmuxRuntimeUnavailableError,
} from './runtimeTypes';

export type AiSessionTmuxFallbackChoice = 'direct' | 'direct-anyway' | 'settings' | 'cancel';

export interface AiSessionTmuxFallbackContext {
    operation: 'resume' | 'create';
    knownHint: boolean;
    error: unknown;
}

interface ClosableRuntimeBackend<TTerminal> extends AiSessionExecutableRuntimeBackend<TTerminal> {
    handleClosedTerminal?(terminal: TTerminal): void;
}

export interface AiSessionRuntimeCoordinatorDependencies<TTerminal> {
    direct: ClosableRuntimeBackend<TTerminal>;
    tmux: ClosableRuntimeBackend<TTerminal>;
    getConfiguration(): AiSessionRuntimeConfiguration;
    chooseTmuxFallback(context: AiSessionTmuxFallbackContext): Promise<AiSessionTmuxFallbackChoice>;
    hasLiveTmuxOwnership?(): Promise<boolean>;
    hasKnownTmuxHint?(identity: AiSessionRuntimeIdentity): Promise<boolean>;
    clearKnownTmuxHint?(identity: AiSessionRuntimeIdentity): Promise<void>;
    chooseConflict?(runtimes: AiSessionRuntimeSnapshot<TTerminal>[]): Promise<AiSessionRuntimeSnapshot<TTerminal> | undefined>;
}

interface RefreshOutcome {
    directError?: unknown;
    tmuxError?: unknown;
}

export class AiSessionRuntimeCoordinator<TTerminal = vscode.Terminal> {
    private readonly inFlight = new Map<string, Promise<AiSessionRuntimeActionResult<TTerminal>>>();

    constructor(private readonly dependencies: AiSessionRuntimeCoordinatorDependencies<TTerminal>) { }

    async refresh(force: boolean = false): Promise<void> {
        const outcome = await this.refreshBackends(force);
        if (outcome.directError) {
            throw outcome.directError;
        }
        if (outcome.tmuxError) {
            throw outcome.tmuxError;
        }
    }

    async refreshForHost(force: boolean = false): Promise<void> {
        const outcome = await this.refreshBackends(force);
        if (outcome.directError) {
            throw outcome.directError;
        }
        if (!outcome.tmuxError) {
            return;
        }
        const configuration = snapshotConfiguration(this.dependencies.getConfiguration());
        const cachedLiveOwnership = this.dependencies.tmux.getActive().length > 0
            || this.dependencies.tmux.getPending().length > 0
            || this.getConflicts().some(runtime => runtime.backend === 'tmux');
        const persistedLiveOwnership = this.dependencies.hasLiveTmuxOwnership
            ? await this.dependencies.hasLiveTmuxOwnership()
            : true;
        if (configuration.mode === 'vscode' && !cachedLiveOwnership && !persistedLiveOwnership
            && this.isTmuxUnavailable(outcome.tmuxError)) {
            return;
        }
        throw outcome.tmuxError;
    }

    async refreshForIdentity(identity: AiSessionRuntimeIdentity, force: boolean = true): Promise<void> {
        const cached = this.matchesForIdentity(identity);
        if (cached.length === 1 && cached[0].backend === 'vscode'
            && cached[0].state !== 'conflict') {
            await this.dependencies.direct.refresh(force);
            return;
        }
        await this.refreshForHost(force);
    }

    getActive(): AiSessionRuntimeSnapshot<TTerminal>[] {
        const runtimes = [
            ...this.dependencies.direct.getActive(),
            ...this.dependencies.tmux.getActive(),
            ...this.getConflicts().filter(runtime => Boolean(runtime.identity.sessionId)),
        ].map(cloneRuntime);
        const counts = countFinalIdentities(runtimes);
        return runtimes.map(runtime => counts.get(finalIdentityKey(runtime.identity)) > 1
            ? { ...runtime, state: 'conflict' }
            : runtime);
    }

    getConflicts(): AiSessionRuntimeSnapshot<TTerminal>[] {
        return [
            ...(this.dependencies.direct.getConflicts?.() || []),
            ...(this.dependencies.tmux.getConflicts?.() || []),
        ].map(runtime => ({ ...cloneRuntime(runtime), state: 'conflict' }));
    }

    getLifecycleBlockers(): AiSessionRuntimeSnapshot<TTerminal>[] {
        return [
            ...(this.dependencies.direct.getLifecycleBlockers?.() || []),
            ...(this.dependencies.tmux.getLifecycleBlockers?.() || []),
        ].map(cloneRuntime);
    }

    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[] {
        return [
            ...this.dependencies.direct.getPending(),
            ...this.dependencies.tmux.getPending(),
        ].map(clonePendingRuntime);
    }

    getById(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<TTerminal> | null {
        const matches = this.findMatches({ provider, sessionId, workspaceScopeIdentity });
        return matches.length === 1 ? cloneRuntime(matches[0]) : null;
    }

    getActiveCandidates(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<TTerminal>[] {
        const matches = [
            ...this.dependencies.direct.getActive(),
            ...this.dependencies.tmux.getActive(),
        ].filter(runtime => runtime.state !== 'conflict'
            && runtime.identity.provider === provider
            && runtime.identity.sessionId === sessionId
            && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity);
        const conflict = matches.length > 1;
        return matches.map(runtime => ({
            ...cloneRuntime(runtime),
            ...(conflict ? { state: 'conflict' as const } : {}),
        }));
    }

    getUnverifiedConflicts(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<TTerminal>[] {
        return this.getConflicts().filter(runtime =>
            runtime.identity.provider === provider
            && runtime.identity.sessionId === sessionId
            && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity
        ).map(cloneRuntime);
    }

    resume(request: AiSessionResumeRuntimeRequest): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        const input = snapshotResumeRequest(request);
        const key = `resume:${input.identity.workspaceScopeIdentity}:${input.identity.provider}:${input.identity.sessionId}`;
        return this.singleFlight(key, () => this.resumeOnce(input), 'focused');
    }

    create(request: AiSessionCreateRuntimeRequest): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        const input = snapshotCreateRequest(request);
        const key = `pending:${JSON.stringify([
            input.identity.provider,
            input.identity.workspaceScopeIdentity,
            input.identity.workspaceNavigationIdentity,
            input.identity.workspaceRootHostPaths.slice().sort(),
            input.identity.cwd,
            input.identity.pendingId,
        ])}`;
        return this.singleFlight(key, () => this.createOnce(input));
    }

    async promotePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string },
        sessionId: string
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        const pendingIdentity = cloneAiSessionRuntimeIdentity(identity);
        const refresh = await this.refreshBackends(true);
        this.throwRefreshFailure(refresh);
        const refreshedConflicts = this.getConflicts().filter(runtime =>
            samePendingIdentity(runtime.identity, pendingIdentity));
        if (refreshedConflicts.length) {
            return refreshedConflicts.map(runtime => ({ ...cloneRuntime(runtime), state: 'conflict' }));
        }
        const directMatches = this.dependencies.direct.getPending().filter(runtime =>
            samePendingIdentity(runtime.identity, pendingIdentity));
        const tmuxMatches = this.dependencies.tmux.getPending().filter(runtime =>
            samePendingIdentity(runtime.identity, pendingIdentity));
        if (directMatches.length + tmuxMatches.length > 1) {
            return [...directMatches, ...tmuxMatches].map(runtime => ({
                ...cloneRuntime(runtime),
                state: 'conflict',
            }));
        }
        const backend = directMatches.length === 1
            ? this.dependencies.direct
            : tmuxMatches.length === 1
                ? this.dependencies.tmux
                : null;
        return backend
            ? (await backend.promotePending(pendingIdentity, sessionId)).map(cloneRuntime)
            : [];
    }

    async focus(identity: AiSessionRuntimeIdentity): Promise<void> {
        const cached = this.matchesForIdentity(identity);
        if (cached.length === 1 && cached[0].state !== 'conflict') {
            if (cached[0].backend === 'vscode') {
                await this.dependencies.direct.refresh(true);
                const directMatches = this.matchesInBackend(this.dependencies.direct, identity);
                if (directMatches.length === 1 && directMatches[0].state !== 'conflict') {
                    await this.dependencies.direct.focus(cloneRuntime(directMatches[0]));
                }
                return;
            }
            try {
                await this.dependencies.tmux.focus(cloneRuntime(cached[0]));
                return;
            } catch (error) {
                if (!(error instanceof AiSessionRuntimeTargetChangedError)) {
                    throw error;
                }
            }
            await this.refreshForHost(true);
            const refreshed = this.matchesForIdentity(identity);
            if (refreshed.length !== 1 || refreshed[0].state === 'conflict') {
                return;
            }
            try {
                await this.backendFor(refreshed[0]).focus(cloneRuntime(refreshed[0]));
            } catch (error) {
                if (!(error instanceof AiSessionRuntimeTargetChangedError)) {
                    throw error;
                }
            }
            return;
        }
        await this.refreshForHost(true);
        const matches = this.matchesForIdentity(identity);
        if (matches.length !== 1 || matches[0].state === 'conflict') {
            return;
        }
        try {
            await this.backendFor(matches[0]).focus(cloneRuntime(matches[0]));
        } catch (error) {
            if (!(error instanceof AiSessionRuntimeTargetChangedError)) {
                throw error;
            }
        }
    }

    async focusSelected(selected: AiSessionRuntimeSnapshot<TTerminal>): Promise<boolean> {
        const selection = cloneRuntime(selected);
        const refresh = await this.refreshBackends(true);
        this.throwRefreshFailure(refresh);
        const backend = this.backendFor(selection);
        const matches = backend.getActive()
            .filter(runtime => runtime.state !== 'conflict'
                && selectedRuntimeMatches(selection, runtime));
        if (matches.length !== 1) {
            return false;
        }
        await backend.focus(cloneRuntime(matches[0]));
        return true;
    }

    async detach(identity: AiSessionRuntimeIdentity): Promise<void> {
        const cached = this.matchesForIdentity(identity);
        if (cached.length === 1 && cached[0].backend === 'vscode'
            && cached[0].state !== 'conflict') {
            await this.dependencies.direct.refresh(true);
            const directMatches = this.matchesInBackend(this.dependencies.direct, identity);
            if (directMatches.length === 1 && directMatches[0].state !== 'conflict') {
                await this.dependencies.direct.detach(cloneRuntime(directMatches[0]));
            }
            return;
        }
        await this.refreshForHost(true);
        const matches = this.matchesForIdentity(identity);
        if (matches.length !== 1 || matches[0].state === 'conflict') {
            return;
        }
        await this.backendFor(matches[0]).detach(cloneRuntime(matches[0]));
    }

    handleClosedTerminal(terminal: TTerminal): void {
        this.dependencies.direct.handleClosedTerminal?.(terminal);
        this.dependencies.tmux.handleClosedTerminal?.(terminal);
    }

    private async resumeOnce(
        request: AiSessionResumeRuntimeRequest
    ): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        const refresh = await this.refreshBackends(true);
        if (refresh.directError) {
            throw refresh.directError;
        }
        const lifecycleBlockers = this.getLifecycleBlockers().filter(runtime =>
            sameFinalIdentity(runtime.identity, request.identity));
        if (lifecycleBlockers.length) {
            return blockedResult(lifecycleBlockers);
        }
        const matches = this.findMatches(request.identity);
        if (matches.length > 1 || matches.some(runtime => runtime.state === 'conflict')) {
            return conflictResult(matches);
        }
        if (matches.length === 1) {
            const runtime = matches[0];
            await this.backendFor(runtime).focus(cloneRuntime(runtime));
            return { status: 'focused', runtime: cloneRuntime(runtime) };
        }

        if (refresh.tmuxError && !this.isTmuxUnavailable(refresh.tmuxError)) {
            throw refresh.tmuxError;
        }

        const configuration = snapshotConfiguration(this.dependencies.getConfiguration());
        const knownHint = this.isTmuxUnavailable(refresh.tmuxError)
            && !!this.dependencies.hasKnownTmuxHint
            && await this.dependencies.hasKnownTmuxHint(cloneAiSessionRuntimeIdentity(request.identity));
        if (knownHint) {
            return this.resumeViaExplicitDirect(request, refresh.tmuxError, true);
        }
        if (configuration.mode === 'vscode') {
            const runtime = await this.dependencies.direct.ensureResume(request);
            return { status: 'started', runtime: cloneRuntime(runtime) };
        }
        if (refresh.tmuxError && this.isTmuxUnavailable(refresh.tmuxError)) {
            return this.resumeViaExplicitDirect(request, refresh.tmuxError, false);
        }

        try {
            const runtime = await this.dependencies.tmux.ensureResume(request, configuration.tmuxLayout);
            return { status: 'started', runtime: cloneRuntime(runtime) };
        } catch (error) {
            if (error instanceof AiSessionRuntimeLifecycleBlockedError) {
                return blockedResult(error.blockers as AiSessionRuntimeSnapshot<TTerminal>[]);
            }
            if (error instanceof AiSessionRuntimeConflictError) {
                return conflictResult(error.conflicts as AiSessionRuntimeSnapshot<TTerminal>[]);
            }
            if (!this.isTmuxUnavailable(error)) {
                throw error;
            }
            const hasKnownHint = !!this.dependencies.hasKnownTmuxHint
                && await this.dependencies.hasKnownTmuxHint(cloneAiSessionRuntimeIdentity(request.identity));
            return this.resumeViaExplicitDirect(request, error, hasKnownHint);
        }
    }

    private async createOnce(
        request: AiSessionCreateRuntimeRequest
    ): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        const refresh = await this.refreshBackends(true);
        if (refresh.directError) {
            throw refresh.directError;
        }
        const existing: AiSessionRuntimeSnapshot<TTerminal>[] = [
            ...this.getPending().filter(runtime =>
                samePendingIdentity(runtime.identity, request.identity)),
            ...this.getConflicts().filter(runtime =>
                samePendingIdentity(runtime.identity, request.identity)),
        ];
        if (existing.length > 1 || existing.some(runtime => runtime.state === 'conflict')) {
            return conflictResult(existing);
        }
        if (existing.length === 1) {
            await this.backendFor(existing[0]).focus(existing[0]);
            return { status: 'focused', runtime: cloneRuntime(existing[0]) };
        }

        if (refresh.tmuxError && !this.isTmuxUnavailable(refresh.tmuxError)) {
            throw refresh.tmuxError;
        }

        const configuration = snapshotConfiguration(this.dependencies.getConfiguration());
        if (configuration.mode === 'vscode') {
            const runtime = await this.dependencies.direct.ensurePending(request);
            return { status: 'started', runtime: cloneRuntime(runtime) };
        }
        if (refresh.tmuxError && this.isTmuxUnavailable(refresh.tmuxError)) {
            return this.createViaExplicitDirect(request, refresh.tmuxError);
        }
        try {
            const runtime = await this.dependencies.tmux.ensurePending(request, configuration.tmuxLayout);
            return { status: 'started', runtime: cloneRuntime(runtime) };
        } catch (error) {
            if (error instanceof AiSessionRuntimeConflictError) {
                return conflictResult(error.conflicts as AiSessionRuntimeSnapshot<TTerminal>[]);
            }
            if (!this.isTmuxUnavailable(error)) {
                throw error;
            }
            return this.createViaExplicitDirect(request, error);
        }
    }

    private async resumeViaExplicitDirect(
        request: AiSessionResumeRuntimeRequest,
        error: unknown,
        knownHint: boolean
    ): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        const choice = await this.dependencies.chooseTmuxFallback({
            operation: 'resume',
            knownHint,
            error,
        });
        if (choice === 'settings') {
            return { status: 'settings' };
        }
        const accepted = knownHint ? choice === 'direct-anyway' : choice === 'direct';
        if (!accepted) {
            return { status: 'cancelled' };
        }
        const runtime = await this.dependencies.direct.ensureResume(request);
        if (knownHint && this.dependencies.clearKnownTmuxHint) {
            await this.dependencies.clearKnownTmuxHint(cloneAiSessionRuntimeIdentity(request.identity));
        }
        return { status: 'started', runtime: cloneRuntime(runtime) };
    }

    private async createViaExplicitDirect(
        request: AiSessionCreateRuntimeRequest,
        error: unknown
    ): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        const choice = await this.dependencies.chooseTmuxFallback({
            operation: 'create',
            knownHint: false,
            error,
        });
        if (choice === 'settings') {
            return { status: 'settings' };
        }
        if (choice !== 'direct') {
            return { status: 'cancelled' };
        }
        const runtime = await this.dependencies.direct.ensurePending(request);
        return { status: 'started', runtime: cloneRuntime(runtime) };
    }

    private async refreshBackends(force: boolean): Promise<RefreshOutcome> {
        let directError: unknown;
        let tmuxError: unknown;
        await Promise.all([
            Promise.resolve().then(() => this.dependencies.direct.refresh(force))
                .catch(error => { directError = error; }),
            Promise.resolve().then(() => this.dependencies.tmux.refresh(force))
                .catch(error => { tmuxError = error; }),
        ]);
        return { directError, tmuxError };
    }

    private throwRefreshFailure(outcome: RefreshOutcome): void {
        if (outcome.directError) {
            throw outcome.directError;
        }
        if (outcome.tmuxError) {
            throw outcome.tmuxError;
        }
    }

    private findMatches(
        identity: Pick<AiSessionRuntimeIdentity, 'provider' | 'sessionId'>
            & Partial<Pick<AiSessionRuntimeIdentity, 'workspaceScopeIdentity'>>
    ): AiSessionRuntimeSnapshot<TTerminal>[] {
        if (!identity?.provider || !identity.sessionId) {
            return [];
        }
        return [
            ...this.dependencies.direct.getActive(),
            ...this.dependencies.tmux.getActive(),
            ...this.getConflicts().filter(runtime => Boolean(runtime.identity.sessionId)),
        ].filter(runtime => runtime.identity.provider === identity.provider
            && runtime.identity.sessionId === identity.sessionId
            && (identity.workspaceScopeIdentity === undefined
                || runtime.identity.workspaceScopeIdentity === identity.workspaceScopeIdentity));
    }

    private matchesForIdentity(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[] {
        if (identity?.sessionId) {
            return this.findMatches(identity);
        }
        return identity?.pendingId
            ? [...this.getPending(), ...this.getConflicts()]
                .filter(runtime => samePendingIdentity(runtime.identity, identity))
            : [];
    }

    private matchesInBackend(
        backend: ClosableRuntimeBackend<TTerminal>,
        identity: AiSessionRuntimeIdentity
    ): AiSessionRuntimeSnapshot<TTerminal>[] {
        if (identity?.sessionId) {
            return backend.getActive().filter(runtime =>
                sameFinalIdentity(runtime.identity, identity));
        }
        return identity?.pendingId
            ? backend.getPending().filter(runtime => samePendingIdentity(runtime.identity, identity))
            : [];
    }

    private backendFor(runtime: AiSessionRuntimeSnapshot<TTerminal>): ClosableRuntimeBackend<TTerminal> {
        return runtime.backend === 'tmux' ? this.dependencies.tmux : this.dependencies.direct;
    }

    private isTmuxUnavailable(error: unknown): boolean {
        return error instanceof TmuxRuntimeUnavailableError;
    }

    private singleFlight(
        key: string,
        operation: () => Promise<AiSessionRuntimeActionResult<TTerminal>>,
        joinedStartedStatus?: 'focused'
    ): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        let promise = this.inFlight.get(key);
        const joined = promise !== undefined;
        if (!promise) {
            promise = Promise.resolve().then(operation);
            this.inFlight.set(key, promise);
            promise.then(
                () => this.releaseFlight(key, promise),
                () => this.releaseFlight(key, promise)
            );
        }
        return promise.then(result => {
            const cloned = cloneActionResult(result);
            if (joined && joinedStartedStatus && cloned.status === 'started') {
                cloned.status = joinedStartedStatus;
            }
            return cloned;
        });
    }

    private releaseFlight(key: string, promise: Promise<AiSessionRuntimeActionResult<TTerminal>>): void {
        if (this.inFlight.get(key) === promise) {
            this.inFlight.delete(key);
        }
    }
}

function snapshotConfiguration(configuration: AiSessionRuntimeConfiguration): AiSessionRuntimeConfiguration {
    return {
        mode: configuration.mode,
        tmuxLayout: configuration.tmuxLayout,
        tmuxPath: configuration.tmuxPath,
    };
}

function snapshotResumeRequest(request: AiSessionResumeRuntimeRequest): AiSessionResumeRuntimeRequest {
    return {
        ...request,
        identity: cloneAiSessionRuntimeIdentity(request.identity),
        directoryScope: cloneDirectoryScope(request.directoryScope),
        launch: { ...request.launch, args: [...request.launch.args] },
    };
}

function snapshotCreateRequest(request: AiSessionCreateRuntimeRequest): AiSessionCreateRuntimeRequest {
    return {
        ...request,
        identity: cloneAiSessionRuntimeIdentity(request.identity),
        directoryScope: cloneDirectoryScope(request.directoryScope),
        excludedSessionIds: [...request.excludedSessionIds],
        launch: { ...request.launch, args: [...request.launch.args] },
    };
}

function cloneRuntime<TTerminal>(runtime: AiSessionRuntimeSnapshot<TTerminal>): AiSessionRuntimeSnapshot<TTerminal> {
    return {
        ...runtime,
        identity: cloneAiSessionRuntimeIdentity(runtime.identity),
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
        ...(runtime.title === undefined ? {} : { title: runtime.title }),
    };
}

function cloneActionResult<TTerminal>(
    result: AiSessionRuntimeActionResult<TTerminal>
): AiSessionRuntimeActionResult<TTerminal> {
    return {
        status: result.status,
        ...(result.runtime ? { runtime: cloneActionRuntime(result.runtime) } : {}),
        ...(result.conflicts ? { conflicts: result.conflicts.map(cloneActionRuntime) } : {}),
        ...(result.blockers ? { blockers: result.blockers.map(cloneActionRuntime) } : {}),
    };
}

function cloneActionRuntime<TTerminal>(
    runtime: AiSessionRuntimeSnapshot<TTerminal>
): AiSessionRuntimeSnapshot<TTerminal> {
    const pending = runtime as AiSessionPendingRuntimeSnapshot<TTerminal>;
    if (typeof pending.createdAt !== 'string' || !Array.isArray(pending.excludedSessionIds)) {
        return cloneRuntime(runtime);
    }
    return {
        ...clonePendingRuntime(pending),
        state: runtime.state,
    };
}

function conflictResult<TTerminal>(
    runtimes: AiSessionRuntimeSnapshot<TTerminal>[]
): AiSessionRuntimeActionResult<TTerminal> {
    return {
        status: 'conflict',
        conflicts: runtimes.map(runtime => ({ ...cloneRuntime(runtime), state: 'conflict' })),
    };
}

function blockedResult<TTerminal>(
    runtimes: AiSessionRuntimeSnapshot<TTerminal>[]
): AiSessionRuntimeActionResult<TTerminal> {
    return {
        status: 'blocked',
        blockers: runtimes.map(cloneRuntime),
    };
}

function finalIdentityKey(identity: AiSessionRuntimeIdentity): string {
    return identity.sessionId
        ? `${identity.workspaceScopeIdentity}:${identity.provider}:${identity.sessionId}`
        : '';
}

function countFinalIdentities<TTerminal>(
    runtimes: AiSessionRuntimeSnapshot<TTerminal>[]
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const runtime of runtimes) {
        const key = finalIdentityKey(runtime.identity);
        if (key) {
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    return counts;
}

function samePendingIdentity(left: AiSessionRuntimeIdentity, right: AiSessionRuntimeIdentity): boolean {
    return !!left.pendingId && !!right.pendingId && sameFullIdentity(left, right);
}

function sameFinalIdentity(left: AiSessionRuntimeIdentity, right: AiSessionRuntimeIdentity): boolean {
    return !!left.sessionId && left.sessionId === right.sessionId
        && left.provider === right.provider
        && left.workspaceScopeIdentity === right.workspaceScopeIdentity;
}

function selectedRuntimeMatches<TTerminal>(
    selected: AiSessionRuntimeSnapshot<TTerminal>,
    current: AiSessionRuntimeSnapshot<TTerminal>
): boolean {
    if (selected.backend !== current.backend
        || selected.markerPath !== current.markerPath
        || selected.runStartedAtMs !== current.runStartedAtMs
        || !sameFullIdentity(selected.identity, current.identity)) {
        return false;
    }
    if (selected.backend === 'vscode') {
        return !!selected.terminal && selected.terminal === current.terminal;
    }
    return !!selected.tmux && !!current.tmux
        && selected.tmux.layout === current.tmux.layout
        && selected.tmux.sessionName === current.tmux.sessionName
        && selected.tmux.windowName === current.tmux.windowName;
}

function sameFullIdentity(left: AiSessionRuntimeIdentity, right: AiSessionRuntimeIdentity): boolean {
    return aiSessionRuntimeIdentitiesEqual(left, right);
}

function cloneDirectoryScope(scope: AiSessionResumeRuntimeRequest['directoryScope']): AiSessionResumeRuntimeRequest['directoryScope'] {
    return {
        ...scope,
        workspaceRootHostPaths: [...scope.workspaceRootHostPaths],
        additionalDirectories: [...scope.additionalDirectories],
    };
}
