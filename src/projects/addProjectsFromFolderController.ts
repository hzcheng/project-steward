'use strict';

import * as path from 'path';
import type * as vscode from 'vscode';

import { USER_CANCELED } from '../constants';
import { Project } from '../models';

export interface AddProjectsFromFolderControllerOptions {
    getCurrentWorkspacePath: () => string | null;
    parsePathAsUri: (projectPath: string) => vscode.Uri;
    showOpenDialog: (options: vscode.OpenDialogOptions) => Thenable<vscode.Uri[] | undefined>;
    getFolders: (folderPath: string) => Promise<string[]>;
    addGroup: (groupName: string) => Promise<{ id: string }>;
    addProject: (project: Project, groupId: string) => Promise<unknown>;
    getRandomColor: () => string;
    isFolderGitRepo: (folderPath: string) => boolean;
    showErrorMessage: (message: string) => unknown;
    refreshAfterMutation: () => void;
    userCanceledToken?: string;
}

export class AddProjectsFromFolderController {
    constructor(private readonly options: AddProjectsFromFolderControllerOptions) {
    }

    async addProjectsFromFolder(): Promise<void> {
        try {
            let currentlyOpenPath = this.options.getCurrentWorkspacePath();
            let folderPath = await this.options.showOpenDialog({
                defaultUri: currentlyOpenPath ? this.options.parsePathAsUri(currentlyOpenPath) : undefined,
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Folder containing Projects',
            });

            if (!folderPath || folderPath.length === 0) {
                return;
            }

            let foldersInPath = await this.options.getFolders(folderPath[0].fsPath);
            let folderName = path.basename(folderPath[0].fsPath);

            let group = await this.options.addGroup(folderName);
            for (const folder of foldersInPath) {
                let name = path.basename(folder);
                let project = new Project(name, folder);
                project.color = this.options.getRandomColor();
                project.isGitRepo = this.options.isFolderGitRepo(folder);
                await this.options.addProject(project, group.id);
            }
        } catch (error) {
            if ((error as Error).message !== (this.options.userCanceledToken || USER_CANCELED)) {
                this.options.showErrorMessage('An error occured while adding the projects.');
                throw error;
            }

            return;
        }

        this.options.refreshAfterMutation();
    }
}
