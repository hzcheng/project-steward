'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type { ActiveAiSessionTerminalIdentity } from './activeTerminalHighlight';
import type { AiSessionExecutionSnapshot } from './executionMonitor';
import type { PendingAiSessionTerminal } from './terminalService';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import type {
    ActiveAiSessionStatus,
    ActiveAiSessionViewModel,
    AiSessionActiveTerminalRuntime,
    AiSessionProviderDefinition,
} from './types';

type ProjectionProvider = Pick<AiSessionProviderDefinition, 'id' | 'label' | 'projectSessionsKey'>;
type LegacyPendingTerminal = Pick<PendingAiSessionTerminal, 'provider' | 'cwd' | 'createdAt' | 'title'>;

export interface ApplyAiSessionRuntimeProjectionInput {
    projects: Project[];
    providers: Record<AiSessionProviderId, ProjectionProvider>;
    activeRuntimes?: AiSessionRuntimeSnapshot[];
    pendingRuntimes?: AiSessionPendingRuntimeSnapshot[];
    /** @deprecated Transitional input until dashboard composition consumes the runtime coordinator. */
    activeTerminals?: AiSessionActiveTerminalRuntime[];
    /** @deprecated Transitional input until dashboard composition consumes the runtime coordinator. */
    pendingTerminals?: LegacyPendingTerminal[];
    executionSnapshot: Record<string, AiSessionExecutionSnapshot>;
    focusedIdentity: AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null;
    getProjectCwd(project: Project): string;
    normalizePath(value: string): string;
}

interface SortableActiveAiSessionViewModel extends ActiveAiSessionViewModel {
    activityMs: number;
    sourceOrder: number;
}

interface ProjectablePendingRuntime extends AiSessionPendingRuntimeSnapshot {
    projectionConflict?: boolean;
}

export function applyAiSessionRuntimeProjection(input: ApplyAiSessionRuntimeProjectionInput): Project[] {
    const projectCwds = input.projects.map(project => normalize(input, input.getProjectCwd(project)));
    const activeRuntimes = deduplicateActiveRuntimes(resolveActiveRuntimes(input));
    const pendingRuntimes = deduplicatePendingRuntimes(resolvePendingRuntimes(input));
    const activeByProject = input.projects.map(() => [] as AiSessionRuntimeSnapshot[]);
    const pendingByProject = input.projects.map(() => [] as ProjectablePendingRuntime[]);

    for (const runtime of activeRuntimes) {
        const projectIndex = findRuntimeProjectIndex(runtime, input, projectCwds);
        if (projectIndex !== -1) {
            activeByProject[projectIndex].push(runtime);
        }
    }
    for (const pending of pendingRuntimes) {
        const cwd = normalize(input, pending.identity.cwd);
        const projectIndex = cwd ? projectCwds.indexOf(cwd) : -1;
        if (projectIndex !== -1) {
            pendingByProject[projectIndex].push(pending);
        }
    }

    return input.projects.map((project, index) => projectWithRuntime(
        project,
        activeByProject[index],
        pendingByProject[index],
        input
    ));
}

function projectWithRuntime(
    project: Project,
    activeRuntimes: AiSessionRuntimeSnapshot[],
    pendingRuntimes: ProjectablePendingRuntime[],
    input: ApplyAiSessionRuntimeProjectionInput
): Project {
    const activeKeys = new Set(activeRuntimes
        .filter(runtime => !!runtime.identity.sessionId)
        .map(runtime => getSessionKey(runtime.identity.provider, runtime.identity.sessionId)));
    const focusedKey = input.focusedIdentity?.sessionId
        ? getSessionKey(input.focusedIdentity.provider, input.focusedIdentity.sessionId)
        : null;
    const focusedPendingId = input.focusedIdentity && 'pendingId' in input.focusedIdentity
        ? input.focusedIdentity.pendingId : undefined;
    const focusedPendingKey = focusedPendingId
        ? getPendingKey(input.focusedIdentity.provider, focusedPendingId)
        : null;
    const clonedProject = { ...project } as Project;
    const sessionsByProvider = new Map<AiSessionProviderId, CodexSession[]>();

    for (const provider of getProviders(input.providers)) {
        const sessions = (project[provider.projectSessionsKey] || []).map(session => {
            const key = getSessionKey(provider.id, session.id);
            return {
                ...session,
                active: activeKeys.has(key),
                focused: focusedKey === key,
            };
        });
        clonedProject[provider.projectSessionsKey] = sessions;
        sessionsByProvider.set(provider.id, sessions);
    }

    const activeModels: SortableActiveAiSessionViewModel[] = activeRuntimes
        .filter(runtime => !!runtime.identity.sessionId)
        .map((runtime, index) => {
            const { provider: providerId, sessionId } = runtime.identity;
            const provider = input.providers[providerId];
            const session = sessionsByProvider.get(providerId)?.find(candidate => candidate.id === sessionId);
            const key = getSessionKey(providerId, sessionId);
            const focused = focusedKey === key;
            const needsAttention = session?.attention?.unread === true;
            const conflict = runtime.state === 'conflict';
            return {
                key,
                provider: providerId,
                sessionId,
                name: session?.name || `${provider?.label || 'AI'} ${shortSessionId(sessionId)}`,
                executionState: input.executionSnapshot[key]?.state || 'stopped',
                status: getEstablishedStatus(needsAttention, focused, conflict),
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
                activityMs: getActivityMs(session?.updatedAt, runtime.runStartedAtMs),
                sourceOrder: index,
            };
        });

    const pendingModels: SortableActiveAiSessionViewModel[] = pendingRuntimes.map((pending, index) => {
        const providerId = pending.identity.provider;
        const provider = input.providers[providerId];
        const pendingId = pending.identity.pendingId || pending.createdAt;
        const focused = focusedPendingKey === getPendingKey(providerId, pendingId);
        const conflict = pending.projectionConflict === true;
        return {
            key: getPendingKey(providerId, pendingId),
            provider: providerId,
            name: pending.title || `New ${provider?.label || 'AI'} session`,
            executionState: 'starting',
            status: conflict ? 'conflict' : focused ? 'focused' : 'starting',
            focused,
            needsAttention: false,
            pending: true,
            backend: pending.backend,
            ...(pending.tmux?.layout ? { tmuxLayout: pending.tmux.layout } : {}),
            attached: pending.attached,
            ...(conflict ? { conflict: true } : {}),
            ...(pending.stale ? { stale: true } : {}),
            createdAt: pending.createdAt,
            activityMs: parseTimestamp(pending.createdAt),
            sourceOrder: index,
        };
    });

    const activeAiSessions = [...activeModels, ...pendingModels]
        .sort(compareActiveSessions)
        .map(({ activityMs: _activityMs, sourceOrder: _sourceOrder, ...model }) => model);

    clonedProject.activeAiSessions = activeAiSessions;
    clonedProject.activeAiSessionTab = activeAiSessions.length ? 'active' : 'sessions';
    return clonedProject;
}

function resolveActiveRuntimes(input: ApplyAiSessionRuntimeProjectionInput): AiSessionRuntimeSnapshot[] {
    if (input.activeRuntimes !== undefined) {
        return input.activeRuntimes.map(cloneRuntime);
    }
    return (input.activeTerminals || []).map(runtime => ({
        identity: {
            provider: runtime.provider,
            projectKey: runtime.cwd || '',
            cwd: runtime.cwd || '',
            sessionId: runtime.sessionId,
        },
        backend: 'vscode',
        state: 'active',
        markerPath: '',
        runStartedAtMs: runtime.runStartedAtMs,
        attached: true,
    }));
}

function resolvePendingRuntimes(input: ApplyAiSessionRuntimeProjectionInput): AiSessionPendingRuntimeSnapshot[] {
    if (input.pendingRuntimes !== undefined) {
        return input.pendingRuntimes.map(clonePendingRuntime);
    }
    return (input.pendingTerminals || []).map(pending => ({
        identity: {
            provider: pending.provider,
            projectKey: pending.cwd || '',
            cwd: pending.cwd || '',
            pendingId: pending.createdAt,
        },
        backend: 'vscode',
        state: 'pending',
        markerPath: '',
        runStartedAtMs: parseTimestamp(pending.createdAt),
        attached: true,
        createdAt: pending.createdAt,
        excludedSessionIds: [],
        ...(pending.title === undefined ? {} : { title: pending.title }),
    }));
}

function deduplicateActiveRuntimes(runtimes: AiSessionRuntimeSnapshot[]): AiSessionRuntimeSnapshot[] {
    const byIdentity = new Map<string, AiSessionRuntimeSnapshot>();
    const withoutFinalIdentity: AiSessionRuntimeSnapshot[] = [];
    for (const runtime of runtimes) {
        const sessionId = runtime.identity.sessionId;
        if (!sessionId) {
            withoutFinalIdentity.push(runtime);
            continue;
        }
        const key = getSessionKey(runtime.identity.provider, sessionId);
        const existing = byIdentity.get(key);
        if (!existing) {
            byIdentity.set(key, runtime);
            continue;
        }
        byIdentity.set(key, {
            ...existing,
            identity: { ...existing.identity },
            state: 'conflict',
        });
    }
    return [...byIdentity.values(), ...withoutFinalIdentity];
}

function deduplicatePendingRuntimes(
    runtimes: AiSessionPendingRuntimeSnapshot[]
): ProjectablePendingRuntime[] {
    const byIdentity = new Map<string, AiSessionPendingRuntimeSnapshot[]>();
    const withoutPendingIdentity: AiSessionPendingRuntimeSnapshot[] = [];
    for (const runtime of runtimes) {
        const pendingId = runtime.identity.pendingId;
        if (!pendingId) {
            withoutPendingIdentity.push(runtime);
            continue;
        }
        const key = getPendingKey(runtime.identity.provider, pendingId);
        const group = byIdentity.get(key) || [];
        group.push(runtime);
        byIdentity.set(key, group);
    }
    const deduplicated = Array.from(byIdentity.values()).map(group => {
        const representative = group.slice().sort(comparePendingRepresentatives)[0];
        return group.length === 1 ? representative : {
            ...representative,
            identity: { ...representative.identity },
            ...(representative.tmux ? { tmux: { ...representative.tmux } } : {}),
            excludedSessionIds: [...representative.excludedSessionIds],
            projectionConflict: true,
        };
    });
    return [...deduplicated, ...withoutPendingIdentity];
}

function comparePendingRepresentatives(
    left: AiSessionPendingRuntimeSnapshot,
    right: AiSessionPendingRuntimeSnapshot
): number {
    const leftKey = getPendingRepresentativeKey(left);
    const rightKey = getPendingRepresentativeKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function getPendingRepresentativeKey(runtime: AiSessionPendingRuntimeSnapshot): string {
    return JSON.stringify([
        runtime.backend === 'tmux' ? 0 : 1,
        runtime.backend,
        runtime.state,
        runtime.identity.provider,
        runtime.identity.pendingId || '',
        runtime.identity.projectKey,
        runtime.identity.cwd,
        runtime.title === undefined ? null : runtime.title,
        runtime.createdAt,
        String(runtime.runStartedAtMs),
        runtime.markerPath,
        runtime.attached,
        runtime.tmux?.layout || null,
        runtime.tmux?.sessionName || null,
        runtime.tmux?.windowName || null,
        runtime.excludedSessionIds,
    ]);
}

function findRuntimeProjectIndex(
    runtime: AiSessionRuntimeSnapshot,
    input: ApplyAiSessionRuntimeProjectionInput,
    projectCwds: string[]
): number {
    const cwd = normalize(input, runtime.identity.cwd);
    if (cwd) {
        const cwdIndex = projectCwds.indexOf(cwd);
        if (cwdIndex !== -1) {
            return cwdIndex;
        }
    }

    const provider = input.providers[runtime.identity.provider];
    const sessionId = runtime.identity.sessionId;
    if (!provider || !sessionId) {
        return -1;
    }
    return input.projects.findIndex(project => {
        return (project[provider.projectSessionsKey] || []).some(session => session.id === sessionId);
    });
}

function getProviders(providers: Record<AiSessionProviderId, ProjectionProvider>): ProjectionProvider[] {
    return Object.keys(providers || {})
        .map(key => providers[key as AiSessionProviderId])
        .filter(Boolean);
}

function getEstablishedStatus(
    needsAttention: boolean,
    focused: boolean,
    conflict: boolean
): ActiveAiSessionStatus {
    return conflict ? 'conflict' : needsAttention ? 'needsAttention' : focused ? 'focused' : 'running';
}

function compareActiveSessions(left: SortableActiveAiSessionViewModel, right: SortableActiveAiSessionViewModel): number {
    const rankDifference = getStatusRank(left.status) - getStatusRank(right.status);
    if (rankDifference !== 0) {
        return rankDifference;
    }
    if (left.pending) {
        return left.activityMs - right.activityMs || left.sourceOrder - right.sourceOrder;
    }
    return right.activityMs - left.activityMs || left.sourceOrder - right.sourceOrder;
}

function getStatusRank(status: ActiveAiSessionStatus): number {
    return status === 'conflict' ? 0
        : status === 'needsAttention' ? 1
            : status === 'focused' ? 2
                : status === 'running' ? 3 : 4;
}

function getActivityMs(updatedAt: string | undefined, runStartedAtMs: number): number {
    const updatedAtMs = parseTimestamp(updatedAt);
    return Math.max(updatedAtMs, Number.isFinite(runStartedAtMs) ? runStartedAtMs : 0);
}

function parseTimestamp(value: string | undefined): number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalize(input: ApplyAiSessionRuntimeProjectionInput, value: string | undefined): string {
    return value ? input.normalizePath(value) || '' : '';
}

function getSessionKey(provider: AiSessionProviderId, sessionId: string): string {
    return `${provider}:${sessionId}`;
}

function getPendingKey(provider: AiSessionProviderId, pendingId: string): string {
    return `pending:${provider}:${pendingId}`;
}

function shortSessionId(sessionId: string): string {
    return (sessionId || 'unknown').substring(0, 8);
}

function cloneRuntime(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot {
    return {
        ...runtime,
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function clonePendingRuntime(runtime: AiSessionPendingRuntimeSnapshot): AiSessionPendingRuntimeSnapshot {
    return {
        ...cloneRuntime(runtime),
        state: 'pending',
        createdAt: runtime.createdAt,
        excludedSessionIds: [...runtime.excludedSessionIds],
        ...(runtime.title === undefined ? {} : { title: runtime.title }),
    };
}
