'use strict';

import type { Group } from '../models';
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

interface CurrentProjectCatalogState {
    actorId: string;
    document: ProjectCatalogSyncDocumentV1;
    conflictProjectIds: string[];
    initialized: boolean;
    localState: ProjectCatalogLocalStateV1 | null;
    syncData: ProjectCatalogSyncDocumentV1 | null;
    legacyGroups: Group[];
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

function parseLocalState(value: ProjectCatalogLocalStateV1 | null): ProjectCatalogLocalStateV1 | null {
    if (!value
        || value.schemaVersion !== 1
        || typeof value.actorId !== 'string'
        || !value.actorId) {
        return null;
    }
    const document = parseProjectCatalogSyncDocument(value.document);
    return document
        ? { schemaVersion: 1, actorId: value.actorId, document }
        : null;
}

export class ProjectCatalogSyncService {
    private pending: Promise<unknown> = Promise.resolve();

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

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation, operation);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    private readCurrent(): CurrentProjectCatalogState {
        const rawSyncData = this.options.getSyncData();
        const syncData = parseProjectCatalogSyncDocument(rawSyncData);
        const localState = parseLocalState(this.options.getLocalState());
        const legacyGroups = clone(this.options.getLegacyGroups() || []);
        const actorId = localState && localState.actorId || this.options.createActorId();
        const initialized = !syncData && !localState;
        let document: ProjectCatalogSyncDocumentV1;
        let conflictProjectIds: string[] = [];

        if (syncData && localState) {
            const merged = mergeProjectCatalogDocuments(localState.document, syncData);
            document = merged.document;
            conflictProjectIds = merged.conflictProjectIds;
        } else if (localState) {
            document = localState.document;
        } else if (syncData) {
            document = syncData;
        } else {
            document = migrateLegacyProjectCatalog(legacyGroups, actorId);
        }

        return {
            actorId,
            document,
            conflictProjectIds,
            initialized,
            localState,
            syncData,
            legacyGroups,
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
        };
        const groups = materializeProjectCatalog(document);
        const writeLocal = !current.localState || !equals(current.localState, localState);
        const writeSync = !current.syncData || !equals(current.syncData, document);
        const writeLegacy = forceProjection || !equals(current.legacyGroups, groups);

        if (writeLocal) {
            await this.options.updateLocalState(localState);
        }
        if (writeSync) {
            await this.options.updateSyncData(document);
        }
        if (writeLegacy) {
            await this.options.updateLegacyGroups(groups);
        }

        if (current.conflictProjectIds.length) {
            this.options.onConflict?.(current.conflictProjectIds);
        }
        if (writeLocal || writeSync || writeLegacy || current.conflictProjectIds.length) {
            this.options.onDiagnostic?.({
                event: 'project-catalog-sync-reconciled',
                actorId: current.actorId,
                repaired: writeSync || writeLegacy,
                conflictProjectIds: current.conflictProjectIds,
            });
        }

        return {
            document: clone(document),
            conflictProjectIds: [...current.conflictProjectIds],
            repaired: writeLocal || writeSync || writeLegacy,
        };
    }
}
