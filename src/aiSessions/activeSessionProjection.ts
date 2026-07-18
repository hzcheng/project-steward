'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type { ActiveAiSessionTerminalIdentity } from './activeTerminalHighlight';
import type { AiSessionExecutionSnapshot } from './executionMonitor';
import type { PendingAiSessionTerminal } from './terminalService';
import type {
    ActiveAiSessionStatus,
    ActiveAiSessionViewModel,
    AiSessionActiveTerminalRuntime,
    AiSessionProviderDefinition,
} from './types';

type ProjectionProvider = Pick<AiSessionProviderDefinition, 'id' | 'label' | 'projectSessionsKey'>;

export interface ApplyAiSessionRuntimeProjectionInput {
    projects: Project[];
    providers: Record<AiSessionProviderId, ProjectionProvider>;
    activeTerminals: AiSessionActiveTerminalRuntime[];
    pendingTerminals: Array<Pick<PendingAiSessionTerminal, 'provider' | 'cwd' | 'createdAt' | 'title'>>;
    executionSnapshot?: Record<string, AiSessionExecutionSnapshot>;
    focusedIdentity: ActiveAiSessionTerminalIdentity | null;
    getProjectCwd(project: Project): string;
    normalizePath(value: string): string;
}

interface SortableActiveAiSessionViewModel extends ActiveAiSessionViewModel {
    activityMs: number;
    sourceOrder: number;
}

export function applyAiSessionRuntimeProjection(input: ApplyAiSessionRuntimeProjectionInput): Project[] {
    const projectCwds = input.projects.map(project => normalize(input, input.getProjectCwd(project)));
    const activeByProject = input.projects.map(() => [] as AiSessionActiveTerminalRuntime[]);
    const pendingByProject = input.projects.map(() => [] as Array<Pick<PendingAiSessionTerminal, 'provider' | 'cwd' | 'createdAt' | 'title'>>);

    for (const runtime of input.activeTerminals || []) {
        const projectIndex = findRuntimeProjectIndex(runtime, input, projectCwds);
        if (projectIndex !== -1) {
            activeByProject[projectIndex].push(runtime);
        }
    }
    for (const pending of input.pendingTerminals || []) {
        const cwd = normalize(input, pending.cwd);
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
    activeTerminals: AiSessionActiveTerminalRuntime[],
    pendingTerminals: Array<Pick<PendingAiSessionTerminal, 'provider' | 'cwd' | 'createdAt' | 'title'>>,
    input: ApplyAiSessionRuntimeProjectionInput
): Project {
    const activeKeys = new Set(activeTerminals.map(runtime => getSessionKey(runtime.provider, runtime.sessionId)));
    const focusedKey = input.focusedIdentity
        ? getSessionKey(input.focusedIdentity.provider, input.focusedIdentity.sessionId)
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

    const activeModels: SortableActiveAiSessionViewModel[] = activeTerminals.map((runtime, index) => {
        const provider = input.providers[runtime.provider];
        const session = sessionsByProvider.get(runtime.provider)?.find(candidate => candidate.id === runtime.sessionId);
        const key = getSessionKey(runtime.provider, runtime.sessionId);
        const focused = focusedKey === key;
        const needsAttention = session?.attention?.unread === true;
        return {
            key,
            provider: runtime.provider,
            sessionId: runtime.sessionId,
            name: session?.name || `${provider?.label || 'AI'} ${shortSessionId(runtime.sessionId)}`,
            status: getEstablishedStatus(needsAttention, focused),
            executionState: (input.executionSnapshot || {})[key]?.state || 'stopped',
            focused,
            needsAttention,
            pending: false,
            ...(session?.updatedAt ? { updatedAt: session.updatedAt } : {}),
            ...(session?.pinned !== undefined ? { pinned: session.pinned } : {}),
            ...(session?.attention?.eventId ? { attentionEventId: session.attention.eventId } : {}),
            activityMs: getActivityMs(session?.updatedAt, runtime.runStartedAtMs),
            sourceOrder: index,
        };
    });

    const pendingModels: SortableActiveAiSessionViewModel[] = pendingTerminals.map((pending, index) => {
        const provider = input.providers[pending.provider];
        return {
            key: `pending:${pending.provider}:${pending.createdAt}`,
            provider: pending.provider,
            name: pending.title || `New ${provider?.label || 'AI'} session`,
            status: 'starting',
            executionState: 'starting',
            focused: false,
            needsAttention: false,
            pending: true,
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

function findRuntimeProjectIndex(
    runtime: AiSessionActiveTerminalRuntime,
    input: ApplyAiSessionRuntimeProjectionInput,
    projectCwds: string[]
): number {
    const cwd = normalize(input, runtime.cwd);
    if (cwd) {
        const cwdIndex = projectCwds.indexOf(cwd);
        if (cwdIndex !== -1) {
            return cwdIndex;
        }
    }

    const provider = input.providers[runtime.provider];
    if (!provider) {
        return -1;
    }
    return input.projects.findIndex(project => {
        return (project[provider.projectSessionsKey] || []).some(session => session.id === runtime.sessionId);
    });
}

function getProviders(providers: Record<AiSessionProviderId, ProjectionProvider>): ProjectionProvider[] {
    return Object.keys(providers || {})
        .map(key => providers[key as AiSessionProviderId])
        .filter(Boolean);
}

function getEstablishedStatus(needsAttention: boolean, focused: boolean): ActiveAiSessionStatus {
    return needsAttention ? 'needsAttention' : focused ? 'focused' : 'running';
}

function compareActiveSessions(left: SortableActiveAiSessionViewModel, right: SortableActiveAiSessionViewModel): number {
    const rankDifference = getPriorityRank(left) - getPriorityRank(right);
    if (rankDifference !== 0) {
        return rankDifference;
    }
    if (left.pending) {
        return left.activityMs - right.activityMs || left.sourceOrder - right.sourceOrder;
    }
    return right.activityMs - left.activityMs || left.sourceOrder - right.sourceOrder;
}

function getPriorityRank(model: ActiveAiSessionViewModel): number {
    return model.needsAttention ? 0 : model.focused ? 1 : model.pending ? 3 : 2;
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

function shortSessionId(sessionId: string): string {
    return (sessionId || 'unknown').substring(0, 8);
}
