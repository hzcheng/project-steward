'use strict';

import { RelevantExtensions } from '../constants';
import { ReopenStewardReason, StewardInfos } from '../models';
import { shouldOpenStewardOnStartup } from './startup';

type RelevantExtensionInstalls = StewardInfos['relevantExtensionsInstalls'];

export interface DashboardStartupControllerOptions {
    stewardInfos: StewardInfos;
    relevantExtensions?: Record<keyof RelevantExtensionInstalls, string>;
    isExtensionInstalled: (extensionId: string) => boolean;
    migrateDataIfNeeded: () => Promise<boolean>;
    publishOpenProjects: () => void;
    showInformationMessage: (message: string) => unknown;
    showSteward: () => unknown;
    applyProjectColorToCurrentWindow: () => void;
    getReopenReason: () => unknown;
    updateReopenReason: (reason: ReopenStewardReason) => unknown;
    reopenNoneValue?: ReopenStewardReason;
    getWorkspaceName: () => string | undefined;
    getVisibleEditorLanguageIds: () => readonly string[];
}

export class DashboardStartupController {
    constructor(private readonly options: DashboardStartupControllerOptions) {
    }

    async checkDataMigration(openStewardAfterMigrate = false): Promise<void> {
        const migrated = await this.options.migrateDataIfNeeded();
        if (!migrated) {
            return;
        }

        this.options.publishOpenProjects();
        this.options.showInformationMessage('Migrated Project Steward projects after changing settings.');

        if (openStewardAfterMigrate) {
            this.options.showSteward();
        }
    }

    async startUp(): Promise<void> {
        this.updateRelevantExtensionInstalls();
        await this.checkDataMigration();
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
