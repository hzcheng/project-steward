'use strict';

import type { Project } from '../models';

export interface ProjectRemovalControllerOptions {
    getProject: (projectId: string) => Project | null;
    getProjectsFlat: () => Project[];
    showProjectPicker: (projectPicks: Array<{ id: string; label: string }>) => Thenable<{ id: string; label: string } | undefined>;
    confirmRemoveProject: (projectName: string) => Thenable<string | undefined>;
    removeProject: (projectId: string) => Thenable<unknown>;
    refreshAfterMutation: () => void;
    postCommandRemoval: () => void;
}

export class ProjectRemovalController {
    constructor(private readonly options: ProjectRemovalControllerOptions) {
    }

    async removeProjectPerCommand(): Promise<void> {
        const projects = this.options.getProjectsFlat();
        const projectPicks = projects.map(p => ({ id: p.id, label: p.name }));
        const selectedProjectPick = await this.options.showProjectPicker(projectPicks);

        if (selectedProjectPick === null || selectedProjectPick === undefined) {
            return;
        }

        await this.options.removeProject(selectedProjectPick.id);
        this.options.refreshAfterMutation();
        this.options.postCommandRemoval();
    }

    async removeProject(projectId: string): Promise<void> {
        const project = this.options.getProject(projectId);
        if (project === null) {
            return;
        }

        const accepted = await this.options.confirmRemoveProject(project.name);
        if (!accepted) {
            return;
        }

        await this.options.removeProject(projectId);
        this.options.refreshAfterMutation();
    }
}
