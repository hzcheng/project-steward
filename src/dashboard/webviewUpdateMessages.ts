'use strict';

import { Group, WorkspaceCardViewModel } from '../models';
import type { AiSessionsUpdatedMessage } from '../aiSessions/types';
import type { OpenWorkspaceBridgeStatus } from '../openWorkspaces/bridgeClient';
import type { TodoSearchCatalogItem } from '../todos/types';
import {
    buildWorkspaceDashboardSearchCatalog,
    DashboardWorkspaceSearchCatalog,
} from '../webview/dashboardViewModel';
import {
    getCurrentWorkspaceGroupContent,
    getOpenWorkspacesGroupContent,
} from '../webview/webviewContent';

export interface WorkspaceUpdatedMessage {
    type: 'workspace-updated';
    version: 2;
    currentWorkspaceCount: 0 | 1;
    html: string;
}

export interface BuildWorkspaceUpdatedMessageInput {
    card: WorkspaceCardViewModel | null;
}

export interface OpenWorkspacesUpdatedMessage {
    type: 'open-workspaces-updated';
    version: 2;
    semanticRevision: string;
    currentWorkspaceCount: 0 | 1;
    navigationWorkspaceCount: number;
    otherWindowsStatus: OpenWorkspaceBridgeStatus;
    searchCatalog: DashboardWorkspaceSearchCatalog;
    html: string;
}

export interface BuildOpenWorkspacesUpdatedMessageInput {
    groups: Group[];
    cards: WorkspaceCardViewModel[];
    collapsed: boolean;
    semanticRevision: string;
    otherWindowsStatus: OpenWorkspaceBridgeStatus;
    todoSearchItems: TodoSearchCatalogItem[];
}

export interface BuildAiSessionsUpdatedMessageInput {
    groups: Group[];
    cards: WorkspaceCardViewModel[];
    sequence: number;
    generatedAt: string;
    todoSearchItems: TodoSearchCatalogItem[];
}

export function buildOpenWorkspacesUpdatedMessage(
    input: BuildOpenWorkspacesUpdatedMessageInput
): OpenWorkspacesUpdatedMessage {
    const currentWorkspaceCount = input.cards.some(card => card.kind === 'current') ? 1 : 0;
    const navigationWorkspaceCount = input.cards.filter(card => card.kind === 'navigation').length;
    return {
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: input.semanticRevision,
        currentWorkspaceCount,
        navigationWorkspaceCount,
        otherWindowsStatus: input.otherWindowsStatus,
        searchCatalog: buildWorkspaceDashboardSearchCatalog(
            input.groups,
            input.cards,
            input.todoSearchItems,
        ),
        html: getOpenWorkspacesGroupContent(input.cards, input.collapsed, input.otherWindowsStatus),
    };
}

export function buildWorkspaceUpdatedMessage(input: BuildWorkspaceUpdatedMessageInput): WorkspaceUpdatedMessage {
    const card = input.card && input.card.kind === 'current'
        ? input.card
        : null;
    return {
        type: 'workspace-updated',
        version: 2,
        currentWorkspaceCount: card ? 1 : 0,
        html: getCurrentWorkspaceGroupContent(card, false),
    };
}

export function buildAiSessionsUpdatedMessage(input: BuildAiSessionsUpdatedMessageInput): AiSessionsUpdatedMessage {
    const current = input.cards.find(card => card.kind === 'current') || null;
    return {
        type: 'ai-sessions-updated',
        version: 2,
        sequence: input.sequence,
        generatedAt: input.generatedAt,
        currentWorkspaceCount: current ? 1 : 0,
        html: getCurrentWorkspaceGroupContent(
            current,
            input.cards.some(card => card.kind === 'navigation'),
        ),
        searchCatalog: buildWorkspaceDashboardSearchCatalog(
            input.groups,
            input.cards,
            input.todoSearchItems,
        ),
    };
}
