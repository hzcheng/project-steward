'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { ActiveAiSessionTerminalIdentity } from '../aiSessions/activeTerminalHighlight';
import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import type { AiSessionExecutionSnapshot } from '../aiSessions/executionMonitor';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from '../aiSessions/runtimeTypes';
import type {
    ActiveAiSessionStatus,
    ActiveAiSessionViewModel,
    AiSessionProviderDefinition,
    AiSessionReadResult,
    AiSessionViewModel,
    WorkspaceAiSessionViewModel,
} from '../aiSessions/types';
import { getAiSessionKey, prepareAiSessionsForDisplay } from '../aiSessions/sessionHelpers';
import {
    assignPathToWorkspaceRoot,
    getWorkspaceHostPathComparisonKey,
    normalizeWorkspaceHostPath,
} from './sessionAssignment';
import type { OpenWorkspace, WorkspaceRoot } from './types';
import {
    buildWorkspaceSessionAttentionIndex,
    getWorkspaceSessionAttention,
} from './sessionAttention';
import { buildWorkspaceAiSessionViewModel } from './viewModels';

type HydrationProvider = Pick<AiSessionProviderDefinition, 'id' | 'label'>;

export interface HydrateWorkspaceAiSessionsInput<TTerminal = unknown> {
    workspace: OpenWorkspace;
    providers: readonly HydrationProvider[];
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>;
    getSessionComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string;
    pinnedSessions: ReadonlySet<string>;
    aliases: Readonly<Record<string, string>>;
    activeRuntimes?: readonly AiSessionRuntimeSnapshot<TTerminal>[];
    pendingRuntimes?: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[];
    executionSnapshot?: Readonly<Record<string, AiSessionExecutionSnapshot>>;
    focusedIdentity?: AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null;
    attentionAggregate?: AttentionAggregate | null;
    activeProvider?: AiSessionProviderId;
    expanded?: boolean;
}

export function getWorkspaceAiSessionCandidatePaths(workspace: OpenWorkspace | null): string[] {
    const seen = new Set<string>();
    return (workspace?.roots || [])
        .slice()
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(root => normalizeWorkspaceHostPath(root.hostPath))
        .filter(candidatePath => {
            const key = getWorkspaceHostPathComparisonKey(candidatePath);
            if (!key || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

interface AssignedHistory {
    session: CodexSession;
    root: WorkspaceRoot;
}

interface SortableActiveSession extends ActiveAiSessionViewModel {
    activityMs: number;
    sourceOrder: number;
}

interface ProjectablePendingRuntime<TTerminal> extends AiSessionPendingRuntimeSnapshot<TTerminal> {
    projectionConflict?: boolean;
}

export function hydrateWorkspaceAiSessions<TTerminal = unknown>(
    input: HydrateWorkspaceAiSessionsInput<TTerminal>
): WorkspaceAiSessionViewModel {
    const attentionByRootAndSession = buildWorkspaceSessionAttentionIndex(
        input.attentionAggregate || null
    );
    const activeRuntimes = deduplicateActiveRuntimes((input.activeRuntimes || [])
        .filter(runtime => hasWorkspaceRuntimeContinuity(input.workspace, runtime)));
    const pendingRuntimes = deduplicatePendingRuntimes((input.pendingRuntimes || [])
        .filter(runtime => runtime.identity.workspaceScopeIdentity === input.workspace.scopeIdentity
            && !!assignPathToWorkspaceRoot(runtime.identity.cwd, input.workspace.roots)));
    const activeSessionKeys = new Set(activeRuntimes
        .filter(runtime => !!runtime.identity.sessionId)
        .map(runtime => getAiSessionKey(runtime.identity.provider, runtime.identity.sessionId)));
    const focusedSessionKey = getFocusedSessionKey(input.focusedIdentity, activeRuntimes);
    const focusedPendingKey = getFocusedPendingKey(input.focusedIdentity, pendingRuntimes);
    const sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>> = {};
    const unavailableProviders: AiSessionProviderId[] = [];

    for (const provider of input.providers) {
        const result = input.sessionResults[provider.id];
        if (!result?.available) {
            unavailableProviders.push(provider.id);
            sessionsByProvider[provider.id] = [];
            continue;
        }
        const assigned = assignHistorySessions(
            provider.id,
            result.sessions,
            input.workspace.roots,
            input.getSessionComparableCwd
        );
        const rootBySessionId = new Map(assigned.map(item => [item.session.id, item.root]));
        sessionsByProvider[provider.id] = prepareAiSessionsForDisplay(
            assigned.map(item => item.session),
            provider.id,
            new Set(input.pinnedSessions),
            { ...input.aliases }
        ).map(session => {
            const root = rootBySessionId.get(session.id);
            const key = getAiSessionKey(provider.id, session.id);
            const attention = root && getWorkspaceSessionAttention(
                attentionByRootAndSession,
                root.uri,
                provider.id,
                session.id
            );
            return {
                ...session,
                provider: provider.id,
                active: activeSessionKeys.has(key),
                focused: focusedSessionKey === key,
                ...(attention ? { attention } : {}),
                primaryRootId: root.id,
                primaryRootLabel: root.name,
            };
        });
    }

    const activeSessions = buildActiveSessions({
        input,
        sessionsByProvider,
        activeRuntimes,
        pendingRuntimes,
        focusedSessionKey,
        focusedPendingKey,
    });
    return buildWorkspaceAiSessionViewModel({
        workspace: input.workspace,
        providers: input.providers,
        sessionsByProvider,
        unavailableProviders,
        activeSessions,
        activeProvider: input.activeProvider,
        expanded: input.expanded,
    });
}

export function hasWorkspaceRuntimeContinuity(
    workspace: OpenWorkspace,
    runtime: Pick<AiSessionRuntimeSnapshot, 'identity'>
): boolean {
    const identity = runtime?.identity;
    if (!workspace || !identity) {
        return false;
    }
    if (identity.workspaceScopeIdentity === workspace.scopeIdentity
        || identity.workspaceNavigationIdentity === workspace.navigationIdentity) {
        return true;
    }
    const currentRoots = new Set(workspace.roots
        .map(root => getWorkspaceHostPathComparisonKey(root.hostPath))
        .filter(Boolean));
    return (identity.workspaceRootHostPaths || [])
        .some(root => currentRoots.has(getWorkspaceHostPathComparisonKey(root)));
}

function assignHistorySessions(
    providerId: AiSessionProviderId,
    sessions: readonly CodexSession[],
    roots: readonly WorkspaceRoot[],
    getSessionComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string,
): AssignedHistory[] {
    const seen = new Set<string>();
    const assigned: AssignedHistory[] = [];
    for (const session of sessions || []) {
        if (!session?.id || seen.has(session.id)) {
            continue;
        }
        seen.add(session.id);
        const root = assignPathToWorkspaceRoot(getSessionComparableCwd(providerId, session), roots);
        if (root) {
            assigned.push({ session: { ...session }, root });
        }
    }
    return assigned;
}

function buildActiveSessions<TTerminal>(input: {
    input: HydrateWorkspaceAiSessionsInput<TTerminal>;
    sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>>;
    activeRuntimes: AiSessionRuntimeSnapshot<TTerminal>[];
    pendingRuntimes: ProjectablePendingRuntime<TTerminal>[];
    focusedSessionKey: string | null;
    focusedPendingKey: string | null;
}): ActiveAiSessionViewModel[] {
    const active = input.activeRuntimes
        .filter(runtime => !!runtime.identity.sessionId)
        .map((runtime, sourceOrder): SortableActiveSession => {
            const providerId = runtime.identity.provider;
            const sessionId = runtime.identity.sessionId;
            const key = getAiSessionKey(providerId, sessionId);
            const session = input.sessionsByProvider[providerId]
                ?.find(candidate => candidate.id === sessionId);
            const root = assignPathToWorkspaceRoot(runtime.identity.cwd, input.input.workspace.roots);
            const focused = input.focusedSessionKey === key;
            const needsAttention = session?.attention?.unread === true;
            const conflict = runtime.state === 'conflict';
            return {
                key,
                provider: providerId,
                sessionId,
                name: session?.name || `${providerLabel(input.input.providers, providerId)} ${shortId(sessionId)}`,
                executionState: input.input.executionSnapshot?.[key]?.state || 'stopped',
                status: establishedStatus(needsAttention, focused, conflict),
                focused,
                needsAttention,
                pending: false,
                backend: runtime.backend,
                ...(runtime.tmux?.layout ? { tmuxLayout: runtime.tmux.layout } : {}),
                attached: runtime.attached,
                ...(conflict ? { conflict: true } : {}),
                ...(runtime.stale ? { stale: true } : {}),
                ...(session?.updatedAt ? { updatedAt: session.updatedAt } : {}),
                ...(session?.pinned !== undefined ? { pinned: session.pinned } : {}),
                ...(session?.attention?.eventId ? { attentionEventId: session.attention.eventId } : {}),
                ...rootMetadata(root),
                activityMs: finiteNumber(runtime.runStartedAtMs),
                sourceOrder,
            };
        });
    const pending = input.pendingRuntimes.map((runtime, sourceOrder): SortableActiveSession => {
        const providerId = runtime.identity.provider;
        const pendingId = runtime.identity.pendingId || runtime.createdAt;
        const key = pendingKey(providerId, pendingId);
        const root = assignPathToWorkspaceRoot(runtime.identity.cwd, input.input.workspace.roots);
        const focused = input.focusedPendingKey === key;
        const conflict = runtime.projectionConflict === true;
        return {
            key,
            provider: providerId,
            name: runtime.title || `New ${providerLabel(input.input.providers, providerId)} session`,
            executionState: 'starting',
            status: conflict ? 'conflict' : focused ? 'focused' : 'starting',
            focused,
            needsAttention: false,
            pending: true,
            backend: runtime.backend,
            ...(runtime.tmux?.layout ? { tmuxLayout: runtime.tmux.layout } : {}),
            attached: runtime.attached,
            ...(conflict ? { conflict: true } : {}),
            ...(runtime.stale ? { stale: true } : {}),
            createdAt: runtime.createdAt,
            ...rootMetadata(root),
            activityMs: timestamp(runtime.createdAt),
            sourceOrder: active.length + sourceOrder,
        };
    });
    return [...active, ...pending]
        .sort(compareActiveSessions)
        .map(({ activityMs: _activityMs, sourceOrder: _sourceOrder, ...session }) => session);
}

function rootMetadata(root: WorkspaceRoot | null): Pick<
ActiveAiSessionViewModel,
'primaryRootId' | 'primaryRootLabel' | 'outsideWorkspace'
> {
    return root ? {
        primaryRootId: root.id,
        primaryRootLabel: root.name,
    } : {
        primaryRootLabel: 'Outside workspace',
        outsideWorkspace: true,
    };
}

function deduplicateActiveRuntimes<TTerminal>(
    runtimes: readonly AiSessionRuntimeSnapshot<TTerminal>[]
): AiSessionRuntimeSnapshot<TTerminal>[] {
    const bySession = new Map<string, AiSessionRuntimeSnapshot<TTerminal>>();
    for (const runtime of runtimes) {
        const sessionId = runtime.identity.sessionId;
        if (!sessionId) {
            continue;
        }
        const key = getAiSessionKey(runtime.identity.provider, sessionId);
        const existing = bySession.get(key);
        if (!existing) {
            bySession.set(key, cloneRuntime(runtime));
        } else {
            bySession.set(key, { ...existing, state: 'conflict' });
        }
    }
    return Array.from(bySession.values());
}

function deduplicatePendingRuntimes<TTerminal>(
    runtimes: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[]
): ProjectablePendingRuntime<TTerminal>[] {
    const byPending = new Map<string, AiSessionPendingRuntimeSnapshot<TTerminal>[]>();
    for (const runtime of runtimes) {
        const pendingId = runtime.identity.pendingId;
        if (!pendingId) {
            continue;
        }
        const key = pendingKey(runtime.identity.provider, pendingId);
        const group = byPending.get(key) || [];
        group.push(runtime);
        byPending.set(key, group);
    }
    return Array.from(byPending.values()).map(group => {
        const representative = group.slice().sort((left, right) => {
            if (left.backend !== right.backend) {
                return left.backend === 'tmux' ? -1 : 1;
            }
            return left.markerPath.localeCompare(right.markerPath);
        })[0];
        return {
            ...cloneRuntime(representative),
            state: 'pending',
            createdAt: representative.createdAt,
            excludedSessionIds: [...representative.excludedSessionIds],
            ...(representative.title === undefined ? {} : { title: representative.title }),
            ...(group.length > 1 ? { projectionConflict: true } : {}),
        };
    });
}

function cloneRuntime<TTerminal>(runtime: AiSessionRuntimeSnapshot<TTerminal>): AiSessionRuntimeSnapshot<TTerminal> {
    return {
        ...runtime,
        identity: {
            ...runtime.identity,
            workspaceRootHostPaths: [...runtime.identity.workspaceRootHostPaths],
        },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function getFocusedSessionKey<TTerminal>(
    focused: AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null | undefined,
    runtimes: readonly AiSessionRuntimeSnapshot<TTerminal>[]
): string | null {
    if (!focused?.sessionId || !runtimes.some(runtime => runtime.identity.provider === focused.provider
        && runtime.identity.sessionId === focused.sessionId
        && runtime.identity.workspaceScopeIdentity === focused.workspaceScopeIdentity)) {
        return null;
    }
    return getAiSessionKey(focused.provider, focused.sessionId);
}

function getFocusedPendingKey<TTerminal>(
    focused: AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null | undefined,
    runtimes: readonly ProjectablePendingRuntime<TTerminal>[]
): string | null {
    if (!focused || !('pendingId' in focused) || !focused.pendingId
        || !runtimes.some(runtime => runtime.identity.provider === focused.provider
            && runtime.identity.pendingId === focused.pendingId
            && runtime.identity.workspaceScopeIdentity === focused.workspaceScopeIdentity)) {
        return null;
    }
    return pendingKey(focused.provider, focused.pendingId);
}

function providerLabel(providers: readonly HydrationProvider[], providerId: AiSessionProviderId): string {
    return providers.find(provider => provider.id === providerId)?.label || 'AI';
}

function establishedStatus(needsAttention: boolean, focused: boolean, conflict: boolean): ActiveAiSessionStatus {
    return conflict ? 'conflict' : needsAttention ? 'needsAttention' : focused ? 'focused' : 'running';
}

function compareActiveSessions(left: SortableActiveSession, right: SortableActiveSession): number {
    if (left.pending !== right.pending) {
        return left.pending ? 1 : -1;
    }
    if (left.pending && right.pending) {
        return left.activityMs - right.activityMs || left.sourceOrder - right.sourceOrder;
    }
    return right.activityMs - left.activityMs || left.sourceOrder - right.sourceOrder;
}

function timestamp(value: string | undefined): number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumber(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

function pendingKey(providerId: AiSessionProviderId, pendingId: string): string {
    return `pending:${providerId}:${pendingId}`;
}

function shortId(value: string): string {
    return (value || 'unknown').substring(0, 8);
}
