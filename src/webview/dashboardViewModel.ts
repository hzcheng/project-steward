'use strict';

import type { AiSessionProviderId, Group, Project } from '../models';
import type { TodoSearchCatalogItem } from '../todos/types';

export interface DashboardWorkspaceSearchSessionItem {
    key: string;
    searchText: string;
    workspaceId: string;
    workspaceNavigationIdentity: string;
    workspaceName: string;
    action: 'reveal-workspace-session';
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
    action: 'open-saved';
    environmentLabel?: string;
    groupLabels: string[];
}

export interface DashboardSearchWorkspaceItem {
    key: string;
    navigationIdentity: string;
    searchText: string;
    workspaceId: string;
    name: string;
    description: string;
    action: 'show-current-workspace' | 'switch-open-workspace';
    current: boolean;
    environmentLabel?: string;
}

export interface DashboardWorkspaceSearchCatalog {
    version: 2;
    sessions: DashboardWorkspaceSearchSessionItem[];
    openWorkspaces: DashboardSearchWorkspaceItem[];
    savedProjects: DashboardSearchProjectItem[];
    todos: TodoSearchCatalogItem[];
}

export interface DashboardSearchWorkspace {
    id: string;
    kind: 'current' | 'navigation';
    navigationIdentity: string;
    name: string;
    environmentLabel?: string;
    roots: Array<{ id: string; name: string; ordinal: number }>;
    aiSessions?: {
        sessionsByProvider: Partial<Record<AiSessionProviderId, Array<{
            id: string;
            name?: string;
            updatedAt?: string;
            active?: boolean;
            primaryRootLabel?: string;
        }>>>;
    };
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

function removeTrailingIdentitySeparators(value: string): string {
    if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
        return value;
    }
    return value.replace(/\/+$/g, '');
}

function normalizeDashboardProjectIdentity(uri: string): string {
    const value = uri || '';
    const uriMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(.*)$/.exec(value);
    if (!uriMatch) {
        if (/^[A-Za-z]:[\\/]/.test(value)) {
            return removeTrailingIdentitySeparators(value.replace(/\\/g, '/'));
        }
        return removeTrailingIdentitySeparators(value);
    }
    const scheme = uriMatch[1].toLowerCase();
    const authority = uriMatch[2]
        .replace(/%[0-9a-fA-F]{2}/g, escape => escape.toUpperCase())
        .replace(/%2B/g, '+');
    const uriPath = removeTrailingIdentitySeparators(uriMatch[3]);
    return `${scheme}://${authority}${uriPath}`;
}

function buildSavedProjectSearchItems(groups: Group[]): DashboardSearchProjectItem[] {
    const savedByIdentity = new Map<string, DashboardSearchProjectItem>();

    (groups || []).forEach(group => (group.projects || []).forEach(project => {
        const identity = normalizeDashboardProjectIdentity(project.path) || project.id;
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

    return Array.from(savedByIdentity.values());
}

export function buildWorkspaceDashboardSearchCatalog(
    groups: Group[],
    workspaces: DashboardSearchWorkspace[],
    todos: TodoSearchCatalogItem[] = []
): DashboardWorkspaceSearchCatalog {
    const current = (workspaces || []).find(workspace => workspace.kind === 'current');
    const byNavigationIdentity = new Map<string, DashboardSearchWorkspace>();
    if (current?.navigationIdentity) {
        byNavigationIdentity.set(current.navigationIdentity, current);
    }
    (workspaces || [])
        .filter(workspace => workspace.kind !== 'current')
        .forEach(workspace => {
            if (workspace.navigationIdentity && !byNavigationIdentity.has(workspace.navigationIdentity)) {
                byNavigationIdentity.set(workspace.navigationIdentity, workspace);
            }
        });

    const openWorkspaces = Array.from(byNavigationIdentity.values())
        .sort((left, right) => {
            if (left === current) {
                return -1;
            }
            if (right === current) {
                return 1;
            }
            return left.navigationIdentity.localeCompare(right.navigationIdentity);
        })
        .map(workspace => {
            const rootNames = (workspace.roots || [])
                .slice()
                .sort((left, right) => left.ordinal - right.ordinal)
                .map(root => root.name);
            const rootCount = rootNames.length;
            const isCurrent = workspace === current;
            return {
                key: `workspace:${workspace.navigationIdentity}`,
                navigationIdentity: workspace.navigationIdentity,
                searchText: searchable(workspace.name, workspace.environmentLabel, ...rootNames),
                workspaceId: workspace.id,
                name: workspace.name || '',
                description: `${rootCount} folder${rootCount === 1 ? '' : 's'}`,
                action: isCurrent ? 'show-current-workspace' as const : 'switch-open-workspace' as const,
                current: isCurrent,
                ...(workspace.environmentLabel ? { environmentLabel: workspace.environmentLabel } : {}),
            };
        });

    const sessions: DashboardWorkspaceSearchSessionItem[] = [];
    if (current?.aiSessions) {
        PROVIDERS.forEach(provider => (current.aiSessions.sessionsByProvider[provider.id] || [])
            .forEach(session => sessions.push({
                key: `${provider.id}:${session.id}`,
                searchText: searchable(
                    session.name,
                    current.name,
                    session.primaryRootLabel,
                    provider.id,
                    session.id
                ),
                workspaceId: current.id,
                workspaceNavigationIdentity: current.navigationIdentity,
                workspaceName: current.name || '',
                action: 'reveal-workspace-session',
                provider: provider.id,
                sessionId: session.id,
                name: session.name || session.id,
                updatedAt: session.updatedAt,
                active: session.active === true,
            })));
    }

    const savedProjects = buildSavedProjectSearchItems(groups);
    return {
        version: 2,
        sessions,
        openWorkspaces,
        savedProjects,
        todos,
    };
}

export function serializeDashboardSearchCatalog(
    catalog: DashboardWorkspaceSearchCatalog
): string {
    return JSON.stringify(catalog)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}
