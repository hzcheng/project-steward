'use strict';

const NON_TODO_DASHBOARD_CONFIGURATION_SECTIONS = [
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
    consumeProjectCatalogWriteEcho?: (
        change: { syncData: boolean; legacyGroups: boolean }
    ) => boolean;
    applyProjectColorToCurrentWindow: () => void;
    refresh: (reason: string) => void;
    refreshProjects?: (reason: string) => void;
    publishOpenWorkspace: (followsFocusEvent?: boolean) => void;
    evaluateAiSessionAttention: () => unknown;
}

export class DashboardLifecycleController {
    constructor(private readonly options: DashboardLifecycleControllerOptions) {
    }

    async handleConfigurationChanged(event: ConfigurationChangeEventLike): Promise<void> {
        const todoDataChanged = event.affectsConfiguration('projectSteward.todoData');
        const localTodoDataWriteEcho = todoDataChanged
            && this.options.consumeTodoDataWriteEcho?.() === true;
        const projectCatalogChange = {
            syncData: event.affectsConfiguration('projectSteward.projectSyncData'),
            legacyGroups: event.affectsConfiguration('projectSteward.projectData'),
        };
        const projectCatalogChanged = projectCatalogChange.syncData
            || projectCatalogChange.legacyGroups;
        const localProjectCatalogWriteEcho = projectCatalogChanged
            && this.options.consumeProjectCatalogWriteEcho?.(projectCatalogChange) === true;
        const nonTodoDashboardConfigurationChanged = event.affectsConfiguration('dashboard')
            || NON_TODO_DASHBOARD_CONFIGURATION_SECTIONS.some(
                section => event.affectsConfiguration(section)
            );

        if (event.affectsConfiguration('projectSteward.storeProjectsInSettings')
            || event.affectsConfiguration('dashboard.storeProjectsInSettings')) {
            await this.options.checkDataMigration(false);
        }

        if (projectCatalogChanged && !localProjectCatalogWriteEcho) {
            await this.options.reconcileProjectCatalog?.();
        }

        if (event.affectsConfiguration('projectSteward')
            || event.affectsConfiguration('dashboard')) {
            if ((todoDataChanged || projectCatalogChanged)
                && !nonTodoDashboardConfigurationChanged
                && (!todoDataChanged || localTodoDataWriteEcho)
                && (!projectCatalogChanged || localProjectCatalogWriteEcho)) {
                return;
            }
            if (projectCatalogChanged
                && !localProjectCatalogWriteEcho
                && !nonTodoDashboardConfigurationChanged
                && (!todoDataChanged || localTodoDataWriteEcho)) {
                this.options.refreshProjects?.('configuration-changed');
                this.options.applyProjectColorToCurrentWindow();
                this.options.publishOpenWorkspace();
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
