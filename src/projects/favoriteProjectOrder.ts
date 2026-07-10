'use strict';

import { Group, Project } from '../models';

interface FavoriteProjectEntry {
    project: Project;
    sourceIndex: number;
}

export function getFavoriteProjectsInOrder(projects: readonly Project[]): Project[] {
    let favorites = (projects || []).filter(project => project.favorite);
    let orderCounts = new Map<number, number>();

    for (let project of favorites) {
        if (isValidFavoriteOrder(project.favoriteOrder)) {
            orderCounts.set(project.favoriteOrder, (orderCounts.get(project.favoriteOrder) || 0) + 1);
        }
    }

    return favorites
        .map((project, sourceIndex) => ({ project, sourceIndex }))
        .sort((left, right) => compareFavoriteEntries(left, right, orderCounts))
        .map(entry => entry.project);
}

export function withFavoriteProjectOrder(groups: readonly Group[], projectIds: readonly string[]): Group[] {
    let clonedGroups = cloneGroups(groups);
    let projects = flattenProjects(clonedGroups);
    let favorites = getFavoriteProjectsInOrder(projects);
    let favoritesById = new Map<string, Project>();
    for (let project of favorites) {
        if (!favoritesById.has(project.id)) {
            favoritesById.set(project.id, project);
        }
    }

    let orderedIds: string[] = [];
    let seenIds = new Set<string>();
    for (let projectId of projectIds || []) {
        if (!seenIds.has(projectId) && favoritesById.has(projectId)) {
            orderedIds.push(projectId);
            seenIds.add(projectId);
        }
    }
    for (let project of favorites) {
        if (!seenIds.has(project.id)) {
            orderedIds.push(project.id);
            seenIds.add(project.id);
        }
    }

    let orderById = new Map<string, number>();
    orderedIds.forEach((projectId, index) => orderById.set(projectId, index));
    for (let project of projects) {
        if (project.favorite && orderById.has(project.id)) {
            project.favoriteOrder = orderById.get(project.id);
        } else {
            delete project.favoriteOrder;
        }
    }

    return clonedGroups;
}

export function withToggledProjectFavorite(groups: readonly Group[], projectId: string): Group[] | null {
    let sourceProjects = flattenProjects(groups);
    let sourceProject = sourceProjects.find(project => project.id === projectId);
    if (!sourceProject) {
        return null;
    }

    let currentFavoriteIds = getFavoriteProjectsInOrder(sourceProjects).map(project => project.id);
    let nextFavorite = !sourceProject.favorite;
    let nextFavoriteIds = nextFavorite
        ? currentFavoriteIds.filter(id => id !== projectId).concat(projectId)
        : currentFavoriteIds.filter(id => id !== projectId);
    let toggledGroups = cloneGroups(groups);
    let toggledProject = flattenProjects(toggledGroups).find(project => project.id === projectId);
    toggledProject.favorite = nextFavorite;
    if (!nextFavorite) {
        delete toggledProject.favoriteOrder;
    }

    return withFavoriteProjectOrder(toggledGroups, nextFavoriteIds);
}

function compareFavoriteEntries(
    left: FavoriteProjectEntry,
    right: FavoriteProjectEntry,
    orderCounts: Map<number, number>
): number {
    let leftOrder = getUniqueFavoriteOrder(left.project, orderCounts);
    let rightOrder = getUniqueFavoriteOrder(right.project, orderCounts);
    if (leftOrder !== null && rightOrder !== null) {
        return leftOrder - rightOrder;
    }
    if (leftOrder !== null) {
        return -1;
    }
    if (rightOrder !== null) {
        return 1;
    }
    return left.sourceIndex - right.sourceIndex;
}

function getUniqueFavoriteOrder(project: Project, orderCounts: Map<number, number>): number | null {
    return isValidFavoriteOrder(project.favoriteOrder) && orderCounts.get(project.favoriteOrder) === 1
        ? project.favoriteOrder
        : null;
}

function isValidFavoriteOrder(value: number): boolean {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function cloneGroups(groups: readonly Group[]): Group[] {
    return (groups || []).map(group => ({
        ...group,
        projects: (group.projects || []).map(project => ({ ...project } as Project)),
    } as Group));
}

function flattenProjects(groups: readonly Group[]): Project[] {
    return (groups || []).reduce(
        (projects, group) => projects.concat(group.projects || []),
        [] as Project[]
    );
}
