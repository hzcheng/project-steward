'use strict';

import type { ProjectDetailsForSave } from '../projects/projectMutationController';
import type { OpenWorkspace } from './types';
import {
    PendingWorkspaceSaveStore,
    PENDING_WORKSPACE_SAVE_TTL_MS,
} from './pendingWorkspaceSaveStore';

export interface SavedWorkspaceProjectAdapterOptions {
    getCurrentWorkspace: () => OpenWorkspace | null;
    pendingStore: PendingWorkspaceSaveStore;
    getProjectDetailsForSave: (navigationUri: string) => Promise<ProjectDetailsForSave | null>;
    saveWorkspaceProject: (details: ProjectDetailsForSave | null) => Promise<void>;
    executeSaveWorkspaceAs: () => Promise<unknown>;
    nowMs?: () => number;
}

export class SavedWorkspaceProjectAdapter {
    private transaction: Promise<void> | null = null;

    constructor(private readonly options: SavedWorkspaceProjectAdapterOptions) { }

    saveCurrentWorkspace(): Promise<void> {
        return this.runTransaction(() => this.saveCurrentWorkspaceUnlocked());
    }

    completePendingWorkspaceSave(): Promise<void> {
        return this.runTransaction(async () => {
            await this.completePendingWorkspaceSaveUnlocked();
        });
    }

    private async saveCurrentWorkspaceUnlocked(): Promise<void> {
        const workspace = this.options.getCurrentWorkspace();
        if (this.options.pendingStore.read()
            && await this.completePendingWorkspaceSaveUnlocked()) {
            return;
        }
        if (!workspace) {
            await this.options.saveWorkspaceProject(null);
            return;
        }

        if (workspace.kind !== 'untitledMultiRoot') {
            await this.saveWorkspace(workspace);
            return;
        }

        const createdAtMs = this.nowMs();
        await this.options.pendingStore.write(
            workspace.scopeIdentity,
            createdAtMs,
            createdAtMs + PENDING_WORKSPACE_SAVE_TTL_MS
        );

        try {
            await this.options.executeSaveWorkspaceAs();
        } catch (error) {
            await this.options.pendingStore.clear();
            throw error;
        }

        const transitioned = this.options.getCurrentWorkspace();
        if (transitioned?.kind === 'savedMultiRoot'
            && transitioned.scopeIdentity === workspace.scopeIdentity) {
            await this.completePendingWorkspaceSaveUnlocked();
            return;
        }

        await this.options.pendingStore.clear();
    }

    private async completePendingWorkspaceSaveUnlocked(): Promise<boolean> {
        const intent = this.options.pendingStore.read();
        await this.options.pendingStore.clear();
        if (!intent || !this.options.pendingStore.isValidAt(intent, this.nowMs())) {
            return false;
        }

        const workspace = this.options.getCurrentWorkspace();
        if (!workspace
            || workspace.kind !== 'savedMultiRoot'
            || workspace.scopeIdentity !== intent.scopeIdentity) {
            return false;
        }

        await this.saveWorkspace(workspace);
        return true;
    }

    private async saveWorkspace(workspace: OpenWorkspace): Promise<void> {
        const details = await this.options.getProjectDetailsForSave(workspace.navigationUri);
        await this.options.saveWorkspaceProject(details);
    }

    private runTransaction(operation: () => Promise<void>): Promise<void> {
        if (this.transaction) {
            return this.transaction;
        }

        const operationPromise = Promise.resolve().then(operation);
        let transaction: Promise<void>;
        transaction = operationPromise.finally(() => {
            if (this.transaction === transaction) {
                this.transaction = null;
            }
        });
        this.transaction = transaction;
        return transaction;
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }
}
