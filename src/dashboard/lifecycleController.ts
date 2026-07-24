'use strict';

const NON_TODO_DASHBOARD_CONFIGURATION_SECTIONS = [
    'projectSteward.projectData',
    'projectSteward.projectSyncData',
    'projectSteward.searchIsActiveByDefault',
    'projectSteward.customCss',
    'projectSteward.recentColors',
    'projectSteward.storeProjectsInSettings',
    'projectSteward.maxVisibleAiSessions',
    'projectSteward.aiSessionTerminalMode',
    'projectSteward.aiSessionTmuxLayout',
    'projectSteward.aiSessionTmuxPath',
    'projectSteward.aiSessionRunningCardAnimation',
    'projectSteward.maxVisibleTodosPerGroup',
    'projectSteward.maxVisibleProjectsPerGroup',
    'projectSteward.aiSessionAttention.enabled',
    'projectSteward.displayProjectPath',
    'projectSteward.prependVscodeUrlToWslRemotes',
    'projectSteward.projectTileWidth',
    'projectSteward.recentColorsToRemember',
    'projectSteward.openOnStartup',
    'projectSteward.showAddGroupButtonTile',
    'projectSteward.customProjectCardBackground',
    'projectSteward.customProjectNameColor',
    'projectSteward.customProjectPathColor',
    'projectSteward.applyProjectColorToWindow',
];

export interface ConfigurationChangeEventLike {
    affectsConfiguration(section: string): boolean;
}

export interface WindowStateLike {
    focused: boolean;
}

export interface DashboardLifecycleControllerOptions {
    checkDataMigration: (openStewardAfterMigrate: boolean) => Promise<void>;
    reconcileProjectCatalog?: () => Promise<void>;
    consumeTodoDataWriteEcho?: () => boolean;
    applyProjectColorToCurrentWindow: () => void;
    refresh: (reason: string) => void;
    publishOpenWorkspace: (followsFocusEvent?: boolean) => void;
    evaluateAiSessionAttention: () => unknown;
}

export class DashboardLifecycleController {
    constructor(private readonly options: DashboardLifecycleControllerOptions) {
    }

    async handleConfigurationChanged(event: ConfigurationChangeEventLike): Promise<void> {
        const localTodoDataWriteEcho = event.affectsConfiguration('projectSteward.todoData')
            && this.options.consumeTodoDataWriteEcho?.() === true;
        const nonTodoDashboardConfigurationChanged = event.affectsConfiguration('dashboard')
            || NON_TODO_DASHBOARD_CONFIGURATION_SECTIONS.some(
                section => event.affectsConfiguration(section)
            );

        if (event.affectsConfiguration('projectSteward.storeProjectsInSettings')
            || event.affectsConfiguration('dashboard.storeProjectsInSettings')) {
            await this.options.checkDataMigration(false);
        }

        if (event.affectsConfiguration('projectSteward.projectSyncData')
            || event.affectsConfiguration('projectSteward.projectData')) {
            await this.options.reconcileProjectCatalog?.();
        }

        if (event.affectsConfiguration('projectSteward')
            || event.affectsConfiguration('dashboard')) {
            if (localTodoDataWriteEcho && !nonTodoDashboardConfigurationChanged) {
                return;
            }
            this.options.applyProjectColorToCurrentWindow();
            this.options.refresh('configuration-changed');
            this.options.publishOpenWorkspace();
        }
    }

    handleWorkspaceFoldersChanged(): void {
        this.options.applyProjectColorToCurrentWindow();
        this.options.refresh('workspace-folders-changed');
        this.options.publishOpenWorkspace();
    }

    handleWindowStateChanged(windowState: WindowStateLike): void {
        if (windowState.focused) {
            this.options.publishOpenWorkspace(true);
        }
        this.options.evaluateAiSessionAttention();
    }
}
