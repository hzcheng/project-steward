'use strict';

import * as vscode from 'vscode';

import type { Project } from '../models';
import { getProjectPathPart, normalizeComparableProjectPath, uriToProjectPath } from '../projects/openProjectMatcher';
import { normalizeAiSessionComparablePath } from './sessionHelpers';

export interface AiSessionOpenProjectCandidate<TProject extends { id: string } = Project> {
    project: TProject;
    path: string;
}

export function getAiSessionOpenProjectCandidates<TProject extends Project>(
    openProjects: TProject[],
    workspaceFile?: vscode.Uri | null,
    workspaceFolders?: readonly { uri: vscode.Uri }[] | null,
): AiSessionOpenProjectCandidate<TProject>[] {
    let candidates: AiSessionOpenProjectCandidate<TProject>[] = [];
    let addCandidate = (project: TProject, projectPath: string) => {
        let normalizedPath = normalizeAiSessionProjectPath(getProjectPathPart(projectPath));
        if (!normalizedPath) {
            return;
        }

        if (candidates.some(candidate => candidate.project.id === project.id && candidate.path === normalizedPath)) {
            return;
        }

        candidates.push({ project, path: normalizedPath });
    };

    for (let project of openProjects) {
        addCandidate(project, project.path);
    }

    if (workspaceFile && workspaceFile.scheme !== 'untitled') {
        let workspaceProject = openProjects.find(project =>
            normalizeComparableProjectPath(project.path) === normalizeComparableProjectPath(uriToProjectPath(workspaceFile))
        ) || openProjects[0];
        for (let workspaceFolder of workspaceFolders || []) {
            addCandidate(workspaceProject, uriToProjectPath(workspaceFolder.uri));
        }
    }

    return candidates;
}

export function getAiSessionCandidatePaths<TProject extends Project>(
    openProjects: TProject[],
    workspaceFile?: vscode.Uri | null,
    workspaceFolders?: readonly { uri: vscode.Uri }[] | null,
): string[] {
    if (!openProjects.length) {
        return [];
    }

    return getAiSessionOpenProjectCandidates(openProjects, workspaceFile, workspaceFolders).map(candidate => candidate.path);
}

export function normalizeAiSessionProjectPath(projectPath: string): string {
    if (!projectPath) {
        return '';
    }

    return normalizeAiSessionComparablePath(projectPath);
}

export function getOpenProjectAiSessionKey(project: Project): string {
    return normalizeAiSessionProjectPath(getProjectPathPart(project.path)) || project.id;
}

export function getOpenProjectTerminalCwd(project: Project): string {
    return normalizeAiSessionProjectPath(getProjectPathPart(project.path)) || null;
}
