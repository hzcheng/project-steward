'use strict';

import * as vscode from 'vscode';

import { uriToProjectPath } from './openProjectMatcher';
import {
    getWorkspaceUri as resolveWorkspaceUri,
    getWorkspaceUris as resolveWorkspaceUris,
} from './openProjectService';

export function getWorkspacePath(
    workspaceFile?: vscode.Uri | null,
    workspaceFolders?: readonly vscode.WorkspaceFolder[] | readonly { uri: vscode.Uri }[] | null
): string {
    let workspaceUri = getWorkspaceUri(workspaceFile, workspaceFolders);

    if (workspaceUri !== null) {
        return uriToProjectPath(workspaceUri);
    } else {
        return null;
    }
}

export function getWorkspaceUri(
    workspaceFile?: vscode.Uri | null,
    workspaceFolders?: readonly vscode.WorkspaceFolder[] | readonly { uri: vscode.Uri }[] | null
): vscode.Uri {
    return resolveWorkspaceUri(workspaceFile, workspaceFolders as readonly vscode.WorkspaceFolder[]);
}

export function getWorkspaceUris(
    workspaceFile?: vscode.Uri | null,
    workspaceFolders?: readonly vscode.WorkspaceFolder[] | readonly { uri: vscode.Uri }[] | null
): vscode.Uri[] {
    return resolveWorkspaceUris(workspaceFile, workspaceFolders as readonly vscode.WorkspaceFolder[]);
}
