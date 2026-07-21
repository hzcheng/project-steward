'use strict';

import * as vscode from 'vscode';

import { REMOTE_REGEX } from '../constants';

export function getWorkspaceUri(workspaceFile: vscode.Uri, workspaceFolders: readonly vscode.WorkspaceFolder[]): vscode.Uri {
    let workspaceUris = getWorkspaceUris(workspaceFile, workspaceFolders);
    return workspaceUris.length ? workspaceUris[0] : null;
}

export function getWorkspaceUris(workspaceFile: vscode.Uri, workspaceFolders: readonly vscode.WorkspaceFolder[]): vscode.Uri[] {
    if (workspaceFile !== null && workspaceFile !== undefined && workspaceFile.scheme !== "untitled") {
        return [workspaceFile];
    }

    return (workspaceFolders || []).map(folder => folder.uri);
}

export function getLastPartOfPath(projectPath: string): string {
    if (!projectPath) {
        return "";
    }

    if (isUriString(projectPath)) {
        try {
            projectPath = vscode.Uri.parse(projectPath).path || projectPath;
        } catch (e) {
            // Keep the original path and fall back to the legacy parsing below.
        }
    }

    projectPath = projectPath.replace(REMOTE_REGEX, '');
    projectPath = projectPath.replace(/^\w+\@/, '');
    return projectPath.replace(/^[\\\/]|[\\\/]$/g, '').replace(/^.*[\\\/]/, '');
}

export function isUriString(projectPath: string): boolean {
    return projectPath && projectPath.includes("://");
}

export function parsePathAsUri(projectPath: string): vscode.Uri {
    return isUriString(projectPath) ? vscode.Uri.parse(projectPath) : vscode.Uri.file(projectPath);
}
