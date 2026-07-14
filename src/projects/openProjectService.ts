'use strict';

import * as vscode from 'vscode';

import { OPEN_PROJECTS_GROUP_ID, REMOTE_REGEX } from '../constants';
import { getRemoteType, getRemoteTypeFromRemoteName, Project } from '../models';
import { findSavedProjectForOpenProject, uriToProjectPath } from './openProjectMatcher';

export interface OpenProjectBuildOptions {
    savedProjects: Project[];
    currentRemoteName: string;
    isFolderGitRepo: (projectPath: string) => boolean;
}

export function getOpenProjectsFromWorkspace(
    workspaceFile: vscode.Uri,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    options: OpenProjectBuildOptions
): Project[] {
    if (workspaceFile && workspaceFile.scheme !== "untitled") {
        return [buildOpenProject(workspaceFile, 0, "Current workspace", null, options)];
    }

    return (workspaceFolders || [])
        .map((folder, index) => buildOpenProject(folder.uri, index, "Workspace folder", folder.name, options));
}

export function getOpenProjectUri(
    projectId: string,
    workspaceFile: vscode.Uri,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
): vscode.Uri {
    let prefix = `${OPEN_PROJECTS_GROUP_ID}-`;
    if (!projectId || !projectId.startsWith(prefix)) {
        return null;
    }

    let index = Number(projectId.substring(prefix.length));
    if (!Number.isInteger(index) || index < 0) {
        return null;
    }

    if (workspaceFile && workspaceFile.scheme !== "untitled") {
        return index === 0 ? workspaceFile : null;
    }

    return (workspaceFolders || [])[index]?.uri || null;
}

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

function buildOpenProject(
    uri: vscode.Uri,
    index: number,
    description: string,
    name: string,
    options: OpenProjectBuildOptions
): Project {
    let projectPath = uriToProjectPath(uri);
    let savedProject = findSavedProjectForOpenProject(options.savedProjects, uri, options.currentRemoteName);
    let projectName = savedProject?.name || name || getLastPartOfPath(projectPath).replace(/\.code-workspace$/g, '') || "Workspace";
    let projectDescription = savedProject ? savedProject.description : description;
    let project = new Project(projectName, projectPath, projectDescription);
    project.attentionProjectPath = savedProject?.path || projectPath;
    project.id = `${OPEN_PROJECTS_GROUP_ID}-${index}`;
    project.color = savedProject?.color || "var(--vscode-focusBorder)";
    project.favorite = savedProject?.favorite;
    project.showSaveAction = savedProject === null || savedProject === undefined;
    project.isGitRepo = options.isFolderGitRepo(projectPath);
    project.remoteType = savedProject?.remoteType ?? (savedProject ? getRemoteType(savedProject) : getRemoteTypeFromRemoteName(options.currentRemoteName));

    return project;
}
