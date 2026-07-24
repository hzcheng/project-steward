'use strict';

import { Group, GroupOrder, Project } from '../models';

export interface ProjectOrderControllerOptions {
    getGroups: () => Group[];
    saveGroups: (groups: Group[]) => Thenable<unknown>;
    showInformationMessage: (message: string) => unknown;
    refreshAfterMutation: (mode?: 'replace' | 'preserve-order') => void;
}

export class ProjectOrderController {
    constructor(private readonly options: ProjectOrderControllerOptions) {
    }

    async reorderGroups(groupOrders: GroupOrder[]): Promise<void> {
        var groups = this.options.getGroups();

        if (groupOrders === null || groupOrders === undefined) {
            this.options.showInformationMessage('Invalid Argument passed to Reordering Projects.');
            return;
        }

        var projectMap = new Map<string, Project>();
        for (let group of groups) {
            if (group.projects === null || group.projects === undefined) {
                continue;
            }

            for (let project of group.projects) {
                projectMap.set(project.id, project);
            }
        }

        var reorderedGroups: Group[] = [];
        for (let { groupId, projectIds } of groupOrders) {
            let group = groups.find(candidate => candidate.id === groupId);
            if (group === null || group === undefined) {
                group = new Group("Group #" + (reorderedGroups.length + 1));
            }

            group.projects = projectIds.map(projectId => projectMap.get(projectId)).filter(project => project !== null && project !== undefined);
            reorderedGroups.push(group);
        }

        await this.options.saveGroups(reorderedGroups);
        this.options.refreshAfterMutation('preserve-order');
    }
}
