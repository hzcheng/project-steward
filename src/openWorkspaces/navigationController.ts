'use strict';

import type { OpenWorkspaceRecord } from './protocol';

export interface WorkspaceNavigationControllerOptions<TUri = unknown> {
    getRecord: (cardId: string) => OpenWorkspaceRecord | null;
    executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown> | Promise<unknown>;
    parseUri: (value: string) => TUri;
    showInformationMessage: (message: string) => unknown;
    showWarningMessage: (message: string) => unknown;
    refresh: (reason: string) => void;
}

export class WorkspaceNavigationController<TUri = unknown> {
    constructor(private readonly options: WorkspaceNavigationControllerOptions<TUri>) {
    }

    async open(cardId: string): Promise<void> {
        const record = this.options.getRecord(cardId);
        if (!record) {
            this.options.refresh('open-workspace-navigation-stale');
            return;
        }

        if (record.kind === 'untitledMultiRoot') {
            this.options.showInformationMessage('Save this workspace before switching to it');
            return;
        }

        try {
            await this.options.executeCommand(
                'vscode.openFolder',
                this.options.parseUri(record.navigationUri),
                { forceNewWindow: true },
            );
        } catch (_error) {
            this.options.showWarningMessage(
                'Unable to switch directly to this workspace. Use VS Code Switch Window instead.',
            );
        }
    }
}
