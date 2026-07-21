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
    private completion: Promise<void> | null = null;

    constructor(private readonly options: SavedWorkspaceProjectAdapterOptions) { }

    async saveCurrentWorkspace(): Promise<void> {
        const workspace = this.options.getCurrentWorkspace();
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
            await this.completePendingWorkspaceSave();
            return;
        }

        await this.options.pendingStore.clear();
    }

    completePendingWorkspaceSave(): Promise<void> {
        if (!this.completion) {
            this.completion = this.completePendingWorkspaceSaveOnce()
                .finally(() => { this.completion = null; });
        }
        return this.completion;
    }

    private async completePendingWorkspaceSaveOnce(): Promise<void> {
        const intent = this.options.pendingStore.read();
        await this.options.pendingStore.clear();
        if (!intent || !this.options.pendingStore.isValidAt(intent, this.nowMs())) {
            return;
        }

        const workspace = this.options.getCurrentWorkspace();
        if (!workspace
            || workspace.kind !== 'savedMultiRoot'
            || workspace.scopeIdentity !== intent.scopeIdentity) {
            return;
        }

        await this.saveWorkspace(workspace);
    }

    private async saveWorkspace(workspace: OpenWorkspace): Promise<void> {
        const details = await this.options.getProjectDetailsForSave(workspace.navigationUri);
        await this.options.saveWorkspaceProject(details);
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }
}
