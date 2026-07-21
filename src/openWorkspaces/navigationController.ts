'use strict';

import { isDirectWorkspaceNavigationSupported } from './navigationCapabilities';
import type { OpenWorkspaceRecord } from './protocol';

export interface WorkspaceNavigationControllerOptions<TUri = unknown> {
    getRecord: (cardId: string) => OpenWorkspaceRecord | null;
    canNavigateDirectly?: (record: OpenWorkspaceRecord) => boolean;
    getAvailableCommands: () => Thenable<string[]> | Promise<string[]>;
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

        const canNavigateDirectly = this.options.canNavigateDirectly
            || (candidate => isDirectWorkspaceNavigationSupported(candidate.environment, candidate.kind));
        if (canNavigateDirectly(record)) {
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
            return;
        }

        if (record.kind === 'untitledMultiRoot') {
            this.options.showInformationMessage('Save this workspace before switching to it');
            return;
        }

        let availableCommands: string[];
        try {
            availableCommands = await this.options.getAvailableCommands();
        } catch (_error) {
            this.showNativeSwitchUnavailable();
            return;
        }
        if (!availableCommands.includes('workbench.action.switchWindow')) {
            this.showNativeSwitchUnavailable();
            return;
        }
        try {
            await this.options.executeCommand('workbench.action.switchWindow');
        } catch (_error) {
            this.showNativeSwitchUnavailable();
        }
    }

    private showNativeSwitchUnavailable(): void {
        this.options.showWarningMessage(
            'VS Code Switch Window is unavailable. Use File > Open Recent to switch to this workspace.',
        );
    }
}
