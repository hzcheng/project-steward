'use strict';

import type * as vscode from 'vscode';

import { Group } from '../models';

export interface ProjectManualEditControllerOptions {
    getGroups: () => Group[];
    getTempFilePath: () => string;
    writeTextFile: (filePath: string, content: string) => Promise<unknown>;
    fileUri: (filePath: string) => vscode.Uri;
    openTextDocument: (uri: vscode.Uri) => Thenable<vscode.TextDocument>;
    showTextDocument: (document: vscode.TextDocument) => Thenable<unknown>;
    onWillSaveTextDocument: (listener: (event: vscode.TextDocumentWillSaveEvent) => unknown) => vscode.Disposable;
    saveGroups: (groups: Group[], baselineGroups: Group[]) => Thenable<unknown>;
    executeCommand: (command: string) => Thenable<unknown>;
    showErrorMessage: (message: string) => unknown;
    postSave: () => void;
}

export class ProjectManualEditController {
    constructor(private readonly options: ProjectManualEditControllerOptions) {
    }

    async editProjectsManually(): Promise<void> {
        const projects = this.options.getGroups();
        const tempFilePath = this.options.getTempFilePath();
        try {
            await this.options.writeTextFile(tempFilePath, JSON.stringify(projects, null, 4));
        } catch (e) {
            const message = e && (e as Error).message ? `: ${(e as Error).message}` : '.';
            this.options.showErrorMessage(`Can not write temporary project file under ${tempFilePath}
            ${message}`);
            return;
        }

        const tempFileUri = this.options.fileUri(tempFilePath);
        const editProjectsDocument = await this.options.openTextDocument(tempFileUri);

        await this.options.showTextDocument(editProjectsDocument);

        const subscriptions: vscode.Disposable[] = [];
        const editSubscription = this.options.onWillSaveTextDocument(async e => {
            if (e.document !== editProjectsDocument) {
                return;
            }

            let updatedGroups: Group[];
            try {
                const text = e.document.getText() || '[]';
                updatedGroups = JSON.parse(text);
            } catch (ex) {
                this.options.showErrorMessage('Edited Projects File can not be parsed.');
                return;
            }

            const validation = this.validateAndCleanupGroups(updatedGroups);
            if (!validation.valid) {
                this.options.showErrorMessage('Edited Projects File does not meet the schema expected by Project Steward.');
                return;
            }

            updatedGroups = validation.groups;
            await this.options.saveGroups(updatedGroups, projects);

            subscriptions.forEach(s => s.dispose());

            try {
                await this.options.showTextDocument(e.document);
                await this.options.executeCommand('workbench.action.closeActiveEditor');
            } catch (e) {
                this.options.showErrorMessage('Could not close the edited Projects File. Please close manually.');
            }

            this.options.postSave();
        });
        subscriptions.push(editSubscription);
    }

    private validateAndCleanupGroups(updatedGroups: unknown): { valid: boolean; groups: Group[] } {
        if (!Array.isArray(updatedGroups)) {
            return { valid: false, groups: [] };
        }

        for (const group of updatedGroups) {
            if (group.name && !group.groupName) {
                group.groupName = group.name;
                delete group.name;
            }

            const groupNameMissing = group && (group.groupName === null || group.groupName === undefined);
            const groupProjectsMissingOrEmpty = group && (group.projects === null || group.projects === undefined || !group.projects.length);
            if (groupNameMissing && groupProjectsMissingOrEmpty) {
                group._delete = true;
            } else if (
                !group ||
                !group.id ||
                group.groupName === undefined ||
                !group.projects ||
                !Array.isArray(group.projects)
            ) {
                return { valid: false, groups: [] };
            } else {
                for (const project of group.projects) {
                    if (!project || !project.id || !project.name || !project.path) {
                        return { valid: false, groups: [] };
                    }

                    delete project.imageFileName;
                }
            }
        }

        return { valid: true, groups: updatedGroups.filter(g => !g._delete) };
    }
}
