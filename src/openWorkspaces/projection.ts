'use strict';

import * as crypto from 'crypto';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import type { WorkspaceCardViewModel } from '../models';
import { getWorkspaceAttentionSummary } from '../workspaces/attentionProjection';
import type { OpenWorkspace, OpenWorkspaceEnvironment } from '../workspaces/types';
import {
    OpenWorkspaceAggregateV2,
    OpenWorkspaceRecord,
    validateOpenWorkspaceRecord,
} from './protocol';

interface NavigationCandidate {
    instanceId: string;
    lastFocusedAtMs: number;
    workspace: OpenWorkspaceRecord;
}

export interface OpenWorkspaceNavigationCardProjection {
    card: WorkspaceCardViewModel;
    workspace: OpenWorkspaceRecord;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function createWorkspaceDescriptorKey(workspace: OpenWorkspaceRecord): string {
    return JSON.stringify([
        workspace.navigationIdentity,
        workspace.scopeIdentity,
        workspace.kind,
        workspace.displayName,
        workspace.navigationUri,
        workspace.environment,
        workspace.roots
            .map(root => [root.id, root.name, root.uri, root.ordinal])
            .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right))),
    ]);
}

function candidateWins(candidate: NavigationCandidate, previous: NavigationCandidate): boolean {
    if (candidate.lastFocusedAtMs !== previous.lastFocusedAtMs) {
        return candidate.lastFocusedAtMs > previous.lastFocusedAtMs;
    }
    const instanceComparison = compareText(candidate.instanceId, previous.instanceId);
    if (instanceComparison !== 0) {
        return instanceComparison < 0;
    }
    return compareText(
        createWorkspaceDescriptorKey(candidate.workspace),
        createWorkspaceDescriptorKey(previous.workspace)
    ) < 0;
}

function compareCandidates(left: NavigationCandidate, right: NavigationCandidate): number {
    if (left.lastFocusedAtMs !== right.lastFocusedAtMs) {
        return left.lastFocusedAtMs > right.lastFocusedAtMs ? -1 : 1;
    }
    return compareText(left.workspace.navigationIdentity, right.workspace.navigationIdentity);
}

function getEnvironmentLabel(environment: OpenWorkspaceEnvironment): string {
    switch (environment) {
        case 'ssh':
            return 'SSH';
        case 'wsl':
            return 'WSL';
        case 'devContainer':
            return 'Dev Container';
        case 'remote':
            return 'Remote';
        case 'local':
        default:
            return 'Local';
    }
}

export function createOpenWorkspacePublication(
    workspace: OpenWorkspace | null,
    runningAiSessionCount = 0,
): OpenWorkspaceRecord | null {
    if (!workspace) {
        return null;
    }
    return validateOpenWorkspaceRecord({
        navigationIdentity: workspace.navigationIdentity,
        scopeIdentity: workspace.scopeIdentity,
        kind: workspace.kind,
        displayName: workspace.displayName,
        navigationUri: workspace.navigationUri,
        environment: workspace.environment,
        runningAiSessionCount,
        roots: (workspace.roots || []).map(root => ({
            id: root.id,
            name: root.name,
            uri: root.uri,
            ordinal: root.ordinal,
        })),
    });
}

function createNavigationCard(
    candidate: NavigationCandidate,
    attentionAggregate: AttentionAggregate | null
): WorkspaceCardViewModel {
    const workspace = candidate.workspace;
    const digest = crypto.createHash('sha256').update(workspace.navigationIdentity).digest('hex').slice(0, 24);
    return {
        id: `__openWorkspaceNavigation-${digest}`,
        kind: 'navigation',
        workspaceKind: workspace.kind,
        showSaveAction: false,
        runningSessionCount: workspace.runningAiSessionCount,
        navigationIdentity: workspace.navigationIdentity,
        scopeIdentity: workspace.scopeIdentity,
        name: workspace.displayName,
        environment: workspace.environment,
        environmentLabel: getEnvironmentLabel(workspace.environment),
        roots: workspace.roots
            .slice()
            .sort((left, right) => left.ordinal - right.ordinal || compareText(left.id, right.id))
            .map(root => ({ id: root.id, name: root.name, ordinal: root.ordinal })),
        attentionCount: getWorkspaceAttentionSummary(workspace, attentionAggregate).attentionCount,
    };
}

export function projectOpenWorkspaceCards(
    currentWorkspace: Pick<OpenWorkspace, 'navigationIdentity'> | null,
    aggregate: OpenWorkspaceAggregateV2 | null,
    ownInstanceId: string,
    attentionAggregate: AttentionAggregate | null = null
): WorkspaceCardViewModel[] {
    return projectOpenWorkspaceNavigationCards(
        currentWorkspace,
        aggregate,
        ownInstanceId,
        attentionAggregate,
    ).map(projection => projection.card);
}

export function projectOpenWorkspaceNavigationCards(
    currentWorkspace: Pick<OpenWorkspace, 'navigationIdentity'> | null,
    aggregate: OpenWorkspaceAggregateV2 | null,
    ownInstanceId: string,
    attentionAggregate: AttentionAggregate | null = null
): OpenWorkspaceNavigationCardProjection[] {
    if (!aggregate) {
        return [];
    }
    const reservedIdentity = currentWorkspace?.navigationIdentity || '';
    const navigationByIdentity = new Map<string, NavigationCandidate>();
    for (const registration of aggregate.registrations || []) {
        if (registration.instanceId === ownInstanceId || !registration.workspace) {
            continue;
        }
        const workspace = registration.workspace;
        if (workspace.navigationIdentity === reservedIdentity) {
            continue;
        }
        const candidate: NavigationCandidate = {
            instanceId: registration.instanceId,
            lastFocusedAtMs: registration.lastFocusedAtMs,
            workspace,
        };
        const previous = navigationByIdentity.get(workspace.navigationIdentity);
        if (!previous || candidateWins(candidate, previous)) {
            navigationByIdentity.set(workspace.navigationIdentity, candidate);
        }
    }
    return Array.from(navigationByIdentity.values())
        .sort(compareCandidates)
        .map(candidate => ({
            card: createNavigationCard(candidate, attentionAggregate),
            workspace: candidate.workspace,
        }));
}
