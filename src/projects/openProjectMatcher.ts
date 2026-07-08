'use strict';

import * as vscode from 'vscode';

import { getRemoteType, getRemoteTypeFromRemoteName, Project, ProjectRemoteType } from '../models';
import { normalizePosixPath, normalizeRemoteAuthority } from './projectPathUtils';

export function findSavedProjectForOpenProject(savedProjects: Project[], uri: vscode.Uri, currentRemoteName: string): Project {
    let exactMatch = savedProjects.find(project => projectMatchesOpenProject(project, uri));
    if (exactMatch) {
        return exactMatch;
    }

    let remotePathMatches = savedProjects.filter(project => projectPathMatchesRemoteOpenProject(project, uri, currentRemoteName));
    return remotePathMatches.length === 1 ? remotePathMatches[0] : null;
}

export function projectMatchesOpenProject(project: Project, uri: vscode.Uri): boolean {
    if (!project || !project.path || !uri) {
        return false;
    }

    return projectPathMatchesWorkspaceUri(project.path, uri);
}

export function projectPathMatchesWorkspaceUri(projectPath: string, workspaceUri: vscode.Uri): boolean {
    if (!workspaceUri || !projectPath) {
        return false;
    }

    let currentWorkspacePath = uriToProjectPath(workspaceUri);
    if (normalizeComparableProjectPath(projectPath) === normalizeComparableProjectPath(currentWorkspacePath)) {
        return true;
    }

    if (!isUriString(projectPath) || workspaceUri.scheme !== "vscode-remote") {
        return false;
    }

    try {
        let projectUri = vscode.Uri.parse(projectPath);
        if (projectUri.scheme !== "vscode-remote") {
            return false;
        }

        if (normalizeRemoteAuthority(projectUri.authority) !== normalizeRemoteAuthority(workspaceUri.authority)) {
            return false;
        }

        let projectUriPath = projectUri.path || projectUri.fsPath;
        let workspacePath = workspaceUri.path || workspaceUri.fsPath;

        return normalizePosixPath(projectUriPath) === normalizePosixPath(workspacePath);
    } catch (e) {
        return false;
    }
}

export function normalizeComparableProjectPath(projectPath: string): string {
    if (!projectPath) {
        return "";
    }

    try {
        if (isUriString(projectPath)) {
            let uri = vscode.Uri.parse(projectPath);
            if (uri.scheme === "file") {
                projectPath = uri.fsPath;
            } else {
                projectPath = `${uri.scheme}://${normalizeRemoteAuthority(uri.authority)}${uri.path}`;
            }
        }
    } catch (e) {
        // Keep the original path and normalize it below.
    }

    return projectPath.replace(/\\/g, '/').replace(/\/+$/g, '');
}

export function projectPathMatchesRemoteOpenProject(project: Project, uri: vscode.Uri, currentRemoteName: string): boolean {
    if (!currentRemoteName || !projectRemoteTypeMatchesCurrentRemote(project, currentRemoteName)) {
        return false;
    }

    if (uri.scheme === "vscode-remote" || uri.authority) {
        return false;
    }

    let projectPath = getProjectPathPart(project.path);
    let openPath = uri.path || uri.fsPath;
    if (!projectPath || !openPath) {
        return false;
    }

    return normalizePosixPath(projectPath) === normalizePosixPath(openPath);
}

export function projectRemoteTypeMatchesCurrentRemote(project: Project, currentRemoteName: string): boolean {
    let currentRemoteType = getRemoteTypeFromRemoteName(currentRemoteName);
    if (currentRemoteType === ProjectRemoteType.None) {
        return false;
    }

    return getRemoteType(project) === currentRemoteType;
}

export function getProjectPathPart(projectPath: string): string {
    if (!projectPath) {
        return projectPath;
    }

    if (!isUriString(projectPath)) {
        return projectPath;
    }

    try {
        let uri = vscode.Uri.parse(projectPath);
        return uri.path || uri.fsPath || projectPath;
    } catch (e) {
        return projectPath;
    }
}

export function uriToProjectPath(uri: vscode.Uri): string {
    return uri.scheme === "file" ? uri.fsPath.trim() : uri.toString().trim();
}

function isUriString(projectPath: string): boolean {
    return projectPath && projectPath.includes("://");
}
