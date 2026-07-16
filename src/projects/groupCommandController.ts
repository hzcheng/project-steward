'use strict';

import type { Group } from '../models';

export interface GroupCommandProjectService {
    addGroup(groupName: string): Thenable<unknown>;
    getGroup(groupId: string): Group | null;
    updateGroup(groupId: string, group: Group): Thenable<unknown>;
    removeGroup(groupId: string, removeProjects?: boolean): Thenable<unknown>;
}

export interface GroupCommandControllerOptions {
    projectService: GroupCommandProjectService;
    promptGroupName: (defaultText?: string) => Promise<string>;
    promptGroupToRemove: () => Promise<[string, boolean]>;
    confirmRemoveGroup: (groupName: string) => Thenable<string | undefined>;
    showErrorMessage: (message: string) => unknown;
    refreshAfterMutation: () => void;
    userCanceledToken: string;
}

export class GroupCommandController {
    constructor(private readonly options: GroupCommandControllerOptions) {
    }

    async addGroup(): Promise<void> {
        let groupName: string;

        try {
            groupName = await this.options.promptGroupName();
        } catch (error) {
            this.handleError('An error occured while adding the group.', error);
            return;
        }

        await this.options.projectService.addGroup(groupName);
        this.options.refreshAfterMutation();
    }

    async editGroup(groupId: string): Promise<void> {
        var group = this.options.projectService.getGroup(groupId);
        if (group === null) {
            return;
        }

        let groupName: string;
        try {
            groupName = await this.options.promptGroupName(group.groupName);
        } catch (error) {
            this.handleError('An error occured while editing the group.', error);
            return;
        }

        group.groupName = groupName;
        await this.options.projectService.updateGroup(groupId, group);
        this.options.refreshAfterMutation();
    }

    async removeGroup(groupId: string): Promise<void> {
        var group = this.options.projectService.getGroup(groupId);
        if (group === null) {
            return;
        }

        let accepted = await this.options.confirmRemoveGroup(group.groupName);
        if (!accepted) {
            return;
        }

        await this.options.projectService.removeGroup(groupId);
        this.options.refreshAfterMutation();
    }

    async removeGroupPerCommand(): Promise<void> {
        const [groupId] = await this.options.promptGroupToRemove();
        await this.removeGroup(groupId);
    }

    private handleError(message: string, error: unknown): void {
        if ((error as Error).message !== this.options.userCanceledToken) {
            this.options.showErrorMessage(message);
            throw error;
        }
    }
}
