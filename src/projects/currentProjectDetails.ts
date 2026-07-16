'use strict';

import type * as vscode from 'vscode';

import { ProjectRemoteType } from '../models';
import { getWorkspaceUri } from './workspaceHelpers';

export interface CurrentProjectDetailsResolverOptions {
    getWorkspaceFile: () => vscode.Uri | null | undefined;
    getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | readonly { uri: vscode.Uri }[] | null | undefined;
    getRemoteName: () => string | undefined;
    getProjectDetailsForSave: (workspaceUri: vscode.Uri, remoteName: string | undefined) => Promise<{ path: string; remoteType: ProjectRemoteType }>;
}

export class CurrentProjectDetailsResolver {
    constructor(private readonly options: CurrentProjectDetailsResolverOptions) {
    }

    async getCurrentProjectDetailsForSave(): Promise<{ path: string; remoteType: ProjectRemoteType } | null> {
        let workspaceUri = getWorkspaceUri(
            this.options.getWorkspaceFile(),
            this.options.getWorkspaceFolders()
        );
        if (workspaceUri === null) {
            return null;
        }

        return this.getProjectDetailsForSave(workspaceUri);
    }

    async getProjectDetailsForSave(workspaceUri: vscode.Uri): Promise<{ path: string; remoteType: ProjectRemoteType }> {
        return this.options.getProjectDetailsForSave(workspaceUri, this.options.getRemoteName());
    }
}
