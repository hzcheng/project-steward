'use strict';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import {
    getAttentionProjectKeys,
    getAttentionSummaryForProjectKeys,
} from '../aiSessions/attentionProject';

export interface WorkspaceAttentionRoot {
    uri: string;
}

export interface WorkspaceAttentionSource {
    navigationIdentity: string;
    roots: readonly WorkspaceAttentionRoot[];
}

export interface WorkspaceAttentionSummary {
    attentionCount: number;
    eventIds: string[];
    sessions: Array<{ sessionKey: string; eventId: string; eventIds: string[] }>;
}

export interface OtherWorkspaceAttention {
    navigationIdentity: string;
    attentionCount: number;
}

export function getWorkspaceAttentionSummary(
    workspace: Pick<WorkspaceAttentionSource, 'roots'>,
    aggregate: AttentionAggregate | null
): WorkspaceAttentionSummary {
    return getAttentionSummaryForProjectKeys(
        getAttentionProjectKeys((workspace?.roots || []).map(root => root.uri)),
        aggregate
    );
}

export function getOtherWorkspaceAttention(
    workspace: WorkspaceAttentionSource,
    aggregate: AttentionAggregate | null
): OtherWorkspaceAttention {
    return {
        navigationIdentity: workspace.navigationIdentity,
        attentionCount: getWorkspaceAttentionSummary(workspace, aggregate).attentionCount,
    };
}
