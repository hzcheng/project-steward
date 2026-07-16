'use strict';

import { Group, Project, StewardInfos } from '../models';
import type { OpenProjectAiSessionViewModel, AiSessionsUpdatedMessage } from '../aiSessions/types';
import { buildDashboardSearchCatalog, DashboardSearchCatalog } from '../webview/dashboardViewModel';
import { getOpenProjectsGroupContent } from '../webview/webviewContent';

export interface OpenProjectsUpdatedMessage {
    type: 'open-projects-updated';
    version: 1;
    semanticRevision: string;
    projectCount: number;
    searchCatalog: DashboardSearchCatalog;
    html: string;
}

export interface BuildOpenProjectsUpdatedMessageInput {
    groups: Group[];
    cards: Project[];
    collapsed: boolean;
    stewardInfos: StewardInfos;
    semanticRevision: string;
}

export interface BuildAiSessionsUpdatedMessageInput {
    groups: Group[];
    cards: Project[];
    sequence: number;
    generatedAt: string;
    openProjects: OpenProjectAiSessionViewModel[];
}

export function buildOpenProjectsUpdatedMessage(input: BuildOpenProjectsUpdatedMessageInput): OpenProjectsUpdatedMessage {
    return {
        type: 'open-projects-updated',
        version: 1,
        semanticRevision: input.semanticRevision,
        projectCount: input.cards.length,
        searchCatalog: buildDashboardSearchCatalog(input.groups, input.cards),
        html: getOpenProjectsGroupContent(
            input.cards,
            input.collapsed,
            input.stewardInfos,
        ),
    };
}

export function buildAiSessionsUpdatedMessage(input: BuildAiSessionsUpdatedMessageInput): AiSessionsUpdatedMessage {
    return {
        type: 'ai-sessions-updated',
        version: 1,
        sequence: input.sequence,
        generatedAt: input.generatedAt,
        openProjects: input.openProjects,
        searchCatalog: buildDashboardSearchCatalog(input.groups, input.cards),
    };
}
