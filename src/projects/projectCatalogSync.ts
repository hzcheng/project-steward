'use strict';

import type { Group, Project } from '../models';

export interface ProjectCatalogVersion {
    actorId: string;
    vector: Record<string, number>;
}

export interface VersionedProjectCatalogGroup {
    value: Record<string, unknown>;
    version: ProjectCatalogVersion;
}

export interface VersionedProjectCatalogProject {
    value: Project;
    groupId: string;
    version: ProjectCatalogVersion;
}

export interface ProjectCatalogLayout {
    groupIds: string[];
    projectIdsByGroup: Record<string, string[]>;
}

export interface VersionedProjectCatalogLayout {
    value: ProjectCatalogLayout;
    version: ProjectCatalogVersion;
}

export interface ProjectCatalogSyncDocumentV1 {
    schemaVersion: 1;
    versionVector: Record<string, number>;
    groups: Record<string, VersionedProjectCatalogGroup>;
    projects: Record<string, VersionedProjectCatalogProject>;
    layout: VersionedProjectCatalogLayout;
}

export interface ProjectCatalogMutationOptions {
    deletedGroupIds?: string[];
    deletedProjectIds?: string[];
}

export interface ProjectCatalogMergeResult {
    document: ProjectCatalogSyncDocumentV1;
    conflictProjectIds: string[];
    repaired: boolean;
}

function clone<T>(value: T): T {
    if (value === undefined || value === null) {
        return value;
    }
    return JSON.parse(JSON.stringify(value));
}

function sortedObject<T>(value: Record<string, T>): Record<string, T> {
    const result: Record<string, T> = {};
    for (const key of Object.keys(value || {}).sort()) {
        result[key] = value[key];
    }
    return result;
}

function normalizeVector(vector: Record<string, number>): Record<string, number> {
    const result: Record<string, number> = {};
    for (const actorId of Object.keys(vector || {}).sort()) {
        const counter = vector[actorId];
        if (actorId && typeof counter === 'number' && Number.isFinite(counter) && counter >= 0) {
            result[actorId] = Math.floor(counter);
        }
    }
    return result;
}

function dominates(left: Record<string, number>, right: Record<string, number>): boolean {
    return Object.keys(right || {}).every(actorId =>
        (left && left[actorId] || 0) >= (right[actorId] || 0));
}

function strictlyDominates(
    left: Record<string, number>,
    right: Record<string, number>
): boolean {
    return dominates(left, right)
        && Object.keys({ ...(left || {}), ...(right || {}) }).some(actorId =>
            (left && left[actorId] || 0) > (right && right[actorId] || 0));
}

function mergeVectors(
    left: Record<string, number>,
    right: Record<string, number>
): Record<string, number> {
    const result = normalizeVector(left || {});
    for (const actorId of Object.keys(right || {})) {
        result[actorId] = Math.max(result[actorId] || 0, right[actorId] || 0);
    }
    return normalizeVector(result);
}

function nextVersion(
    vector: Record<string, number>,
    actorId: string
): ProjectCatalogVersion {
    const next = normalizeVector(vector || {});
    next[actorId] = (next[actorId] || 0) + 1;
    return { actorId, vector: normalizeVector(next) };
}

function normalizeVersion(version: ProjectCatalogVersion): ProjectCatalogVersion {
    return {
        actorId: version.actorId,
        vector: normalizeVector(version.vector),
    };
}

function compareVersions(
    left: ProjectCatalogVersion,
    right: ProjectCatalogVersion
): number {
    const leftDominates = dominates(left.vector, right.vector);
    const rightDominates = dominates(right.vector, left.vector);
    if (leftDominates && !rightDominates) {
        return 1;
    }
    if (rightDominates && !leftDominates) {
        return -1;
    }
    return left.actorId.localeCompare(right.actorId);
}

function withoutProjects(group: Group): Record<string, unknown> {
    const value = clone(group) as unknown as Record<string, unknown>;
    delete value.projects;
    return value;
}

function valueEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeLayout(
    layout: ProjectCatalogLayout,
    groups: Record<string, VersionedProjectCatalogGroup>,
    projects: Record<string, VersionedProjectCatalogProject>
): ProjectCatalogLayout {
    const groupIds = [];
    const seenGroups = new Set<string>();
    for (const groupId of (layout && layout.groupIds || [])) {
        if (groups[groupId] && !seenGroups.has(groupId)) {
            groupIds.push(groupId);
            seenGroups.add(groupId);
        }
    }
    for (const groupId of Object.keys(groups).sort()) {
        if (!seenGroups.has(groupId)) {
            groupIds.push(groupId);
            seenGroups.add(groupId);
        }
    }

    const projectIdsByGroup: Record<string, string[]> = {};
    for (const groupId of groupIds) {
        const projectIds = [];
        const seenProjects = new Set<string>();
        const requested = layout && layout.projectIdsByGroup
            ? layout.projectIdsByGroup[groupId] || []
            : [];
        for (const projectId of requested) {
            if (projects[projectId]
                && projects[projectId].groupId === groupId
                && !seenProjects.has(projectId)) {
                projectIds.push(projectId);
                seenProjects.add(projectId);
            }
        }
        for (const projectId of Object.keys(projects).sort()) {
            if (projects[projectId].groupId === groupId && !seenProjects.has(projectId)) {
                projectIds.push(projectId);
                seenProjects.add(projectId);
            }
        }
        projectIdsByGroup[groupId] = projectIds;
    }
    return { groupIds, projectIdsByGroup: sortedObject(projectIdsByGroup) };
}

function normalizeDocument(
    document: ProjectCatalogSyncDocumentV1
): ProjectCatalogSyncDocumentV1 {
    const groups: Record<string, VersionedProjectCatalogGroup> = {};
    for (const groupId of Object.keys(document.groups || {}).sort()) {
        const record = document.groups[groupId];
        groups[groupId] = {
            value: clone(record.value),
            version: normalizeVersion(record.version),
        };
    }
    const projects: Record<string, VersionedProjectCatalogProject> = {};
    for (const projectId of Object.keys(document.projects || {}).sort()) {
        const record = document.projects[projectId];
        projects[projectId] = {
            value: clone(record.value),
            groupId: record.groupId,
            version: normalizeVersion(record.version),
        };
    }
    const layoutValue = normalizeLayout(
        document.layout && document.layout.value || { groupIds: [], projectIdsByGroup: {} },
        groups,
        projects
    );
    return {
        schemaVersion: 1,
        versionVector: normalizeVector(document.versionVector || {}),
        groups,
        projects,
        layout: {
            value: layoutValue,
            version: normalizeVersion(document.layout.version),
        },
    };
}

function isVersion(value: unknown): value is ProjectCatalogVersion {
    const candidate = value as ProjectCatalogVersion;
    return Boolean(candidate
        && typeof candidate === 'object'
        && typeof candidate.actorId === 'string'
        && candidate.actorId
        && candidate.vector
        && typeof candidate.vector === 'object'
        && !Array.isArray(candidate.vector));
}

export function parseProjectCatalogSyncDocument(
    value: unknown
): ProjectCatalogSyncDocumentV1 | null {
    const candidate = value as ProjectCatalogSyncDocumentV1;
    if (!candidate
        || typeof candidate !== 'object'
        || Array.isArray(candidate)
        || candidate.schemaVersion !== 1
        || !candidate.versionVector
        || typeof candidate.versionVector !== 'object'
        || Array.isArray(candidate.versionVector)
        || !candidate.groups
        || typeof candidate.groups !== 'object'
        || Array.isArray(candidate.groups)
        || !candidate.projects
        || typeof candidate.projects !== 'object'
        || Array.isArray(candidate.projects)
        || !candidate.layout
        || typeof candidate.layout !== 'object'
        || !isVersion(candidate.layout.version)
        || !candidate.layout.value
        || !Array.isArray(candidate.layout.value.groupIds)
        || !candidate.layout.value.projectIdsByGroup
        || typeof candidate.layout.value.projectIdsByGroup !== 'object') {
        return null;
    }
    for (const groupId of Object.keys(candidate.groups)) {
        const record = candidate.groups[groupId];
        if (!record || typeof record.value !== 'object' || !isVersion(record.version)) {
            return null;
        }
    }
    for (const projectId of Object.keys(candidate.projects)) {
        const record = candidate.projects[projectId];
        if (!record
            || !record.value
            || typeof record.value !== 'object'
            || typeof record.groupId !== 'string'
            || !isVersion(record.version)) {
            return null;
        }
    }
    return normalizeDocument(candidate);
}

export function migrateLegacyProjectCatalog(
    groups: Group[],
    actorId: string
): ProjectCatalogSyncDocumentV1 {
    const version = nextVersion({}, actorId);
    const versionVector = version.vector;
    const groupRecords: Record<string, VersionedProjectCatalogGroup> = {};
    const projectRecords: Record<string, VersionedProjectCatalogProject> = {};
    const layout: ProjectCatalogLayout = { groupIds: [], projectIdsByGroup: {} };

    for (const group of Array.isArray(groups) ? groups : []) {
        if (!group || !group.id || groupRecords[group.id]) {
            continue;
        }
        groupRecords[group.id] = { value: withoutProjects(group), version: clone(version) };
        layout.groupIds.push(group.id);
        layout.projectIdsByGroup[group.id] = [];
        for (const project of Array.isArray(group.projects) ? group.projects : []) {
            if (!project || !project.id || projectRecords[project.id]) {
                continue;
            }
            projectRecords[project.id] = {
                value: clone(project),
                groupId: group.id,
                version: clone(version),
            };
            layout.projectIdsByGroup[group.id].push(project.id);
        }
    }

    return normalizeDocument({
        schemaVersion: 1,
        versionVector,
        groups: groupRecords,
        projects: projectRecords,
        layout: { value: layout, version: clone(version) },
    });
}

export function materializeProjectCatalog(
    document: ProjectCatalogSyncDocumentV1
): Group[] {
    const normalized = normalizeDocument(document);
    return normalized.layout.value.groupIds.map(groupId => {
        const group = clone(normalized.groups[groupId].value) as unknown as Group;
        group.projects = (normalized.layout.value.projectIdsByGroup[groupId] || [])
            .map(projectId => normalized.projects[projectId])
            .filter(Boolean)
            .map(record => clone(record.value));
        return group;
    });
}

export function applyProjectCatalogSnapshot(
    document: ProjectCatalogSyncDocumentV1,
    groups: Group[],
    actorId: string,
    options: ProjectCatalogMutationOptions = {}
): ProjectCatalogSyncDocumentV1 {
    const current = normalizeDocument(document);
    const desiredGroups: Record<string, Record<string, unknown>> = {};
    const desiredProjects: Record<string, { value: Project; groupId: string }> = {};
    const requestedGroupIds: string[] = [];
    const requestedProjectIdsByGroup: Record<string, string[]> = {};

    for (const groupId of current.layout.value.groupIds) {
        desiredGroups[groupId] = clone(current.groups[groupId].value);
    }
    for (const projectId of Object.keys(current.projects)) {
        const record = current.projects[projectId];
        desiredProjects[projectId] = { value: clone(record.value), groupId: record.groupId };
    }

    for (const group of Array.isArray(groups) ? groups : []) {
        if (!group || !group.id) {
            continue;
        }
        desiredGroups[group.id] = withoutProjects(group);
        if (!requestedGroupIds.includes(group.id)) {
            requestedGroupIds.push(group.id);
        }
        requestedProjectIdsByGroup[group.id] = [];
        for (const project of Array.isArray(group.projects) ? group.projects : []) {
            if (!project || !project.id) {
                continue;
            }
            desiredProjects[project.id] = { value: clone(project), groupId: group.id };
            if (!requestedProjectIdsByGroup[group.id].includes(project.id)) {
                requestedProjectIdsByGroup[group.id].push(project.id);
            }
        }
    }

    for (const projectId of options.deletedProjectIds || []) {
        delete desiredProjects[projectId];
    }
    for (const groupId of options.deletedGroupIds || []) {
        delete desiredGroups[groupId];
        for (const projectId of Object.keys(desiredProjects)) {
            if (desiredProjects[projectId].groupId === groupId) {
                delete desiredProjects[projectId];
            }
        }
    }

    const desiredGroupIds = requestedGroupIds.filter(groupId => desiredGroups[groupId]);
    for (const groupId of current.layout.value.groupIds) {
        if (desiredGroups[groupId] && !desiredGroupIds.includes(groupId)) {
            desiredGroupIds.push(groupId);
        }
    }
    for (const groupId of Object.keys(desiredGroups).sort()) {
        if (!desiredGroupIds.includes(groupId)) {
            desiredGroupIds.push(groupId);
        }
    }

    const desiredLayout: ProjectCatalogLayout = {
        groupIds: desiredGroupIds,
        projectIdsByGroup: {},
    };
    for (const groupId of desiredGroupIds) {
        const ids = (requestedProjectIdsByGroup[groupId] || [])
            .filter(projectId => desiredProjects[projectId]
                && desiredProjects[projectId].groupId === groupId);
        for (const projectId of current.layout.value.projectIdsByGroup[groupId] || []) {
            if (desiredProjects[projectId]
                && desiredProjects[projectId].groupId === groupId
                && !ids.includes(projectId)) {
                ids.push(projectId);
            }
        }
        for (const projectId of Object.keys(desiredProjects).sort()) {
            if (desiredProjects[projectId].groupId === groupId && !ids.includes(projectId)) {
                ids.push(projectId);
            }
        }
        desiredLayout.projectIdsByGroup[groupId] = ids;
    }

    let changed = !valueEquals(current.layout.value, desiredLayout);
    changed = changed || Object.keys(current.groups).some(groupId => !desiredGroups[groupId]);
    changed = changed || Object.keys(current.projects).some(projectId => !desiredProjects[projectId]);
    changed = changed || Object.keys(desiredGroups).some(groupId =>
        !current.groups[groupId]
        || !valueEquals(current.groups[groupId].value, desiredGroups[groupId]));
    changed = changed || Object.keys(desiredProjects).some(projectId => {
        const currentRecord = current.projects[projectId];
        const desired = desiredProjects[projectId];
        return !currentRecord
            || currentRecord.groupId !== desired.groupId
            || !valueEquals(currentRecord.value, desired.value);
    });
    if (!changed) {
        return current;
    }

    const version = nextVersion(current.versionVector, actorId);
    const nextGroups: Record<string, VersionedProjectCatalogGroup> = {};
    for (const groupId of desiredGroupIds) {
        const existing = current.groups[groupId];
        nextGroups[groupId] = existing && valueEquals(existing.value, desiredGroups[groupId])
            ? clone(existing)
            : { value: clone(desiredGroups[groupId]), version: clone(version) };
    }
    const nextProjects: Record<string, VersionedProjectCatalogProject> = {};
    for (const projectId of Object.keys(desiredProjects).sort()) {
        const desired = desiredProjects[projectId];
        const existing = current.projects[projectId];
        nextProjects[projectId] = existing
            && existing.groupId === desired.groupId
            && valueEquals(existing.value, desired.value)
            ? clone(existing)
            : {
                value: clone(desired.value),
                groupId: desired.groupId,
                version: clone(version),
            };
    }

    return normalizeDocument({
        schemaVersion: 1,
        versionVector: version.vector,
        groups: nextGroups,
        projects: nextProjects,
        layout: valueEquals(current.layout.value, desiredLayout)
            ? clone(current.layout)
            : { value: desiredLayout, version: clone(version) },
    });
}

function chooseRecord<T extends { version: ProjectCatalogVersion }>(
    left: T,
    right: T
): T {
    const comparison = compareVersions(left.version, right.version);
    if (comparison > 0) {
        return clone(left);
    }
    if (comparison < 0) {
        return clone(right);
    }
    return JSON.stringify(left).localeCompare(JSON.stringify(right)) >= 0
        ? clone(left)
        : clone(right);
}

export function mergeProjectCatalogDocuments(
    local: ProjectCatalogSyncDocumentV1,
    incoming: ProjectCatalogSyncDocumentV1
): ProjectCatalogMergeResult {
    const left = normalizeDocument(local);
    const right = normalizeDocument(incoming);
    const versionVector = mergeVectors(left.versionVector, right.versionVector);
    const groups: Record<string, VersionedProjectCatalogGroup> = {};
    const projects: Record<string, VersionedProjectCatalogProject> = {};
    const conflictProjectIds = new Set<string>();

    for (const groupId of Array.from(new Set([
        ...Object.keys(left.groups),
        ...Object.keys(right.groups),
    ])).sort()) {
        const leftRecord = left.groups[groupId];
        const rightRecord = right.groups[groupId];
        if (leftRecord && rightRecord) {
            groups[groupId] = chooseRecord(leftRecord, rightRecord);
        } else if (leftRecord
            && !strictlyDominates(right.versionVector, leftRecord.version.vector)) {
            groups[groupId] = clone(leftRecord);
        } else if (rightRecord
            && !strictlyDominates(left.versionVector, rightRecord.version.vector)) {
            groups[groupId] = clone(rightRecord);
        }
    }

    for (const projectId of Array.from(new Set([
        ...Object.keys(left.projects),
        ...Object.keys(right.projects),
    ])).sort()) {
        const leftRecord = left.projects[projectId];
        const rightRecord = right.projects[projectId];
        if (leftRecord && rightRecord) {
            projects[projectId] = chooseRecord(leftRecord, rightRecord);
        } else if (leftRecord
            && !strictlyDominates(right.versionVector, leftRecord.version.vector)) {
            projects[projectId] = clone(leftRecord);
            conflictProjectIds.add(projectId);
        } else if (rightRecord
            && !strictlyDominates(left.versionVector, rightRecord.version.vector)) {
            projects[projectId] = clone(rightRecord);
            conflictProjectIds.add(projectId);
        }
    }

    for (const projectId of Object.keys(projects)) {
        const groupId = projects[projectId].groupId;
        if (!groups[groupId]) {
            const candidate = left.groups[groupId] || right.groups[groupId];
            if (candidate) {
                groups[groupId] = clone(candidate);
                conflictProjectIds.add(projectId);
            }
        }
    }

    const layout = chooseRecord(left.layout, right.layout);
    const document = normalizeDocument({
        schemaVersion: 1,
        versionVector,
        groups,
        projects,
        layout,
    });
    return {
        document,
        conflictProjectIds: Array.from(conflictProjectIds).sort(),
        repaired: JSON.stringify(document) !== JSON.stringify(right),
    };
}
