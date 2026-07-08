'use strict';

import * as vscode from 'vscode';

import { getRemoteType, getRemoteTypeFromRemoteName, Project, ProjectRemoteType } from '../models';
import { encodeRemoteAuthority, ensureLeadingSlash, getPathMatchScore, normalizeRemoteAuthority } from './projectPathUtils';
import { uriToProjectPath } from './openProjectMatcher';

export interface ProjectDetailsForSave {
    path: string;
    remoteType: ProjectRemoteType;
}

export default class RemoteProjectResolver {
    constructor(private readonly logError: (message: string, error: unknown) => void) { }

    async getProjectDetailsForSave(workspaceUri: vscode.Uri, currentRemoteName: string): Promise<ProjectDetailsForSave> {
        let remoteType = getRemoteTypeFromRemoteName(currentRemoteName);
        if (workspaceUri.scheme === "file") {
            let codespaceUri = await this.resolveCurrentCodespaceWorkspaceUri(workspaceUri, currentRemoteName);
            if (codespaceUri) {
                return { path: uriToProjectPath(codespaceUri), remoteType: this.getRemoteTypeFromRemoteUri(codespaceUri, remoteType) };
            }

            if (remoteType !== ProjectRemoteType.None) {
                let remoteUri = await this.resolveCurrentRemoteWorkspaceUri(workspaceUri, remoteType, currentRemoteName);
                if (remoteUri) {
                    return { path: uriToProjectPath(remoteUri), remoteType: this.getRemoteTypeFromRemoteUri(remoteUri, remoteType) };
                }
            }

            return { path: uriToProjectPath(workspaceUri), remoteType };
        }

        return { path: uriToProjectPath(workspaceUri), remoteType: this.getRemoteTypeFromRemoteUri(workspaceUri, remoteType) };
    }

    async resolveCurrentCodespaceWorkspaceUri(workspaceUri: vscode.Uri, currentRemoteName: string): Promise<vscode.Uri> {
        if (currentRemoteName !== "codespaces") {
            return null;
        }

        try {
            let info = await vscode.commands.executeCommand<{ name: string } | undefined>('github.codespaces.getCurrentCodespace');
            if (info && info.name) {
                return this.buildVscodeRemoteUri(`codespaces+${info.name}`, workspaceUri.fsPath || workspaceUri.path);
            }
        } catch (error) {
            this.logError('Failed to resolve current Codespace workspace URI.', error);
        }

        return null;
    }

    async resolveCurrentRemoteWorkspaceUri(workspaceUri: vscode.Uri, remoteType: ProjectRemoteType, currentRemoteName: string): Promise<vscode.Uri> {
        let currentPath = workspaceUri.path || workspaceUri.fsPath;
        if (!currentPath) {
            return null;
        }

        try {
            let recentlyOpened = await vscode.commands.executeCommand('_workbench.getRecentlyOpened') as any;
            let candidates = [
                ...this.getRecentRemoteCandidates((recentlyOpened && recentlyOpened.workspaces) || [], currentPath, remoteType, currentRemoteName, true),
                ...this.getRecentRemoteCandidates((recentlyOpened && recentlyOpened.files) || [], currentPath, remoteType, currentRemoteName, false),
            ].sort((a, b) => b.score - a.score);

            if (!candidates.length) {
                return null;
            }

            let selectedAuthority = normalizeRemoteAuthority(candidates[0].remoteAuthority);

            return this.buildVscodeRemoteUri(selectedAuthority, currentPath);
        } catch (error) {
            this.logError('Failed to resolve current remote workspace URI.', error);
        }

        return null;
    }

    getRemoteTypeFromRemoteUri(uri: vscode.Uri, fallbackRemoteType: ProjectRemoteType): ProjectRemoteType {
        if (!uri || uri.scheme !== "vscode-remote" || !uri.authority) {
            return fallbackRemoteType;
        }

        let project = new Project("", uri.toString());
        return getRemoteType(project);
    }

    private getRecentRemoteCandidates(
        recentEntries: any[],
        currentPath: string,
        remoteType: ProjectRemoteType,
        currentRemoteName: string,
        isWorkspaceEntry: boolean
    ): { remoteAuthority: string, score: number }[] {
        let candidates: { remoteAuthority: string, score: number }[] = [];

        for (let recent of recentEntries) {
            let remoteAuthority = recent && recent.remoteAuthority;
            if (!remoteAuthority || !this.remoteAuthorityMatchesType(remoteAuthority, remoteType, currentRemoteName)) {
                continue;
            }

            let recentUri = this.getRecentEntryUri(recent);
            if (!recentUri) {
                continue;
            }

            let score = getPathMatchScore(currentPath, recentUri.path || recentUri.fsPath, isWorkspaceEntry);
            if (score > 0) {
                candidates.push({ remoteAuthority, score });
            }
        }

        return candidates;
    }

    private remoteAuthorityMatchesType(remoteAuthority: string, remoteType: ProjectRemoteType, currentRemoteName: string): boolean {
        let normalizedAuthority = normalizeRemoteAuthority(remoteAuthority);

        switch (remoteType) {
            case ProjectRemoteType.SSH:
                return normalizedAuthority.startsWith('ssh-remote+');
            case ProjectRemoteType.WSL:
                return normalizedAuthority.startsWith('wsl+');
            case ProjectRemoteType.DevContainer:
                return normalizedAuthority.startsWith('dev-container+') || normalizedAuthority.startsWith('attached-container+');
            case ProjectRemoteType.Remote:
                if (currentRemoteName) {
                    return normalizedAuthority.startsWith(`${currentRemoteName}+`);
                }

                return true;
            case ProjectRemoteType.None:
            default:
                return false;
        }
    }

    private buildVscodeRemoteUri(remoteAuthority: string, resourcePath: string): vscode.Uri {
        return vscode.Uri.parse(`vscode-remote://${encodeRemoteAuthority(remoteAuthority)}${ensureLeadingSlash(resourcePath)}`);
    }

    private getRecentEntryUri(recent: any): vscode.Uri {
        return this.asUri(recent.folderUri)
            || this.asUri(recent.workspace && recent.workspace.configPath)
            || this.asUri(recent.fileUri);
    }

    private asUri(value: any): vscode.Uri {
        if (!value) {
            return null;
        }

        if (value instanceof vscode.Uri) {
            return value;
        }

        if (typeof value === 'string') {
            return vscode.Uri.parse(value);
        }

        if (value.scheme && typeof value.path === 'string') {
            if (typeof value.toString === 'function') {
                let uriString = value.toString();
                if (uriString && uriString !== '[object Object]') {
                    return vscode.Uri.parse(uriString);
                }
            }

            if (value.scheme === "vscode-remote" && value.authority) {
                return this.buildVscodeRemoteUri(value.authority, value.path);
            }

            if (value.scheme === "file") {
                return vscode.Uri.file(value.fsPath || value.path);
            }

            let authority = value.authority ? `//${value.authority}` : '';
            let query = value.query ? `?${value.query}` : '';
            let fragment = value.fragment ? `#${value.fragment}` : '';
            return vscode.Uri.parse(`${value.scheme}:${authority}${value.path}${query}${fragment}`);
        }

        return null;
    }
}
