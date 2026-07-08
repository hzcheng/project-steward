'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { Project, GroupOrder, Group, ProjectRemoteType, getRemoteType, getRemoteTypeFromRemoteName, StewardInfos, ProjectOpenType, ReopenStewardReason, ProjectPathType, sanitizeProjectName, CodexSession, AiSessionProviderId, isAiSessionProviderId } from './models';
import { getStewardContent } from './webview/webviewContent';
import { USE_PROJECT_COLOR, PREDEFINED_COLORS, StartupOptions, USER_CANCELED, SAVE_CURRENT_PROJECT, FixedColorOptions, RelevantExtensions, SSH_REGEX, REMOTE_REGEX, SSH_REMOTE_PREFIX, REOPEN_KEY, WSL_DEFAULT_REGEX, FAVORITES_GROUP_ID, FAVORITES_GROUP_COLLAPSED_KEY, OPEN_PROJECTS_GROUP_ID, OPEN_PROJECTS_GROUP_COLLAPSED_KEY, OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY, OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY, OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY, LEGACY_DASHBOARD_CONFIG_SECTION, PROJECT_STEWARD_CONFIG_SECTION } from './constants';
import { execSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';

import ColorService from './services/colorService';
import ProjectService from './services/projectService';
import FileService from './services/fileService';
import CodexSessionService, { CodexSessionReadResult } from './services/codexSessionService';
import KimiSessionService, { KimiSessionReadResult } from './services/kimiSessionService';
import ClaudeSessionService, { ClaudeSessionReadResult } from './services/claudeSessionService';

interface CodexSessionTerminalEntry {
    terminal: vscode.Terminal;
    markerPath: string;
}

interface NewAiSessionFields {
    title: string;
}

interface PendingAiSessionTerminal {
    provider: AiSessionProviderId;
    terminal: vscode.Terminal;
    markerPath: string;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
}

const CODEX_SESSION_TERMINAL_ENV = 'PROJECT_STEWARD_CODEX_SESSION_ID';
const CODEX_SESSION_TERMINAL_NAME_PREFIX = 'Codex';
const CODEX_SESSION_TERMINAL_STARTUP_DELAY_MS = 1000;
const PENDING_AI_SESSION_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const NEW_AI_SESSION_REFRESH_DELAYS_MS = [250, 1000, 2500, 5000];
const KIMI_SESSION_TERMINAL_ENV = 'PROJECT_STEWARD_KIMI_SESSION_ID';
const KIMI_SESSION_TERMINAL_NAME_PREFIX = 'Kimi';
const CLAUDE_SESSION_TERMINAL_ENV = 'PROJECT_STEWARD_CLAUDE_SESSION_ID';
const CLAUDE_SESSION_TERMINAL_NAME_PREFIX = 'Claude';
const AI_SESSION_ALIASES_FILE_NAME = 'ai-session-aliases.json';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Project Steward');
    context.subscriptions.push(outputChannel);

    class SidebarStewardViewProvider implements vscode.WebviewViewProvider {

        public static readonly viewType = "projectSteward.steward";

        private _view?: vscode.WebviewView;

        resolveWebviewView(webviewView: vscode.WebviewView, webviewContext: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): void | Thenable<void> {
            this._view = webviewView;
            webviewView.webview.options = getWebviewOptions();
            this.refresh();

            webviewView.webview.onDidReceiveMessage(async (e) => {
                await handleStewardMessage(e);
            });

            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this.refresh();
                }
            });
        }

        refresh() {
            if (this._view) {
                try {
                    this._view.webview.html = getStewardContent(
                        context,
                        this._view.webview,
                        projectService.getGroups(),
                        stewardInfos,
                        true
                    );
                } catch (error) {
                    logError('Failed to render Project Steward view.', error);
                    this._view.webview.html = getErrorContent(error);
                }
            }
        }
    }

    const colorService = new ColorService(context);
    const projectService = new ProjectService(context, colorService);
    const fileService = new FileService(context);
    const codexSessionService = new CodexSessionService();
    const kimiSessionService = new KimiSessionService();
    const claudeSessionService = new ClaudeSessionService();
    const codexSessionTerminals = new Map<string, CodexSessionTerminalEntry>();
    const kimiSessionTerminals = new Map<string, CodexSessionTerminalEntry>();
    const claudeSessionTerminals = new Map<string, CodexSessionTerminalEntry>();
    let pendingAiSessionTerminals: PendingAiSessionTerminal[] = [];
    const codexSessionResumesInFlight = new Set<string>();
    const kimiSessionResumesInFlight = new Set<string>();
    const claudeSessionResumesInFlight = new Set<string>();
    let codexSessionRefreshTimeout: NodeJS.Timeout = null;

    const provider = new SidebarStewardViewProvider();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarStewardViewProvider.viewType, provider));
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(terminal => {
            for (let [sessionId, entry] of codexSessionTerminals) {
                if (entry.terminal === terminal) {
                    deleteCodexSessionTerminalMarker(entry);
                    codexSessionTerminals.delete(sessionId);
                }
            }
            for (let [sessionId, entry] of kimiSessionTerminals) {
                if (entry.terminal === terminal) {
                    deleteKimiSessionTerminalMarker(entry);
                    kimiSessionTerminals.delete(sessionId);
                }
            }
            for (let [sessionId, entry] of claudeSessionTerminals) {
                if (entry.terminal === terminal) {
                    deleteClaudeSessionTerminalMarker(entry);
                    claudeSessionTerminals.delete(sessionId);
                }
            }
            pendingAiSessionTerminals = pendingAiSessionTerminals.filter(entry => {
                if (entry.terminal !== terminal) {
                    return true;
                }

                deleteAiSessionTerminalMarker(entry.markerPath);
                return false;
            });
        }));
    context.subscriptions.push(
        codexSessionService.watchSessionChanges(() => scheduleCodexSessionRefresh()));
    context.subscriptions.push(
        kimiSessionService.watchSessionChanges(() => scheduleCodexSessionRefresh()));
    context.subscriptions.push(
        claudeSessionService.watchSessionChanges(() => scheduleCodexSessionRefresh()));
    context.subscriptions.push({
        dispose: () => {
            if (codexSessionRefreshTimeout) {
                clearTimeout(codexSessionRefreshTimeout);
            }
        }
    });

    const stewardInfos: StewardInfos = {
        relevantExtensionsInstalls: {
            remoteSSH: false,
            remoteContainers: false,
        },
        get config() { return getStewardConfiguration() },
        get otherStorageHasData() { return projectService.otherStorageHasData() },
        get favoritesGroupCollapsed() { return context.globalState.get(FAVORITES_GROUP_COLLAPSED_KEY) as boolean },
        get openProjects() { return getOpenProjects() },
        get openProjectsGroupCollapsed() { return context.globalState.get(OPEN_PROJECTS_GROUP_COLLAPSED_KEY) as boolean },
    };

    const openCommand = vscode.commands.registerCommand('projectSteward.open', () => {
        showSteward();
    });

    const addProjectCommand = vscode.commands.registerCommand('projectSteward.addProject', async () => {
        await addProject();
    });

    const saveProjectCommand = vscode.commands.registerCommand('projectSteward.saveProject', async () => {
        await saveProject();
    });

    const removeProjectCommand = vscode.commands.registerCommand('projectSteward.removeProject', async () => {
        await removeProjectPerCommand();
    });

    const editProjectsManuallyCommand = vscode.commands.registerCommand('projectSteward.editProjects', async () => {
        await editProjectsManuallyPerCommand();
    });

    const addGroupCommand = vscode.commands.registerCommand('projectSteward.addGroup', async () => {
        await addGroup();
    });

    const removeGroupCommand = vscode.commands.registerCommand('projectSteward.removeGroup', async () => {
        await removeGroupPerCommand();
    });
    const addProjectsFromFolderCommand = vscode.commands.registerCommand('projectSteward.addProjectsFromFolder', async () => {
        await addProjectsFromFolder();
    });

    context.subscriptions.push(openCommand);
    context.subscriptions.push(addProjectCommand);
    context.subscriptions.push(saveProjectCommand);
    context.subscriptions.push(removeProjectCommand);
    context.subscriptions.push(editProjectsManuallyCommand);
    context.subscriptions.push(addGroupCommand);
    context.subscriptions.push(removeGroupCommand);
    context.subscriptions.push(addProjectsFromFolderCommand);

    vscode.workspace.onDidChangeConfiguration(async event => {
        if (event.affectsConfiguration("projectSteward.storeProjectsInSettings")
            || event.affectsConfiguration("dashboard.storeProjectsInSettings")) {
            await checkDataMigration(false);
        }

        if (event.affectsConfiguration("projectSteward")
            || event.affectsConfiguration("dashboard")) {
            refreshStewardViews();
        }
    });

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
        refreshStewardViews();
    });

    startUp();

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ Functions ~~~~~~~~~~~~~~~~~~~~~~~~~
    async function checkDataMigration(openStewardAfterMigrate: boolean = false) {
        let migrated = await projectService.migrateDataIfNeeded();
        if (migrated) {
            vscode.window.showInformationMessage("Migrated Project Steward projects after changing settings.");

            if (openStewardAfterMigrate) {
                showSteward();
            }
        }
    }

    async function startUp() {
        for (let exName in stewardInfos.relevantExtensionsInstalls) {
            let exId = RelevantExtensions[exName];
            let installed = vscode.extensions.getExtension(exId) !== undefined;
            stewardInfos.relevantExtensionsInstalls[exName] = installed;
        }

        await checkDataMigration();

        let reopenStewardReason = context.globalState.get(REOPEN_KEY) as ReopenStewardReason;
        context.globalState.update(REOPEN_KEY, ReopenStewardReason.None);
        showStewardOnOpenIfNeeded(reopenStewardReason);
    }

    function showStewardOnOpenIfNeeded(reopenReason: ReopenStewardReason = ReopenStewardReason.None) {

        var open = reopenReason !== ReopenStewardReason.None;

        if (!open) {
            var { openOnStartup } = stewardInfos.config;

            switch (openOnStartup) {
                case StartupOptions.always:
                    open = true;
                    break;
                case StartupOptions.never:
                    break;
                case StartupOptions.emptyWorkSpace:
                default:
                    let editors = vscode.window.visibleTextEditors;
                    // Includes Workaround for temporary code runner file
                    let noOpenEditorsOrWorkspaces = !vscode.workspace.name && (
                        editors.length === 0 || editors.length === 1 && editors[0].document.languageId === "code-runner-output"
                    );
                    open = noOpenEditorsOrWorkspaces;
                    break;
            }
        }

        if (open) {
            showSteward();
        }
    }

    function showSteward() {
        revealSidebarSteward();
        refreshStewardViews();
    }

    function revealSidebarSteward() {
        vscode.commands.executeCommand('workbench.view.extension.project-steward')
            .then(() => vscode.commands.executeCommand(`${SidebarStewardViewProvider.viewType}.focus`))
            .then(undefined, () => vscode.commands.executeCommand(`${SidebarStewardViewProvider.viewType}.focus`))
            .then(undefined, () => { });
    }

    function getStewardConfiguration(): vscode.WorkspaceConfiguration {
        let primaryConfig = vscode.workspace.getConfiguration(PROJECT_STEWARD_CONFIG_SECTION);
        let legacyConfig = vscode.workspace.getConfiguration(LEGACY_DASHBOARD_CONFIG_SECTION);

        return new Proxy({}, {
            get(_target, property: string | symbol) {
                if (property === 'get') {
                    return (key: string, defaultValue?: any) => getStewardConfigValue(key, defaultValue);
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

        function getStewardConfigValue(key: string, defaultValue?: any) {
            if (hasConfiguredValue(primaryConfig, key)) {
                return primaryConfig.get(key, defaultValue);
            }

            if (hasConfiguredValue(legacyConfig, key)) {
                return legacyConfig.get(key, defaultValue);
            }

            return primaryConfig.get(key, defaultValue);
        }
    }

    function hasConfiguredValue(config: vscode.WorkspaceConfiguration, key: string): boolean {
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

    function getWebviewOptions(): vscode.WebviewOptions {
        return {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'media')),
            ],
        };
    }

    function refreshStewardViews() {
        provider.refresh();
    }

    function scheduleCodexSessionRefresh() {
        if (codexSessionRefreshTimeout) {
            clearTimeout(codexSessionRefreshTimeout);
        }

        codexSessionRefreshTimeout = setTimeout(() => {
            codexSessionRefreshTimeout = null;
            refreshStewardViews();
        }, 250);
    }

    function scheduleNewAiSessionRefresh(providerId: AiSessionProviderId) {
        for (let delay of NEW_AI_SESSION_REFRESH_DELAYS_MS) {
            setTimeout(() => {
                invalidateAiSessionCache(providerId);
                refreshStewardViews();
            }, delay);
        }
    }

    function invalidateAiSessionCache(providerId: AiSessionProviderId) {
        if (providerId === 'codex') {
            codexSessionService.invalidateCache();
        } else if (providerId === 'kimi') {
            kimiSessionService.invalidateCache();
        } else if (providerId === 'claude') {
            claudeSessionService.invalidateCache();
        }
    }

    function logError(message: string, error: unknown) {
        outputChannel.appendLine(message);
        outputChannel.appendLine(error instanceof Error ? `${error.stack || error.message}` : String(error));
    }

    function getErrorContent(error: unknown): string {
        let message = error instanceof Error ? error.message : String(error);
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            padding: 12px;
        }
        code {
            color: var(--vscode-errorForeground);
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <p>Project Steward could not render this view.</p>
    <code>${escapeHtml(message)}</code>
</body>
</html>`;
    }

    function escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function refreshAfterMutation() {
        refreshStewardViews();
    }

    async function handleStewardMessage(e: any) {
        let projectId: string, groupId: string;
        switch (e.type) {
            case 'selected-project':
                projectId = e.projectId as string;
                let projectOpenType = e.projectOpenType as ProjectOpenType;

                let project = projectService.getProject(projectId) || getOpenProjects().find(p => p.id === projectId);
                if (project == null) {
                    vscode.window.showWarningMessage("Selected Project not found.");
                    break;
                }

                await openProject(project, projectOpenType);
                break;
            case 'add-project':
                groupId = e.groupId as string;
                await addProject(groupId);
                break;
            case 'import-from-other-storage':
                await projectService.copyProjectsFromFilledStorageOptionToEmptyStorageOption();
                refreshAfterMutation();
                break;
            case 'reordered-projects':
                let groupOrders = e.groupOrders as GroupOrder[];
                await reorderGroups(groupOrders);
                break;
            case 'remove-project':
                projectId = e.projectId as string;
                await removeProject(projectId);
                break;
            case 'edit-project':
                projectId = e.projectId as string;
                await editProject(projectId);
                break;
            case 'color-project':
                projectId = e.projectId as string;
                await editProjectColor(projectId);
                break;
            case 'favorite-project':
                projectId = e.projectId as string;
                await toggleProjectFavorite(projectId);
                break;
            case 'save-project':
                projectId = e.projectId as string;
                await saveOpenProject(projectId);
                break;
            case 'toggle-codex-sessions':
                projectId = e.projectId as string;
                await toggleCodexSessions(projectId, Boolean(e.expanded));
                break;
            case 'select-ai-session-provider':
                projectId = e.projectId as string;
                await selectAiSessionProvider(projectId, e.provider as AiSessionProviderId);
                break;
            case 'create-ai-session':
                projectId = e.projectId as string;
                await createAiSession(projectId, e.provider as AiSessionProviderId);
                break;
            case 'toggle-ai-session-pin':
                await toggleAiSessionPin(e.provider as AiSessionProviderId, e.sessionId as string);
                break;
            case 'rename-ai-session':
                await renameAiSession(e.provider as AiSessionProviderId, e.sessionId as string);
                break;
            case 'copy-ai-session-id':
                await copyAiSessionId(e.sessionId as string);
                break;
            case 'resume-codex-session':
                projectId = e.projectId as string;
                await resumeCodexSession(projectId, e.sessionId as string);
                break;
            case 'resume-kimi-session':
                projectId = e.projectId as string;
                await resumeKimiSession(projectId, e.sessionId as string);
                break;
            case 'resume-claude-session':
                projectId = e.projectId as string;
                await resumeClaudeSession(projectId, e.sessionId as string);
                break;
            case 'archive-codex-session':
                await archiveCodexSession(e.sessionId as string);
                break;
            case 'archive-kimi-session':
                await archiveKimiSession(e.sessionId as string);
                break;
            case 'archive-claude-session':
                await archiveClaudeSession(e.sessionId as string);
                break;
            case 'edit-group':
                groupId = e.groupId as string;
                await editGroup(groupId);
                break;
            case 'remove-group':
                groupId = e.groupId as string;
                await removeGroup(groupId);
                break;
            case 'add-group':
                await addGroup();
                break;
            case 'collapse-group':
                groupId = e.groupId as string;
                await collapseGroup(groupId, e.collapsed as boolean);
                break;
            case 'toggle-all-groups':
                // Collapse-all is a per-webview convenience action.
                break;
        }
    }

    async function addGroup() {
        var groupName;

        try {
            groupName = await queryGroupFields();
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while adding the group.`);
                throw error; // Rethrow error to make vscode log it
            }

            return;
        }

        await projectService.addGroup(groupName);
        refreshAfterMutation();
    }

    async function editGroup(groupId: string) {
        var group = projectService.getGroup(groupId);
        if (group == null) {
            return;
        }

        var groupName;

        try {
            groupName = await queryGroupFields(group.groupName);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while editing the group.`);
                throw error; // Rethrow error to make vscode log it
            }

            return;
        }

        // Name
        group.groupName = groupName;
        await projectService.updateGroup(groupId, group);

        refreshAfterMutation();
    }

    async function queryGroupFields(defaultText: string = null): Promise<string> {
        var groupName = await vscode.window.showInputBox({
            value: defaultText || undefined,
            valueSelection: defaultText ? [0, defaultText.length] : undefined,
            placeHolder: 'Group Name',
            ignoreFocusOut: true,
            validateInput: (val: string) => val ? '' : 'A Group Name must be provided.',
        });

        if (groupName == null) {
            throw new Error(USER_CANCELED);
        }

        return groupName;
    }

    async function removeGroupPerCommand() {
        var [groupId, newlyCreated] = await queryGroup();
        removeGroup(groupId);
    }

    async function addProjectsFromFolder() {
        try {
            let currentlyOpenPath = getWorkspacePath();
            let folderPath = await vscode.window.showOpenDialog({
                defaultUri: currentlyOpenPath ? parsePathAsUri(currentlyOpenPath) : undefined,
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Folder containing Projects',
            });

            if (!folderPath || folderPath.length === 0)
                return;

            let foldersInPath = await fileService.getFolders(folderPath[0].fsPath);
            let folderName = path.basename(folderPath[0].fsPath);

            let group = await projectService.addGroup(folderName);
            for (const folder of foldersInPath) {
                let name = path.basename(folder);
                let project = new Project(name, folder);
                project.color = colorService.getRandomColor();
                project.isGitRepo = isFolderGitRepo(folder);
                await projectService.addProject(project, group.id);
            }

        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while adding the projects.`);
                throw error; // Rethrow error to make vscode log it
            }

            return;
        }

        refreshAfterMutation();
    }

    async function removeGroup(groupId: string) {
        var group = projectService.getGroup(groupId);
        if (group == null) {
            return;
        }

        let accepted = await vscode.window.showWarningMessage(`Remove ${group.groupName}?`, { modal: true }, 'Remove');
        if (!accepted) {
            return;
        }

        await projectService.removeGroup(groupId);
        refreshAfterMutation();
    }

    async function collapseGroup(groupId: string, collapsed?: boolean) {
        if (groupId === FAVORITES_GROUP_ID) {
            await context.globalState.update(FAVORITES_GROUP_COLLAPSED_KEY, Boolean(collapsed));
            return;
        }

        if (groupId === OPEN_PROJECTS_GROUP_ID) {
            await context.globalState.update(OPEN_PROJECTS_GROUP_COLLAPSED_KEY, Boolean(collapsed));
            return;
        }

        var group = projectService.getGroup(groupId);
        if (group == null) {
            return;
        }

        group.collapsed = collapsed !== undefined ? collapsed : !group.collapsed;
        await projectService.updateGroup(groupId, group);

        //showSteward(); // No need to repaint for that
    }

    async function toggleCodexSessions(projectId: string, expanded: boolean) {
        let project = getOpenProjects().find(p => p.id === projectId);
        if (!project) {
            return;
        }

        let expandedProjects = getExpandedCodexSessionProjects();
        let projectKey = getOpenProjectCodexExpansionKey(project);
        if (expanded) {
            expandedProjects.add(projectKey);
        } else {
            expandedProjects.delete(projectKey);
        }

        await context.globalState.update(OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY, Array.from(expandedProjects));
    }

    async function selectAiSessionProvider(projectId: string, providerId: AiSessionProviderId) {
        if (!isAiSessionProviderId(providerId)) {
            return;
        }

        let project = getOpenProjects().find(p => p.id === projectId);
        if (!project) {
            return;
        }

        let selectedProviders = getActiveAiSessionProviders();
        selectedProviders[getOpenProjectCodexExpansionKey(project)] = providerId;
        await context.globalState.update(OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY, selectedProviders);
        refreshAfterMutation();
    }

    async function toggleAiSessionPin(providerId: AiSessionProviderId, sessionId: string) {
        if (!isAiSessionProviderId(providerId) || !sessionId) {
            return;
        }

        let pinnedSessions = getPinnedAiSessionKeys();
        let sessionKey = getAiSessionPinKey(providerId, sessionId);
        if (pinnedSessions.has(sessionKey)) {
            pinnedSessions.delete(sessionKey);
        } else {
            pinnedSessions.add(sessionKey);
        }

        await context.globalState.update(OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY, Array.from(pinnedSessions));
        refreshAfterMutation();
    }

    async function renameAiSession(providerId: AiSessionProviderId, sessionId: string) {
        if (!isAiSessionProviderId(providerId) || !sessionId) {
            return;
        }

        let aliases = getAiSessionAliases();
        let sessionKey = getAiSessionPinKey(providerId, sessionId);
        let originalName = getAiSessionOriginalName(providerId, sessionId);
        let currentAlias = aliases[sessionKey] || '';
        let value = await vscode.window.showInputBox({
            prompt: 'Set a local display name for this chat. Leave empty to reset.',
            placeHolder: originalName || sessionId,
            value: currentAlias || originalName || '',
            ignoreFocusOut: true,
        });

        if (value === undefined) {
            return;
        }

        let alias = sanitizeAiSessionAlias(value);
        if (!alias || alias === originalName) {
            delete aliases[sessionKey];
        } else {
            aliases[sessionKey] = alias;
        }

        saveAiSessionAliases(aliases);
        refreshAfterMutation();
    }

    async function copyAiSessionId(sessionId: string) {
        if (!sessionId) {
            return;
        }

        await vscode.env.clipboard.writeText(sessionId);
        vscode.window.showInformationMessage("Chat ID copied to clipboard.");
    }

    async function createAiSession(projectId: string, providerId: AiSessionProviderId) {
        if (!isAiSessionProviderId(providerId)) {
            return;
        }

        let project = getOpenProjects().find(p => p.id === projectId);
        if (!project) {
            vscode.window.showWarningMessage("Open project not found.");
            return;
        }

        let fields = await queryNewAiSessionFields(providerId);
        if (!fields) {
            return;
        }

        if (providerId === 'codex') {
            await createCodexSession(project, fields);
        } else if (providerId === 'claude') {
            await createClaudeSession(project, fields);
        } else {
            await createKimiSession(project, fields);
        }
    }

    async function queryNewAiSessionFields(providerId: AiSessionProviderId): Promise<NewAiSessionFields> {
        let providerLabel = getAiSessionProviderLabel(providerId);
        let title = await vscode.window.showInputBox({
            prompt: `New ${providerLabel} chat title (optional)`,
            placeHolder: 'Leave empty to use the session ID',
            ignoreFocusOut: true,
        });
        if (title === undefined) {
            return null;
        }

        return {
            title: sanitizeAiSessionAlias(title),
        };
    }

    async function createCodexSession(project: Project, fields: NewAiSessionFields) {
        let cwd = getUsableTerminalCwd(getOpenProjectTerminalCwd(project));
        let pendingTerminalCwd = cwd || getOpenProjectTerminalCwd(project);
        let terminalName = `${CODEX_SESSION_TERMINAL_NAME_PREFIX}: ${project.name || 'New Session'}`;
        let terminal = createAiSessionTerminal(terminalName, cwd, 'Codex');
        let existingSessionIds = getAiSessionIdsForCwd(codexSessionService.getSessions(true), pendingTerminalCwd);
        let createdAt = new Date().toISOString();
        let markerPath = getPendingAiSessionTerminalMarkerPath('codex');

        trackPendingAiSessionTerminal('codex', terminal, markerPath, pendingTerminalCwd, createdAt, existingSessionIds, fields.title);

        terminal.show();
        await waitForTerminalReady(terminal);
        terminal.sendText(buildCodexNewSessionCommand(cwd, null, markerPath));
        scheduleNewAiSessionRefresh('codex');
    }

    async function createKimiSession(project: Project, fields: NewAiSessionFields) {
        let cwd = getUsableTerminalCwd(getOpenProjectTerminalCwd(project));
        let pendingTerminalCwd = cwd || getOpenProjectTerminalCwd(project);
        let terminalName = `${KIMI_SESSION_TERMINAL_NAME_PREFIX}: ${project.name || 'New Session'}`;
        let terminal = createAiSessionTerminal(terminalName, cwd, 'Kimi');
        let existingSessionIds = getAiSessionIdsForCwd(kimiSessionService.getSessions(true), pendingTerminalCwd);
        let createdAt = new Date().toISOString();
        let markerPath = getPendingAiSessionTerminalMarkerPath('kimi');
        trackPendingAiSessionTerminal('kimi', terminal, markerPath, pendingTerminalCwd, createdAt, existingSessionIds, fields.title);

        terminal.show();
        await waitForTerminalReady(terminal);
        terminal.sendText(buildKimiNewSessionCommand(cwd, null, markerPath));
        scheduleNewAiSessionRefresh('kimi');
    }

    async function createClaudeSession(project: Project, fields: NewAiSessionFields) {
        let cwd = getUsableTerminalCwd(getOpenProjectTerminalCwd(project));
        let pendingTerminalCwd = cwd || getOpenProjectTerminalCwd(project);
        let terminalName = `${CLAUDE_SESSION_TERMINAL_NAME_PREFIX}: ${project.name || 'New Session'}`;
        let terminal = createAiSessionTerminal(terminalName, cwd, 'Claude');
        let existingSessionIds = getAiSessionIdsForCwd(claudeSessionService.getSessions(true), pendingTerminalCwd);
        let createdAt = new Date().toISOString();
        let markerPath = getPendingAiSessionTerminalMarkerPath('claude');
        trackPendingAiSessionTerminal('claude', terminal, markerPath, pendingTerminalCwd, createdAt, existingSessionIds, fields.title);

        terminal.show();
        await waitForTerminalReady(terminal);
        terminal.sendText(buildClaudeNewSessionCommand(cwd, fields.title, markerPath));
        scheduleNewAiSessionRefresh('claude');
    }

    function createAiSessionTerminal(terminalName: string, cwd: string, providerLabel: string): vscode.Terminal {
        try {
            return vscode.window.createTerminal({
                name: terminalName,
                cwd: cwd || undefined,
            });
        } catch (error) {
            logError(`Failed to create ${providerLabel} terminal with cwd.`, error);
            vscode.window.showWarningMessage(`Could not open the ${providerLabel} terminal at the project directory. Starting without a working directory.`);
            return vscode.window.createTerminal({
                name: terminalName,
            });
        }
    }

    async function resumeCodexSession(projectId: string, sessionId: string) {
        let project = getOpenProjects().find(p => p.id === projectId);
        let session = project?.codexSessions?.find(s => s.id === sessionId);
        if (!project || !session) {
            vscode.window.showWarningMessage("Selected Codex session not found.");
            return;
        }

        let cwd = getUsableTerminalCwd(getCodexSessionTerminalCwd(session, project));
        let existingTerminal = getCodexSessionTerminal(session);
        if (existingTerminal && !isCodexSessionTerminalComplete(existingTerminal)) {
            existingTerminal.terminal.show();
            return;
        }

        if (codexSessionResumesInFlight.has(session.id)) {
            return;
        }

        codexSessionResumesInFlight.add(session.id);
        let terminalName = getCodexSessionTerminalName(session);
        let terminal: vscode.Terminal = existingTerminal?.terminal;
        let terminalEnv = { [CODEX_SESSION_TERMINAL_ENV]: session.id };
        let markerPath = existingTerminal?.markerPath || getCodexSessionTerminalMarkerPath(session.id);

        try {
            if (!terminal) {
                try {
                    terminal = vscode.window.createTerminal({
                        name: terminalName,
                        cwd: cwd || undefined,
                        env: terminalEnv,
                    });
                } catch (error) {
                    logError('Failed to create Codex terminal with cwd.', error);
                    cwd = null;
                    terminal = vscode.window.createTerminal({
                        name: terminalName,
                        env: terminalEnv,
                    });
                    vscode.window.showWarningMessage("Could not open the Codex terminal at the session directory. Resuming without a working directory.");
                }
            }

            codexSessionTerminals.set(session.id, { terminal, markerPath });
            terminal.show();
            await sendCodexResumeCommand(terminal, session.id, cwd, markerPath);
        } finally {
            codexSessionResumesInFlight.delete(session.id);
        }
    }

    async function resumeKimiSession(projectId: string, sessionId: string) {
        let project = getOpenProjects().find(p => p.id === projectId);
        let session = project?.kimiSessions?.find(s => s.id === sessionId);
        if (!project || !session) {
            vscode.window.showWarningMessage("Selected Kimi session not found.");
            return;
        }

        let cwd = getUsableTerminalCwd(getKimiSessionTerminalCwd(session, project));
        let existingTerminal = getKimiSessionTerminal(session);
        if (existingTerminal && !isKimiSessionTerminalComplete(existingTerminal)) {
            existingTerminal.terminal.show();
            return;
        }

        if (kimiSessionResumesInFlight.has(session.id)) {
            return;
        }

        kimiSessionResumesInFlight.add(session.id);
        let terminalName = getKimiSessionTerminalName(session);
        let terminal: vscode.Terminal = existingTerminal?.terminal;
        let terminalEnv = { [KIMI_SESSION_TERMINAL_ENV]: session.id };
        let markerPath = existingTerminal?.markerPath || getKimiSessionTerminalMarkerPath(session.id);

        try {
            if (!terminal) {
                try {
                    terminal = vscode.window.createTerminal({
                        name: terminalName,
                        cwd: cwd || undefined,
                        env: terminalEnv,
                    });
                } catch (error) {
                    logError('Failed to create Kimi terminal with cwd.', error);
                    cwd = null;
                    terminal = vscode.window.createTerminal({
                        name: terminalName,
                        env: terminalEnv,
                    });
                    vscode.window.showWarningMessage("Could not open the Kimi terminal at the session directory. Resuming without a working directory.");
                }
            }

            kimiSessionTerminals.set(session.id, { terminal, markerPath });
            terminal.show();
            await sendKimiResumeCommand(terminal, session.id, cwd, markerPath);
        } finally {
            kimiSessionResumesInFlight.delete(session.id);
        }
    }

    async function resumeClaudeSession(projectId: string, sessionId: string) {
        let project = getOpenProjects().find(p => p.id === projectId);
        let session = project?.claudeSessions?.find(s => s.id === sessionId);
        if (!project || !session) {
            vscode.window.showWarningMessage("Selected Claude session not found.");
            return;
        }

        let cwd = getUsableTerminalCwd(getClaudeSessionTerminalCwd(session, project));
        let existingTerminal = getClaudeSessionTerminal(session);
        if (existingTerminal && !isClaudeSessionTerminalComplete(existingTerminal)) {
            existingTerminal.terminal.show();
            return;
        }

        if (claudeSessionResumesInFlight.has(session.id)) {
            return;
        }

        claudeSessionResumesInFlight.add(session.id);
        let terminalName = getClaudeSessionTerminalName(session);
        let terminal: vscode.Terminal = existingTerminal?.terminal;
        let terminalEnv = { [CLAUDE_SESSION_TERMINAL_ENV]: session.id };
        let markerPath = existingTerminal?.markerPath || getClaudeSessionTerminalMarkerPath(session.id);

        try {
            if (!terminal) {
                try {
                    terminal = vscode.window.createTerminal({
                        name: terminalName,
                        cwd: cwd || undefined,
                        env: terminalEnv,
                    });
                } catch (error) {
                    logError('Failed to create Claude terminal with cwd.', error);
                    cwd = null;
                    terminal = vscode.window.createTerminal({
                        name: terminalName,
                        env: terminalEnv,
                    });
                    vscode.window.showWarningMessage("Could not open the Claude terminal at the session directory. Resuming without a working directory.");
                }
            }

            claudeSessionTerminals.set(session.id, { terminal, markerPath });
            terminal.show();
            await sendClaudeResumeCommand(terminal, session.id, cwd, markerPath);
        } finally {
            claudeSessionResumesInFlight.delete(session.id);
        }
    }

    async function archiveCodexSession(sessionId: string) {
        if (!sessionId) {
            return;
        }

        let existingTerminal = getCodexSessionTerminalById(sessionId);
        if (existingTerminal && !isCodexSessionTerminalComplete(existingTerminal)) {
            vscode.window.showWarningMessage("This Codex session is open in a terminal. Exit or close that terminal before archiving it.");
            existingTerminal.terminal.show();
            return;
        }

        let accepted = await vscode.window.showWarningMessage("Archive this Codex session?", { modal: true }, "Archive");
        if (!accepted) {
            return;
        }

        if (!codexSessionService.archiveSession(sessionId)) {
            vscode.window.showErrorMessage("Could not archive Codex session.");
            return;
        }

        if (existingTerminal) {
            deleteCodexSessionTerminalMarker(existingTerminal);
        }

        codexSessionTerminals.delete(sessionId);
        deleteAiSessionAlias('codex', sessionId);
        refreshAfterMutation();
    }

    async function archiveKimiSession(sessionId: string) {
        if (!sessionId) {
            return;
        }

        let existingTerminal = getKimiSessionTerminalById(sessionId);
        if (existingTerminal && !isKimiSessionTerminalComplete(existingTerminal)) {
            vscode.window.showWarningMessage("This Kimi session is open in a terminal. Exit or close that terminal before archiving it.");
            existingTerminal.terminal.show();
            return;
        }

        let accepted = await vscode.window.showWarningMessage("Archive this Kimi session?", { modal: true }, "Archive");
        if (!accepted) {
            return;
        }

        if (!kimiSessionService.archiveSession(sessionId)) {
            vscode.window.showErrorMessage("Could not archive Kimi session.");
            return;
        }

        if (existingTerminal) {
            deleteKimiSessionTerminalMarker(existingTerminal);
        }

        kimiSessionTerminals.delete(sessionId);
        deleteAiSessionAlias('kimi', sessionId);
        refreshAfterMutation();
    }

    async function archiveClaudeSession(sessionId: string) {
        if (!sessionId) {
            return;
        }

        let existingTerminal = getClaudeSessionTerminalById(sessionId);
        if (existingTerminal && !isClaudeSessionTerminalComplete(existingTerminal)) {
            vscode.window.showWarningMessage("This Claude session is open in a terminal. Exit or close that terminal before archiving it.");
            existingTerminal.terminal.show();
            return;
        }

        let accepted = await vscode.window.showWarningMessage("Archive this Claude session?", { modal: true }, "Archive");
        if (!accepted) {
            return;
        }

        if (!claudeSessionService.archiveSession(sessionId)) {
            vscode.window.showErrorMessage("Could not archive Claude session.");
            return;
        }

        if (existingTerminal) {
            deleteClaudeSessionTerminalMarker(existingTerminal);
        }

        claudeSessionTerminals.delete(sessionId);
        deleteAiSessionAlias('claude', sessionId);
        refreshAfterMutation();
    }

    async function openProject(project: Project, projectOpenType: ProjectOpenType): Promise<void> {
        // project is parsed from JSON at runtime, so its not an instance of Project
        let remoteType = getRemoteType(project);
        let projectPath = (project.path || '').trim();

        if (!path.isAbsolute(projectPath) && !projectPath.includes("://")) {
            let rootPath = vscode.workspace.workspaceFile?.path || vscode.workspace.workspaceFolders[0]?.uri.path;
            if (rootPath) {
                projectPath = path.join(rootPath, projectPath);
            } else {
                vscode.window.showWarningMessage("Tried to open a project with a relative path, but no workspace is open.");
                return;
            }
        }

        if (remoteType !== ProjectRemoteType.None && !isUriString(projectPath) && !projectPath.match(WSL_DEFAULT_REGEX)) {
            remoteType = ProjectRemoteType.None;
        }

        if (projectOpenType === ProjectOpenType.Default) {
            if (projectPathMatchesCurrentWorkspace(projectPath)) {
                return;
            }

            projectOpenType = ProjectOpenType.NewWindow;
        }

        if (projectOpenType === ProjectOpenType.CurrentWindow) {
            if (projectPathMatchesCurrentWorkspace(projectPath)) {
                return;
            }
        }

        var openInNewWindow = projectOpenType === ProjectOpenType.NewWindow;

        let uri: vscode.Uri;
        switch (remoteType) {
            case ProjectRemoteType.None:
                uri = isUriString(projectPath) ? vscode.Uri.parse(projectPath) : vscode.Uri.file(projectPath);

                if (projectOpenType === ProjectOpenType.AddToWorkspace) {
                    await addToWorkspace(project, uri);
                } else {
                    await openFolderUri(uri, openInNewWindow);
                }

                break;
            case ProjectRemoteType.SSH:
                let sshUri = isUriString(projectPath) ? vscode.Uri.parse(projectPath) : null;
                if (sshUri && sshUri.path && sshUri.path !== '/') {
                    uri = vscode.Uri.parse(projectPath);
                    await openFolderUri(uri, openInNewWindow);
                } else {
                    let remotePathMatch = projectPath.replace(SSH_REMOTE_PREFIX, '').match(SSH_REGEX);
                    let remoteAuthority = sshUri ? decodeURIComponent(sshUri.authority) : projectPath.replace("vscode-remote://", "");
                    let hasRemoteFolder = remotePathMatch && remotePathMatch.groups.folder != null;

                    if (hasRemoteFolder) {
                        uri = vscode.Uri.parse(projectPath);
                        await openFolderUri(uri, openInNewWindow);
                        break;
                    }

                    await vscode.commands.executeCommand("vscode.newWindow", {
                        remoteAuthority,
                        reuseWindow: !openInNewWindow,
                    });
                }
                break;
            case ProjectRemoteType.WSL:
                var { prependVscodeUrlToWslRemotes } = stewardInfos.config;
                if (prependVscodeUrlToWslRemotes && projectPath.match(WSL_DEFAULT_REGEX)) {
                    projectPath = `vscode-remote://wsl+${projectPath.replace(WSL_DEFAULT_REGEX, '')}`;
                }

                uri = vscode.Uri.parse(projectPath);

                await openFolderUri(uri, openInNewWindow);
                break;
            case ProjectRemoteType.DevContainer:
            case ProjectRemoteType.Remote:
                uri = vscode.Uri.parse(projectPath);

                await openFolderUri(uri, openInNewWindow);
                break;
        }
    }

    async function openFolderUri(uri: vscode.Uri, openInNewWindow: boolean): Promise<void> {
        let options = openInNewWindow
            ? { forceNewWindow: true }
            : { forceReuseWindow: true };

        await vscode.commands.executeCommand("vscode.openFolder", uri, options);
    }

    function projectPathMatchesCurrentWorkspace(projectPath: string): boolean {
        return getWorkspaceUris().some(workspaceUri => projectPathMatchesWorkspaceUri(projectPath, workspaceUri));
    }

    function projectPathMatchesWorkspaceUri(projectPath: string, workspaceUri: vscode.Uri): boolean {
        if (!workspaceUri || !projectPath) {
            return false;
        }

        let currentWorkspacePath = uriToProjectPath(workspaceUri);
        if (normalizeComparableProjectPath(projectPath) === normalizeComparableProjectPath(currentWorkspacePath)) {
            return true;
        }

        if (!isUriString(projectPath) || workspaceUri.scheme !== "vscode-remote") {
            return false;
        }

        try {
            let projectUri = vscode.Uri.parse(projectPath);
            if (projectUri.scheme !== "vscode-remote") {
                return false;
            }

            if (normalizeRemoteAuthority(projectUri.authority) !== normalizeRemoteAuthority(workspaceUri.authority)) {
                return false;
            }

            let projectUriPath = projectUri.path || projectUri.fsPath;
            let workspacePath = workspaceUri.path || workspaceUri.fsPath;

            return normalizePosixPath(projectUriPath) === normalizePosixPath(workspacePath);
        } catch (e) {
            return false;
        }
    }

    function normalizeComparableProjectPath(projectPath: string): string {
        if (!projectPath) {
            return "";
        }

        try {
            if (isUriString(projectPath)) {
                let uri = vscode.Uri.parse(projectPath);
                if (uri.scheme === "file") {
                    projectPath = uri.fsPath;
                } else {
                    projectPath = `${uri.scheme}://${normalizeRemoteAuthority(uri.authority)}${uri.path}`;
                }
            }
        } catch (e) {
            // Keep the original path and normalize it below.
        }

        return projectPath.replace(/\\/g, '/').replace(/\/+$/g, '');
    }

    async function addToWorkspace(project: Project, uri: vscode.Uri): Promise<void> {
        let wsToAdd: { uri: vscode.Uri, name?: string }[];
        let projectPathType = await fileService.getProjectPathType(uri.fsPath);

        switch (projectPathType) {
            case ProjectPathType.Folder:
                let name = sanitizeProjectName(project.name);
                wsToAdd = [{ uri, name }];
                break;
            case ProjectPathType.WorkspaceFile:
                try {
                    let folderPaths = await fileService.getFoldersFromWorkspaceFile(uri.fsPath);
                    wsToAdd = folderPaths.map(f => ({ uri: vscode.Uri.file(f) }));
                } catch (e) {
                    console.error(e);
                    vscode.window.showErrorMessage("Could not read the project's workspace file.");
                    return;
                }
                break;
            default:
                vscode.window.showInformationMessage("A file project cannot be added to the workspace.");
                return;
        }

        let workspaceFolders = new Set((vscode.workspace.workspaceFolders || []).map(w => path.normalize(w.uri.fsPath)));
        wsToAdd = wsToAdd.filter(ws => {
            return !workspaceFolders.has(path.normalize(ws.uri.fsPath));
        })

        if (!wsToAdd.length) {
            return;
        }

        let isNewWorkSpace = !vscode.workspace.workspaceFile;
        let couldOpen = vscode.workspace.updateWorkspaceFolders(
            workspaceFolders.size,
            null,
            ...wsToAdd,
        );

        if (!couldOpen) {
            vscode.window.showErrorMessage('Could not add project to workspace.');
        } else if (isNewWorkSpace) {
            context.globalState.update(REOPEN_KEY, ReopenStewardReason.EditorReopenedAsWorkspace);
        }
    }

    async function addProject(groupId: string = null) {
        var project: Project, selectedGroupId: string;
        var groupWasNewlyCreated = false;

        try {
            let currentlyOpenPath = getWorkspacePath();
            [project, selectedGroupId, groupWasNewlyCreated] = await queryProjectFields(groupId, false, { path: currentlyOpenPath });
            if (project == null) {
                await saveProject(selectedGroupId, groupWasNewlyCreated);
                return;
            }

            await projectService.addProject(project, selectedGroupId);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while adding the project.`);
                throw error; // Rethrow error to make vscode log it
            }

            return;
        }

        refreshAfterMutation();
    }

    async function saveOpenProject(projectId: string) {
        let uri = getOpenProjectUri(projectId);
        if (uri == null) {
            vscode.window.showWarningMessage("Selected Project not found.");
            return;
        }

        await saveProject(null, false, await getProjectDetailsForSave(uri));
    }

    async function saveProject(groupId: string = null, groupWasNewlyCreated: boolean = false, projectDetails: { path: string, remoteType: ProjectRemoteType } = null) {
        var selectedGroupId: string;

        try {
            let currentProjectDetails = projectDetails || await getCurrentProjectDetailsForSave();
            if (!currentProjectDetails || !currentProjectDetails.path) {
                vscode.window.showWarningMessage("No project is currently open.");
                return;
            }

            let currentlyOpenPath = currentProjectDetails.path;
            let currentRemoteType = currentProjectDetails.remoteType;
            if (currentRemoteType !== ProjectRemoteType.None && !isUriString(currentlyOpenPath) && !currentlyOpenPath.match(WSL_DEFAULT_REGEX)) {
                vscode.window.showErrorMessage("Project Steward could not resolve the current remote project URI. Open this project once from VS Code's recent list, then run Save Project again.");
                return;
            }

            let duplicate = projectService.getProjectsFlat().find(p => p.path === currentlyOpenPath);
            if (duplicate != null) {
                vscode.window.showInformationMessage(`Project "${duplicate.name}" is already saved.`);
                return;
            }

            if (groupId == null) {
                [selectedGroupId, groupWasNewlyCreated] = await queryGroup(null, true);
            } else {
                selectedGroupId = groupId;
            }

            let defaultProjectName = getLastPartOfPath(currentlyOpenPath).replace(/\.code-workspace$/g, '');
            let projectName = await vscode.window.showInputBox({
                value: defaultProjectName || undefined,
                valueSelection: defaultProjectName ? [0, defaultProjectName.length] : undefined,
                placeHolder: 'Project Name',
                ignoreFocusOut: true,
                validateInput: (val: string) => val ? '' : 'A Project Name must be provided.',
            });

            if (!projectName) {
                if (groupWasNewlyCreated) {
                    await projectService.removeGroup(selectedGroupId, true);
                }
                throw new Error(USER_CANCELED);
            }

            let project = new Project(projectName, currentlyOpenPath);
            project.description = await queryProjectDescription();
            project.color = colorService.getRandomColor();
            project.isGitRepo = isFolderGitRepo(currentlyOpenPath);
            project.remoteType = currentRemoteType;

            await projectService.addProject(project, selectedGroupId);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while saving the project.`);
                throw error; // Rethrow error to make vscode log it
            }

            if (groupWasNewlyCreated) {
                await projectService.removeGroup(selectedGroupId, true);
            }

            return;
        }

        refreshAfterMutation();
    }

    async function editProject(projectId: string) {
        var [project, group] = projectService.getProjectAndGroup(projectId);
        if (project == null || group == null) {
            return;
        }

        var editedProject: Project, selectedGroupId: string;
        try {
            [editedProject, selectedGroupId] = await queryProjectFields(group.id, true, project);
            await projectService.updateProject(projectId, editedProject);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while updating project ${project.name}.`);
                throw error;
            }

            return;
        }

        refreshAfterMutation();
    }

    async function editProjectColor(projectId: string) {
        var [project, group] = projectService.getProjectAndGroup(projectId);
        if (project == null || group == null) {
            return;
        }

        try {
            project.color = await queryProjectColor(true, project);
            await projectService.updateProject(projectId, project);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while updating project ${project.name}.`);
                throw error;
            }

            return;
        }

        refreshAfterMutation();
    }

    async function toggleProjectFavorite(projectId: string) {
        var project = projectService.getProject(projectId);
        if (project == null) {
            return;
        }

        project.favorite = !project.favorite;
        await projectService.updateProject(projectId, project);
        refreshAfterMutation();
    }

    async function queryProjectFields(groupId: string = null, isEditing: boolean, projectTemplate: { name?: string, description?: string, path?: string, color?: string, remoteType?: ProjectRemoteType, favorite?: boolean } = null): Promise<[Project, string, boolean]> {
        // For editing a project: Ignore Group selection and take it from template
        var selectedGroupId: string, projectPath: string, defaultProjectName: string, defaultProjectDescription: string;
        var groupWasNewlyCreated = false;

        try {
            if (projectTemplate) {
                projectPath = projectTemplate.path;
                defaultProjectName = projectTemplate.name;
                defaultProjectDescription = projectTemplate.description;
            }

            selectedGroupId = groupId;

            if (!isEditing) {
                // New
                if (selectedGroupId == null) {
                    [selectedGroupId, groupWasNewlyCreated] = await queryGroup(groupId, true);
                }
                projectPath = await queryProjectPath(projectPath);
                if (projectPath === SAVE_CURRENT_PROJECT) {
                    return [null, selectedGroupId, groupWasNewlyCreated];
                }
            }

            defaultProjectName = defaultProjectName || getLastPartOfPath(projectPath).replace(/\.code-workspace$/g, '');

            // Name
            var projectName = await vscode.window.showInputBox({
                value: defaultProjectName || undefined,
                valueSelection: defaultProjectName ? [0, defaultProjectName.length] : undefined,
                placeHolder: 'Project Name',
                ignoreFocusOut: true,
                validateInput: (val: string) => val ? '' : 'A Project Name must be provided.',
            });

            if (!projectName) {
                if (groupWasNewlyCreated) {
                    await projectService.removeGroup(selectedGroupId, true);
                }
                throw new Error(USER_CANCELED);
            }

            let projectDescription = await queryProjectDescription(defaultProjectDescription);

            // Updating path if needed
            if (isEditing) {
                let updatePathPicks = [
                    {
                        id: false,
                        label: "Keep Path",
                    },
                    {
                        id: true,
                        label: "Edit Path"
                    },
                ]
                let updatePath = await vscode.window.showQuickPick(updatePathPicks, {
                    placeHolder: "Edit Path?"
                });

                if (updatePath == null) {
                    throw new Error(USER_CANCELED);
                }

                if (updatePath.id) {
                    projectPath = await queryProjectPath(projectPath);
                }
            }

            // Color
            var color = isEditing ? projectTemplate.color : await queryProjectColor(isEditing, projectTemplate);

            //Test if Git Repo
            let isGitRepo = isFolderGitRepo(projectPath);

            // Save
            let project = new Project(projectName, projectPath, projectDescription);
            project.color = color;
            project.isGitRepo = isGitRepo;
            project.remoteType = projectTemplate?.remoteType;
            project.favorite = projectTemplate?.favorite;

            return [project, selectedGroupId, groupWasNewlyCreated];
        } catch (e) {
            // Cleanup
            if (groupWasNewlyCreated) {
                await projectService.removeGroup(selectedGroupId, true);
            }

            throw e;
        }
    }

    async function queryProjectDescription(defaultText: string = null): Promise<string> {
        let projectDescription = await vscode.window.showInputBox({
            value: defaultText || undefined,
            valueSelection: defaultText ? [0, defaultText.length] : undefined,
            placeHolder: 'Project Description',
            prompt: 'Optional description shown on the project tile.',
            ignoreFocusOut: true,
        });

        if (projectDescription == null) {
            throw new Error(USER_CANCELED);
        }

        return projectDescription.trim();
    }

    async function queryGroup(groupId: string = null, optionForAdding: boolean = false): Promise<[string, boolean]> {
        var groups = projectService.getGroups();

        if (optionForAdding && !groups.length) {
            groupId = 'Add';
        } else {
            // Reorder array to set given group to front (to quickly select it).
            let orderedGroups = groups;
            if (groupId != null) {
                let idx = groups.findIndex(g => g.id === groupId);
                if (idx != null) {
                    orderedGroups = groups.slice();
                    let group = orderedGroups.splice(idx, 1);
                    orderedGroups.unshift(...group);
                }
            }

            let defaultGroupSet = false;
            let groupPicks = orderedGroups.map(group => {
                let label = group.groupName;
                if (!label) {
                    label = defaultGroupSet ? 'Unnamed Group' : 'Default Group';
                    defaultGroupSet = true;
                }

                return {
                    id: group.id,
                    label,
                }
            });

            if (optionForAdding) {
                groupPicks.push({
                    id: "Add",
                    label: "Add new Group",
                });
            }


            let selectedGroupPick = await vscode.window.showQuickPick(groupPicks, {
                placeHolder: "Group"
            });

            if (selectedGroupPick == null) {
                throw new Error(USER_CANCELED);
            }

            groupId = selectedGroupPick.id;

        }

        var newlyCreated = false;
        if (groupId === 'Add') {
            let newGroupName = await vscode.window.showInputBox({
                placeHolder: 'New Group Name',
                ignoreFocusOut: true,
                validateInput: (val: string) => val ? '' : 'A Group Name must be provided.',
            });

            if (newGroupName == null) {
                throw new Error(USER_CANCELED);
            }

            groupId = (await projectService.addGroup(newGroupName)).id;
            newlyCreated = true;
        }

        return [groupId, newlyCreated];
    }

    async function queryProjectPath(defaultPath: string = null): Promise<string> {
        let projectTypePicks = [
            { id: 'save-current', label: 'Save Current Project' },
            { id: 'dir', label: 'Folder Project' },
            { id: 'file', label: 'Workspace or File Project' },
            { id: 'manual', label: `Enter manually` },
            { id: 'ssh', label: `SSH Target ${!stewardInfos.relevantExtensionsInstalls.remoteSSH ? '(Remote Development extension is not installed)' : ''}` },
        ];

        let selectedProjectTypePick = await vscode.window.showQuickPick(projectTypePicks, {
            placeHolder: "Project Type",
        });

        if (selectedProjectTypePick == null) {
            throw new Error(USER_CANCELED);
        }

        switch (selectedProjectTypePick.id) {
            case 'save-current':
                return SAVE_CURRENT_PROJECT;
            case 'dir':
                return await getPathFromPicker(true, defaultPath);
            case 'file':
                return await getPathFromPicker(false, defaultPath);
            case 'manual':
                return await getManualPath(defaultPath);
            case 'ssh':
                return await getSSHPath(defaultPath);
            default:
                throw new Error(USER_CANCELED);
        }
    }

    async function getPathFromPicker(folderProject: boolean, defaultPath: string = null): Promise<string> {
        var defaultUri: vscode.Uri = undefined;
        if (defaultPath) {
            if (!isUriString(defaultPath)) {
                defaultPath = folderProject && fileService.isFile(defaultPath) ? path.dirname(defaultPath) : defaultPath;
            }

            defaultUri = parsePathAsUri(defaultPath);
        }

        // Path
        let selectedProjectUris = await vscode.window.showOpenDialog({
            defaultUri,
            openLabel: `Select ${folderProject ? 'Folder' : 'File'} as Project`,
            canSelectFolders: folderProject,
            canSelectFiles: !folderProject,
            canSelectMany: false,
        });

        if (selectedProjectUris == null || selectedProjectUris[0] == null) {
            throw new Error(USER_CANCELED);
        }

        return uriToProjectPath(selectedProjectUris[0]);
    }

    async function getManualPath(defaultPath: string = null): Promise<string> {
        let manualPath = await vscode.window.showInputBox({
            placeHolder: './',
            value: defaultPath || undefined,
            ignoreFocusOut: true,
            prompt: "Enter absolute or relative path to the project.\nProjects with relative paths can only be opened if a workspace is already open.",
        });

        if (!manualPath) {
            throw new Error(USER_CANCELED);
        }

        return manualPath.trim();
    }

    async function getSSHPath(defaultPath: string = null): Promise<string> {
        if (defaultPath) {
            defaultPath = defaultPath.replace(SSH_REMOTE_PREFIX, '');
        }

        let remotePath = await vscode.window.showInputBox({
            placeHolder: 'user@target.xyz/home/optional-folder',
            value: SSH_REGEX.test(defaultPath) ? defaultPath : undefined,
            ignoreFocusOut: true,
            prompt: "SSH remote, target folder is optional",
            validateInput: (val: string) => SSH_REGEX.test(val) ? '' : 'A valid SSH Target must be proviced',
        });

        if (!remotePath) {
            throw new Error(USER_CANCELED);
        }

        remotePath = `${SSH_REMOTE_PREFIX}${remotePath}`;
        return remotePath.trim();
    }

    function buildColorText(colorCode: string, colorName: string = null): string {
        if (colorCode == null) {
            return "";
        }

        // If color is predefined, use this label only.
        let predefColor = PREDEFINED_COLORS.find(c => c.value === colorCode);
        if (predefColor) {
            return predefColor.label;
        }

        // If it has a color, aggregate colorCode and name
        colorName = colorName || colorService.getColorName(colorCode);
        let colorText = colorName ? `${colorName}    (${colorCode})` : colorCode;

        return colorText;
    }

    async function queryProjectColor(isEditing: boolean, projectTemplate: { color?: string } = null): Promise<string> {
        isEditing = isEditing && projectTemplate != null;

        var color: string = null;
        if (!USE_PROJECT_COLOR) {
            return null;
        }

        if (projectTemplate != null) {
            color = projectTemplate.color;
        }

        // Colors are keyed by label, not by value
        // I tried to key them by their value, but the selected QuickPick was always undefined,
        // even when sanitizing the values (to alphanumeric only)
        let colorPicks = PREDEFINED_COLORS.map(c => ({
            id: c.label,
            label: c.label,
        }));
        colorPicks.unshift({ id: FixedColorOptions.random, label: 'Random Color' });
        colorPicks.unshift({ id: FixedColorOptions.custom, label: '> Custom Color' });
        colorPicks.unshift({ id: FixedColorOptions.recent, label: '> Recent Colors' });

        if (!isEditing || projectTemplate.color) {
            colorPicks.push({ id: FixedColorOptions.none, label: 'None' });
        } else if (isEditing && !projectTemplate.color) {
            colorPicks.unshift({
                id: FixedColorOptions.none,
                label: `Current: None`,
            });
        }

        if (isEditing && projectTemplate.color) {
            // Get existing color name by value
            let color = PREDEFINED_COLORS.find(c => c.value === projectTemplate.color);
            let existingEntryIdx = !color ? -1 : colorPicks.findIndex(p => p.id === color.label);

            // If color is already in quicklist, remove it
            if (existingEntryIdx !== -1) {
                colorPicks.splice(existingEntryIdx, 1)[0];
            }

            colorPicks.unshift({
                id: projectTemplate.color,
                label: `Current: ${buildColorText(projectTemplate.color)}`,
            });
        }

        do {
            color = null;
            let selectedColorPick = await vscode.window.showQuickPick(colorPicks, {
                placeHolder: 'Project Color',
            });

            if (selectedColorPick == null) {
                throw new Error(USER_CANCELED);
            }

            switch (selectedColorPick.id) {
                case FixedColorOptions.custom:
                    let customColor = await vscode.window.showInputBox({
                        placeHolder: '#cc3344   crimson   rgb(68, 145, 203)   linear-gradient(to right, gold, darkorange)',
                        ignoreFocusOut: true,
                        prompt: "Any color name, value or gradient.",
                    });

                    color = (customColor || "").replace(/[;"]/g, "").trim();
                    break;
                case FixedColorOptions.recent:
                    let recentColors = colorService.getRecentColors();
                    let recentColorPicks = recentColors.map(([code, name]) => ({
                        id: code,
                        label: buildColorText(code, name),
                    }));

                    recentColorPicks.unshift({
                        id: null,
                        label: "(Back)",
                    })

                    let selectedRecentColor = await vscode.window.showQuickPick(recentColorPicks, {
                        placeHolder: recentColorPicks.length ? 'Recent Color' : 'No colors have recently been used.',
                        ignoreFocusOut: true,
                    });

                    // if (selectedRecentColor == null) {
                    //     throw new Error(USER_CANCELED);
                    // }
                    if (selectedRecentColor != null) {
                        color = selectedRecentColor.id;
                    }
                    break;
                case FixedColorOptions.none:
                    return null; // Only case to allow null color
                case FixedColorOptions.random:
                    color = colorService.getRandomColor();
                    break;
                default:
                    // PredefinedColor
                    let predefinedColor = PREDEFINED_COLORS.find(c => c.label == selectedColorPick.id || c.value == selectedColorPick.id);
                    if (predefinedColor != null) {
                        color = predefinedColor.value;
                    } else {
                        color = selectedColorPick.id;
                    }
            }
        } while (!color);

        return color;
    }

    async function removeProjectPerCommand() {
        var projects = projectService.getProjectsFlat();
        let projectPicks = projects.map(p => ({ id: p.id, label: p.name }));

        let selectedProjectPick = await vscode.window.showQuickPick(projectPicks);

        if (selectedProjectPick == null)
            return;

        await projectService.removeProject(selectedProjectPick.id)
        showSteward();
    }

    async function editProjectsManuallyPerCommand() {
        var projects = projectService.getGroups();
        const tempFilePath = getGroupsTempFilePath();
        try {
            await fileService.writeTextFile(tempFilePath, JSON.stringify(projects, null, 4));
        } catch (e) {
            vscode.window.showErrorMessage(`Can not write temporary project file under ${tempFilePath}
            ${e.message ? ': ' + e.message : '.'}`);
            return;
        }

        const tempFileUri = vscode.Uri.file(tempFilePath);

        var editProjectsDocument = await vscode.workspace.openTextDocument(tempFileUri);

        await vscode.window.showTextDocument(editProjectsDocument);

        var subscriptions: vscode.Disposable[] = [];
        var editSubscription = vscode.workspace.onWillSaveTextDocument(async (e) => {
            if (e.document == editProjectsDocument) {
                let updatedGroups;
                try {
                    var text = e.document.getText() || "[]";
                    updatedGroups = JSON.parse(text);
                } catch (ex) {
                    vscode.window.showErrorMessage("Edited Projects File can not be parsed.")
                    return;
                }

                // Validate and Cleanup
                var jsonIsInvalid = false;
                if (Array.isArray(updatedGroups)) {
                    for (let group of updatedGroups) {
                        if (group.name && !group.groupName) {
                            // One of the testers produced a group with any groupName
                            // We could not reproduce that, but this may be a result from updating legacy groups
                            // This should fix that issue
                            group.groupName = group.name;
                            delete group.name;
                        }

                        if (group && group.groupName == null && (group.projects == null || !group.projects.length)) {
                            // Remove empty, unnamed group
                            group._delete = true;
                        } else if (!group || !group.id || group.groupName == undefined || !group.projects || !Array.isArray(group.projects)) {
                            jsonIsInvalid = true;
                            break;
                        } else {
                            for (let project of group.projects) {
                                if (!project || !project.id || !project.name || !project.path) {
                                    jsonIsInvalid = true;
                                    break;
                                }

                                // Remove obsolete properties
                                delete project.imageFileName;
                            }
                        }
                    }
                } else {
                    jsonIsInvalid = true;
                }

                if (jsonIsInvalid) {
                    vscode.window.showErrorMessage("Edited Projects File does not meet the schema expected by Project Steward.");
                    return;
                }

                updatedGroups = updatedGroups.filter(g => !g._delete);

                await projectService.saveGroups(updatedGroups);

                subscriptions.forEach(s => s.dispose());

                // Select and close our document editor
                try {
                    await vscode.window.showTextDocument(e.document);
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
                } catch (e) {
                    vscode.window.showErrorMessage("Could not close the edited Projects File. Please close manually.")
                }

                showSteward();

            }
        });
        subscriptions.push(editSubscription);
    }

    async function removeProject(projectId: string) {
        var project = projectService.getProject(projectId);
        if (project == null) {
            return;
        }

        let accepted = await vscode.window.showWarningMessage(`Remove ${project.name}?`, { modal: true }, 'Remove');
        if (!accepted) {
            return;
        }

        await projectService.removeProject(projectId);
        refreshAfterMutation();
    }

    async function reorderGroups(groupOrders: GroupOrder[]) {
        var groups = projectService.getGroups();

        if (groupOrders == null) {
            vscode.window.showInformationMessage('Invalid Argument passed to Reordering Projects.');
            return;
        }


        // Map projects by id for easier access
        var projectMap = new Map<string, Project>();
        for (let group of groups) {
            if (group.projects == null) {
                continue;
            }

            for (let project of group.projects) {
                projectMap.set(project.id, project);
            }
        }

        // Build new, reordered projects group array
        var reorderedGroups: Group[] = [];
        for (let { groupId, projectIds } of groupOrders) {
            let group = groups.find(g => g.id === groupId);
            if (group == null) {
                group = new Group("Group #" + (reorderedGroups.length + 1));
            }

            group.projects = projectIds.map(pid => projectMap.get(pid)).filter(p => p != null);
            reorderedGroups.push(group);
        }

        await projectService.saveGroups(reorderedGroups);
        refreshAfterMutation();
    }

    function isFolderGitRepo(fPath: string) {
        if (isUriString(fPath)) {
            return false;
        }

        try {
            fPath = lstatSync(fPath).isDirectory() ? fPath : path.dirname(fPath);
            var test = execSync(`cd ${fPath} && git rev-parse --is-inside-work-tree`, { encoding: 'utf8' });
            return !!test;
        } catch (e) {
            return false;
        }
    }

    function getGroupsTempFilePath(): string {
        var savePath = context.globalStoragePath;
        return `${savePath}/Project Steward Projects.json`;
    }

    function getLastPartOfPath(path: string): string {
        if (!path) {
            return "";
        }

        if (isUriString(path)) {
            try {
                path = vscode.Uri.parse(path).path || path;
            } catch (e) {
                // Keep the original path and fall back to the legacy parsing below.
            }
        }

        // get last folder of filename of path/remote
        path = path.replace(REMOTE_REGEX, ''); // Remove remote prefix
        path = path.replace(/^\w+\@/, ''); // Remove Username
        let lastPart = path.replace(/^[\\\/]|[\\\/]$/g, '').replace(/^.*[\\\/]/, '');

        return lastPart;
    }

    function getOpenProjects(): Project[] {
        let workspaceFile = vscode.workspace.workspaceFile;
        let openProjects: Project[];
        if (workspaceFile && workspaceFile.scheme !== "untitled") {
            openProjects = [buildOpenProject(workspaceFile, 0, "Current workspace")];
        } else {
            openProjects = (vscode.workspace.workspaceFolders || [])
                .map((folder, index) => buildOpenProject(folder.uri, index, "Workspace folder", folder.name));
        }

        return withAiSessions(openProjects);
    }

    function getOpenProjectUri(projectId: string): vscode.Uri {
        let prefix = `${OPEN_PROJECTS_GROUP_ID}-`;
        if (!projectId || !projectId.startsWith(prefix)) {
            return null;
        }

        let index = Number(projectId.substring(prefix.length));
        if (!Number.isInteger(index) || index < 0) {
            return null;
        }

        let workspaceFile = vscode.workspace.workspaceFile;
        if (workspaceFile && workspaceFile.scheme !== "untitled") {
            return index === 0 ? workspaceFile : null;
        }

        return (vscode.workspace.workspaceFolders || [])[index]?.uri || null;
    }

    function buildOpenProject(uri: vscode.Uri, index: number, description: string, name: string = null): Project {
        let projectPath = uriToProjectPath(uri);
        let savedProject = findSavedProjectForOpenProject(uri);
        let projectName = savedProject?.name || name || getLastPartOfPath(projectPath).replace(/\.code-workspace$/g, '') || "Workspace";
        let projectDescription = savedProject ? savedProject.description : description;
        let project = new Project(projectName, projectPath, projectDescription);
        project.id = `${OPEN_PROJECTS_GROUP_ID}-${index}`;
        project.color = savedProject?.color || "var(--vscode-focusBorder)";
        project.favorite = savedProject?.favorite;
        project.showSaveAction = savedProject == null;
        project.isGitRepo = isFolderGitRepo(projectPath);
        project.remoteType = savedProject?.remoteType ?? (savedProject ? getRemoteType(savedProject) : getRemoteTypeFromRemoteName(vscode.env.remoteName));

        return project;
    }

    function withAiSessions(openProjects: Project[]): Project[] {
        if (!openProjects.length) {
            return openProjects;
        }

        let codexSessionResult = codexSessionService.getSessions();
        let kimiSessionResult = kimiSessionService.getSessions();
        let claudeSessionResult = claudeSessionService.getSessions();
        resolvePendingAiSessionTerminals(codexSessionResult, kimiSessionResult, claudeSessionResult);
        let codexAssignments = getCodexSessionAssignments(openProjects, codexSessionResult);
        let kimiAssignments = getKimiSessionAssignments(openProjects, kimiSessionResult);
        let claudeAssignments = getClaudeSessionAssignments(openProjects, claudeSessionResult);
        let expandedProjects = getExpandedCodexSessionProjects();
        let activeProviders = getActiveAiSessionProviders();
        let pinnedSessions = prunePinnedAiSessionKeys(getPinnedAiSessionKeys(), codexSessionResult, kimiSessionResult, claudeSessionResult);
        let aliases = pruneAiSessionAliases(getAiSessionAliases(), codexSessionResult, kimiSessionResult, claudeSessionResult);

        return openProjects.map(project => {
            project.codexSessions = prepareAiSessionsForDisplay(codexAssignments.get(project.id) || [], 'codex', pinnedSessions, aliases);
            project.kimiSessions = prepareAiSessionsForDisplay(kimiAssignments.get(project.id) || [], 'kimi', pinnedSessions, aliases);
            project.claudeSessions = prepareAiSessionsForDisplay(claudeAssignments.get(project.id) || [], 'claude', pinnedSessions, aliases);
            project.codexSessionsUnavailable = !codexSessionResult.available;
            project.kimiSessionsUnavailable = !kimiSessionResult.available;
            project.claudeSessionsUnavailable = !claudeSessionResult.available;
            project.codexSessionsExpanded = expandedProjects.has(getOpenProjectCodexExpansionKey(project));
            project.activeAiSessionProvider = getActiveAiSessionProvider(project, activeProviders);
            return project;
        });
    }

    function getCodexSessionAssignments(openProjects: Project[], codexSessionResult: CodexSessionReadResult): Map<string, CodexSession[]> {
        let assignments = new Map<string, CodexSession[]>();
        if (!codexSessionResult.available || !codexSessionResult.sessions.length) {
            return assignments;
        }

        let candidates = getCodexOpenProjectCandidates(openProjects);

        for (let session of codexSessionResult.sessions) {
            let sessionPath = normalizeCodexComparablePath(session.cwd);
            if (!sessionPath) {
                continue;
            }

            let bestMatch = candidates
                .filter(candidate => codexPathContainsSessionPath(candidate.path, sessionPath))
                .sort((a, b) => b.path.length - a.path.length)[0];

            if (!bestMatch) {
                continue;
            }

            let projectSessions = assignments.get(bestMatch.project.id) || [];
            projectSessions.push(session);
            assignments.set(bestMatch.project.id, projectSessions);
        }

        return assignments;
    }

    function getKimiSessionAssignments(openProjects: Project[], kimiSessionResult: KimiSessionReadResult): Map<string, CodexSession[]> {
        let assignments = new Map<string, CodexSession[]>();
        if (!kimiSessionResult.available || !kimiSessionResult.sessions.length) {
            return assignments;
        }

        let candidates = getCodexOpenProjectCandidates(openProjects);

        for (let session of kimiSessionResult.sessions) {
            let sessionPath = normalizeCodexComparablePath(session.workDir || session.cwd);
            if (!sessionPath) {
                continue;
            }

            let bestMatch = candidates
                .filter(candidate => codexPathContainsSessionPath(candidate.path, sessionPath))
                .sort((a, b) => b.path.length - a.path.length)[0];

            if (!bestMatch) {
                continue;
            }

            let projectSessions = assignments.get(bestMatch.project.id) || [];
            projectSessions.push(session);
            assignments.set(bestMatch.project.id, projectSessions);
        }

        return assignments;
    }

    function getClaudeSessionAssignments(openProjects: Project[], claudeSessionResult: ClaudeSessionReadResult): Map<string, CodexSession[]> {
        let assignments = new Map<string, CodexSession[]>();
        if (!claudeSessionResult.available || !claudeSessionResult.sessions.length) {
            return assignments;
        }

        let candidates = getCodexOpenProjectCandidates(openProjects);

        for (let session of claudeSessionResult.sessions) {
            let sessionPath = normalizeCodexComparablePath(session.workDir || session.cwd);
            if (!sessionPath) {
                continue;
            }

            let bestMatch = candidates
                .filter(candidate => codexPathContainsSessionPath(candidate.path, sessionPath))
                .sort((a, b) => b.path.length - a.path.length)[0];

            if (!bestMatch) {
                continue;
            }

            let projectSessions = assignments.get(bestMatch.project.id) || [];
            projectSessions.push(session);
            assignments.set(bestMatch.project.id, projectSessions);
        }

        return assignments;
    }

    function prepareAiSessionsForDisplay(sessions: CodexSession[], providerId: AiSessionProviderId, pinnedSessions: Set<string>, aliases: Record<string, string>): CodexSession[] {
        let sortedSessions = sessions
            .map(session => ({
                ...session,
                name: aliases[getAiSessionPinKey(providerId, session.id)] || session.name,
                provider: providerId,
                pinned: pinnedSessions.has(getAiSessionPinKey(providerId, session.id)),
            }))
            .sort((a, b) => {
                if (a.pinned !== b.pinned) {
                    return a.pinned ? -1 : 1;
                }

                return compareAiSessionUpdatedAt(b.updatedAt, a.updatedAt);
            });

        let pinned = sortedSessions.filter(session => session.pinned);
        let recent = sortedSessions.filter(session => !session.pinned).slice(0, Math.max(20 - pinned.length, 0));

        return pinned.concat(recent);
    }

    function compareAiSessionUpdatedAt(a: string, b: string): number {
        let aTime = a ? Date.parse(a) : 0;
        let bTime = b ? Date.parse(b) : 0;

        if (isNaN(aTime) && isNaN(bTime)) {
            return 0;
        }

        if (isNaN(aTime)) {
            return -1;
        }

        if (isNaN(bTime)) {
            return 1;
        }

        return aTime - bTime;
    }

    function getPinnedAiSessionKeys(): Set<string> {
        let pinnedSessions = context.globalState.get(OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY) as string[];
        return new Set(Array.isArray(pinnedSessions) ? pinnedSessions : []);
    }

    function getAiSessionIdsForCwd(sessionResult: CodexSessionReadResult | KimiSessionReadResult | ClaudeSessionReadResult, cwd: string): string[] {
        let comparableCwd = normalizeCodexComparablePath(cwd);
        if (!sessionResult.available || !comparableCwd) {
            return [];
        }

        return sessionResult.sessions
            .filter(session => normalizeCodexComparablePath(session.workDir || session.cwd) === comparableCwd)
            .map(session => session.id)
            .filter(id => !!id);
    }

    function trackPendingAiSessionTerminal(providerId: AiSessionProviderId, terminal: vscode.Terminal, markerPath: string, cwd: string, createdAt: string, excludedSessionIds: string[], title: string = null) {
        let comparableCwd = normalizeCodexComparablePath(cwd);
        if (!terminal || !markerPath || !comparableCwd) {
            return;
        }

        pendingAiSessionTerminals.push({
            provider: providerId,
            terminal,
            markerPath,
            cwd: comparableCwd,
            createdAt,
            excludedSessionIds: Array.isArray(excludedSessionIds) ? excludedSessionIds.filter(id => !!id) : [],
            title: sanitizeAiSessionAlias(title),
        });
        pendingAiSessionTerminals = trimPendingAiSessionTerminals(pendingAiSessionTerminals);
    }

    function trimPendingAiSessionTerminals(pendingTerminals: PendingAiSessionTerminal[]): PendingAiSessionTerminal[] {
        let cutoff = Date.now() - PENDING_AI_SESSION_TERMINAL_TTL_MS;
        return pendingTerminals.filter(entry => {
            return entry
                && entry.terminal
                && !!entry.markerPath
                && !!entry.cwd
                && !!entry.createdAt
                && !isNaN(Date.parse(entry.createdAt))
                && Date.parse(entry.createdAt) >= cutoff;
        });
    }

    function resolvePendingAiSessionTerminals(codexSessionResult: CodexSessionReadResult, kimiSessionResult: KimiSessionReadResult, claudeSessionResult: ClaudeSessionReadResult) {
        if (!pendingAiSessionTerminals.length) {
            return;
        }

        let remainingPendingTerminals: PendingAiSessionTerminal[] = [];
        let claimedSessionKeys = getTrackedAiSessionTerminalKeys();

        for (let pendingTerminal of trimPendingAiSessionTerminals(pendingAiSessionTerminals)) {
            let sessionResult = pendingTerminal.provider === 'codex'
                ? codexSessionResult
                : pendingTerminal.provider === 'claude'
                    ? claudeSessionResult
                    : kimiSessionResult;
            let session = findPendingAiSessionTerminalMatch(pendingTerminal, sessionResult, claimedSessionKeys);
            if (!session) {
                remainingPendingTerminals.push(pendingTerminal);
                continue;
            }

            let entry = {
                terminal: pendingTerminal.terminal,
                markerPath: pendingTerminal.markerPath,
            };
            if (pendingTerminal.provider === 'codex') {
                codexSessionTerminals.set(session.id, entry);
            } else if (pendingTerminal.provider === 'claude') {
                claudeSessionTerminals.set(session.id, entry);
            } else {
                kimiSessionTerminals.set(session.id, entry);
            }
            setAiSessionAlias(pendingTerminal.provider, session.id, pendingTerminal.title);
            claimedSessionKeys.add(getAiSessionPinKey(pendingTerminal.provider, session.id));
        }

        pendingAiSessionTerminals = remainingPendingTerminals;
    }

    function getTrackedAiSessionTerminalKeys(): Set<string> {
        let sessionKeys = new Set<string>();
        for (let sessionId of codexSessionTerminals.keys()) {
            sessionKeys.add(getAiSessionPinKey('codex', sessionId));
        }
        for (let sessionId of kimiSessionTerminals.keys()) {
            sessionKeys.add(getAiSessionPinKey('kimi', sessionId));
        }
        for (let sessionId of claudeSessionTerminals.keys()) {
            sessionKeys.add(getAiSessionPinKey('claude', sessionId));
        }

        return sessionKeys;
    }

    function findPendingAiSessionTerminalMatch(pendingTerminal: PendingAiSessionTerminal, sessionResult: CodexSessionReadResult | KimiSessionReadResult | ClaudeSessionReadResult, claimedSessionKeys: Set<string>): CodexSession {
        if (!sessionResult.available) {
            return null;
        }

        let createdAt = Date.parse(pendingTerminal.createdAt);
        return sessionResult.sessions
            .filter(session => {
                let sessionKey = getAiSessionPinKey(pendingTerminal.provider, session.id);
                let sessionCwd = normalizeCodexComparablePath(session.workDir || session.cwd);
                let updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
                return sessionCwd === pendingTerminal.cwd
                    && !pendingTerminal.excludedSessionIds.includes(session.id)
                    && !claimedSessionKeys.has(sessionKey)
                    && !isNaN(updatedAt)
                    && updatedAt >= createdAt;
            })
            .sort((a, b) => compareAiSessionUpdatedAt(a.updatedAt, b.updatedAt))[0] || null;
    }

    function prunePinnedAiSessionKeys(pinnedSessions: Set<string>, codexSessionResult: CodexSessionReadResult, kimiSessionResult: KimiSessionReadResult, claudeSessionResult: ClaudeSessionReadResult): Set<string> {
        if (!pinnedSessions.size) {
            return pinnedSessions;
        }

        let availableSessionKeys = new Set<string>();
        addAvailableAiSessionKeys(availableSessionKeys, 'codex', codexSessionResult.available, codexSessionResult.sessions);
        addAvailableAiSessionKeys(availableSessionKeys, 'kimi', kimiSessionResult.available, kimiSessionResult.sessions);
        addAvailableAiSessionKeys(availableSessionKeys, 'claude', claudeSessionResult.available, claudeSessionResult.sessions);

        let prunedPinnedSessions = new Set<string>();
        for (let sessionKey of pinnedSessions) {
            let providerId = getProviderIdFromAiSessionPinKey(sessionKey);
            let providerUnavailable = providerId === 'codex'
                ? !codexSessionResult.available
                : providerId === 'kimi'
                    ? !kimiSessionResult.available
                    : providerId === 'claude'
                        ? !claudeSessionResult.available
                        : false;
            if (providerUnavailable || availableSessionKeys.has(sessionKey)) {
                prunedPinnedSessions.add(sessionKey);
            }
        }

        if (prunedPinnedSessions.size !== pinnedSessions.size) {
            context.globalState.update(OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY, Array.from(prunedPinnedSessions));
        }

        return prunedPinnedSessions;
    }

    function addAvailableAiSessionKeys(sessionKeys: Set<string>, providerId: AiSessionProviderId, available: boolean, sessions: CodexSession[]) {
        if (!available) {
            return;
        }

        for (let session of sessions) {
            sessionKeys.add(getAiSessionPinKey(providerId, session.id));
        }
    }

    function getAiSessionPinKey(providerId: AiSessionProviderId, sessionId: string): string {
        return `${providerId}:${sessionId}`;
    }

    function getAiSessionAliasesPath(): string {
        mkdirSync(context.globalStoragePath, { recursive: true });
        return path.join(context.globalStoragePath, AI_SESSION_ALIASES_FILE_NAME);
    }

    function getAiSessionAliases(): Record<string, string> {
        try {
            let aliasesPath = getAiSessionAliasesPath();
            if (!existsSync(aliasesPath)) {
                return {};
            }

            let aliases = JSON.parse(readFileSync(aliasesPath, 'utf8'));
            if (aliases == null || typeof aliases !== 'object' || Array.isArray(aliases)) {
                return {};
            }

            return Object.keys(aliases).reduce((result, key) => {
                if (typeof aliases[key] === 'string' && aliases[key].trim()) {
                    result[key] = aliases[key];
                }

                return result;
            }, {} as Record<string, string>);
        } catch (error) {
            logError('Failed to read AI session aliases.', error);
            return {};
        }
    }

    function pruneAiSessionAliases(aliases: Record<string, string>, codexSessionResult: CodexSessionReadResult, kimiSessionResult: KimiSessionReadResult, claudeSessionResult: ClaudeSessionReadResult): Record<string, string> {
        if (!Object.keys(aliases).length) {
            return aliases;
        }

        let availableSessionKeys = new Set<string>();
        addAvailableAiSessionKeys(availableSessionKeys, 'codex', codexSessionResult.available, codexSessionResult.sessions);
        addAvailableAiSessionKeys(availableSessionKeys, 'kimi', kimiSessionResult.available, kimiSessionResult.sessions);
        addAvailableAiSessionKeys(availableSessionKeys, 'claude', claudeSessionResult.available, claudeSessionResult.sessions);

        let prunedAliases: Record<string, string> = {};
        for (let sessionKey of Object.keys(aliases)) {
            let providerId = getProviderIdFromAiSessionPinKey(sessionKey);
            let providerUnavailable = providerId === 'codex'
                ? !codexSessionResult.available
                : providerId === 'kimi'
                    ? !kimiSessionResult.available
                    : providerId === 'claude'
                        ? !claudeSessionResult.available
                        : false;
            if (providerUnavailable || availableSessionKeys.has(sessionKey)) {
                prunedAliases[sessionKey] = aliases[sessionKey];
            }
        }

        if (Object.keys(prunedAliases).length !== Object.keys(aliases).length) {
            saveAiSessionAliases(prunedAliases);
        }

        return prunedAliases;
    }

    function saveAiSessionAliases(aliases: Record<string, string>) {
        try {
            writeFileSync(getAiSessionAliasesPath(), JSON.stringify(aliases, null, 2), 'utf8');
        } catch (error) {
            logError('Failed to save AI session aliases.', error);
            vscode.window.showErrorMessage("Could not save the chat name.");
        }
    }

    function deleteAiSessionAlias(providerId: AiSessionProviderId, sessionId: string) {
        let aliases = getAiSessionAliases();
        let sessionKey = getAiSessionPinKey(providerId, sessionId);
        if (!aliases[sessionKey]) {
            return;
        }

        delete aliases[sessionKey];
        saveAiSessionAliases(aliases);
    }

    function setAiSessionAlias(providerId: AiSessionProviderId, sessionId: string, alias: string) {
        alias = sanitizeAiSessionAlias(alias);
        if (!isAiSessionProviderId(providerId) || !sessionId || !alias) {
            return;
        }

        let aliases = getAiSessionAliases();
        aliases[getAiSessionPinKey(providerId, sessionId)] = alias;
        saveAiSessionAliases(aliases);
    }

    function getAiSessionOriginalName(providerId: AiSessionProviderId, sessionId: string): string {
        let sessionResult = providerId === 'kimi'
            ? kimiSessionService.getSessions()
            : providerId === 'claude'
                ? claudeSessionService.getSessions()
                : codexSessionService.getSessions();
        let session = sessionResult.sessions.find(candidate => candidate.id === sessionId);

        return session?.name || sessionId;
    }

    function sanitizeAiSessionAlias(value: string): string {
        return String(value || '').replace(/[\r\n]+/g, ' ').trim();
    }

    function getProviderIdFromAiSessionPinKey(sessionKey: string): AiSessionProviderId {
        let separatorIndex = sessionKey.indexOf(':');
        if (separatorIndex === -1) {
            return null;
        }

        let providerId = sessionKey.substring(0, separatorIndex);
        return isAiSessionProviderId(providerId) ? providerId : null;
    }

    function getActiveAiSessionProviders(): Record<string, AiSessionProviderId> {
        let selectedProviders = context.globalState.get(OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY) as Record<string, AiSessionProviderId>;
        if (!selectedProviders || typeof selectedProviders !== 'object' || Array.isArray(selectedProviders)) {
            return {};
        }

        return selectedProviders;
    }

    function getActiveAiSessionProvider(project: Project, activeProviders: Record<string, AiSessionProviderId>): AiSessionProviderId {
        let selectedProvider = activeProviders[getOpenProjectCodexExpansionKey(project)];
        if (isAiSessionProviderId(selectedProvider)) {
            return selectedProvider;
        }

        if (project.codexSessions?.length) {
            return 'codex';
        }

        if (project.kimiSessions?.length) {
            return 'kimi';
        }

        if (project.claudeSessions?.length) {
            return 'claude';
        }

        return 'codex';
    }

    function getAiSessionProviderLabel(providerId: AiSessionProviderId): string {
        switch (providerId) {
            case 'kimi':
                return 'Kimi';
            case 'claude':
                return 'Claude';
            default:
                return 'Codex';
        }
    }

    function getCodexOpenProjectCandidates(openProjects: Project[]): { project: Project, path: string }[] {
        let candidates: { project: Project, path: string }[] = [];
        let addCandidate = (project: Project, projectPath: string) => {
            let normalizedPath = normalizeCodexComparablePath(getProjectPathPart(projectPath));
            if (!normalizedPath) {
                return;
            }

            if (candidates.some(candidate => candidate.project.id === project.id && candidate.path === normalizedPath)) {
                return;
            }

            candidates.push({ project, path: normalizedPath });
        };

        for (let project of openProjects) {
            addCandidate(project, project.path);
        }

        let workspaceFile = vscode.workspace.workspaceFile;
        if (workspaceFile && workspaceFile.scheme !== "untitled") {
            let workspaceProject = openProjects.find(project => normalizeComparableProjectPath(project.path) === normalizeComparableProjectPath(uriToProjectPath(workspaceFile))) || openProjects[0];
            for (let workspaceFolder of vscode.workspace.workspaceFolders || []) {
                addCandidate(workspaceProject, uriToProjectPath(workspaceFolder.uri));
            }
        }

        return candidates;
    }

    function codexPathContainsSessionPath(projectPath: string, sessionPath: string): boolean {
        if (!projectPath || !sessionPath) {
            return false;
        }

        return sessionPath === projectPath || sessionPath.startsWith(`${projectPath}/`);
    }

    function normalizeCodexComparablePath(projectPath: string): string {
        if (!projectPath) {
            return "";
        }

        return decodeProjectPath(projectPath)
            .replace(/\\/g, '/')
            .replace(/\/+$/g, '');
    }

    function decodeProjectPath(projectPath: string): string {
        try {
            return decodeURIComponent(projectPath);
        } catch (e) {
            return projectPath;
        }
    }

    function getExpandedCodexSessionProjects(): Set<string> {
        let expandedProjects = context.globalState.get(OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY) as string[];
        return new Set(Array.isArray(expandedProjects) ? expandedProjects : []);
    }

    function getOpenProjectCodexExpansionKey(project: Project): string {
        return normalizeCodexComparablePath(getProjectPathPart(project.path)) || project.id;
    }

    function getCodexSessionTerminalCwd(session: CodexSession, project: Project): string {
        return session.cwd || normalizeCodexComparablePath(getProjectPathPart(project.path)) || null;
    }

    function getCodexSessionTerminal(session: CodexSession): CodexSessionTerminalEntry {
        return getCodexSessionTerminalById(session.id, session);
    }

    function getCodexSessionTerminalById(sessionId: string, session: CodexSession = null): CodexSessionTerminalEntry {
        let trackedTerminal = codexSessionTerminals.get(sessionId);
        if (trackedTerminal) {
            return trackedTerminal;
        }

        let terminal = vscode.window.terminals.find(candidate => terminalMatchesCodexSession(candidate, sessionId));
        if (!terminal) {
            return null;
        }

        let entry = {
            terminal,
            markerPath: getCodexSessionTerminalMarkerPath(sessionId),
        };
        codexSessionTerminals.set(sessionId, entry);

        return entry;
    }

    function terminalMatchesCodexSession(terminal: vscode.Terminal, sessionId: string): boolean {
        let creationOptions = terminal.creationOptions;
        if ('env' in creationOptions && creationOptions.env?.[CODEX_SESSION_TERMINAL_ENV] === sessionId) {
            return true;
        }

        return terminal.name.startsWith(`${CODEX_SESSION_TERMINAL_NAME_PREFIX}: `)
            && terminal.name.endsWith(` [${sessionId.substring(0, 8)}]`);
    }

    function getCodexSessionTerminalName(session: CodexSession): string {
        return `${CODEX_SESSION_TERMINAL_NAME_PREFIX}: ${session.name || session.id} [${session.id.substring(0, 8)}]`;
    }

    function getKimiSessionTerminalCwd(session: CodexSession, project: Project): string {
        return session.workDir || session.cwd || normalizeCodexComparablePath(getProjectPathPart(project.path)) || null;
    }

    function getOpenProjectTerminalCwd(project: Project): string {
        return normalizeCodexComparablePath(getProjectPathPart(project.path)) || null;
    }

    function getKimiSessionTerminal(session: CodexSession): CodexSessionTerminalEntry {
        return getKimiSessionTerminalById(session.id, session);
    }

    function getKimiSessionTerminalById(sessionId: string, session: CodexSession = null): CodexSessionTerminalEntry {
        let trackedTerminal = kimiSessionTerminals.get(sessionId);
        if (trackedTerminal) {
            return trackedTerminal;
        }

        let terminal = vscode.window.terminals.find(candidate => terminalMatchesKimiSession(candidate, sessionId));
        if (!terminal) {
            return null;
        }

        let entry = {
            terminal,
            markerPath: getKimiSessionTerminalMarkerPath(sessionId),
        };
        kimiSessionTerminals.set(sessionId, entry);

        return entry;
    }

    function terminalMatchesKimiSession(terminal: vscode.Terminal, sessionId: string): boolean {
        let creationOptions = terminal.creationOptions;
        if ('env' in creationOptions && creationOptions.env?.[KIMI_SESSION_TERMINAL_ENV] === sessionId) {
            return true;
        }

        return terminal.name.startsWith(`${KIMI_SESSION_TERMINAL_NAME_PREFIX}: `)
            && terminal.name.endsWith(` [${sessionId.substring(0, 8)}]`);
    }

    function getKimiSessionTerminalName(session: CodexSession): string {
        return `${KIMI_SESSION_TERMINAL_NAME_PREFIX}: ${session.name || session.id} [${session.id.substring(0, 8)}]`;
    }

    function getClaudeSessionTerminalCwd(session: CodexSession, project: Project): string {
        return session.workDir || session.cwd || normalizeCodexComparablePath(getProjectPathPart(project.path)) || null;
    }

    function getClaudeSessionTerminal(session: CodexSession): CodexSessionTerminalEntry {
        return getClaudeSessionTerminalById(session.id, session);
    }

    function getClaudeSessionTerminalById(sessionId: string, session: CodexSession = null): CodexSessionTerminalEntry {
        let trackedTerminal = claudeSessionTerminals.get(sessionId);
        if (trackedTerminal) {
            return trackedTerminal;
        }

        let terminal = vscode.window.terminals.find(candidate => terminalMatchesClaudeSession(candidate, sessionId));
        if (!terminal) {
            return null;
        }

        let entry = {
            terminal,
            markerPath: getClaudeSessionTerminalMarkerPath(sessionId),
        };
        claudeSessionTerminals.set(sessionId, entry);

        return entry;
    }

    function terminalMatchesClaudeSession(terminal: vscode.Terminal, sessionId: string): boolean {
        let creationOptions = terminal.creationOptions;
        if ('env' in creationOptions && creationOptions.env?.[CLAUDE_SESSION_TERMINAL_ENV] === sessionId) {
            return true;
        }

        return terminal.name.startsWith(`${CLAUDE_SESSION_TERMINAL_NAME_PREFIX}: `)
            && terminal.name.endsWith(` [${sessionId.substring(0, 8)}]`);
    }

    function getClaudeSessionTerminalName(session: CodexSession): string {
        return `${CLAUDE_SESSION_TERMINAL_NAME_PREFIX}: ${session.name || session.id} [${session.id.substring(0, 8)}]`;
    }

    function getUsableTerminalCwd(cwd: string): string {
        if (!cwd || isUriString(cwd)) {
            return null;
        }

        try {
            return lstatSync(cwd).isDirectory() ? cwd : path.dirname(cwd);
        } catch (e) {
            return null;
        }
    }

    async function sendCodexResumeCommand(terminal: vscode.Terminal, sessionId: string, cwd: string, markerPath: string) {
        deleteCodexSessionTerminalMarker({ terminal, markerPath });
        await waitForTerminalReady(terminal);
        terminal.sendText(buildCodexResumeCommand(sessionId, cwd, markerPath));
    }

    async function sendKimiResumeCommand(terminal: vscode.Terminal, sessionId: string, cwd: string, markerPath: string) {
        deleteKimiSessionTerminalMarker({ terminal, markerPath });
        await waitForTerminalReady(terminal);
        terminal.sendText(buildKimiResumeCommand(sessionId, cwd, markerPath));
    }

    async function sendClaudeResumeCommand(terminal: vscode.Terminal, sessionId: string, cwd: string, markerPath: string) {
        deleteClaudeSessionTerminalMarker({ terminal, markerPath });
        await waitForTerminalReady(terminal);
        terminal.sendText(buildClaudeResumeCommand(sessionId, cwd, markerPath));
    }

    async function waitForTerminalReady(terminal: vscode.Terminal) {
        try {
            await terminal.processId;
            await new Promise(resolve => setTimeout(resolve, CODEX_SESSION_TERMINAL_STARTUP_DELAY_MS));
        } catch (e) {
            // Best effort only; sendText can still work if VS Code cannot resolve the process id.
        }
    }

    function isCodexSessionTerminalComplete(entry: CodexSessionTerminalEntry): boolean {
        return existsSync(entry.markerPath);
    }

    function isKimiSessionTerminalComplete(entry: CodexSessionTerminalEntry): boolean {
        return existsSync(entry.markerPath);
    }

    function isClaudeSessionTerminalComplete(entry: CodexSessionTerminalEntry): boolean {
        return existsSync(entry.markerPath);
    }

    function getCodexSessionTerminalMarkerPath(sessionId: string): string {
        let markerDir = path.join(context.globalStoragePath, 'codex-session-terminals');
        try {
            mkdirSync(markerDir, { recursive: true });
        } catch (e) {
            // Fall through; the terminal command will still run without relying on the marker.
        }

        return path.join(markerDir, `${sessionId}.done`);
    }

    function getKimiSessionTerminalMarkerPath(sessionId: string): string {
        let markerDir = path.join(context.globalStoragePath, 'kimi-session-terminals');
        try {
            mkdirSync(markerDir, { recursive: true });
        } catch (e) {
            // Fall through; the terminal command will still run without relying on the marker.
        }

        return path.join(markerDir, `${sessionId}.done`);
    }

    function getClaudeSessionTerminalMarkerPath(sessionId: string): string {
        let markerDir = path.join(context.globalStoragePath, 'claude-session-terminals');
        try {
            mkdirSync(markerDir, { recursive: true });
        } catch (e) {
            // Fall through; the terminal command will still run without relying on the marker.
        }

        return path.join(markerDir, `${sessionId}.done`);
    }

    function getPendingAiSessionTerminalMarkerPath(providerId: AiSessionProviderId): string {
        let markerDir = path.join(context.globalStoragePath, 'pending-ai-session-terminals');
        try {
            mkdirSync(markerDir, { recursive: true });
        } catch (e) {
            // Fall through; the terminal command will still run without relying on the marker.
        }

        let uniqueId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return path.join(markerDir, `${providerId}-${uniqueId}.done`);
    }

    function deleteCodexSessionTerminalMarker(entry: CodexSessionTerminalEntry) {
        deleteAiSessionTerminalMarker(entry.markerPath);
    }

    function deleteKimiSessionTerminalMarker(entry: CodexSessionTerminalEntry) {
        deleteAiSessionTerminalMarker(entry.markerPath);
    }

    function deleteClaudeSessionTerminalMarker(entry: CodexSessionTerminalEntry) {
        deleteAiSessionTerminalMarker(entry.markerPath);
    }

    function deleteAiSessionTerminalMarker(markerPath: string) {
        try {
            if (markerPath && existsSync(markerPath)) {
                unlinkSync(markerPath);
            }
        } catch (e) {
            // Ignore marker cleanup failures; they only affect best-effort terminal reuse.
        }
    }

    function buildCodexResumeCommand(sessionId: string, cwd: string, markerPath: string = null): string {
        if (process.platform === 'win32' && markerPath) {
            return buildWindowsCodexResumeCommand(sessionId, cwd, markerPath);
        }

        let quotedSessionId = quoteShellArg(sessionId);
        let resumeCommand = cwd
            ? `codex resume --cd ${quoteShellArg(cwd)} ${quotedSessionId}`
            : `codex resume ${quotedSessionId}`;

        if (!markerPath) {
            return resumeCommand;
        }

        let markerArg = quoteShellArg(markerPath);
        return `sh -lc ${quoteShellArg(`rm -f ${markerArg}; ${resumeCommand}; : > ${markerArg}`)}`;
    }

    function buildWindowsCodexResumeCommand(sessionId: string, cwd: string, markerPath: string): string {
        let resumeCommand = cwd
            ? `codex resume --cd ${quotePowerShellArg(cwd)} ${quotePowerShellArg(sessionId)}`
            : `codex resume ${quotePowerShellArg(sessionId)}`;
        let script = [
            `Remove-Item -LiteralPath ${quotePowerShellArg(markerPath)} -ErrorAction SilentlyContinue`,
            resumeCommand,
            `New-Item -ItemType File -Force -Path ${quotePowerShellArg(markerPath)} | Out-Null`,
        ].join('; ');

        return `powershell -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsCommandArg(script)}`;
    }

    function buildCodexNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null): string {
        if (process.platform === 'win32') {
            return buildWindowsCodexNewSessionCommand(cwd, prompt, markerPath);
        }

        let promptArg = prompt ? ` ${quoteShellArg(prompt)}` : '';
        let newSessionCommand = cwd
            ? `codex --cd ${quoteShellArg(cwd)}${promptArg}`
            : `codex${promptArg}`;

        if (!markerPath) {
            return newSessionCommand;
        }

        let markerArg = quoteShellArg(markerPath);
        return `sh -lc ${quoteShellArg(`rm -f ${markerArg}; ${newSessionCommand}; : > ${markerArg}`)}`;
    }

    function buildWindowsCodexNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null): string {
        let promptArg = prompt ? ` ${quotePowerShellArg(prompt)}` : '';
        let command = cwd
            ? `codex --cd ${quotePowerShellArg(cwd)}${promptArg}`
            : `codex${promptArg}`;

        if (markerPath) {
            command = [
                `Remove-Item -LiteralPath ${quotePowerShellArg(markerPath)} -ErrorAction SilentlyContinue`,
                command,
                `New-Item -ItemType File -Force -Path ${quotePowerShellArg(markerPath)} | Out-Null`,
            ].join('; ');
        }

        return `powershell -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsCommandArg(command)}`;
    }

    function buildKimiResumeCommand(sessionId: string, cwd: string, markerPath: string = null): string {
        if (process.platform === 'win32' && markerPath) {
            return buildWindowsKimiResumeCommand(sessionId, cwd, markerPath);
        }

        let resumeCommand = cwd
            ? `kimi --work-dir ${quoteShellArg(cwd)} --resume ${quoteShellArg(sessionId)}`
            : `kimi --resume ${quoteShellArg(sessionId)}`;

        if (!markerPath) {
            return resumeCommand;
        }

        let markerArg = quoteShellArg(markerPath);
        return `sh -lc ${quoteShellArg(`rm -f ${markerArg}; ${resumeCommand}; : > ${markerArg}`)}`;
    }

    function buildWindowsKimiResumeCommand(sessionId: string, cwd: string, markerPath: string): string {
        let resumeCommand = cwd
            ? `kimi --work-dir ${quotePowerShellArg(cwd)} --resume ${quotePowerShellArg(sessionId)}`
            : `kimi --resume ${quotePowerShellArg(sessionId)}`;
        let script = [
            `Remove-Item -LiteralPath ${quotePowerShellArg(markerPath)} -ErrorAction SilentlyContinue`,
            resumeCommand,
            `New-Item -ItemType File -Force -Path ${quotePowerShellArg(markerPath)} | Out-Null`,
        ].join('; ');

        return `powershell -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsCommandArg(script)}`;
    }

    function buildKimiNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null): string {
        if (process.platform === 'win32') {
            return buildWindowsKimiNewSessionCommand(cwd, prompt, markerPath);
        }

        let promptArg = prompt ? ` --prompt ${quoteShellArg(prompt)}` : '';
        let newSessionCommand = cwd
            ? `kimi --work-dir ${quoteShellArg(cwd)}${promptArg}`
            : `kimi${promptArg}`;

        if (!markerPath) {
            return newSessionCommand;
        }

        let markerArg = quoteShellArg(markerPath);
        return `sh -lc ${quoteShellArg(`rm -f ${markerArg}; ${newSessionCommand}; : > ${markerArg}`)}`;
    }

    function buildWindowsKimiNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null): string {
        let promptArg = prompt ? ` --prompt ${quotePowerShellArg(prompt)}` : '';
        let command = cwd
            ? `kimi --work-dir ${quotePowerShellArg(cwd)}${promptArg}`
            : `kimi${promptArg}`;

        if (markerPath) {
            command = [
                `Remove-Item -LiteralPath ${quotePowerShellArg(markerPath)} -ErrorAction SilentlyContinue`,
                command,
                `New-Item -ItemType File -Force -Path ${quotePowerShellArg(markerPath)} | Out-Null`,
            ].join('; ');
        }

        return `powershell -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsCommandArg(command)}`;
    }

    function buildClaudeResumeCommand(sessionId: string, cwd: string, markerPath: string = null): string {
        if (process.platform === 'win32' && markerPath) {
            return buildWindowsClaudeResumeCommand(sessionId, cwd, markerPath);
        }

        let resumeCommand = cwd
            ? `cd ${quoteShellArg(cwd)} && claude --resume ${quoteShellArg(sessionId)}`
            : `claude --resume ${quoteShellArg(sessionId)}`;

        if (!markerPath) {
            return resumeCommand;
        }

        let markerArg = quoteShellArg(markerPath);
        return `sh -lc ${quoteShellArg(`rm -f ${markerArg}; ${resumeCommand}; : > ${markerArg}`)}`;
    }

    function buildWindowsClaudeResumeCommand(sessionId: string, cwd: string, markerPath: string): string {
        let resumeCommand = cwd
            ? `Set-Location -LiteralPath ${quotePowerShellArg(cwd)}; claude --resume ${quotePowerShellArg(sessionId)}`
            : `claude --resume ${quotePowerShellArg(sessionId)}`;
        let script = [
            `Remove-Item -LiteralPath ${quotePowerShellArg(markerPath)} -ErrorAction SilentlyContinue`,
            resumeCommand,
            `New-Item -ItemType File -Force -Path ${quotePowerShellArg(markerPath)} | Out-Null`,
        ].join('; ');

        return `powershell -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsCommandArg(script)}`;
    }

    function buildClaudeNewSessionCommand(cwd: string, title: string = null, markerPath: string = null): string {
        if (process.platform === 'win32') {
            return buildWindowsClaudeNewSessionCommand(cwd, title, markerPath);
        }

        let titleArg = title ? ` --name ${quoteShellArg(title)}` : '';
        let newSessionCommand = cwd
            ? `cd ${quoteShellArg(cwd)} && claude${titleArg}`
            : `claude${titleArg}`;

        if (!markerPath) {
            return newSessionCommand;
        }

        let markerArg = quoteShellArg(markerPath);
        return `sh -lc ${quoteShellArg(`rm -f ${markerArg}; ${newSessionCommand}; : > ${markerArg}`)}`;
    }

    function buildWindowsClaudeNewSessionCommand(cwd: string, title: string = null, markerPath: string = null): string {
        let titleArg = title ? ` --name ${quotePowerShellArg(title)}` : '';
        let command = cwd
            ? `Set-Location -LiteralPath ${quotePowerShellArg(cwd)}; claude${titleArg}`
            : `claude${titleArg}`;

        if (markerPath) {
            command = [
                `Remove-Item -LiteralPath ${quotePowerShellArg(markerPath)} -ErrorAction SilentlyContinue`,
                command,
                `New-Item -ItemType File -Force -Path ${quotePowerShellArg(markerPath)} | Out-Null`,
            ].join('; ');
        }

        return `powershell -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsCommandArg(command)}`;
    }

    function sanitizeTerminalLineInput(value: string): string {
        return String(value || '').replace(/[\r\n]+/g, ' ').trim();
    }

    function quoteShellArg(value: string): string {
        if (process.platform === 'win32') {
            return `"${String(value).replace(/"/g, '\\"')}"`;
        }

        return `'${String(value).replace(/'/g, `'\\''`)}'`;
    }

    function quotePowerShellArg(value: string): string {
        return `'${String(value).replace(/'/g, `''`)}'`;
    }

    function quoteWindowsCommandArg(value: string): string {
        return `"${String(value).replace(/"/g, '\\"')}"`;
    }

    function findSavedProjectForOpenProject(uri: vscode.Uri): Project {
        let savedProjects = projectService.getProjectsFlat();
        let exactMatch = savedProjects.find(project => projectMatchesOpenProject(project, uri));
        if (exactMatch) {
            return exactMatch;
        }

        let remotePathMatches = savedProjects.filter(project => projectPathMatchesRemoteOpenProject(project, uri));
        return remotePathMatches.length === 1 ? remotePathMatches[0] : null;
    }

    function projectMatchesOpenProject(project: Project, uri: vscode.Uri): boolean {
        if (!project || !project.path || !uri) {
            return false;
        }

        if (projectPathMatchesWorkspaceUri(project.path, uri)) {
            return true;
        }

        return false;
    }

    function projectPathMatchesRemoteOpenProject(project: Project, uri: vscode.Uri): boolean {
        if (!vscode.env.remoteName || !projectRemoteTypeMatchesCurrentRemote(project)) {
            return false;
        }

        if (uri.scheme === "vscode-remote" || uri.authority) {
            return false;
        }

        let projectPath = getProjectPathPart(project.path);
        let openPath = uri.path || uri.fsPath;
        if (!projectPath || !openPath) {
            return false;
        }

        return normalizePosixPath(projectPath) === normalizePosixPath(openPath);
    }

    function projectRemoteTypeMatchesCurrentRemote(project: Project): boolean {
        let currentRemoteType = getRemoteTypeFromRemoteName(vscode.env.remoteName);
        if (currentRemoteType === ProjectRemoteType.None) {
            return false;
        }

        return getRemoteType(project) === currentRemoteType;
    }

    function getProjectPathPart(projectPath: string): string {
        if (!projectPath) {
            return projectPath;
        }

        if (!isUriString(projectPath)) {
            return projectPath;
        }

        try {
            let uri = vscode.Uri.parse(projectPath);
            return uri.path || uri.fsPath || projectPath;
        } catch (e) {
            return projectPath;
        }
    }

    function getWorkspacePath(): string {
        let workspaceUri = getWorkspaceUri();

        if (workspaceUri != null) {
            return uriToProjectPath(workspaceUri);
        } else {
            return null;
        }
    }

    async function getCurrentProjectDetailsForSave(): Promise<{ path: string, remoteType: ProjectRemoteType }> {
        let workspaceUri = getWorkspaceUri();
        if (workspaceUri == null) {
            return null;
        }

        return getProjectDetailsForSave(workspaceUri);
    }

    async function getProjectDetailsForSave(workspaceUri: vscode.Uri): Promise<{ path: string, remoteType: ProjectRemoteType }> {
        let remoteType = getRemoteTypeFromRemoteName(vscode.env.remoteName);
        if (workspaceUri.scheme === "file") {
            let codespaceUri = await resolveCurrentCodespaceWorkspaceUri(workspaceUri);
            if (codespaceUri) {
                return { path: uriToProjectPath(codespaceUri), remoteType: getRemoteTypeFromRemoteUri(codespaceUri, remoteType) };
            }

            if (remoteType !== ProjectRemoteType.None) {
                let remoteUri = await resolveCurrentRemoteWorkspaceUri(workspaceUri, remoteType);
                if (remoteUri) {
                    return { path: uriToProjectPath(remoteUri), remoteType: getRemoteTypeFromRemoteUri(remoteUri, remoteType) };
                }
            }

            return { path: uriToProjectPath(workspaceUri), remoteType };
        }

        return { path: uriToProjectPath(workspaceUri), remoteType: getRemoteTypeFromRemoteUri(workspaceUri, remoteType) };
    }

    function getWorkspaceUri(): vscode.Uri {
        let workspaceUris = getWorkspaceUris();
        return workspaceUris.length ? workspaceUris[0] : null;
    }

    function getWorkspaceUris(): vscode.Uri[] {
        let workspaceUri = vscode.workspace.workspaceFile;
        if (workspaceUri != null && workspaceUri.scheme !== "untitled") {
            return [workspaceUri];
        }

        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri);
    }

    async function resolveCurrentCodespaceWorkspaceUri(workspaceUri: vscode.Uri): Promise<vscode.Uri> {
        if (vscode.env.remoteName !== "codespaces") {
            return null;
        }

        try {
            let info = await vscode.commands.executeCommand<{ name: string } | undefined>('github.codespaces.getCurrentCodespace');
            if (info && info.name) {
                return buildVscodeRemoteUri(`codespaces+${info.name}`, workspaceUri.fsPath || workspaceUri.path);
            }
        } catch (error) {
            logError('Failed to resolve current Codespace workspace URI.', error);
        }

        return null;
    }

    async function resolveCurrentRemoteWorkspaceUri(workspaceUri: vscode.Uri, remoteType: ProjectRemoteType): Promise<vscode.Uri> {
        let currentPath = workspaceUri.path || workspaceUri.fsPath;
        if (!currentPath) {
            return null;
        }

        try {
            let recentlyOpened = await vscode.commands.executeCommand('_workbench.getRecentlyOpened') as any;
            let candidates = [
                ...getRecentRemoteCandidates((recentlyOpened && recentlyOpened.workspaces) || [], currentPath, remoteType, true),
                ...getRecentRemoteCandidates((recentlyOpened && recentlyOpened.files) || [], currentPath, remoteType, false),
            ].sort((a, b) => b.score - a.score);

            if (!candidates.length) {
                return null;
            }

            let selectedAuthority = normalizeRemoteAuthority(candidates[0].remoteAuthority);

            return buildVscodeRemoteUri(selectedAuthority, currentPath);
        } catch (error) {
            logError('Failed to resolve current remote workspace URI.', error);
        }

        return null;
    }

    function getRecentRemoteCandidates(recentEntries: any[], currentPath: string, remoteType: ProjectRemoteType, isWorkspaceEntry: boolean): { remoteAuthority: string, score: number }[] {
        let candidates: { remoteAuthority: string, score: number }[] = [];

        for (let recent of recentEntries) {
            let remoteAuthority = recent && recent.remoteAuthority;
            if (!remoteAuthority || !remoteAuthorityMatchesType(remoteAuthority, remoteType)) {
                continue;
            }

            let recentUri = getRecentEntryUri(recent);
            if (!recentUri) {
                continue;
            }

            let score = getPathMatchScore(currentPath, recentUri.path || recentUri.fsPath, isWorkspaceEntry);
            if (score > 0) {
                candidates.push({ remoteAuthority, score });
            }
        }

        return candidates;
    }

    function getPathMatchScore(currentPath: string, recentPath: string, isWorkspaceEntry: boolean): number {
        if (!currentPath || !recentPath) {
            return 0;
        }

        let normalizedCurrentPath = normalizePosixPath(currentPath);
        let normalizedRecentPath = normalizePosixPath(recentPath);

        if (normalizedCurrentPath === normalizedRecentPath) {
            return isWorkspaceEntry ? 100 : 60;
        }

        if (isWorkspaceEntry && isPathInside(normalizedCurrentPath, normalizedRecentPath)) {
            return 80;
        }

        if (isWorkspaceEntry && isPathInside(normalizedRecentPath, normalizedCurrentPath)) {
            return 70;
        }

        if (!isWorkspaceEntry && isPathInside(normalizedRecentPath, normalizedCurrentPath)) {
            return 40;
        }

        if (path.posix.basename(normalizedCurrentPath) === path.posix.basename(normalizedRecentPath)) {
            return isWorkspaceEntry ? 30 : 10;
        }

        return 0;
    }

    function remoteAuthorityMatchesType(remoteAuthority: string, remoteType: ProjectRemoteType): boolean {
        let normalizedAuthority = normalizeRemoteAuthority(remoteAuthority);

        switch (remoteType) {
            case ProjectRemoteType.SSH:
                return normalizedAuthority.startsWith('ssh-remote+');
            case ProjectRemoteType.WSL:
                return normalizedAuthority.startsWith('wsl+');
            case ProjectRemoteType.DevContainer:
                return normalizedAuthority.startsWith('dev-container+') || normalizedAuthority.startsWith('attached-container+');
            case ProjectRemoteType.Remote:
                if (vscode.env.remoteName) {
                    return normalizedAuthority.startsWith(`${vscode.env.remoteName}+`);
                }

                return true;
            case ProjectRemoteType.None:
            default:
                return false;
        }
    }

    function getRemoteTypeFromRemoteUri(uri: vscode.Uri, fallbackRemoteType: ProjectRemoteType): ProjectRemoteType {
        if (!uri || uri.scheme !== "vscode-remote" || !uri.authority) {
            return fallbackRemoteType;
        }

        let project = new Project("", uri.toString());
        return getRemoteType(project);
    }

    function buildVscodeRemoteUri(remoteAuthority: string, resourcePath: string): vscode.Uri {
        return vscode.Uri.parse(`vscode-remote://${encodeRemoteAuthority(remoteAuthority)}${ensureLeadingSlash(resourcePath)}`);
    }

    function ensureLeadingSlash(value: string): string {
        if (!value) {
            return "/";
        }

        return value.startsWith("/") ? value : `/${value}`;
    }

    function normalizeRemoteAuthority(remoteAuthority: string): string {
        if (!remoteAuthority) {
            return remoteAuthority;
        }

        try {
            return decodeURIComponent(remoteAuthority);
        } catch (e) {
            return remoteAuthority;
        }
    }

    function normalizePosixPath(value: string): string {
        return path.posix.normalize(value).replace(/\/+$/g, '') || '/';
    }

    function isPathInside(childPath: string, parentPath: string): boolean {
        return childPath !== parentPath && childPath.startsWith(`${parentPath}/`);
    }

    function getRecentEntryUri(recent: any): vscode.Uri {
        return asUri(recent.folderUri)
            || asUri(recent.workspace && recent.workspace.configPath)
            || asUri(recent.fileUri);
    }

    function asUri(value: any): vscode.Uri {
        if (!value) {
            return null;
        }

        if (value instanceof vscode.Uri) {
            return value;
        }

        if (typeof value === 'string') {
            return vscode.Uri.parse(value);
        }

        if (value.scheme && typeof value.path === 'string') {
            if (typeof value.toString === 'function') {
                let uriString = value.toString();
                if (uriString && uriString !== '[object Object]') {
                    return vscode.Uri.parse(uriString);
                }
            }

            if (value.scheme === "vscode-remote" && value.authority) {
                return buildVscodeRemoteUri(value.authority, value.path);
            }

            if (value.scheme === "file") {
                return vscode.Uri.file(value.fsPath || value.path);
            }

            let authority = value.authority ? `//${value.authority}` : '';
            let query = value.query ? `?${value.query}` : '';
            let fragment = value.fragment ? `#${value.fragment}` : '';
            return vscode.Uri.parse(`${value.scheme}:${authority}${value.path}${query}${fragment}`);
        }

        return null;
    }

    function encodeRemoteAuthority(remoteAuthority: string): string {
        return normalizeRemoteAuthority(remoteAuthority).split('@').map(part => encodeURIComponent(part)).join('@');
    }

    function isUriString(projectPath: string): boolean {
        return projectPath && projectPath.includes("://");
    }

    function parsePathAsUri(projectPath: string): vscode.Uri {
        return isUriString(projectPath) ? vscode.Uri.parse(projectPath) : vscode.Uri.file(projectPath);
    }

    function uriToProjectPath(uri: vscode.Uri): string {
        return uri.scheme === "file" ? uri.fsPath.trim() : uri.toString().trim();
    }
}




// this method is called when your extension is deactivated
export function deactivate() {
}
