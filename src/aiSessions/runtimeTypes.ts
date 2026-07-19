'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionLaunchSpec } from './launchSpec';

const MAX_RUNTIME_IDENTITY_ID_LENGTH = 512;
const SAFE_RUNTIME_IDENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isValidAiSessionRuntimeIdentityId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_RUNTIME_IDENTITY_ID_LENGTH
        && SAFE_RUNTIME_IDENTITY_ID.test(value);
}

export type AiSessionRuntimeBackendId = 'vscode' | 'tmux';
export type AiSessionTmuxLayout = 'project' | 'session';
export type AiSessionRuntimeState = 'pending' | 'active' | 'completed' | 'stopped' | 'conflict';

export type TmuxRuntimeUnavailableReason =
    | 'unsupported-platform'
    | 'not-found'
    | 'permission-denied'
    | 'probe-timeout'
    | 'invalid-version'
    | 'missing-capability'
    | 'probe-failed';

export class TmuxRuntimeUnavailableError extends Error {
    readonly code = 'TMUX_RUNTIME_UNAVAILABLE';

    constructor(
        public readonly reason: TmuxRuntimeUnavailableReason,
        message: string
    ) {
        super(message);
        this.name = 'TmuxRuntimeUnavailableError';
        Object.setPrototypeOf(this, TmuxRuntimeUnavailableError.prototype);
    }
}

export interface AiSessionRuntimeIdentity {
    provider: AiSessionProviderId;
    projectKey: string;
    cwd: string;
    sessionId?: string;
    pendingId?: string;
}

export interface AiSessionTmuxLocator {
    layout: AiSessionTmuxLayout;
    sessionName: string;
    windowName?: string;
}

export interface AiSessionTmuxDiscoveryDiagnostic {
    kind: 'tmux-locator-collision';
    identity: AiSessionRuntimeIdentity;
    actual: AiSessionTmuxLocator;
    expected: AiSessionTmuxLocator;
    stale?: boolean;
}

export interface AiSessionManagedTmuxMetadataBase {
    version: 1;
    layout: AiSessionTmuxLayout;
    projectKey: string;
    provider: AiSessionProviderId;
    createdAt?: string;
    marker?: string;
}

export type AiSessionManagedTmuxMetadata = AiSessionManagedTmuxMetadataBase & (
    { sessionId: string; pendingId?: never }
    | { pendingId: string; sessionId?: never }
);

// Keep the normalized ownership contract aligned with the runtime parser.
type AssertFalse<T extends false> = T;
type ManagedTmuxMetadataRejectsBothIds = AssertFalse<{
    version: 1;
    layout: 'project';
    projectKey: string;
    provider: 'codex';
    sessionId: string;
    pendingId: string;
} extends AiSessionManagedTmuxMetadata ? true : false>;
type ManagedTmuxMetadataRejectsMissingIds = AssertFalse<{
    version: 1;
    layout: 'project';
    projectKey: string;
    provider: 'codex';
} extends AiSessionManagedTmuxMetadata ? true : false>;

export interface AiSessionRuntimeSnapshot<TTerminal = unknown> {
    identity: AiSessionRuntimeIdentity;
    backend: AiSessionRuntimeBackendId;
    state: AiSessionRuntimeState;
    markerPath: string;
    runStartedAtMs: number;
    detectedAtMs?: number;
    stale?: boolean;
    attached: boolean;
    terminal?: TTerminal;
    tmux?: AiSessionTmuxLocator;
}

export class AiSessionRuntimeConflictError extends Error {
    readonly conflicts: AiSessionRuntimeSnapshot[];

    constructor(conflicts: readonly AiSessionRuntimeSnapshot[]) {
        super('Multiple or conflicting AI session runtimes were discovered.');
        this.name = 'AiSessionRuntimeConflictError';
        this.conflicts = (conflicts || []).map(runtime => ({
            ...runtime,
            state: 'conflict',
            identity: { ...runtime.identity },
            ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        }));
        Object.setPrototypeOf(this, AiSessionRuntimeConflictError.prototype);
    }
}

export class AiSessionRuntimeLifecycleBlockedError extends Error {
    readonly blockers: AiSessionRuntimeSnapshot[];

    constructor(blockers: readonly AiSessionRuntimeSnapshot[]) {
        super('AI session runtime replay is blocked until lifecycle acknowledgement completes.');
        this.name = 'AiSessionRuntimeLifecycleBlockedError';
        this.blockers = (blockers || []).map(runtime => ({
            ...runtime,
            identity: { ...runtime.identity },
            ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        }));
        Object.setPrototypeOf(this, AiSessionRuntimeLifecycleBlockedError.prototype);
    }
}

export interface AiSessionPendingRuntimeSnapshot<TTerminal = unknown> extends AiSessionRuntimeSnapshot<TTerminal> {
    state: 'pending';
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
}

export interface AiSessionRuntimeConfiguration {
    mode: AiSessionRuntimeBackendId;
    tmuxLayout: AiSessionTmuxLayout;
    tmuxPath: string;
}

export interface AiSessionRuntimeBackend<TTerminal = unknown> {
    refresh(force?: boolean): Promise<void>;
    getActive(): AiSessionRuntimeSnapshot<TTerminal>[];
    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[];
    getConflicts?(): AiSessionRuntimeSnapshot<TTerminal>[];
    getLifecycleBlockers?(): AiSessionRuntimeSnapshot<TTerminal>[];
    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[];
    focus(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void>;
    detach(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void>;
}

export interface AiSessionResumeRuntimeRequest {
    identity: AiSessionRuntimeIdentity & { sessionId: string };
    projectName: string;
    terminalName: string;
    launch: AiSessionLaunchSpec;
}

export interface AiSessionCreateRuntimeRequest {
    identity: AiSessionRuntimeIdentity & { pendingId: string };
    projectName: string;
    terminalName: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
    launch: AiSessionLaunchSpec;
}

export interface AiSessionRuntimeActionResult<TTerminal = unknown> {
    status: 'started' | 'focused' | 'cancelled' | 'settings' | 'conflict' | 'blocked';
    runtime?: AiSessionRuntimeSnapshot<TTerminal>;
    conflicts?: AiSessionRuntimeSnapshot<TTerminal>[];
    blockers?: AiSessionRuntimeSnapshot<TTerminal>[];
}

export interface AiSessionExecutableRuntimeBackend<TTerminal = unknown> extends AiSessionRuntimeBackend<TTerminal> {
    ensureResume(
        request: AiSessionResumeRuntimeRequest,
        layout?: AiSessionTmuxLayout
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>>;
    ensurePending(
        request: AiSessionCreateRuntimeRequest,
        layout?: AiSessionTmuxLayout
    ): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>>;
    promotePending(pendingId: string, sessionId: string): Promise<AiSessionRuntimeSnapshot<TTerminal>[]>;
}
