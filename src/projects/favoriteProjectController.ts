'use strict';

import type { Group } from '../models';
import { withFavoriteProjectOrder, withToggledProjectFavorite } from './favoriteProjectOrder';

export interface FavoriteProjectControllerOptions {
    getGroups: () => Group[];
    saveGroups: (groups: Group[]) => Thenable<unknown>;
    refreshAfterMutation: () => void;
}

export class FavoriteProjectController {
    constructor(private readonly options: FavoriteProjectControllerOptions) {
    }

    async toggleProjectFavorite(projectId: string): Promise<void> {
        var groups = this.options.getGroups();
        var updatedGroups = withToggledProjectFavorite(groups, projectId);
        if (updatedGroups === null) {
            return;
        }

        await this.options.saveGroups(updatedGroups);
        this.options.refreshAfterMutation();
    }

    async reorderFavoriteProjects(projectIds: string[]): Promise<void> {
        var groups = this.options.getGroups();
        var reorderedGroups = withFavoriteProjectOrder(groups, projectIds);
        await this.options.saveGroups(reorderedGroups);
        this.options.refreshAfterMutation();
    }
}
