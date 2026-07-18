'use strict';

import type { AiSessionProviderId, Group, Project } from '../models';
import { normalizeOpenProjectIdentity } from '../openProjects/projection';
import type { TodoSearchCatalogItem } from '../todos/types';

export type DashboardSearchProjectAction = 'open-current' | 'switch-open' | 'open-saved';

export interface DashboardSearchSessionItem {
    key: string;
    searchText: string;
    projectId: string;
    projectName: string;
    provider: AiSessionProviderId;
    sessionId: string;
    name: string;
    updatedAt?: string;
    active?: boolean;
}

export interface DashboardSearchProjectItem {
    key: string;
    identity: string;
    searchText: string;
    projectId: string;
    name: string;
    description: string;
    action: DashboardSearchProjectAction;
    environmentLabel?: string;
    groupLabels: string[];
}

export interface DashboardSearchCatalog {
    sessions: DashboardSearchSessionItem[];
    openProjects: DashboardSearchProjectItem[];
    savedProjects: DashboardSearchProjectItem[];
    todos: TodoSearchCatalogItem[];
}

const PROVIDERS: Array<{
    id: AiSessionProviderId;
    key: 'codexSessions' | 'kimiSessions' | 'claudeSessions';
}> = [
    { id: 'codex', key: 'codexSessions' },
    { id: 'kimi', key: 'kimiSessions' },
    { id: 'claude', key: 'claudeSessions' },
];

function searchable(...values: Array<string | undefined>): string {
    return values.filter(Boolean).join(' ').toLowerCase();
}

export function buildDashboardSearchCatalog(
    groups: Group[],
    openProjects: Project[],
    todos: TodoSearchCatalogItem[] = []
): DashboardSearchCatalog {
    const sessions: DashboardSearchSessionItem[] = [];
    const openItems: DashboardSearchProjectItem[] = [];
    const savedByIdentity = new Map<string, DashboardSearchProjectItem>();

    (openProjects || []).forEach(project => {
        const identity = normalizeOpenProjectIdentity(project.path) || project.id;
        const current = project.openProjectCardKind !== 'projectNavigation';
        openItems.push({
            key: `open:${identity}`,
            identity,
            searchText: searchable(project.name, project.description, project.openProjectEnvironmentLabel),
            projectId: project.id,
            name: project.name || '',
            description: project.description || '',
            action: current ? 'open-current' : 'switch-open',
            environmentLabel: project.openProjectEnvironmentLabel,
            groupLabels: [],
        });
        if (!current) {
            return;
        }
        PROVIDERS.forEach(provider => (project[provider.key] || []).forEach(session => sessions.push({
            key: `${provider.id}:${session.id}`,
            searchText: searchable(session.name, project.name, provider.id, session.id),
            projectId: project.id,
            projectName: project.name || '',
            provider: provider.id,
            sessionId: session.id,
            name: session.name || session.id,
            updatedAt: session.updatedAt,
            active: session.active === true,
        })));
    });

    (groups || []).forEach(group => (group.projects || []).forEach(project => {
        const identity = normalizeOpenProjectIdentity(project.path) || project.id;
        let item = savedByIdentity.get(identity);
        if (!item) {
            item = {
                key: `saved:${identity}`,
                identity,
                searchText: searchable(project.name, project.description, group.groupName),
                projectId: project.id,
                name: project.name || '',
                description: project.description || '',
                action: 'open-saved',
                groupLabels: [],
            };
            savedByIdentity.set(identity, item);
        }
        if (project.favorite && !item.groupLabels.includes('FAVORITES')) {
            item.groupLabels.push('FAVORITES');
        }
        if (group.groupName && !item.groupLabels.includes(group.groupName)) {
            item.groupLabels.push(group.groupName);
        }
        item.searchText = searchable(item.searchText, project.name, project.description, group.groupName);
    }));

    return {
        sessions,
        openProjects: openItems,
        savedProjects: Array.from(savedByIdentity.values()),
        todos,
    };
}

export function serializeDashboardSearchCatalog(catalog: DashboardSearchCatalog): string {
    return JSON.stringify(catalog)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}
