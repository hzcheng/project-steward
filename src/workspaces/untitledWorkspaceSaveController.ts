'use strict';

import type { OpenWorkspace } from './types';

export interface UntitledWorkspaceSaveControllerOptions {
    getCurrentWorkspace: () => OpenWorkspace | null;
    executeSaveWorkspaceAs: () => Promise<unknown>;
    onSaved: () => void;
}

export class UntitledWorkspaceSaveController {
    private transaction: Promise<void> | null = null;

    constructor(private readonly options: UntitledWorkspaceSaveControllerOptions) { }

    save(): Promise<void> {
        if (this.transaction) {
            return this.transaction;
        }

        this.transaction = this.saveUnlocked().finally(() => {
            this.transaction = null;
        });
        return this.transaction;
    }

    private async saveUnlocked(): Promise<void> {
        const workspace = this.options.getCurrentWorkspace();
        if (!workspace || workspace.kind !== 'untitledMultiRoot') {
            return;
        }

        await this.options.executeSaveWorkspaceAs();

        const savedWorkspace = this.options.getCurrentWorkspace();
        if (savedWorkspace?.kind === 'savedMultiRoot'
            && savedWorkspace.scopeIdentity === workspace.scopeIdentity) {
            this.options.onSaved();
        }
    }
}
