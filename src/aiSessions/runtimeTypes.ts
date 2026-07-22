'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionLaunchSpec } from './launchSpec';
import type { AiSessionDirectoryScope } from './types';
import {
    getWorkspaceHostPathComparisonKey,
    isWorkspaceHostPathContained,
    normalizeWorkspaceHostPath,
} from '../workspaces/sessionAssignment';

const MAX_RUNTIME_IDENTITY_ID_LENGTH = 512;
const MAX_RUNTIME_NAVIGATION_IDENTITY_LENGTH = 4096;
const MAX_RUNTIME_ROOTS = 1000;
const MAX_RUNTIME_PATH_LENGTH = 4096;
const MAX_RUNTIME_DISPLAY_NAME_LENGTH = 200;
const SAFE_RUNTIME_IDENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function isValidAiSessionRuntimeIdentityId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_RUNTIME_IDENTITY_ID_LENGTH
        && SAFE_RUNTIME_IDENTITY_ID.test(value);
}

export function isValidAiSessionPromotionDisplayName(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
        && value.length <= MAX_RUNTIME_DISPLAY_NAME_LENGTH && !CONTROL_CHARACTERS.test(value);
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

export class AiSessionRuntimeTargetChangedError extends Error {
    constructor() {
        super('The AI session runtime target changed.');
        this.name = 'AiSessionRuntimeTargetChangedError';
        Object.setPrototypeOf(this, AiSessionRuntimeTargetChangedError.prototype);
    }
}

export interface AiSessionRuntimeIdentity {
    provider: AiSessionProviderId;
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
    sessionId?: string;
    pendingId?: string;
}

export function cloneAiSessionRuntimeIdentity<T extends AiSessionRuntimeIdentity>(identity: T): T {
    return {
        ...identity,
        workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
    };
}

export function getAiSessionRuntimeRootSnapshotKey(identity: AiSessionRuntimeIdentity): string {
    return JSON.stringify(getNormalizedRuntimeRoots(identity?.workspaceRootHostPaths));
}

export function aiSessionRuntimeIdentitiesEqual(
    left: AiSessionRuntimeIdentity,
    right: AiSessionRuntimeIdentity
): boolean {
    return !!left && !!right
        && left.provider === right.provider
        && left.workspaceScopeIdentity === right.workspaceScopeIdentity
        && left.workspaceNavigationIdentity === right.workspaceNavigationIdentity
        && getAiSessionRuntimeRootSnapshotKey(left) === getAiSessionRuntimeRootSnapshotKey(right)
        && normalizeWorkspaceHostPath(left.cwd) === normalizeWorkspaceHostPath(right.cwd)
        && left.sessionId === right.sessionId
        && left.pendingId === right.pendingId;
}

export function isValidAiSessionRuntimeIdentity(value: unknown): value is AiSessionRuntimeIdentity {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const identity = value as Record<string, unknown>;
    const hasSessionId = identity.sessionId !== undefined;
    const hasPendingId = identity.pendingId !== undefined;
    if (!isProviderId(identity.provider)
        || !isBoundedIdentityString(identity.workspaceScopeIdentity, MAX_RUNTIME_IDENTITY_ID_LENGTH)
        || !isBoundedIdentityString(
            identity.workspaceNavigationIdentity, MAX_RUNTIME_NAVIGATION_IDENTITY_LENGTH
        )
        || hasSessionId === hasPendingId
        || !isValidAiSessionRuntimeIdentityId(hasSessionId ? identity.sessionId : identity.pendingId)
        || !Array.isArray(identity.workspaceRootHostPaths)
        || identity.workspaceRootHostPaths.length === 0
        || identity.workspaceRootHostPaths.length > MAX_RUNTIME_ROOTS
        || !isNormalizedRuntimePath(identity.cwd)) {
        return false;
    }
    const roots = identity.workspaceRootHostPaths;
    if (roots.some(root => !isNormalizedRuntimePath(root))) {
        return false;
    }
    const normalizedRootKeys = roots.map(root => getWorkspaceHostPathComparisonKey(root as string));
    return new Set(normalizedRootKeys).size === normalizedRootKeys.length
        && roots.some(root => isWorkspaceHostPathContained(root as string, identity.cwd as string));
}

function getNormalizedRuntimeRoots(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(root => normalizeWorkspaceHostPath(typeof root === 'string' ? root : ''))
        .filter(root => !!root)
        .sort((left, right) => getWorkspaceHostPathComparisonKey(left)
            .localeCompare(getWorkspaceHostPathComparisonKey(right)));
}

function isNormalizedRuntimePath(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_RUNTIME_PATH_LENGTH
        && !CONTROL_CHARACTERS.test(value)
        && normalizeWorkspaceHostPath(value) === value;
}

function isBoundedIdentityString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength
        && !CONTROL_CHARACTERS.test(value);
}

function isProviderId(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
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
    version: 2;
    layout: AiSessionTmuxLayout;
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
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
    version: 2;
    layout: 'project';
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
    provider: 'codex';
    sessionId: string;
    pendingId: string;
} extends AiSessionManagedTmuxMetadata ? true : false>;
type ManagedTmuxMetadataRejectsMissingIds = AssertFalse<{
    version: 2;
    layout: 'project';
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
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
            identity: cloneAiSessionRuntimeIdentity(runtime.identity),
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
            identity: cloneAiSessionRuntimeIdentity(runtime.identity),
            ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        }));
        Object.setPrototypeOf(this, AiSessionRuntimeLifecycleBlockedError.prototype);
    }
}

export interface AiSessionPendingRuntimeSnapshot<TTerminal = unknown> extends AiSessionRuntimeSnapshot<TTerminal> {
    state: 'pending';
    createdAt: string;
    excludedSessionIds: string[];
    projectName?: string;
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
    sessionName: string;
    terminalName: string;
    launch: AiSessionLaunchSpec;
    directoryScope: AiSessionDirectoryScope;
}

export interface AiSessionCreateRuntimeRequest {
    identity: AiSessionRuntimeIdentity & { pendingId: string };
    projectName: string;
    terminalName: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
    launch: AiSessionLaunchSpec;
    directoryScope: AiSessionDirectoryScope;
}

export interface AiSessionRuntimeActionResult<TTerminal = unknown> {
    status: 'started' | 'focused' | 'cancelled' | 'settings' | 'conflict' | 'blocked';
    runtime?: AiSessionRuntimeSnapshot<TTerminal>;
    conflicts?: AiSessionRuntimeSnapshot<TTerminal>[];
    blockers?: AiSessionRuntimeSnapshot<TTerminal>[];
}

export interface AiSessionExecutableRuntimeBackend<TTerminal = unknown> extends AiSessionRuntimeBackend<TTerminal> {
    listRecoverablePending?(): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>[]>;
    getRecoverablePending?(
        identity: AiSessionRuntimeIdentity & { pendingId: string }
    ): Promise<AiSessionPendingRuntimeSnapshot<TTerminal> | null>;
    ensureResume(
        request: AiSessionResumeRuntimeRequest,
        layout?: AiSessionTmuxLayout
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>>;
    ensurePending(
        request: AiSessionCreateRuntimeRequest,
        layout?: AiSessionTmuxLayout
    ): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>>;
    promotePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string },
        sessionId: string,
        sessionName: string
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]>;
}
