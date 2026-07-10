import * as vscode from 'vscode';

import { INBUILT_COLOR_DEFAULTS } from '../constants';
import { Project } from '../models';
import BaseService from './baseService';

const WORKBENCH_SECTION = 'workbench';
const COLOR_CUSTOMIZATIONS_KEY = 'colorCustomizations';
const PROJECT_COLOR_TO_WINDOW_KEY = 'applyProjectColorToWindow';
const PROJECT_WINDOW_COLOR_BACKUP_KEY = 'projectWindowColorBackup';
const PROJECT_WINDOW_COLOR_KEYS = [
    'activityBar.background',
    'activityBar.foreground',
    'activityBar.activeBackground',
    'activityBar.activeBorder',
    'activityBarBadge.background',
    'activityBarBadge.foreground',
    'commandCenter.activeBorder',
    'statusBar.background',
    'statusBar.foreground',
    'statusBar.noFolderBackground',
    'statusBar.debuggingBackground',
    'statusBarItem.remoteBackground',
    'statusBarItem.remoteForeground',
    'titleBar.activeBackground',
    'titleBar.activeForeground',
    'titleBar.inactiveBackground',
    'titleBar.inactiveForeground',
];

interface ProjectWindowColorBackup {
    values: Record<string, string | null>;
}

export default class ProjectWindowColorService extends BaseService {
    isEnabled(): boolean {
        return this.getConfig<boolean>(PROJECT_COLOR_TO_WINDOW_KEY, false);
    }

    async syncProjectColorToCurrentWindow(project: Project): Promise<void> {
        if (!this.isEnabled() || !project?.color) {
            await this.restoreProjectWindowColors(project);
            return;
        }

        let color = this.resolveWindowColor(project.color);
        if (!color) {
            await this.restoreProjectWindowColors(project);
            return;
        }

        let colorCustomizations = vscode.workspace.getConfiguration(WORKBENCH_SECTION).get<Record<string, string>>(COLOR_CUSTOMIZATIONS_KEY, {});
        let originalColorCustomizations = this.removeGeneratedProjectWindowColors(colorCustomizations, project);
        await this.backupProjectWindowColors(originalColorCustomizations);

        let nextColorCustomizations = this.withoutProjectWindowColors(originalColorCustomizations);
        nextColorCustomizations = {
            ...nextColorCustomizations,
            ...this.getWindowColorCustomizations(color),
        };

        await vscode.workspace.getConfiguration(WORKBENCH_SECTION)
            .update(COLOR_CUSTOMIZATIONS_KEY, nextColorCustomizations, vscode.ConfigurationTarget.Workspace);
    }

    async restoreProjectWindowColors(project: Project = null): Promise<void> {
        let colorCustomizations = vscode.workspace.getConfiguration(WORKBENCH_SECTION).get<Record<string, string>>(COLOR_CUSTOMIZATIONS_KEY, {});
        let backup = this.context.workspaceState.get<ProjectWindowColorBackup>(PROJECT_WINDOW_COLOR_BACKUP_KEY);
        let nextColorCustomizations = { ...colorCustomizations };

        if (backup) {
            nextColorCustomizations = this.restoreBackedUpProjectWindowColors(nextColorCustomizations, backup);
        } else {
            nextColorCustomizations = this.removeGeneratedProjectWindowColors(nextColorCustomizations, project);
        }

        if (this.hasColorCustomizationChanges(colorCustomizations, nextColorCustomizations)) {
            await vscode.workspace.getConfiguration(WORKBENCH_SECTION)
                .update(COLOR_CUSTOMIZATIONS_KEY, nextColorCustomizations, vscode.ConfigurationTarget.Workspace);
        }

        await this.context.workspaceState.update(PROJECT_WINDOW_COLOR_BACKUP_KEY, undefined);
    }

    resolveWindowColor(color: string): string {
        if (!color) {
            return null;
        }

        color = color.trim();
        let inbuiltColor = this.resolveInbuiltColor(color);
        if (inbuiltColor) {
            return inbuiltColor;
        }

        let hexColor = color.match(/^#([0-9a-fA-F]{6})$/);
        if (hexColor) {
            return `#${hexColor[1].toLowerCase()}`;
        }

        let shortHexColor = color.match(/^#([0-9a-fA-F]{3})$/);
        if (shortHexColor) {
            return `#${shortHexColor[1].split('').map(value => value + value).join('').toLowerCase()}`;
        }

        let rgbColor = color.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
        if (rgbColor) {
            let rgb = rgbColor.slice(1, 4).map(value => Math.max(0, Math.min(255, Number(value))));
            return `#${rgb.map(value => this.toHexPair(value)).join('')}`;
        }

        return null;
    }

    getWindowColorCustomizations(color: string): Record<string, string> {
        let auraPalette = this.getAuraPalette(color);

        return {
            'activityBar.activeBackground': auraPalette.activityActive,
            'activityBar.activeBorder': color,
            'activityBar.foreground': auraPalette.foreground,
            'activityBarBadge.background': auraPalette.badge,
            'activityBarBadge.foreground': auraPalette.badgeForeground,
            'commandCenter.activeBorder': auraPalette.commandBorder,
            'statusBar.background': auraPalette.statusBar,
            'statusBar.foreground': auraPalette.statusBarForeground,
            'statusBar.noFolderBackground': auraPalette.statusBar,
            'statusBar.debuggingBackground': auraPalette.statusBar,
            'statusBarItem.remoteBackground': auraPalette.remote,
            'statusBarItem.remoteForeground': auraPalette.remoteForeground,
            'titleBar.activeBackground': auraPalette.titleBar,
            'titleBar.activeForeground': auraPalette.titleBarForeground,
            'titleBar.inactiveBackground': auraPalette.titleBarInactive,
            'titleBar.inactiveForeground': auraPalette.titleBarForeground,
        };
    }

    private restoreBackedUpProjectWindowColors(
        colorCustomizations: Record<string, string>,
        backup: ProjectWindowColorBackup
    ): Record<string, string> {
        let nextColorCustomizations = { ...colorCustomizations };

        for (let key of PROJECT_WINDOW_COLOR_KEYS) {
            if (backup.values[key] !== null && backup.values[key] !== undefined) {
                nextColorCustomizations[key] = backup.values[key];
            } else {
                delete nextColorCustomizations[key];
            }
        }

        return nextColorCustomizations;
    }

    private removeGeneratedProjectWindowColors(colorCustomizations: Record<string, string>, project: Project): Record<string, string> {
        let color = this.resolveWindowColor(project?.color);
        if (!color) {
            return colorCustomizations;
        }

        let generatedColorCustomizations = {
            ...this.getLegacyWindowColorCustomizations(color),
            ...this.getWindowColorCustomizations(color),
        };
        let nextColorCustomizations = { ...colorCustomizations };

        for (let key of PROJECT_WINDOW_COLOR_KEYS) {
            if (nextColorCustomizations[key] === generatedColorCustomizations[key]) {
                delete nextColorCustomizations[key];
            }
        }

        return nextColorCustomizations;
    }

    private getLegacyWindowColorCustomizations(color: string): Record<string, string> {
        let foreground = this.getReadableForeground(color);

        return {
            'activityBar.background': color,
            'activityBar.foreground': foreground,
            'activityBarBadge.background': foreground,
            'activityBarBadge.foreground': color,
            'statusBar.background': color,
            'statusBar.foreground': foreground,
            'statusBar.noFolderBackground': color,
            'statusBar.debuggingBackground': color,
            'titleBar.activeBackground': color,
            'titleBar.activeForeground': foreground,
            'titleBar.inactiveBackground': this.withAlpha(color, '99'),
            'titleBar.inactiveForeground': foreground,
        };
    }

    private resolveInbuiltColor(color: string): string {
        let variableMatch = color.match(/^var\((--[^,\)]+)(?:,[^\)]*)?\)$/);
        if (!variableMatch) {
            return null;
        }

        let colorDefault = INBUILT_COLOR_DEFAULTS.find(defaultColor => defaultColor.name === variableMatch[1]);
        return colorDefault?.defaultValue || null;
    }

    private getAuraPalette(color: string) {
        let titleBar = this.mixColor(color, '#06070b', 0.74);
        let statusBar = this.mixColor(color, '#05060a', 0.68);
        let remote = this.mixColor(color, '#10131a', 0.18);
        let badge = this.mixColor(color, '#ffffff', 0.10);

        return {
            titleBar,
            titleBarInactive: this.withAlpha(titleBar, 'cc'),
            titleBarForeground: this.getReadableForeground(titleBar),
            statusBar,
            statusBarForeground: this.getReadableForeground(statusBar),
            remote,
            remoteForeground: this.getReadableForeground(remote),
            activityActive: this.withAlpha(color, '18'),
            foreground: this.getReadableForeground(titleBar),
            badge,
            badgeForeground: this.getReadableForeground(badge),
            commandBorder: this.withAlpha(color, '88'),
        };
    }

    private async backupProjectWindowColors(colorCustomizations: Record<string, string>): Promise<void> {
        if (this.context.workspaceState.get<ProjectWindowColorBackup>(PROJECT_WINDOW_COLOR_BACKUP_KEY)) {
            return;
        }

        let values: Record<string, string | null> = {};
        for (let key of PROJECT_WINDOW_COLOR_KEYS) {
            values[key] = colorCustomizations[key] === undefined ? null : colorCustomizations[key];
        }

        await this.context.workspaceState.update(PROJECT_WINDOW_COLOR_BACKUP_KEY, { values });
    }

    private withoutProjectWindowColors(colorCustomizations: Record<string, string>): Record<string, string> {
        let nextColorCustomizations = { ...colorCustomizations };
        for (let key of PROJECT_WINDOW_COLOR_KEYS) {
            delete nextColorCustomizations[key];
        }

        return nextColorCustomizations;
    }

    private hasColorCustomizationChanges(current: Record<string, string>, next: Record<string, string>): boolean {
        let keys = Object.keys({ ...current, ...next });
        return keys.some(key => current[key] !== next[key]);
    }

    private getReadableForeground(color: string): string {
        let rgb = this.hexToRgb(color);
        if (!rgb) {
            return '#ffffff';
        }

        let brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
        return brightness > 145 ? '#1f1f1f' : '#ffffff';
    }

    private hexToRgb(color: string): { r: number, g: number, b: number } {
        let match = color.match(/^#([0-9a-fA-F]{6})$/);
        if (!match) {
            return null;
        }

        let value = match[1];
        return {
            r: parseInt(value.substr(0, 2), 16),
            g: parseInt(value.substr(2, 2), 16),
            b: parseInt(value.substr(4, 2), 16),
        };
    }

    private toHexPair(value: number): string {
        let hex = value.toString(16);
        return hex.length === 1 ? `0${hex}` : hex;
    }

    private mixColor(color: string, mixWith: string, weight: number): string {
        let source = this.hexToRgb(color);
        let target = this.hexToRgb(mixWith);
        if (!source || !target) {
            return color;
        }

        let mix = (sourceValue: number, targetValue: number) => Math.round(sourceValue * (1 - weight) + targetValue * weight);
        return `#${[
            mix(source.r, target.r),
            mix(source.g, target.g),
            mix(source.b, target.b),
        ].map(value => this.toHexPair(value)).join('')}`;
    }

    private withAlpha(color: string, alpha: string): string {
        return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : color;
    }
}
