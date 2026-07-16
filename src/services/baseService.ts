import * as vscode from 'vscode';
import { LEGACY_DASHBOARD_CONFIG_SECTION, PROJECT_STEWARD_CONFIG_SECTION } from '../constants';
import { hasConfiguredValue } from '../dashboard/configuration';

export default abstract class BaseService {
    context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    get configurationSection(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(PROJECT_STEWARD_CONFIG_SECTION);
    }

    getConfig<T>(key: string, defaultValue?: T): T {
        let primaryConfig = vscode.workspace.getConfiguration(PROJECT_STEWARD_CONFIG_SECTION);
        let legacyConfig = vscode.workspace.getConfiguration(LEGACY_DASHBOARD_CONFIG_SECTION);

        if (hasConfiguredValue(primaryConfig, key)) {
            return primaryConfig.get<T>(key, defaultValue);
        }

        if (hasConfiguredValue(legacyConfig, key)) {
            return legacyConfig.get<T>(key, defaultValue);
        }

        return primaryConfig.get<T>(key, defaultValue);
    }

    useSettingsStorage(): boolean {
        return this.getConfig<boolean>('storeProjectsInSettings');
    }

}
