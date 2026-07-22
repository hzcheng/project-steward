'use strict';

import type * as vscode from 'vscode';

import { USER_CANCELED, WSL_DEFAULT_REGEX } from '../constants';
import { Group, Project, ProjectRemoteType } from '../models';
import { getLastPartOfPath, isUriString } from './openProjectService';
import type { ProjectPromptController } from './projectPromptController';

export interface ProjectDetailsForSave {
    path: string;
    remoteType: ProjectRemoteType;
}

export interface ProjectMutationControllerOptions {
    getCurrentWorkspacePath: () => string;
    getCurrentProjectDetailsForSave: () => Promise<ProjectDetailsForSave | null>;
    getProjectDetailsForSave: (uri: vscode.Uri) => Promise<ProjectDetailsForSave | null>;
    getProjectsFlat: () => Project[];
    getProjectAndGroup: (projectId: string) => [Project, Group];
    addProjectToGroup: (project: Project, groupId: string) => Promise<unknown>;
    updateProject: (projectId: string, project: Project) => Promise<unknown>;
    removeGroup: (groupId: string, skipConfirmation?: boolean) => Promise<unknown>;
    getRandomColor: () => string;
    isFolderGitRepo: (projectPath: string) => boolean;
    prompt: Pick<ProjectPromptController, 'queryProjectFields' | 'queryGroup' | 'queryProjectDescription' | 'queryProjectColor'>;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showWarningMessage: (message: string) => unknown;
    showInformationMessage: (message: string) => unknown;
    showErrorMessage: (message: string) => unknown;
    refreshAfterMutation: () => void;
}

export class ProjectMutationController {
    constructor(private readonly options: ProjectMutationControllerOptions) {
    }

    async addProject(groupId: string = null): Promise<void> {
        let project: Project;
        let selectedGroupId: string;
        let groupWasNewlyCreated = false;

        try {
            const currentlyOpenPath = this.options.getCurrentWorkspacePath();
            [project, selectedGroupId, groupWasNewlyCreated] = await this.options.prompt.queryProjectFields(groupId, false, { path: currentlyOpenPath });
            if (project === null) {
                await this.saveProject(selectedGroupId, groupWasNewlyCreated);
                return;
            }

            await this.options.addProjectToGroup(project, selectedGroupId);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                this.options.showErrorMessage('An error occured while adding the project.');
                throw error;
            }

            return;
        }

        this.options.refreshAfterMutation();
    }

    async saveWorkspaceProject(projectDetails: ProjectDetailsForSave | null): Promise<void> {
        if (!projectDetails || !projectDetails.path) {
            this.options.showWarningMessage('No project is currently open.');
            return;
        }
        await this.saveProject(null, false, projectDetails);
    }

    async saveProject(groupId: string = null, groupWasNewlyCreated: boolean = false, projectDetails: ProjectDetailsForSave = null): Promise<void> {
        let selectedGroupId: string;

        try {
            const currentProjectDetails = projectDetails || await this.options.getCurrentProjectDetailsForSave();
            if (!currentProjectDetails || !currentProjectDetails.path) {
                this.options.showWarningMessage('No project is currently open.');
                return;
            }

            const currentlyOpenPath = currentProjectDetails.path;
            const currentRemoteType = currentProjectDetails.remoteType;
            if (currentRemoteType !== ProjectRemoteType.None && !isUriString(currentlyOpenPath) && !currentlyOpenPath.match(WSL_DEFAULT_REGEX)) {
                this.options.showErrorMessage("Project Steward could not resolve the current remote project URI. Open this project once from VS Code's recent list, then run Save Project again.");
                return;
            }

            const duplicate = this.options.getProjectsFlat().find(p => p.path === currentlyOpenPath);
            if (duplicate !== null && duplicate !== undefined) {
                this.options.showInformationMessage(`Project "${duplicate.name}" is already saved.`);
                return;
            }

            if (groupId === null || groupId === undefined) {
                [selectedGroupId, groupWasNewlyCreated] = await this.options.prompt.queryGroup(null, true);
            } else {
                selectedGroupId = groupId;
            }

            const defaultProjectName = getLastPartOfPath(currentlyOpenPath).replace(/\.code-workspace$/g, '');
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

            const project = new Project(projectName, currentlyOpenPath);
            project.description = await this.options.prompt.queryProjectDescription();
            project.color = this.options.getRandomColor();
            project.isGitRepo = this.options.isFolderGitRepo(currentlyOpenPath);
            project.remoteType = currentRemoteType;

            await this.options.addProjectToGroup(project, selectedGroupId);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                this.options.showErrorMessage('An error occured while saving the project.');
                throw error;
            }

            if (groupWasNewlyCreated) {
                await this.options.removeGroup(selectedGroupId, true);
            }

            return;
        }

        this.options.refreshAfterMutation();
    }

    async editProject(projectId: string): Promise<void> {
        const [project, group] = this.options.getProjectAndGroup(projectId);
        if (project === null || project === undefined || group === null || group === undefined) {
            return;
        }

        let editedProject: Project;
        try {
            [editedProject] = await this.options.prompt.queryProjectFields(group.id, true, project);
            await this.options.updateProject(projectId, editedProject);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                this.options.showErrorMessage(`An error occured while updating project ${project.name}.`);
                throw error;
            }

            return;
        }

        this.options.refreshAfterMutation();
    }

    async editProjectColor(projectId: string): Promise<void> {
        const [project, group] = this.options.getProjectAndGroup(projectId);
        if (project === null || project === undefined || group === null || group === undefined) {
            return;
        }

        try {
            project.color = await this.options.prompt.queryProjectColor(true, project);
            await this.options.updateProject(projectId, project);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                this.options.showErrorMessage(`An error occured while updating project ${project.name}.`);
                throw error;
            }

            return;
        }

        this.options.refreshAfterMutation();
    }
}
