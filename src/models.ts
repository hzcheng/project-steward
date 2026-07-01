'use strict';

import * as vscode from 'vscode';
import { StorageOption, VSCODE_REMOTE_PREFIX, WSL_DEFAULT_REGEX } from "./constants";

export class Group {
    id: string;
    groupName: string;
    collapsed: boolean;
    projects: Project[];

    constructor(groupName: string, projects: Project[] = null) {
        this.id = generateRandomId(groupName);
        this.groupName = groupName;
        this.projects = projects || [];
    }

    static getRandomId(prepend: string = null) {
        return generateRandomId(prepend);
    }
}

export class Project {
    id: string;
    name: string;
    description: string;
    path: string;
    remoteType?: ProjectRemoteType;
    color: string;
    isGitRepo = false;

    constructor(name: string, path: string, description: string = null) {
        this.id = generateRandomId(name);
        this.name = name;
        this.description = description;
        this.path = path;
    }

    getRemoteType(): ProjectRemoteType {
        if (this.remoteType !== null && this.remoteType !== undefined) {
            return this.remoteType;
        }

        let remoteAuthority = getRemoteAuthority(this.path);

        if (remoteAuthority && remoteAuthority.startsWith('ssh-remote+')) {
            return ProjectRemoteType.SSH;
        } else if (this.path && (this.path.match(WSL_DEFAULT_REGEX) || (remoteAuthority && remoteAuthority.startsWith('wsl+')))) {
            return ProjectRemoteType.WSL;
        } else if (remoteAuthority && (remoteAuthority.startsWith('dev-container+') || remoteAuthority.startsWith('attached-container+'))) {
            return ProjectRemoteType.DevContainer;
        } else if (remoteAuthority || (this.path && this.path.startsWith(VSCODE_REMOTE_PREFIX))) {
            return ProjectRemoteType.Remote;
        }

        return ProjectRemoteType.None;
    }

    static getRandomId(prepend: string = null) {
        return generateRandomId(prepend);
    }
}

export function sanitizeProjectName(name: string) {
    if (!name) {
        return "";
    }

    return name.replace(/<[^>]+>/g, '').trim();
}

export function getRemoteType(project: Project): ProjectRemoteType {
    return Project.prototype.getRemoteType.call(project);
}

function getRemoteAuthority(projectPath: string): string {
    projectPath = normalizeProjectPath(projectPath);

    if (!projectPath || !projectPath.startsWith(VSCODE_REMOTE_PREFIX)) {
        return null;
    }

    try {
        let withoutScheme = projectPath.substring(VSCODE_REMOTE_PREFIX.length);
        let pathStart = withoutScheme.indexOf('/');
        let authority = pathStart === -1 ? withoutScheme : withoutScheme.substring(0, pathStart);
        return decodeURIComponent(authority);
    } catch (e) {
        return null;
    }
}

function normalizeProjectPath(projectPath: string): string {
    if (!projectPath) {
        return projectPath;
    }

    try {
        let decoded = decodeURIComponent(projectPath);
        return decoded || projectPath;
    } catch (e) {
        return projectPath;
    }
}

export function getRemoteTypeFromRemoteName(remoteName: string): ProjectRemoteType {
    if (!remoteName) {
        return ProjectRemoteType.None;
    }

    if (remoteName === 'ssh-remote') {
        return ProjectRemoteType.SSH;
    } else if (remoteName === 'wsl') {
        return ProjectRemoteType.WSL;
    } else if (remoteName === 'dev-container' || remoteName === 'attached-container') {
        return ProjectRemoteType.DevContainer;
    }

    return ProjectRemoteType.Remote;
}

function generateRandomId(prepend: string = null) {
    if (prepend) {
        prepend = prepend.replace(/\W/ig, "").toLowerCase().substring(0, 24);
    } else {
        prepend = '';
    }

    return prepend + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

export interface GroupOrder {
    groupId: string;
    projectIds: string[];
}

export interface DashboardInfos {
    relevantExtensionsInstalls: { remoteSSH: boolean; remoteContainers: boolean };
    config: vscode.WorkspaceConfiguration;
    otherStorageHasData: boolean;
}

export enum ProjectPathType {
    Folder,
    WorkspaceFile,
    File,
}

export enum ProjectOpenType {
    Default = 0,
    NewWindow = 1,
    AddToWorkspace = 2,
}

export enum ProjectRemoteType {
    None,
    SSH,
    WSL,
    DevContainer,
    Remote,
}

export enum ReopenDashboardReason {
    None = 0,
    EditorReopenedAsWorkspace,
}
