'use strict';

import type * as vscode from 'vscode';

import { Project } from '../models';
import { getOpenProjectsFromWorkspace, getOpenProjectUri as resolveOpenProjectUri } from '../projects/openProjectService';
import { createOpenProjectRecords } from './projection';
import type { OpenProjectRecord } from './protocol';

export interface OpenProjectWorkspaceControllerOptions {
    getWorkspaceFile: () => vscode.Uri | null | undefined;
    getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | readonly { uri: vscode.Uri; name?: string }[] | null | undefined;
    getSavedProjects: () => Project[];
    getCurrentRemoteName: () => string | undefined;
    isFolderGitRepo: (projectPath: string) => boolean;
    getActiveSessionCounts?: () => ReadonlyMap<string, number>;
    publishRecords: (records: OpenProjectRecord[], followsFocusEvent: boolean) => unknown;
}

export class OpenProjectWorkspaceController {
    constructor(private readonly options: OpenProjectWorkspaceControllerOptions) {
    }

    getRawOpenProjects(): Project[] {
        return getOpenProjectsFromWorkspace(
            this.options.getWorkspaceFile() as vscode.Uri,
            this.options.getWorkspaceFolders() as readonly vscode.WorkspaceFolder[],
            {
                savedProjects: this.options.getSavedProjects(),
                currentRemoteName: this.options.getCurrentRemoteName(),
                isFolderGitRepo: this.options.isFolderGitRepo,
            }
        );
    }

    getOpenProjectRecords(): OpenProjectRecord[] {
        return createOpenProjectRecords(
            this.getRawOpenProjects(),
            this.options.getActiveSessionCounts ? this.options.getActiveSessionCounts() : undefined
        );
    }

    publish(followsFocusEvent = false): void {
        void this.options.publishRecords(
            this.getOpenProjectRecords(),
            followsFocusEvent
        );
    }

    getOpenProjectUri(projectId: string): vscode.Uri | null {
        return resolveOpenProjectUri(
            projectId,
            this.options.getWorkspaceFile() as vscode.Uri,
            this.options.getWorkspaceFolders() as readonly vscode.WorkspaceFolder[]
        );
    }
}
