'use strict';

import type * as vscode from 'vscode';
import { LEGACY_DASHBOARD_CONFIG_SECTION, PROJECT_STEWARD_CONFIG_SECTION } from '../constants';

interface WorkspaceProvider {
    getConfiguration(section?: string): vscode.WorkspaceConfiguration;
}

export function getStewardConfiguration(workspace: WorkspaceProvider = require('vscode').workspace): vscode.WorkspaceConfiguration {
    return createStewardConfiguration(
        workspace.getConfiguration(PROJECT_STEWARD_CONFIG_SECTION),
        workspace.getConfiguration(LEGACY_DASHBOARD_CONFIG_SECTION)
    );
}

export function createStewardConfiguration(
    primaryConfig: vscode.WorkspaceConfiguration,
    legacyConfig: vscode.WorkspaceConfiguration
): vscode.WorkspaceConfiguration {
    function getStewardConfigValue<T>(key: string, defaultValue?: T): T {
        if (hasConfiguredValue(primaryConfig, key)) {
            return primaryConfig.get<T>(key, defaultValue);
        }

        if (hasConfiguredValue(legacyConfig, key)) {
            return legacyConfig.get<T>(key, defaultValue);
        }

        return primaryConfig.get<T>(key, defaultValue);
    }

    return new Proxy({}, {
        get(_target, property: string | symbol) {
            if (property === 'get') {
                return (key: string, defaultValue?: unknown) => getStewardConfigValue(key, defaultValue);
            }

            if (typeof property === 'string'
                && (primaryConfig.inspect(property) || legacyConfig.inspect(property))) {
                return getStewardConfigValue(property);
            }

            let targetValue = (primaryConfig as any)[property as any];
            if (targetValue !== undefined) {
                return typeof targetValue === 'function' ? targetValue.bind(primaryConfig) : targetValue;
            }

            if (typeof property === 'string') {
                return getStewardConfigValue(property);
            }

            return undefined;
        },
    }) as vscode.WorkspaceConfiguration;
}

export function hasConfiguredValue(config: vscode.WorkspaceConfiguration, key: string): boolean {
    let inspection = config.inspect(key);
    if (!inspection) {
        return false;
    }

    return inspection.globalValue !== undefined
        || inspection.workspaceValue !== undefined
        || inspection.workspaceFolderValue !== undefined
        || inspection.globalLanguageValue !== undefined
        || inspection.workspaceLanguageValue !== undefined
        || inspection.workspaceFolderLanguageValue !== undefined;
}
