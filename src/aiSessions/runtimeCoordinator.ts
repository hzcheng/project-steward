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
import { TmuxRuntimeUnavailableError } from './runtimeTypes';

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

    getActive(): AiSessionRuntimeSnapshot<TTerminal>[] {
        const runtimes = [
            ...this.dependencies.direct.getActive(),
            ...this.dependencies.tmux.getActive(),
        ].map(cloneRuntime);
        const counts = countFinalIdentities(runtimes);
        return runtimes.map(runtime => counts.get(finalIdentityKey(runtime.identity)) > 1
            ? { ...runtime, state: 'conflict' }
            : runtime);
    }

    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[] {
        return [
            ...this.dependencies.direct.getPending(),
            ...this.dependencies.tmux.getPending(),
        ].map(clonePendingRuntime);
    }

    getById(
        provider: AiSessionProviderId,
        sessionId: string
    ): AiSessionRuntimeSnapshot<TTerminal> | null {
        const matches = this.findMatches({ provider, sessionId });
        return matches.length === 1 ? cloneRuntime(matches[0]) : null;
    }

    resume(request: AiSessionResumeRuntimeRequest): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        const input = snapshotResumeRequest(request);
        const key = `resume:${input.identity.provider}:${input.identity.sessionId}`;
        return this.singleFlight(key, () => this.resumeOnce(input));
    }

    create(request: AiSessionCreateRuntimeRequest): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        const input = snapshotCreateRequest(request);
        const key = `pending:${input.identity.pendingId}`;
        return this.singleFlight(key, () => this.createOnce(input));
    }

    async promotePending(
        pendingId: string,
        sessionId: string
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        await this.refreshBackends(true);
        const directMatches = this.dependencies.direct.getPending().filter(runtime =>
            runtime.identity.pendingId === pendingId);
        const tmuxMatches = this.dependencies.tmux.getPending().filter(runtime =>
            runtime.identity.pendingId === pendingId);
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
            ? (await backend.promotePending(pendingId, sessionId)).map(cloneRuntime)
            : [];
    }

    async focus(identity: AiSessionRuntimeIdentity): Promise<void> {
        const matches = this.matchesForIdentity(identity);
        if (matches.length !== 1) {
            return;
        }
        await this.backendFor(matches[0]).focus(cloneRuntime(matches[0]));
    }

    async detach(identity: AiSessionRuntimeIdentity): Promise<void> {
        const matches = this.matchesForIdentity(identity);
        if (matches.length !== 1) {
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
        const matches = this.findMatches(request.identity);
        if (matches.length > 1) {
            return conflictResult(matches);
        }
        if (matches.length === 1) {
            const runtime = matches[0];
            await this.backendFor(runtime).focus(cloneRuntime(runtime));
            return { status: 'focused', runtime: cloneRuntime(runtime) };
        }

        const configuration = snapshotConfiguration(this.dependencies.getConfiguration());
        const knownHint = this.isTmuxUnavailable(refresh.tmuxError)
            && !!this.dependencies.hasKnownTmuxHint
            && await this.dependencies.hasKnownTmuxHint({ ...request.identity });
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
            if (!this.isTmuxUnavailable(error)) {
                throw error;
            }
            const hasKnownHint = !!this.dependencies.hasKnownTmuxHint
                && await this.dependencies.hasKnownTmuxHint({ ...request.identity });
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
        const existing = this.getPending().filter(runtime =>
            runtime.identity.pendingId === request.identity.pendingId);
        if (existing.length > 1) {
            return conflictResult(existing);
        }
        if (existing.length === 1) {
            await this.backendFor(existing[0]).focus(existing[0]);
            return { status: 'focused', runtime: cloneRuntime(existing[0]) };
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
            await this.dependencies.clearKnownTmuxHint({ ...request.identity });
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

    private findMatches(identity: Pick<AiSessionRuntimeIdentity, 'provider' | 'sessionId'>): AiSessionRuntimeSnapshot<TTerminal>[] {
        if (!identity?.provider || !identity.sessionId) {
            return [];
        }
        return [
            ...this.dependencies.direct.getActive(),
            ...this.dependencies.tmux.getActive(),
        ].filter(runtime => runtime.identity.provider === identity.provider
            && runtime.identity.sessionId === identity.sessionId);
    }

    private matchesForIdentity(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[] {
        if (identity?.sessionId) {
            return this.findMatches(identity);
        }
        return identity?.pendingId
            ? this.getPending().filter(runtime => samePendingIdentity(runtime.identity, identity))
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
        operation: () => Promise<AiSessionRuntimeActionResult<TTerminal>>
    ): Promise<AiSessionRuntimeActionResult<TTerminal>> {
        let promise = this.inFlight.get(key);
        if (!promise) {
            promise = Promise.resolve().then(operation);
            this.inFlight.set(key, promise);
            promise.then(
                () => this.releaseFlight(key, promise),
                () => this.releaseFlight(key, promise)
            );
        }
        return promise.then(cloneActionResult);
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
        identity: { ...request.identity },
        launch: { ...request.launch, args: [...request.launch.args] },
    };
}

function snapshotCreateRequest(request: AiSessionCreateRuntimeRequest): AiSessionCreateRuntimeRequest {
    return {
        ...request,
        identity: { ...request.identity },
        excludedSessionIds: [...request.excludedSessionIds],
        launch: { ...request.launch, args: [...request.launch.args] },
    };
}

function cloneRuntime<TTerminal>(runtime: AiSessionRuntimeSnapshot<TTerminal>): AiSessionRuntimeSnapshot<TTerminal> {
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

function finalIdentityKey(identity: AiSessionRuntimeIdentity): string {
    return identity.sessionId ? `${identity.provider}:${identity.sessionId}` : '';
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
    return !!left.pendingId && left.pendingId === right.pendingId
        && left.provider === right.provider;
}
