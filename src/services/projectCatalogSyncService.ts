'use strict';

import type { Group, Project } from '../models';
import {
    applyProjectCatalogSnapshot,
    materializeProjectCatalog,
    mergeProjectCatalogDocuments,
    migrateLegacyProjectCatalog,
    parseProjectCatalogSyncDocument,
    ProjectCatalogMergeResult,
    ProjectCatalogMutationOptions,
    ProjectCatalogSyncDocumentV1,
} from '../projects/projectCatalogSync';

export interface ProjectCatalogLocalStateV1 {
    schemaVersion: 1;
    actorId: string;
    document: ProjectCatalogSyncDocumentV1;
    legacyProjection?: Group[];
}

export interface ProjectCatalogSyncServiceOptions {
    getSyncData: () => unknown;
    updateSyncData: (value: ProjectCatalogSyncDocumentV1) => Thenable<void>;
    getLegacyGroups: () => Group[] | null;
    updateLegacyGroups: (groups: Group[]) => Thenable<void>;
    getLocalState: () => ProjectCatalogLocalStateV1 | null;
    updateLocalState: (value: ProjectCatalogLocalStateV1) => Thenable<void>;
    createActorId: () => string;
    onDiagnostic?: (event: Record<string, unknown>) => void;
    onConflict?: (projectIds: string[]) => void;
}

export interface ProjectCatalogConfigurationChange {
    syncData: boolean;
    legacyGroups: boolean;
}

interface PendingConfigurationWrite {
    id: number;
    fingerprint: string;
}

interface CurrentProjectCatalogState {
    actorId: string;
    document: ProjectCatalogSyncDocumentV1;
    conflictProjectIds: string[];
    initialized: boolean;
    localState: ProjectCatalogLocalStateV1 | null;
    syncData: ProjectCatalogSyncDocumentV1 | null;
    legacyGroups: Group[];
    legacyProjection: Group[] | null;
    invalidSyncData: boolean;
    invalidLocalState: boolean;
}

function clone<T>(value: T): T {
    if (value === undefined || value === null) {
        return value;
    }
    return JSON.parse(JSON.stringify(value));
}

function equals(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function fingerprint(value: unknown): string | null {
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : null;
    } catch (_error) {
        return null;
    }
}

function parseLocalState(value: ProjectCatalogLocalStateV1 | null): ProjectCatalogLocalStateV1 | null {
    if (!value
        || value.schemaVersion !== 1
        || typeof value.actorId !== 'string'
        || !value.actorId) {
        return null;
    }
    const document = parseProjectCatalogSyncDocument(value.document);
    if (!document) {
        return null;
    }
    const parsed: ProjectCatalogLocalStateV1 = {
        schemaVersion: 1,
        actorId: value.actorId,
        document,
    };
    if (Array.isArray(value.legacyProjection)) {
        parsed.legacyProjection = clone(value.legacyProjection);
    }
    return parsed;
}

interface CatalogProject {
    groupId: string;
    value: Project;
}

function groupValue(group: Group): Record<string, unknown> {
    const value = clone(group) as unknown as Record<string, unknown>;
    delete value.projects;
    return value;
}

function projectMap(groups: Group[]): Map<string, CatalogProject> {
    const result = new Map<string, CatalogProject>();
    for (const group of groups) {
        if (!group || !group.id) {
            continue;
        }
        for (const project of Array.isArray(group.projects) ? group.projects : []) {
            if (project && project.id) {
                result.set(project.id, {
                    groupId: group.id,
                    value: clone(project),
                });
            }
        }
    }
    return result;
}

function findGroup(groups: Group[], groupId: string): Group | undefined {
    return groups.find(group => group && group.id === groupId);
}

function ensureGroup(candidate: Group[], legacyGroup: Group): Group {
    const existing = findGroup(candidate, legacyGroup.id);
    if (existing) {
        return existing;
    }
    const added = clone(legacyGroup);
    added.projects = [];
    candidate.push(added);
    return added;
}

function replaceProject(
    candidate: Group[],
    legacyGroup: Group,
    project: Project
): void {
    for (const group of candidate) {
        group.projects = (group.projects || []).filter(item => item.id !== project.id);
    }
    ensureGroup(candidate, legacyGroup).projects.push(clone(project));
}

function importLegacyChanges(
    document: ProjectCatalogSyncDocumentV1,
    legacyGroups: Group[],
    legacyProjection: Group[] | null,
    actorId: string,
    discardedProjects: Map<string, CatalogProject>
): { document: ProjectCatalogSyncDocumentV1; conflictProjectIds: string[] } {
    const canonicalGroups = materializeProjectCatalog(document);
    if (!legacyProjection || equals(legacyGroups, legacyProjection)) {
        return { document, conflictProjectIds: [] };
    }
    const legacyProjects = projectMap(legacyGroups);
    const repeatsDiscardedProject = Array.from(discardedProjects).some(
        ([projectId, discardedProject]) => {
            const legacyProject = legacyProjects.get(projectId);
            return legacyProject && equals(legacyProject, discardedProject);
        }
    );
    if (equals(canonicalGroups, legacyProjection) && !repeatsDiscardedProject) {
        return {
            document: applyProjectCatalogSnapshot(document, legacyGroups, actorId),
            conflictProjectIds: [],
        };
    }

    const candidate = clone(canonicalGroups);
    const canonicalProjects = projectMap(canonicalGroups);
    const baselineProjects = projectMap(legacyProjection);
    const conflictProjectIds = new Set<string>();

    for (const legacyGroup of legacyGroups) {
        if (!legacyGroup || !legacyGroup.id) {
            continue;
        }
        const canonicalGroup = findGroup(canonicalGroups, legacyGroup.id);
        const baselineGroup = legacyProjection
            ? findGroup(legacyProjection, legacyGroup.id)
            : undefined;
        const candidateGroup = findGroup(candidate, legacyGroup.id);

        if (!baselineGroup && !canonicalGroup) {
            candidate.push(clone(legacyGroup));
            continue;
        }
        if (baselineGroup
            && canonicalGroup
            && candidateGroup
            && equals(groupValue(canonicalGroup), groupValue(baselineGroup))
            && !equals(groupValue(legacyGroup), groupValue(baselineGroup))) {
            Object.assign(candidateGroup, groupValue(legacyGroup));
        }

        for (const legacyProject of Array.isArray(legacyGroup.projects)
            ? legacyGroup.projects
            : []) {
            if (!legacyProject || !legacyProject.id) {
                continue;
            }
            const legacyValue: CatalogProject = {
                groupId: legacyGroup.id,
                value: clone(legacyProject),
            };
            const canonicalValue = canonicalProjects.get(legacyProject.id);
            const baselineValue = baselineProjects.get(legacyProject.id);
            const discardedProject = discardedProjects.get(legacyProject.id);

            if (discardedProject && equals(legacyValue, discardedProject)) {
                continue;
            }
            if (discardedProject) {
                conflictProjectIds.add(legacyProject.id);
            }

            if (!baselineValue) {
                if (!canonicalValue) {
                    replaceProject(candidate, legacyGroup, legacyValue.value);
                }
                continue;
            }
            if (canonicalValue && equals(canonicalValue, baselineValue)) {
                if (!equals(legacyValue, baselineValue)) {
                    replaceProject(candidate, legacyGroup, legacyValue.value);
                }
                continue;
            }
            if (!equals(legacyValue, baselineValue)
                && !equals(canonicalValue, legacyValue)) {
                conflictProjectIds.add(legacyProject.id);
                if (!canonicalValue) {
                    replaceProject(candidate, legacyGroup, legacyValue.value);
                }
            }
        }
    }

    return {
        document: applyProjectCatalogSnapshot(document, candidate, actorId),
        conflictProjectIds: Array.from(conflictProjectIds).sort(),
    };
}

export class ProjectCatalogSyncService {
    private pending: Promise<unknown> = Promise.resolve();
    private nextConfigurationWriteId = 1;
    private pendingSyncDataWrites: PendingConfigurationWrite[] = [];
    private pendingLegacyGroupWrites: PendingConfigurationWrite[] = [];

    constructor(private readonly options: ProjectCatalogSyncServiceOptions) {
    }

    getGroups(): Group[] {
        return materializeProjectCatalog(this.readCurrent().document);
    }

    reconcile(): Promise<ProjectCatalogMergeResult> {
        return this.enqueue(async () => {
            const current = this.readCurrent();
            return this.persist(current, current.document, current.initialized);
        });
    }

    saveGroups(
        groups: Group[],
        options: ProjectCatalogMutationOptions = {}
    ): Promise<Group[]> {
        return this.enqueue(async () => {
            const current = this.readCurrent();
            const document = applyProjectCatalogSnapshot(
                current.document,
                groups,
                current.actorId,
                options
            );
            await this.persist(current, document, false);
            return materializeProjectCatalog(document);
        });
    }

    consumeConfigurationWriteEcho(change: ProjectCatalogConfigurationChange): boolean {
        if (!change || (!change.syncData && !change.legacyGroups)) {
            return false;
        }
        let local = true;
        if (change.syncData) {
            local = this.consumeWriteEcho(
                this.pendingSyncDataWrites,
                this.options.getSyncData(),
                value => !!parseProjectCatalogSyncDocument(value)
            ) && local;
        }
        if (change.legacyGroups) {
            local = this.consumeWriteEcho(
                this.pendingLegacyGroupWrites,
                this.options.getLegacyGroups(),
                value => Array.isArray(value)
            ) && local;
        }
        return local;
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation, operation);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    private readCurrent(): CurrentProjectCatalogState {
        const rawSyncData = this.options.getSyncData();
        const syncData = parseProjectCatalogSyncDocument(rawSyncData);
        const rawLocalState = this.options.getLocalState();
        const localState = parseLocalState(rawLocalState);
        const legacyGroups = clone(this.options.getLegacyGroups() || []);
        const actorId = localState && localState.actorId || this.options.createActorId();
        const initialized = !syncData && !localState;
        let document: ProjectCatalogSyncDocumentV1;
        let conflictProjectIds: string[] = [];
        const discardedProjects = new Map<string, CatalogProject>();

        if (syncData && localState) {
            const merged = mergeProjectCatalogDocuments(localState.document, syncData);
            document = merged.document;
            conflictProjectIds = merged.conflictProjectIds;
            for (const source of [localState.document, syncData]) {
                for (const projectId of Object.keys(source.projects)) {
                    if (!document.projects[projectId]) {
                        discardedProjects.set(
                            projectId,
                            {
                                groupId: source.projects[projectId].groupId,
                                value: clone(source.projects[projectId].value),
                            }
                        );
                    }
                }
            }
        } else if (localState) {
            document = localState.document;
        } else if (syncData) {
            document = syncData;
        } else {
            document = migrateLegacyProjectCatalog(legacyGroups, actorId);
        }

        const legacyProjection = initialized
            ? legacyGroups
            : localState && localState.legacyProjection || null;
        if (!initialized) {
            const imported = importLegacyChanges(
                document,
                legacyGroups,
                legacyProjection,
                actorId,
                discardedProjects
            );
            document = imported.document;
            conflictProjectIds = Array.from(new Set([
                ...conflictProjectIds,
                ...imported.conflictProjectIds,
            ])).sort();
        }

        return {
            actorId,
            document,
            conflictProjectIds,
            initialized,
            localState,
            syncData,
            legacyGroups,
            legacyProjection,
            invalidSyncData: rawSyncData !== null
                && rawSyncData !== undefined
                && !syncData,
            invalidLocalState: rawLocalState !== null
                && rawLocalState !== undefined
                && !localState,
        };
    }

    private async persist(
        current: CurrentProjectCatalogState,
        document: ProjectCatalogSyncDocumentV1,
        forceProjection: boolean
    ): Promise<ProjectCatalogMergeResult> {
        const localState: ProjectCatalogLocalStateV1 = {
            schemaVersion: 1,
            actorId: current.actorId,
            document: clone(document),
            legacyProjection: clone(current.legacyProjection || current.legacyGroups),
        };
        const groups = materializeProjectCatalog(document);
        const writeLocal = !current.localState || !equals(current.localState, localState);
        const writeSync = !current.syncData || !equals(current.syncData, document);
        const writeLegacy = forceProjection || !equals(current.legacyGroups, groups);
        const repairReasons = new Set<string>();

        if (current.invalidSyncData) {
            repairReasons.add('invalid-sync-data');
            this.options.onDiagnostic?.({
                event: 'project-catalog-sync-invalid-source',
                source: 'projectSyncData',
            });
        }
        if (current.invalidLocalState) {
            repairReasons.add('invalid-local-shadow');
            this.options.onDiagnostic?.({
                event: 'project-catalog-sync-invalid-source',
                source: 'localShadow',
            });
        }
        if (writeLocal && !current.localState && !current.invalidLocalState) {
            repairReasons.add('missing-local-shadow');
        }
        if (writeSync && !current.invalidSyncData) {
            repairReasons.add(current.syncData ? 'stale-sync-data' : 'missing-sync-data');
        }
        if (writeLegacy) {
            repairReasons.add('stale-compatibility-projection');
        }
        if (current.conflictProjectIds.length) {
            repairReasons.add('conflict-recovery');
        }
        if (writeLocal) {
            await this.options.updateLocalState(localState);
        }
        if (writeSync) {
            await this.writeConfigurationValue(
                this.pendingSyncDataWrites,
                document,
                () => this.options.updateSyncData(document)
            );
        }
        if (writeLegacy) {
            await this.writeConfigurationValue(
                this.pendingLegacyGroupWrites,
                groups,
                () => this.options.updateLegacyGroups(groups)
            );
        }
        const confirmedLocalState: ProjectCatalogLocalStateV1 = {
            ...localState,
            legacyProjection: clone(groups),
        };
        const acknowledgeLegacyProjection = !equals(localState, confirmedLocalState);
        if (acknowledgeLegacyProjection) {
            repairReasons.add('compatibility-baseline-confirmed');
            await this.options.updateLocalState(confirmedLocalState);
        }

        if (current.conflictProjectIds.length) {
            this.options.onConflict?.(current.conflictProjectIds);
        }
        if (writeLocal
            || writeSync
            || writeLegacy
            || acknowledgeLegacyProjection
            || current.conflictProjectIds.length) {
            this.options.onDiagnostic?.({
                event: 'project-catalog-sync-reconciled',
                actorId: current.actorId,
                causalVersionVector: clone(document.versionVector),
                repairReasons: Array.from(repairReasons).sort(),
                affectedProjectIds: [...current.conflictProjectIds],
                repaired: writeSync || writeLegacy,
                conflictProjectIds: current.conflictProjectIds,
            });
        }

        return {
            document: clone(document),
            conflictProjectIds: [...current.conflictProjectIds],
            repaired: writeLocal || writeSync || writeLegacy || acknowledgeLegacyProjection,
        };
    }

    private consumeWriteEcho(
        pendingWrites: PendingConfigurationWrite[],
        currentValue: unknown,
        isReadable: (value: unknown) => boolean
    ): boolean {
        const currentFingerprint = isReadable(currentValue)
            ? fingerprint(currentValue)
            : null;
        const matchingIndex = currentFingerprint === null
            ? -1
            : pendingWrites.map(write => write.fingerprint).lastIndexOf(currentFingerprint);
        if (matchingIndex < 0) {
            pendingWrites.length = 0;
            return false;
        }
        pendingWrites.splice(0, matchingIndex + 1);
        return true;
    }

    private async writeConfigurationValue(
        pendingWrites: PendingConfigurationWrite[],
        value: unknown,
        update: () => Thenable<void>
    ): Promise<void> {
        const valueFingerprint = fingerprint(value);
        if (valueFingerprint === null) {
            await update();
            return;
        }
        const token = {
            id: this.nextConfigurationWriteId++,
            fingerprint: valueFingerprint,
        };
        pendingWrites.push(token);
        try {
            await update();
        } catch (error) {
            const index = pendingWrites.findIndex(candidate => candidate.id === token.id);
            if (index >= 0) {
                pendingWrites.splice(index, 1);
            }
            throw error;
        }
    }
}
