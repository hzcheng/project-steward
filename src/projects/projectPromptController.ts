'use strict';

import * as path from 'path';
import type * as vscode from 'vscode';

import { FixedColorOptions, PREDEFINED_COLORS, SAVE_CURRENT_PROJECT, SSH_REGEX, SSH_REMOTE_PREFIX, USE_PROJECT_COLOR, USER_CANCELED } from '../constants';
import { Group, Project, ProjectRemoteType } from '../models';
import { uriToProjectPath } from './openProjectMatcher';
import { getLastPartOfPath, isUriString, parsePathAsUri } from './openProjectService';

export interface ProjectPromptTemplate {
    name?: string;
    description?: string;
    path?: string;
    color?: string;
    remoteType?: ProjectRemoteType;
    favorite?: boolean;
}

interface QuickPickItemWithId<T> extends vscode.QuickPickItem {
    id: T;
}

export interface ProjectPromptControllerOptions {
    getGroups: () => Group[];
    addGroup: (name: string) => Promise<Group>;
    removeGroup: (groupId: string, skipConfirmation?: boolean) => Promise<unknown>;
    isFile: (projectPath: string) => boolean;
    isFolderGitRepo: (projectPath: string) => boolean;
    getRandomColor: () => string;
    getColorName: (colorCode: string) => string;
    getRecentColors: () => string[][];
    getRemoteSshExtensionInstalled: () => boolean;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showQuickPick: <T extends vscode.QuickPickItem>(items: T[], options?: vscode.QuickPickOptions) => Thenable<T | undefined>;
    showOpenDialog: (options: vscode.OpenDialogOptions) => Thenable<vscode.Uri[] | undefined>;
}

export class ProjectPromptController {
    constructor(private readonly options: ProjectPromptControllerOptions) {
    }

    async queryProjectFields(
        groupId: string = null,
        isEditing: boolean,
        projectTemplate: ProjectPromptTemplate = null
    ): Promise<[Project, string, boolean]> {
        let selectedGroupId: string;
        let projectPath: string;
        let defaultProjectName: string;
        let defaultProjectDescription: string;
        let groupWasNewlyCreated = false;

        try {
            if (projectTemplate) {
                projectPath = projectTemplate.path;
                defaultProjectName = projectTemplate.name;
                defaultProjectDescription = projectTemplate.description;
            }

            selectedGroupId = groupId;

            if (!isEditing) {
                if (selectedGroupId === null || selectedGroupId === undefined) {
                    [selectedGroupId, groupWasNewlyCreated] = await this.queryGroup(groupId, true);
                }
                projectPath = await this.queryProjectPath(projectPath);
                if (projectPath === SAVE_CURRENT_PROJECT) {
                    return [null, selectedGroupId, groupWasNewlyCreated];
                }
            }

            defaultProjectName = defaultProjectName || getLastPartOfPath(projectPath).replace(/\.code-workspace$/g, '');

            const projectName = await this.options.showInputBox({
                value: defaultProjectName || undefined,
                valueSelection: defaultProjectName ? [0, defaultProjectName.length] : undefined,
                placeHolder: 'Project Name',
                ignoreFocusOut: true,
                validateInput: (val: string) => val ? '' : 'A Project Name must be provided.',
            });

            if (!projectName) {
                if (groupWasNewlyCreated) {
                    await this.options.removeGroup(selectedGroupId, true);
                }
                throw new Error(USER_CANCELED);
            }

            const projectDescription = await this.queryProjectDescription(defaultProjectDescription);

            if (isEditing) {
                const updatePathPicks: Array<QuickPickItemWithId<boolean>> = [
                    {
                        id: false,
                        label: 'Keep Path',
                    },
                    {
                        id: true,
                        label: 'Edit Path',
                    },
                ];
                const updatePath = await this.options.showQuickPick(updatePathPicks, {
                    placeHolder: 'Edit Path?',
                });

                if (updatePath === null || updatePath === undefined) {
                    throw new Error(USER_CANCELED);
                }

                if (updatePath.id) {
                    projectPath = await this.queryProjectPath(projectPath);
                }
            }

            const color = isEditing ? projectTemplate.color : await this.queryProjectColor(isEditing, projectTemplate);
            const isGitRepo = this.options.isFolderGitRepo(projectPath);
            const project = new Project(projectName, projectPath, projectDescription);
            project.color = color;
            project.isGitRepo = isGitRepo;
            project.remoteType = projectTemplate?.remoteType;
            project.favorite = projectTemplate?.favorite;

            return [project, selectedGroupId, groupWasNewlyCreated];
        } catch (e) {
            if (groupWasNewlyCreated) {
                await this.options.removeGroup(selectedGroupId, true);
            }

            throw e;
        }
    }

    async queryProjectDescription(defaultText: string = null): Promise<string> {
        const projectDescription = await this.options.showInputBox({
            value: defaultText || undefined,
            valueSelection: defaultText ? [0, defaultText.length] : undefined,
            placeHolder: 'Project Description',
            prompt: 'Optional description shown on the project tile.',
            ignoreFocusOut: true,
        });

        if (projectDescription === null || projectDescription === undefined) {
            throw new Error(USER_CANCELED);
        }

        return projectDescription.trim();
    }

    async queryGroup(groupId: string = null, optionForAdding: boolean = false): Promise<[string, boolean]> {
        const groups = this.options.getGroups();

        if (optionForAdding && !groups.length) {
            groupId = 'Add';
        } else {
            let orderedGroups = groups;
            if (groupId !== null && groupId !== undefined) {
                const idx = groups.findIndex(g => g.id === groupId);
                if (idx !== null && idx !== undefined) {
                    orderedGroups = groups.slice();
                    const group = orderedGroups.splice(idx, 1);
                    orderedGroups.unshift(...group);
                }
            }

            let defaultGroupSet = false;
            const groupPicks = orderedGroups.map(group => {
                let label = group.groupName;
                if (!label) {
                    label = defaultGroupSet ? 'Unnamed Group' : 'Default Group';
                    defaultGroupSet = true;
                }

                return {
                    id: group.id,
                    label,
                };
            });

            if (optionForAdding) {
                groupPicks.push({
                    id: 'Add',
                    label: 'Add new Group',
                });
            }

            const selectedGroupPick = await this.options.showQuickPick(groupPicks, {
                placeHolder: 'Group',
            });

            if (selectedGroupPick === null || selectedGroupPick === undefined) {
                throw new Error(USER_CANCELED);
            }

            groupId = selectedGroupPick.id;
        }

        let newlyCreated = false;
        if (groupId === 'Add') {
            const newGroupName = await this.options.showInputBox({
                placeHolder: 'New Group Name',
                ignoreFocusOut: true,
                validateInput: (val: string) => val ? '' : 'A Group Name must be provided.',
            });

            if (newGroupName === null || newGroupName === undefined) {
                throw new Error(USER_CANCELED);
            }

            groupId = (await this.options.addGroup(newGroupName)).id;
            newlyCreated = true;
        }

        return [groupId, newlyCreated];
    }

    async queryProjectPath(defaultPath: string = null): Promise<string> {
        const projectTypePicks: Array<QuickPickItemWithId<string>> = [
            { id: 'save-current', label: 'Save Current Project' },
            { id: 'dir', label: 'Folder Project' },
            { id: 'file', label: 'Workspace or File Project' },
            { id: 'manual', label: 'Enter manually' },
            { id: 'ssh', label: `SSH Target ${!this.options.getRemoteSshExtensionInstalled() ? '(Remote Development extension is not installed)' : ''}` },
        ];

        const selectedProjectTypePick = await this.options.showQuickPick(projectTypePicks, {
            placeHolder: 'Project Type',
        });

        if (selectedProjectTypePick === null || selectedProjectTypePick === undefined) {
            throw new Error(USER_CANCELED);
        }

        switch (selectedProjectTypePick.id) {
            case 'save-current':
                return SAVE_CURRENT_PROJECT;
            case 'dir':
                return await this.getPathFromPicker(true, defaultPath);
            case 'file':
                return await this.getPathFromPicker(false, defaultPath);
            case 'manual':
                return await this.getManualPath(defaultPath);
            case 'ssh':
                return await this.getSSHPath(defaultPath);
            default:
                throw new Error(USER_CANCELED);
        }
    }

    async queryProjectColor(isEditing: boolean, projectTemplate: ProjectPromptTemplate = null): Promise<string> {
        isEditing = isEditing && projectTemplate !== null && projectTemplate !== undefined;

        let color: string = null;
        if (!USE_PROJECT_COLOR) {
            return null;
        }

        if (projectTemplate !== null && projectTemplate !== undefined) {
            color = projectTemplate.color;
        }

        const colorPicks: Array<QuickPickItemWithId<string>> = PREDEFINED_COLORS.map(c => ({
            id: c.label,
            label: c.label,
        }));
        colorPicks.unshift({ id: FixedColorOptions.random, label: 'Random Color' });
        colorPicks.unshift({ id: FixedColorOptions.custom, label: '> Custom Color' });
        colorPicks.unshift({ id: FixedColorOptions.recent, label: '> Recent Colors' });

        if (!isEditing || projectTemplate.color) {
            colorPicks.push({ id: FixedColorOptions.none, label: 'None' });
        } else if (isEditing && !projectTemplate.color) {
            colorPicks.unshift({
                id: FixedColorOptions.none,
                label: 'Current: None',
            });
        }

        if (isEditing && projectTemplate.color) {
            const predefinedColor = PREDEFINED_COLORS.find(c => c.value === projectTemplate.color);
            const existingEntryIdx = !predefinedColor ? -1 : colorPicks.findIndex(p => p.id === predefinedColor.label);

            if (existingEntryIdx !== -1) {
                colorPicks.splice(existingEntryIdx, 1);
            }

            colorPicks.unshift({
                id: projectTemplate.color,
                label: `Current: ${this.buildColorText(projectTemplate.color)}`,
            });
        }

        do {
            color = null;
            const selectedColorPick = await this.options.showQuickPick(colorPicks, {
                placeHolder: 'Project Color',
            });

            if (selectedColorPick === null || selectedColorPick === undefined) {
                throw new Error(USER_CANCELED);
            }

            switch (selectedColorPick.id) {
                case FixedColorOptions.custom:
                    const customColor = await this.options.showInputBox({
                        placeHolder: '#cc3344   crimson   rgb(68, 145, 203)   linear-gradient(to right, gold, darkorange)',
                        ignoreFocusOut: true,
                        prompt: 'Any color name, value or gradient.',
                    });

                    color = (customColor || '').replace(/[;"]/g, '').trim();
                    break;
                case FixedColorOptions.recent:
                    const recentColors = this.options.getRecentColors();
                    const recentColorPicks: Array<QuickPickItemWithId<string>> = recentColors.map(([code, name]) => ({
                        id: code,
                        label: this.buildColorText(code, name),
                    }));

                    recentColorPicks.unshift({
                        id: null,
                        label: '(Back)',
                    });

                    const selectedRecentColor = await this.options.showQuickPick(recentColorPicks, {
                        placeHolder: recentColorPicks.length ? 'Recent Color' : 'No colors have recently been used.',
                        ignoreFocusOut: true,
                    });

                    if (selectedRecentColor !== null && selectedRecentColor !== undefined) {
                        color = selectedRecentColor.id;
                    }
                    break;
                case FixedColorOptions.none:
                    return null;
                case FixedColorOptions.random:
                    color = this.options.getRandomColor();
                    break;
                default:
                    const predefinedColor = PREDEFINED_COLORS.find(c => c.label === selectedColorPick.id || c.value === selectedColorPick.id);
                    if (predefinedColor !== null && predefinedColor !== undefined) {
                        color = predefinedColor.value;
                    } else {
                        color = selectedColorPick.id;
                    }
            }
        } while (!color);

        return color;
    }

    private async getPathFromPicker(folderProject: boolean, defaultPath: string = null): Promise<string> {
        let defaultUri: vscode.Uri = undefined;
        if (defaultPath) {
            if (!isUriString(defaultPath)) {
                defaultPath = folderProject && this.options.isFile(defaultPath) ? path.dirname(defaultPath) : defaultPath;
            }

            defaultUri = parsePathAsUri(defaultPath);
        }

        const selectedProjectUris = await this.options.showOpenDialog({
            defaultUri,
            openLabel: `Select ${folderProject ? 'Folder' : 'File'} as Project`,
            canSelectFolders: folderProject,
            canSelectFiles: !folderProject,
            canSelectMany: false,
        });

        if (selectedProjectUris === null || selectedProjectUris === undefined || selectedProjectUris[0] === null || selectedProjectUris[0] === undefined) {
            throw new Error(USER_CANCELED);
        }

        return uriToProjectPath(selectedProjectUris[0]);
    }

    private async getManualPath(defaultPath: string = null): Promise<string> {
        const manualPath = await this.options.showInputBox({
            placeHolder: './',
            value: defaultPath || undefined,
            ignoreFocusOut: true,
            prompt: 'Enter absolute or relative path to the project.\nProjects with relative paths can only be opened if a workspace is already open.',
        });

        if (!manualPath) {
            throw new Error(USER_CANCELED);
        }

        return manualPath.trim();
    }

    private async getSSHPath(defaultPath: string = null): Promise<string> {
        if (defaultPath) {
            defaultPath = defaultPath.replace(SSH_REMOTE_PREFIX, '');
        }

        let remotePath = await this.options.showInputBox({
            placeHolder: 'user@target.xyz/home/optional-folder',
            value: SSH_REGEX.test(defaultPath) ? defaultPath : undefined,
            ignoreFocusOut: true,
            prompt: 'SSH remote, target folder is optional',
            validateInput: (val: string) => SSH_REGEX.test(val) ? '' : 'A valid SSH Target must be proviced',
        });

        if (!remotePath) {
            throw new Error(USER_CANCELED);
        }

        remotePath = `${SSH_REMOTE_PREFIX}${remotePath}`;
        return remotePath.trim();
    }

    private buildColorText(colorCode: string, colorName: string = null): string {
        if (colorCode === null || colorCode === undefined) {
            return '';
        }

        const predefColor = PREDEFINED_COLORS.find(c => c.value === colorCode);
        if (predefColor) {
            return predefColor.label;
        }

        colorName = colorName || this.options.getColorName(colorCode);
        return colorName ? `${colorName}    (${colorCode})` : colorCode;
    }
}
