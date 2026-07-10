'use strict';

import { Group, Project } from '../models';

export interface CurrentWorkspaceState {
    groups: Group[];
    openProjects: Project[];
}

export type CurrentWorkspaceProjectMatcher<TWorkspaceUri> = (
    savedProjects: Project[],
    workspaceUri: TWorkspaceUri,
    currentRemoteName: string
) => Project;

export function getCurrentWorkspaceProjectIds<TWorkspaceUri>(
    savedProjects: Project[],
    workspaceUris: readonly TWorkspaceUri[],
    currentRemoteName: string,
    findSavedProject: CurrentWorkspaceProjectMatcher<TWorkspaceUri>
): string[] {
    let matchingIds = (workspaceUris || [])
        .map(uri => findSavedProject(savedProjects || [], uri, currentRemoteName))
        .filter(project => !!project)
        .map(project => project.id);

    return Array.from(new Set(matchingIds));
}

export function withCurrentWorkspaceState(
    groups: Group[],
    openProjects: Project[],
    currentProjectIds: string[]
): CurrentWorkspaceState {
    let currentIds = new Set((currentProjectIds || []).filter(id => !!id));
    let decoratedGroups = (groups || []).map(group => ({
        ...group,
        projects: (group.projects || []).map(project => ({
            ...project,
            isCurrentWorkspace: currentIds.has(project.id),
        })),
    } as Group));
    let decoratedOpenProjects = (openProjects || []).map(project => ({
        ...project,
        isCurrentWorkspace: true,
    } as Project));

    return { groups: decoratedGroups, openProjects: decoratedOpenProjects };
}
