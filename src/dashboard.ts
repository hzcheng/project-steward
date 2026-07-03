'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { Project, GroupOrder, Group, ProjectRemoteType, getRemoteType, getRemoteTypeFromRemoteName, StewardInfos, ProjectOpenType, ReopenStewardReason, ProjectPathType, sanitizeProjectName } from './models';
import { getStewardContent } from './webview/webviewContent';
import { USE_PROJECT_COLOR, PREDEFINED_COLORS, StartupOptions, USER_CANCELED, SAVE_CURRENT_PROJECT, FixedColorOptions, RelevantExtensions, SSH_REGEX, REMOTE_REGEX, SSH_REMOTE_PREFIX, REOPEN_KEY, WSL_DEFAULT_REGEX, FAVORITES_GROUP_ID, FAVORITES_GROUP_COLLAPSED_KEY, OPEN_PROJECTS_GROUP_ID, OPEN_PROJECTS_GROUP_COLLAPSED_KEY, LEGACY_DASHBOARD_CONFIG_SECTION, PROJECT_STEWARD_CONFIG_SECTION } from './constants';
import { execSync } from 'child_process';
import { lstatSync } from 'fs';

import ColorService from './services/colorService';
import ProjectService from './services/projectService';
import FileService from './services/fileService';

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

    const provider = new SidebarStewardViewProvider();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarStewardViewProvider.viewType, provider));

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
                await setAllGroupsCollapsed(Boolean(e.collapsed));
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

    async function setAllGroupsCollapsed(collapsed: boolean) {
        var groups = projectService.getGroups();
        groups.forEach(group => group.collapsed = collapsed);
        await context.globalState.update(FAVORITES_GROUP_COLLAPSED_KEY, collapsed);
        await context.globalState.update(OPEN_PROJECTS_GROUP_COLLAPSED_KEY, collapsed);
        await projectService.saveGroups(groups);

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

    async function saveProject(groupId: string = null, groupWasNewlyCreated: boolean = false) {
        var selectedGroupId: string;

        try {
            let currentProjectDetails = await getCurrentProjectDetailsForSave();
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
        if (workspaceFile && workspaceFile.scheme !== "untitled") {
            return [buildOpenProject(workspaceFile, 0, "Current workspace")];
        }

        return (vscode.workspace.workspaceFolders || [])
            .map((folder, index) => buildOpenProject(folder.uri, index, "Workspace folder", folder.name));
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
        project.isGitRepo = isFolderGitRepo(projectPath);
        project.remoteType = savedProject?.remoteType ?? (savedProject ? getRemoteType(savedProject) : getRemoteTypeFromRemoteName(vscode.env.remoteName));

        return project;
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

            let topCandidates = candidates.filter(candidate => candidate.score === candidates[0].score);
            let uniqueAuthorities = Array.from(new Set(topCandidates.map(candidate => normalizeRemoteAuthority(candidate.remoteAuthority))));
            let selectedAuthority = uniqueAuthorities[0];

            if (uniqueAuthorities.length > 1) {
                let selected = await vscode.window.showQuickPick(
                    uniqueAuthorities.map(authority => ({ label: authority })),
                    { placeHolder: "Select the remote target for this project" }
                );

                if (!selected) {
                    return null;
                }

                selectedAuthority = selected.label;
            }

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
