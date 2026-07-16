'use strict';

export interface ConfigurationChangeEventLike {
    affectsConfiguration(section: string): boolean;
}

export interface WindowStateLike {
    focused: boolean;
}

export interface DashboardLifecycleControllerOptions {
    checkDataMigration: (openStewardAfterMigrate: boolean) => Promise<void>;
    applyProjectColorToCurrentWindow: () => void;
    refresh: (reason: string) => void;
    publishOpenProjects: (followsFocusEvent?: boolean) => void;
    evaluateAiSessionAttention: () => unknown;
}

export class DashboardLifecycleController {
    constructor(private readonly options: DashboardLifecycleControllerOptions) {
    }

    async handleConfigurationChanged(event: ConfigurationChangeEventLike): Promise<void> {
        if (event.affectsConfiguration('projectSteward.storeProjectsInSettings')
            || event.affectsConfiguration('dashboard.storeProjectsInSettings')) {
            await this.options.checkDataMigration(false);
        }

        if (event.affectsConfiguration('projectSteward')
            || event.affectsConfiguration('dashboard')) {
            this.options.applyProjectColorToCurrentWindow();
            this.options.refresh('configuration-changed');
            this.options.publishOpenProjects();
        }
    }

    handleWorkspaceFoldersChanged(): void {
        this.options.applyProjectColorToCurrentWindow();
        this.options.refresh('workspace-folders-changed');
        this.options.publishOpenProjects();
    }

    handleWindowStateChanged(windowState: WindowStateLike): void {
        if (windowState.focused) {
            this.options.publishOpenProjects(true);
        }
        this.options.evaluateAiSessionAttention();
    }
}
