'use strict';

import { RelevantExtensions } from '../constants';
import { ReopenStewardReason, StewardInfos } from '../models';
import { shouldOpenStewardOnStartup } from './startup';

type RelevantExtensionInstalls = StewardInfos['relevantExtensionsInstalls'];

export interface DashboardMigrationComponentResult {
    migrated: boolean;
    error?: unknown;
}

export interface DashboardMigrationResult {
    projects: DashboardMigrationComponentResult;
    todos: DashboardMigrationComponentResult;
}

export function settleMigration(
    run: () => Promise<boolean> | boolean
): Promise<DashboardMigrationComponentResult> {
    return Promise.resolve()
        .then(run)
        .then(
            migrated => ({ migrated }),
            error => ({ migrated: false, error })
        );
}

export interface DashboardStartupControllerOptions {
    stewardInfos: StewardInfos;
    relevantExtensions?: Record<keyof RelevantExtensionInstalls, string>;
    isExtensionInstalled: (extensionId: string) => boolean;
    migrateDataIfNeeded: () => Promise<DashboardMigrationResult>;
    refreshDashboard: () => unknown;
    publishOpenProjects: () => void;
    showInformationMessage: (message: string) => unknown;
    showErrorMessage: (message: string) => unknown;
    logError: (message: string, error: unknown) => unknown;
    showSteward: () => unknown;
    applyProjectColorToCurrentWindow: () => void;
    getReopenReason: () => unknown;
    updateReopenReason: (reason: ReopenStewardReason) => unknown;
    reopenNoneValue?: ReopenStewardReason;
    getWorkspaceName: () => string | undefined;
    getVisibleEditorLanguageIds: () => readonly string[];
    afterProjectMigrationSucceeded?: () => Promise<void>;
}

export class DashboardStartupController {
    constructor(private readonly options: DashboardStartupControllerOptions) {
    }

    async checkDataMigration(openStewardAfterMigrate = false): Promise<DashboardMigrationResult | null> {
        let migration: DashboardMigrationResult;
        try {
            migration = await this.options.migrateDataIfNeeded();
        } catch (error) {
            this.options.logError('Failed to migrate Project Steward data.', error);
            const detail = error instanceof Error ? ` ${error.message}` : '';
            this.options.showErrorMessage(`Could not migrate Project Steward data.${detail}`);
            return null;
        }

        this.reportComponentError('project', migration.projects);
        this.reportComponentError('TODO', migration.todos);
        if (!migration.projects.migrated && !migration.todos.migrated) {
            return migration;
        }

        await this.options.refreshDashboard();
        this.options.publishOpenProjects();
        this.options.showInformationMessage('Migrated Project Steward projects after changing settings.');

        if (openStewardAfterMigrate) {
            this.options.showSteward();
        }
        return migration;
    }

    private reportComponentError(
        component: 'project' | 'TODO',
        result: DashboardMigrationComponentResult
    ): void {
        if (!Object.prototype.hasOwnProperty.call(result, 'error')) {
            return;
        }
        this.options.logError(`Failed to migrate Project Steward ${component} data.`, result.error);
        const detail = result.error instanceof Error ? ` ${result.error.message}` : '';
        this.options.showErrorMessage(`Could not migrate Project Steward ${component} data.${detail}`);
    }

    async startUp(): Promise<void> {
        this.updateRelevantExtensionInstalls();
        const migration = await this.checkDataMigration();
        if (migration
            && !Object.prototype.hasOwnProperty.call(migration.projects, 'error')
            && this.options.afterProjectMigrationSucceeded) {
            await this.options.afterProjectMigrationSucceeded();
        }
        this.options.applyProjectColorToCurrentWindow();

        const reopenNoneValue = this.options.reopenNoneValue ?? ReopenStewardReason.None;
        const reopenStewardReason = this.options.getReopenReason();
        this.options.updateReopenReason(reopenNoneValue);
        if (shouldOpenStewardOnStartup({
            reopenReason: reopenStewardReason,
            reopenNoneValue,
            openOnStartup: this.options.stewardInfos.config.openOnStartup,
            workspaceName: this.options.getWorkspaceName(),
            visibleEditorLanguageIds: this.options.getVisibleEditorLanguageIds(),
        })) {
            this.options.showSteward();
        }
    }

    private updateRelevantExtensionInstalls(): void {
        const relevantExtensions = this.options.relevantExtensions || RelevantExtensions;
        for (const extensionName in this.options.stewardInfos.relevantExtensionsInstalls) {
            const key = extensionName as keyof RelevantExtensionInstalls;
            this.options.stewardInfos.relevantExtensionsInstalls[key] = this.options.isExtensionInstalled(relevantExtensions[key]);
        }
    }
}
