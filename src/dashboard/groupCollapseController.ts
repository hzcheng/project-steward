'use strict';

import {
    FAVORITES_GROUP_COLLAPSED_KEY,
    FAVORITES_GROUP_ID,
    OPEN_WORKSPACES_GROUP_COLLAPSED_KEY,
    OPEN_WORKSPACES_GROUP_ID,
} from '../constants';
import type { Group } from '../models';

export interface GroupCollapseState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

export interface GroupCollapseProjectService {
    getGroup(groupId: string): Group | null;
    updateGroup(groupId: string, group: Group): Thenable<unknown>;
}

export interface GroupCollapseControllerOptions {
    state: GroupCollapseState;
    projectService: GroupCollapseProjectService;
}

export class GroupCollapseController {
    constructor(private readonly options: GroupCollapseControllerOptions) {
    }

    getFavoritesCollapsed(): boolean | undefined {
        return this.options.state.get<boolean>(FAVORITES_GROUP_COLLAPSED_KEY);
    }

    getOpenWorkspacesCollapsed(): boolean | undefined {
        return this.options.state.get<boolean>(OPEN_WORKSPACES_GROUP_COLLAPSED_KEY);
    }

    async collapseGroup(groupId: string, collapsed?: boolean): Promise<void> {
        if (groupId === FAVORITES_GROUP_ID) {
            await this.options.state.update(FAVORITES_GROUP_COLLAPSED_KEY, Boolean(collapsed));
            return;
        }

        if (groupId === OPEN_WORKSPACES_GROUP_ID) {
            await this.options.state.update(OPEN_WORKSPACES_GROUP_COLLAPSED_KEY, Boolean(collapsed));
            return;
        }

        let group = this.options.projectService.getGroup(groupId);
        if (group === null) {
            return;
        }

        group.collapsed = collapsed !== undefined ? collapsed : !group.collapsed;
        await this.options.projectService.updateGroup(groupId, group);
    }
}
