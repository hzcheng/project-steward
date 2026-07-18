'use strict';

import type { AiSessionProviderId } from '../models';

export type AiSessionRuntimeBackendId = 'vscode' | 'tmux';
export type AiSessionTmuxLayout = 'project' | 'session';
export type AiSessionRuntimeState = 'pending' | 'active' | 'completed' | 'stopped' | 'conflict';

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
    attached: boolean;
    terminal?: TTerminal;
    tmux?: AiSessionTmuxLocator;
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
    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[];
    focus(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void>;
    detach(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void>;
}
