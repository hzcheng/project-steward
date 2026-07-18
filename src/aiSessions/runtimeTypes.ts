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

export interface AiSessionManagedTmuxMetadata {
    version: 1;
    layout: AiSessionTmuxLayout;
    projectKey: string;
    provider: AiSessionProviderId;
    sessionId?: string;
    pendingId?: string;
    createdAt?: string;
    marker?: string;
}

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
