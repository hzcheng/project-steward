'use strict';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import * as path from 'path';
import { Project, GroupOrder, ProjectRemoteType, StewardInfos, ProjectOpenType, ReopenStewardReason, AiSessionProviderId, isAiSessionProviderId } from './models';
import { getProjectsPanelContent, getStewardContent } from './webview/webviewContent';
import { USER_CANCELED, RelevantExtensions, REOPEN_KEY, WSL_DEFAULT_REGEX, OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY } from './constants';

import ColorService from './services/colorService';
import ProjectService from './services/projectService';
import { TodoService } from './todos/service';
import {
    deleteTodoWithConfirmation,
    renameTodoGroupWithPrompt,
    runTodoMutation,
    runTodoPromptMutation,
    runTodoRequestMutation,
} from './todos/hostMutation';
import { UnsupportedTodoDataVersionError } from './todos/types';
import { buildTodoViewModel } from './todos/viewModel';
import { getTodoPanelContent, getUnsupportedTodoVersionPanelContent } from './todos/webviewContent';
import FileService from './services/fileService';
import CodexSessionService from './services/codexSessionService';
import KimiSessionService from './services/kimiSessionService';
import ClaudeSessionService from './services/claudeSessionService';
import ProjectWindowColorService from './services/projectWindowColorService';
import AiSessionAliasStore from './aiSessions/aliasStore';
import AiSessionAliasController from './aiSessions/aliasController';
import AiSessionPinStore from './aiSessions/pinStore';
import AiSessionPinController from './aiSessions/pinController';
import AiSessionProjectStateStore from './aiSessions/projectStateStore';
import ActiveAiSessionTerminalHighlighter from './aiSessions/activeTerminalHighlight';
import AttentionBridgeClient from './aiSessions/attentionBridgeClient';
import { getAttentionProjectKey, withAttentionProject } from './aiSessions/attentionProject';
import type { ActiveAiSessionTerminalIdentity } from './aiSessions/activeTerminalHighlight';
import { getAiSessionKey } from './aiSessions/sessionHelpers';
import { AI_SESSION_PROVIDER_DEFINITIONS, createAiSessionProviderRegistry, getAiSessionProviderLabel } from './aiSessions/providers';
import { applyAiSessionRuntimeProjection } from './aiSessions/activeSessionProjection';
import { isCommandAvailableOnPath } from './aiSessions/providerAvailability';
import { ProviderDirectoryCapabilityProbe } from './aiSessions/providerDirectoryCapability';
import type {
    BoundedChildProcessOptions,
    BoundedChildProcessResult,
} from './aiSessions/providerDirectoryCapability';
import { getOpenProjectAiSessionKey, getOpenProjectTerminalCwd as getOpenProjectAiSessionTerminalCwd, normalizeAiSessionProjectPath } from './aiSessions/projectCandidates';
import { getAiSessionComparableCwd as getProviderAiSessionComparableCwd, getAiSessionTerminalName as getProviderAiSessionTerminalName, getProjectAiSessions as getProviderProjectAiSessions } from './aiSessions/sessionPaths';
import { getAiSessionIdsForCwd } from './aiSessions/pendingTerminals';
import { getAiSessionTerminalCandidates } from './aiSessions/terminalCandidates';
import { AiSessionReadCoordinator } from './aiSessions/readCoordinator';
import AiSessionTerminalService from './aiSessions/terminalService';
import AiSessionTerminalBindingStore from './aiSessions/terminalBindingStore';
import { readAiSessionRuntimeConfiguration } from './aiSessions/runtimeConfiguration';
import { DirectTerminalRuntimeBackend } from './aiSessions/directTerminalRuntimeBackend';
import { AiSessionRuntimeCoordinator } from './aiSessions/runtimeCoordinator';
import type { AiSessionTmuxFallbackContext } from './aiSessions/runtimeCoordinator';
import type { AiSessionRuntimeSnapshot } from './aiSessions/runtimeTypes';
import { cloneAiSessionRuntimeIdentity, TmuxRuntimeUnavailableError } from './aiSessions/runtimeTypes';
import { TmuxClient, TmuxClientError } from './aiSessions/tmuxClient';
import { TmuxRuntimeBindingStore } from './aiSessions/tmuxRuntimeBindingStore';
import { TmuxAttachBindingStore } from './aiSessions/tmuxAttachBindingStore';
import {
    findTmuxCollisionRuntime,
    isCurrentRuntimeMarker,
    TmuxRuntimeDiscovery,
} from './aiSessions/tmuxRuntimeDiscovery';
import { TmuxRuntimeBackend } from './aiSessions/tmuxRuntimeBackend';
import { TmuxFocusedRuntimeMonitor } from './aiSessions/tmuxFocusedRuntimeMonitor';
import { withTmuxCreationLock } from './aiSessions/tmuxCreationLock';
import type { AiSessionBatchArchiveCompletedMessage, AiSessionProvider, AiSessionService, AiSessionTerminalEntry, AiSessionsUpdatedMessage, WorkspaceAiSessionActionTarget } from './aiSessions/types';
import { AiSessionDashboardController } from './aiSessions/dashboardController';
import { AiSessionCommandController } from './aiSessions/commandController';
import { AiSessionCreationController } from './aiSessions/creationController';
import { AiSessionArchiveController } from './aiSessions/archiveController';
import { AiSessionResumeController } from './aiSessions/resumeController';
import { AiSessionTerminalCommandController } from './aiSessions/terminalCommandController';
import { AiSessionExecutionController } from './aiSessions/executionController';
import {
    AiSessionAttentionController,
    runAiSessionRuntimeLifecycleTask,
    settleAiSessionRuntimeLifecycles,
} from './aiSessions/attentionController';
import type {
    AiSessionAttentionEvaluation,
    AiSessionRuntimeLifecycleCandidate,
} from './aiSessions/attentionController';
import { AiSessionProjectHydrationController } from './aiSessions/projectHydrationController';
import {
    getLastPartOfPath,
    getOpenProjectsFromWorkspace,
    getOpenProjectUri as resolveOpenProjectUri,
    isUriString,
    parsePathAsUri,
} from './projects/openProjectService';
import { getWorkspacePath as resolveWorkspacePath } from './projects/workspaceHelpers';
import RemoteProjectResolver from './projects/remoteProjectResolver';
import GitRepositoryDetector from './projects/gitRepositoryDetector';
import { AddProjectsFromFolderController } from './projects/addProjectsFromFolderController';
import { CurrentProjectDetailsResolver } from './projects/currentProjectDetails';
import { FavoriteProjectController } from './projects/favoriteProjectController';
import { GroupCommandController } from './projects/groupCommandController';
import { queryGroupName } from './projects/groupPrompts';
import { ProjectManualEditController } from './projects/projectManualEditController';
import { ProjectMutationController } from './projects/projectMutationController';
import { ProjectOpenController } from './projects/projectOpenController';
import { ProjectOrderController } from './projects/projectOrderController';
import { ProjectPromptController } from './projects/projectPromptController';
import { ProjectRemovalController } from './projects/projectRemovalController';
import { SidebarStewardViewProvider } from './dashboard/viewProvider';
import { getStewardConfiguration } from './dashboard/configuration';
import { DashboardCommandRegistration } from './dashboard/commandRegistration';
import { ActiveTerminalFileReferenceController } from './dashboard/activeTerminalFileReference';
import DashboardDiagnostics from './dashboard/diagnostics';
import { getErrorContent } from './dashboard/errorContent';
import { GroupCollapseController } from './dashboard/groupCollapseController';
import { DashboardLifecycleController } from './dashboard/lifecycleController';
import { createDashboardMessageRouter } from './dashboard/messageRouter';
import { DashboardRuntimeController } from './dashboard/runtimeController';
import { DashboardStartupController, settleMigration } from './dashboard/startupController';
import { getDashboardWebviewOptions } from './dashboard/webviewOptions';
import OpenWorkspaceBridgeClient from './openWorkspaces/bridgeClient';
import { OpenWorkspaceDashboardController } from './openWorkspaces/dashboardController';
import { WorkspaceNavigationController } from './openWorkspaces/navigationController';
import { OpenWorkspaceController } from './openWorkspaces/workspaceController';
import { WorkspaceContextResolver } from './workspaces/contextResolver';
import { WorkspacePrimaryRootStore } from './workspaces/primaryRootStore';
import { PendingWorkspaceSaveStore } from './workspaces/pendingWorkspaceSaveStore';
import { SavedWorkspaceProjectAdapter } from './workspaces/savedWorkspaceProjectAdapter';
import { WorkspaceSessionHydrationController } from './workspaces/sessionHydrationController';
import type { OpenWorkspace } from './workspaces/types';
import { buildWorkspaceDashboardSearchCatalog } from './webview/dashboardViewModel';

const NEW_AI_SESSION_REFRESH_DELAYS_MS = [250, 1000, 2500, 5000];
const AI_SESSION_REFRESH_DEBOUNCE_MS = 3000;
const AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS = 10000;
const AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000;

function resolveAiProviderExecutable(commandName: string): string | null {
    if (!commandName) {
        return null;
    }
    if (path.isAbsolute(commandName)) {
        return existsSync(commandName) ? commandName : null;
    }

    const windows = process.platform === 'win32';
    const pathValue = process.env.PATH || process.env.Path || '';
    const extensions = windows
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
        for (const extension of extensions) {
            const candidate = path.join(directory, `${commandName}${extension}`);
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

function runBoundedAiProviderHelp(
    executable: string,
    args: readonly string[],
    options: BoundedChildProcessOptions
): Promise<BoundedChildProcessResult> {
    return new Promise(resolve => {
        execFile(executable, [...args], {
            timeout: options.timeoutMs,
            maxBuffer: options.maxOutputBytes,
            encoding: 'utf8',
            windowsHide: true,
        }, (error, stdout, stderr) => {
            const childError = error as unknown as NodeJS.ErrnoException & {
                code?: string | number;
                killed?: boolean;
            };
            resolve({
                exitCode: error
                    ? (typeof childError.code === 'number' ? childError.code : null)
                    : 0,
                stdout: typeof stdout === 'string' ? stdout : '',
                stderr: typeof stderr === 'string' ? stderr : '',
                timedOut: Boolean(error && childError.killed),
            });
        });
    });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('Project Steward');
    context.subscriptions.push(outputChannel);
    const dashboardDiagnostics = new DashboardDiagnostics({
        outputChannel,
        globalStoragePath: context.globalStoragePath,
    });
    const logError = (message: string, error: unknown) => dashboardDiagnostics.logError(message, error);
    const logAiSessionDiagnostic = (event: Record<string, unknown>) => dashboardDiagnostics.logAiSessionDiagnostic(event);
    const logDashboardDiagnostic = (event: Record<string, unknown>) => dashboardDiagnostics.logDashboardDiagnostic(event);
    const logOpenProjectDiagnostic = (component: string, event: unknown) => dashboardDiagnostics.logOpenProjectDiagnostic(component, event);

    const colorService = new ColorService(context);
    const projectService = new ProjectService(context, colorService);
    const todoService = new TodoService(context);
    const todoViewState = todoService.getViewState();
    let revealedTodoId: string | undefined;
    const todoStorageMigration = { ready: Promise.resolve<unknown>(undefined) };
    const groupCollapseController = new GroupCollapseController({
        state: context.globalState,
        projectService,
    });
    const groupCommandController = new GroupCommandController({
        projectService,
        promptGroupName: defaultText => queryGroupName(vscode.window, defaultText),
        promptGroupToRemove: () => projectPromptController.queryGroup(),
        confirmRemoveGroup: groupName => vscode.window.showWarningMessage(`Remove ${groupName}?`, { modal: true }, 'Remove'),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        refreshAfterMutation,
        userCanceledToken: USER_CANCELED,
    });
    const projectWindowColorService = new ProjectWindowColorService(context);
    const fileService = new FileService(context);
    const gitRepositoryDetector = new GitRepositoryDetector();
    const projectOpenController = new ProjectOpenController({
        getWorkspaceFile: () => vscode.workspace.workspaceFile,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getPrependVscodeUrlToWslRemotes: () => stewardInfos.config.prependVscodeUrlToWslRemotes,
        getProjectPathType: projectPath => fileService.getProjectPathType(projectPath),
        getFoldersFromWorkspaceFile: workspaceFilePath => fileService.getFoldersFromWorkspaceFile(workspaceFilePath),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
        updateWorkspaceFolders: (start, deleteCount, ...workspaceFoldersToAdd) => vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...workspaceFoldersToAdd),
        updateReopenReason: reason => context.globalState.update(REOPEN_KEY, reason),
        fileUri: projectPath => vscode.Uri.file(projectPath),
        parseUri: projectPath => vscode.Uri.parse(projectPath),
    });
    const projectPromptController = new ProjectPromptController({
        getGroups: () => projectService.getGroups(),
        addGroup: name => projectService.addGroup(name),
        removeGroup: (groupId, skipConfirmation) => projectService.removeGroup(groupId, skipConfirmation),
        isFile: projectPath => fileService.isFile(projectPath),
        isFolderGitRepo: projectPath => isFolderGitRepo(projectPath),
        getRandomColor: () => colorService.getRandomColor(),
        getColorName: colorCode => colorService.getColorName(colorCode),
        getRecentColors: () => colorService.getRecentColors(),
        getRemoteSshExtensionInstalled: () => stewardInfos.relevantExtensionsInstalls.remoteSSH,
        showInputBox: options => vscode.window.showInputBox(options),
        showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
        showOpenDialog: options => vscode.window.showOpenDialog(options),
    });
    const projectMutationController = new ProjectMutationController({
        getCurrentWorkspacePath: () => resolveWorkspacePath(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders),
        getOpenProjectUri: projectId => resolveOpenProjectUri(
            projectId,
            vscode.workspace.workspaceFile,
            vscode.workspace.workspaceFolders,
        ),
        getCurrentProjectDetailsForSave: () => currentProjectDetailsResolver.getCurrentProjectDetailsForSave(),
        getProjectDetailsForSave: uri => currentProjectDetailsResolver.getProjectDetailsForSave(uri),
        getProjectsFlat: () => projectService.getProjectsFlat(),
        getProjectAndGroup: projectId => projectService.getProjectAndGroup(projectId),
        addProjectToGroup: (project, groupId) => projectService.addProject(project, groupId),
        updateProject: (projectId, project) => projectService.updateProject(projectId, project),
        removeGroup: (groupId, skipConfirmation) => projectService.removeGroup(groupId, skipConfirmation),
        getRandomColor: () => colorService.getRandomColor(),
        isFolderGitRepo,
        prompt: projectPromptController,
        showInputBox: options => vscode.window.showInputBox(options),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        refreshAfterMutation,
    });
    const favoriteProjectController = new FavoriteProjectController({
        getGroups: () => projectService.getGroups(),
        saveGroups: groups => projectService.saveGroups(groups),
        refreshAfterMutation,
    });
    const projectOrderController = new ProjectOrderController({
        getGroups: () => projectService.getGroups(),
        saveGroups: groups => projectService.saveGroups(groups),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        refreshAfterMutation,
    });
    const projectRemovalController = new ProjectRemovalController({
        getProject: projectId => projectService.getProject(projectId),
        getProjectsFlat: () => projectService.getProjectsFlat(),
        showProjectPicker: projectPicks => vscode.window.showQuickPick(projectPicks),
        confirmRemoveProject: projectName => vscode.window.showWarningMessage(`Remove ${projectName}?`, { modal: true }, 'Remove'),
        removeProject: projectId => projectService.removeProject(projectId),
        refreshAfterMutation,
        postCommandRemoval: () => { void showSteward(); },
    });
    const projectManualEditController = new ProjectManualEditController({
        getGroups: () => projectService.getGroups(),
        getTempFilePath: () => `${context.globalStoragePath}/Project Steward Projects.json`,
        writeTextFile: (filePath, content) => fileService.writeTextFile(filePath, content),
        fileUri: filePath => vscode.Uri.file(filePath),
        openTextDocument: uri => vscode.workspace.openTextDocument(uri),
        showTextDocument: document => vscode.window.showTextDocument(document),
        onWillSaveTextDocument: listener => vscode.workspace.onWillSaveTextDocument(listener),
        saveGroups: groups => projectService.saveGroups(groups),
        executeCommand: command => vscode.commands.executeCommand(command),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        postSave: () => showSteward(),
    });
    const addProjectsFromFolderController = new AddProjectsFromFolderController({
        getCurrentWorkspacePath: () => resolveWorkspacePath(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders),
        parsePathAsUri,
        showOpenDialog: options => vscode.window.showOpenDialog(options),
        getFolders: folderPath => fileService.getFolders(folderPath),
        addGroup: groupName => projectService.addGroup(groupName),
        addProject: (project, groupId) => projectService.addProject(project, groupId),
        getRandomColor: () => colorService.getRandomColor(),
        isFolderGitRepo,
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        refreshAfterMutation,
        userCanceledToken: USER_CANCELED,
    });
    const codexSessionService = new CodexSessionService();
    const kimiSessionService = new KimiSessionService();
    const claudeSessionService = new ClaudeSessionService();
    const remoteProjectResolver = new RemoteProjectResolver(logError);
    const currentProjectDetailsResolver = new CurrentProjectDetailsResolver({
        getWorkspaceFile: () => vscode.workspace.workspaceFile,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getRemoteName: () => vscode.env.remoteName,
        getProjectDetailsForSave: (workspaceUri, remoteName) => remoteProjectResolver.getProjectDetailsForSave(workspaceUri, remoteName),
    });
    const aiSessionServices: Record<AiSessionProviderId, AiSessionService> = {
        codex: codexSessionService,
        kimi: kimiSessionService,
        claude: claudeSessionService,
    };
    const aiSessionProviderRegistry = createAiSessionProviderRegistry(aiSessionServices);
    const aiSessionProviders = aiSessionProviderRegistry.providers();
    const aiSessionReadCoordinator = new AiSessionReadCoordinator(
        aiSessionProviders,
        logAiSessionDiagnostic
    );
    const aiSessionTerminalBindingStore = new AiSessionTerminalBindingStore(context.workspaceState, error =>
        logError('Failed to persist AI session terminal ownership.', error)
    );
    const aiSessionTerminalService = new AiSessionTerminalService(
        context.globalStoragePath,
        aiSessionProviders,
        undefined,
        undefined,
        aiSessionTerminalBindingStore
    );
    let aiSessionRuntimeConfiguration = readAiSessionRuntimeConfiguration(getStewardConfiguration());
    const tmuxRuntimeStore = new TmuxRuntimeBindingStore(
        path.join(context.globalStoragePath, 'ai-session-tmux-runtimes'),
        () => Date.now(),
        operation => withTmuxCreationLock(
            context.globalStoragePath,
            'runtime-binding-final-records',
            operation
        )
    );
    const tmuxAttachBindingStore = new TmuxAttachBindingStore(context.workspaceState, error => {
        logAiSessionRuntimeFailure('persist-attach-binding', error);
    });
    const tmuxClient = new TmuxClient(aiSessionRuntimeConfiguration.tmuxPath);
    const tmuxRuntimeDiscovery = new TmuxRuntimeDiscovery({
        client: tmuxClient,
        bindingStore: tmuxRuntimeStore,
        markerIsCurrent: isCurrentRuntimeMarker,
    });
    try {
        await tmuxRuntimeDiscovery.loadPersistedInactive();
    } catch (error) {
        logAiSessionRuntimeFailure('restore-inactive-runtimes', error);
    }
    const directTerminalRuntimeBackend = new DirectTerminalRuntimeBackend(aiSessionTerminalService);
    const tmuxRuntimeBackend = new TmuxRuntimeBackend<vscode.Terminal>({
        platform: process.platform,
        client: tmuxClient,
        discovery: tmuxRuntimeDiscovery,
        runtimeStore: tmuxRuntimeStore,
        attachStore: tmuxAttachBindingStore,
        withCreationLock: (key, operation) => withTmuxCreationLock(context.globalStoragePath, key, operation),
        createTerminal: options => vscode.window.createTerminal(options),
        nowMs: () => Date.now(),
        getAttachTerminalName: getAiSessionTmuxAttachTerminalName,
    });
    const aiSessionRuntimeCoordinator = new AiSessionRuntimeCoordinator<vscode.Terminal>({
        direct: directTerminalRuntimeBackend,
        tmux: tmuxRuntimeBackend,
        getConfiguration: () => ({ ...aiSessionRuntimeConfiguration }),
        chooseTmuxFallback: chooseAiSessionTmuxFallback,
        hasLiveTmuxOwnership,
        hasKnownTmuxHint: async identity => Boolean(identity.sessionId
            && await tmuxRuntimeStore.getKnown(identity.provider, identity.sessionId,
                identity.workspaceScopeIdentity)),
        clearKnownTmuxHint: async identity => {
            if (identity.sessionId) {
                await tmuxRuntimeStore.removeKnown(identity.provider, identity.sessionId,
                    identity.workspaceScopeIdentity);
            }
        },
    });
    await aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals);
    try {
        await tmuxRuntimeBackend.restoreAttachTerminals(vscode.window.terminals);
    } catch (error) {
        logAiSessionRuntimeFailure('restore-attach-terminals', error);
    }
    const aiSessionAliasStore = new AiSessionAliasStore(context.globalStoragePath);
    const aiSessionAliasController = new AiSessionAliasController({
        store: aiSessionAliasStore,
        isProviderId: isAiSessionProviderId,
        getSessionKey: getAiSessionPinKey,
        getProviderResult: (providerId, options) => aiSessionReadCoordinator.getProviderResult(providerId, options),
        logError,
        showSaveError: () => vscode.window.showErrorMessage("Could not save the chat name."),
    });
    const aiSessionPinStore = new AiSessionPinStore(context.globalStoragePath);
    const aiSessionPinController = new AiSessionPinController({
        store: aiSessionPinStore,
        getSessionKey: getAiSessionPinKey,
        logError,
        showUpdateError: () => vscode.window.showErrorMessage('Could not update the pinned chat.'),
    });
    const aiSessionProjectStateStore = new AiSessionProjectStateStore(context.globalState, isAiSessionProviderId);
    // Callbacks below intentionally close over controllers initialized later in activate().
    // The hydration controller constructor must stay side-effect-free.
    const aiSessionProjectHydrationController = new AiSessionProjectHydrationController<vscode.Terminal>({
        getWorkspaceFile: () => vscode.workspace.workspaceFile,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getRefreshReason: () => currentAiSessionRefreshReason,
        incrementalScanMaxFiles: AI_SESSION_INCREMENTAL_SCAN_MAX_FILES,
        getProviders: getRegisteredAiSessionProviders,
        getSessionKey: getAiSessionPinKey,
        readCoordinator: aiSessionReadCoordinator,
        terminalService: aiSessionTerminalService,
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        getWorkspaceScopeIdentity: () => getCurrentOpenWorkspace()?.scopeIdentity || null,
        setAlias: (providerId, sessionId, alias) => aiSessionAliasController.set(providerId, sessionId, alias),
        syncActiveTerminal: () => activeAiSessionTerminalHighlighter.sync(),
        onDidPromoteRuntime: () => {
            aiSessionExecutionController.evaluate();
        },
        getSessionComparableCwd: (providerId, session) => getProviderAiSessionComparableCwd(providerId, session, aiSessionProviders),
        getExpandedProjects: () => aiSessionProjectStateStore.getExpandedProjects(),
        getActiveProviders: () => aiSessionProjectStateStore.getActiveProviders(),
        getPinnedSessions: () => aiSessionPinController.getAll(),
        getAliases: () => aiSessionAliasController.getAll(),
        getAttentionAggregate: () => aiSessionAttentionController.getEffectiveAggregate(),
        getLocalAttentionBySession: () => aiSessionAttentionController.getLocalSnapshot(),
        hasRemoteAttentionAggregate: () => aiSessionAttentionController.hasRemoteAggregate(),
        getProjectKey: getOpenProjectAiSessionKey,
        normalizeProjectPath: normalizeAiSessionProjectPath,
        logDiagnostic: logAiSessionDiagnostic,
    });
    aiSessionPinController.migrateLegacy(
        context.globalState.get(OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY) as string[],
        () => context.globalState.update(OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY, undefined)
    );
    const workspaceContextResolver = new WorkspaceContextResolver();
    const workspacePrimaryRootStore = new WorkspacePrimaryRootStore(context.globalState);
    let openWorkspaceController: OpenWorkspaceController;
    let workspaceNavigationController: WorkspaceNavigationController<vscode.Uri>;
    const resolveCurrentOpenWorkspace = (): OpenWorkspace | null => workspaceContextResolver.resolve({
        workspaceFile: vscode.workspace.workspaceFile,
        workspaceFolders: vscode.workspace.workspaceFolders,
        workspaceName: vscode.workspace.name,
        remoteName: vscode.env.remoteName,
    });
    const getCurrentOpenWorkspace = (): OpenWorkspace | null => openWorkspaceController
        ? openWorkspaceController.getCurrentWorkspace()
        : resolveCurrentOpenWorkspace();
    const savedWorkspaceProjectAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: resolveCurrentOpenWorkspace,
        pendingStore: new PendingWorkspaceSaveStore(context.globalState),
        getProjectDetailsForSave: navigationUri =>
            currentProjectDetailsResolver.getProjectDetailsForSave(vscode.Uri.parse(navigationUri)),
        saveWorkspaceProject: details => projectMutationController.saveWorkspaceProject(details),
        executeSaveWorkspaceAs: () => Promise.resolve(
            vscode.commands.executeCommand('workbench.action.saveWorkspaceAs')
        ),
    });
    const workspaceSessionHydrationController = new WorkspaceSessionHydrationController<vscode.Terminal>({
        providers: aiSessionProviders,
        readCoordinator: aiSessionReadCoordinator,
        incrementalScanMaxFiles: AI_SESSION_INCREMENTAL_SCAN_MAX_FILES,
        getRefreshReason: () => currentAiSessionRefreshReason,
        getSessionComparableCwd: (providerId, session) =>
            getProviderAiSessionComparableCwd(providerId, session, aiSessionProviders),
        getPinnedSessions: () => aiSessionPinController.getAll(),
        getAliases: () => aiSessionAliasController.getAll(),
        getActiveProvider: scopeIdentity => aiSessionProjectStateStore.getActiveProviders()[scopeIdentity],
        getExpanded: scopeIdentity => aiSessionProjectStateStore.getExpandedProjects().has(scopeIdentity),
        getActiveRuntimes: () => aiSessionRuntimeCoordinator.getActive(),
        getPendingRuntimes: () => aiSessionRuntimeCoordinator.getPending(),
        getExecutionSnapshot: () => aiSessionExecutionController.getSnapshot(),
        getFocusedIdentity: () => getFocusedAiSessionRuntimeIdentity(),
        logDiagnostic: logAiSessionDiagnostic,
    });
    const providerDirectoryCapability = new ProviderDirectoryCapabilityProbe({
        resolveExecutable: commandName => resolveAiProviderExecutable(commandName),
        run: (executable, args, options) => runBoundedAiProviderHelp(executable, args, options),
    }, message => outputChannel.appendLine(message));
    const aiSessionCommandController = new AiSessionCommandController({
        getOpenProjects,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getProjectKey: getOpenProjectAiSessionKey,
        getOpenWorkspace: getCurrentOpenWorkspace,
        getActiveEditorUri: () => vscode.window.activeTextEditor?.document.uri,
        isWorkspaceTrusted: () => (
            vscode.workspace as typeof vscode.workspace & { isTrusted?: boolean }
        ).isTrusted !== false,
        getProvider: getRegisteredAiSessionProvider,
        getProviderDirectoryCapability: providerDefinition =>
            providerDirectoryCapability.probe(providerDefinition),
        getPrimaryRootId: workspace => workspacePrimaryRootStore.getPrimaryRootId(
            workspace.scopeIdentity,
            workspace.roots
        ),
        setPrimaryRootId: (scopeIdentity, rootId) =>
            workspacePrimaryRootStore.setPrimaryRootId(scopeIdentity, rootId),
        pickWorkspaceRoot: async (workspace, action) => {
            const selected = await vscode.window.showQuickPick(
                workspace.roots.map(root => ({
                    label: root.name,
                    description: root.hostPath,
                    rootId: root.id,
                })),
                {
                    placeHolder: 'Select a workspace root',
                    ignoreFocusOut: true,
                    title: action === 'resume'
                        ? 'Resume AI Session in Workspace Root'
                        : 'New AI Session in Workspace Root',
                } as vscode.QuickPickOptions & { title: string }
            );
            return selected?.rootId;
        },
        isDirectory: hostPath => {
            try {
                return statSync(hostPath).isDirectory();
            } catch (error) {
                return false;
            }
        },
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        isProviderId: isAiSessionProviderId,
        setExpanded: (projectKey, expanded) => aiSessionProjectStateStore.setExpanded(projectKey, expanded),
        setActiveProvider: (projectKey, providerId) => aiSessionProjectStateStore.setActiveProvider(projectKey, providerId),
        togglePin: (providerId, sessionId) => aiSessionPinController.toggle(providerId, sessionId),
        getAliases: () => aiSessionAliasController.getAll(),
        saveAliases: aliases => aiSessionAliasController.saveAll(aliases),
        getOriginalName: (providerId, sessionId) => aiSessionAliasController.getOriginalName(providerId, sessionId),
        getSessionKey: getAiSessionPinKey,
        showInputBox: options => vscode.window.showInputBox(options),
        writeClipboard: value => vscode.env.clipboard.writeText(value),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        refresh: refreshAiSessionViewsIncrementally,
    });
    const pickAiSessionProvider = async (): Promise<AiSessionProviderId | undefined> => {
        while (true) {
            const picks = getRegisteredAiSessionProviders().map(providerDefinition => {
                const available = isCommandAvailableOnPath(
                    providerDefinition.commandName,
                    process.env,
                    process.platform,
                    existsSync
                );
                return {
                    label: available ? providerDefinition.label : `$(circle-slash) ${providerDefinition.label}`,
                    description: available
                        ? `Open a new ${providerDefinition.label} session`
                        : `Unavailable — ${providerDefinition.commandName} was not found on PATH`,
                    providerId: providerDefinition.id,
                    available,
                };
            });
            const quickPickOptions: vscode.QuickPickOptions = {
                placeHolder: 'Select an AI provider',
                ignoreFocusOut: true,
            };
            (quickPickOptions as vscode.QuickPickOptions & { title?: string }).title = 'Select an AI provider';
            const selected = await vscode.window.showQuickPick(picks, quickPickOptions);
            if (!selected) {
                return undefined;
            }
            if (selected.available) {
                return selected.providerId;
            }
            await vscode.window.showWarningMessage(selected.description);
        }
    };
    const aiSessionCreationController = new AiSessionCreationController({
        isProviderId: isAiSessionProviderId,
        getOpenProjects,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        pickProvider: pickAiSessionProvider,
        getProviderLabel: getAiSessionProviderLabel,
        getProvider: getRegisteredAiSessionProvider,
        resolveDirectoryScope: (project, providerId, explicitRootId) =>
            aiSessionCommandController.resolveDirectoryScope(
                project, providerId, undefined, explicitRootId
            ),
        resolveWorkspaceDirectoryScope: (target, providerId, explicitRootId) =>
            aiSessionCommandController.resolveWorkspaceDirectoryScope(
                target.workspace, providerId, undefined, explicitRootId
            ),
        rememberDirectoryScope: async directoryScope => {
            try {
                await aiSessionCommandController.rememberDirectoryScope(directoryScope);
            } catch (error) {
                logError('Could not save the AI session workspace root.', error);
            }
        },
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        createPendingId: () => randomBytes(16).toString('hex'),
        showInputBox: options => vscode.window.showInputBox(options),
        showActiveTab: projectId => provider.postMessage({
            type: 'ai-session-tab-selection-requested',
            projectId,
            tab: 'active',
        }),
        showWarningMessage: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        refresh: refreshAiSessionViewsIncrementally,
        getExistingSessionIdsForCwd: (providerId, cwd) => getAiSessionIdsForCwd(providerId, aiSessionReadCoordinator.getProviderResult(providerId, {
            forceRefresh: true,
            candidatePaths: [cwd],
            reason: 'new-session',
        }), cwd, aiSessionProviders),
        getPendingMarkerPath: providerId => aiSessionTerminalService.getPendingMarkerPath(providerId),
        scheduleNewSessionRefresh: scheduleNewAiSessionRefresh,
        announceStatus: (projectId, message) => provider.postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
        nowMs: () => Date.now(),
    });
    const aiSessionArchiveController = new AiSessionArchiveController<AiSessionRuntimeSnapshot<vscode.Terminal>>({
        isProviderId: isAiSessionProviderId,
        getProvider: getRegisteredAiSessionProvider,
        getProviderLabel: getAiSessionProviderLabel,
        getOpenProjects,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getProjectSessions: (project, providerId) => getProviderProjectAiSessions(project, providerId, aiSessionProviders),
        getRuntimeById: getAiSessionRuntimeById,
        refreshRuntimeGuard: () => aiSessionRuntimeCoordinator.refreshForHost(true),
        isRuntimeComplete: runtime => runtime.state === 'completed',
        focusRuntime: runtime => aiSessionRuntimeCoordinator.focus({ ...runtime.identity }),
        deleteRuntimeMarker: runtime => aiSessionTerminalService.deleteMarker(runtime.markerPath),
        untrackRuntime: (providerId, sessionId, workspaceScopeIdentity) =>
            aiSessionTerminalService.untrack(providerId, sessionId, workspaceScopeIdentity),
        deletePin: (providerId, sessionId) => aiSessionPinController.remove(providerId, sessionId),
        deleteAlias: (providerId, sessionId) => aiSessionAliasController.remove(providerId, sessionId),
        confirmSingleArchive: providerLabel => vscode.window.showWarningMessage(`Archive this ${providerLabel} session?`, { modal: true }, "Archive"),
        confirmBatchArchive: message => vscode.window.showWarningMessage(message, { modal: true }, 'Archive'),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        appendLine: message => outputChannel.appendLine(message),
        postCompletion: completion => postBatchArchiveCompletion(completion as AiSessionBatchArchiveCompletedMessage),
        refresh: refreshAiSessionViewsIncrementally,
        syncActiveRuntime: () => activeAiSessionTerminalHighlighter.sync(),
        logUnexpectedError: (operation, error, failedSessionId) => {
            if (operation === 'focus-runtime') {
                logAiSessionRuntimeFailure(operation, error, 'tmux');
                return;
            }
            logError(`Batch AI session archive failed during ${operation}${failedSessionId ? ` (${failedSessionId})` : ''}.`, error);
        },
    });
    const aiSessionTerminalCommandController = new AiSessionTerminalCommandController<vscode.Terminal>({
        isProviderId: isAiSessionProviderId,
        getOpenProjects,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getProjectSessions: (project, providerId) => getProviderProjectAiSessions(project, providerId, aiSessionProviders),
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        getWorkspaceScopeIdentity: () => getCurrentOpenWorkspace()?.scopeIdentity || null,
        getProjectCwd: getOpenProjectAiSessionTerminalCwd,
        normalizePath: normalizeAiSessionProjectPath,
        confirmRuntimeClose: (message, action) => vscode.window.showWarningMessage(
            message, { modal: true }, action
        ),
        chooseRuntimeConflict: async runtimes => {
            const picks = runtimes.map(runtime => {
                const backendLabel = runtime.backend === 'tmux'
                    ? `tmux · ${runtime.tmux?.layout || 'unknown'} layout`
                    : 'Direct · VS Code Terminal';
                const attachment = runtime.attached ? 'attached' : 'detached';
                const target = runtime.backend === 'tmux'
                    ? `${runtime.tmux?.sessionName || 'unknown session'}${runtime.tmux?.windowName
                        ? `:${runtime.tmux.windowName}` : ''}`
                    : runtime.terminal?.name || 'unnamed VS Code terminal';
                return {
                    label: `$(terminal) ${backendLabel}`,
                    description: attachment,
                    detail: `Target: ${target}`,
                    runtime,
                };
            });
            const selected = await vscode.window.showQuickPick(picks, {
                placeHolder: 'Select the exact AI session runtime to focus',
                ignoreFocusOut: true,
            });
            return selected?.runtime;
        },
        announceStatus: (projectId, message) => provider.postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        getProviderLabel: getAiSessionProviderLabel,
        refresh: refreshAiSessionViewsIncrementally,
    });
    const aiSessionResumeController = new AiSessionResumeController<vscode.Terminal>({
        getOpenProjects,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getProvider: getRegisteredAiSessionProvider,
        getProjectSession: (project, providerId, sessionId) => getProviderProjectAiSessions(project, providerId, aiSessionProviders).find(session => session.id === sessionId),
        resolveDirectoryScope: (project, session, providerId, explicitRootId) =>
            aiSessionCommandController.resolveDirectoryScope(
                project, providerId, session, explicitRootId
            ),
        resolveWorkspaceDirectoryScope: (target, session, providerId, explicitRootId) =>
            aiSessionCommandController.resolveWorkspaceDirectoryScope(
                target.workspace, providerId, session, explicitRootId
            ),
        rememberDirectoryScope: async directoryScope => {
            try {
                await aiSessionCommandController.rememberDirectoryScope(directoryScope);
            } catch (error) {
                logError('Could not save the AI session workspace root.', error);
            }
        },
        getTerminalName: (providerId, session) => getProviderAiSessionTerminalName(providerId, session, aiSessionProviders),
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        getRuntimeConflict: getAiSessionRuntimeCollision,
        getMarkerPath: (providerId, sessionId) => aiSessionTerminalService.getMarkerPath(providerId, sessionId),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        refresh: refreshAiSessionViewsIncrementally,
        showActiveTab: projectId => provider.postMessage({
            type: 'ai-session-tab-selection-requested',
            projectId,
            tab: 'active',
        }),
        announceStatus: (projectId, message) => provider.postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
    });
    let aiSessionUpdateSequence = 0;
    let currentAiSessionRefreshReason = 'refresh';
    let aiSessionAttentionBridgeClient: AttentionBridgeClient;
    const aiSessionAttentionController = new AiSessionAttentionController<AiSessionRuntimeSnapshot<vscode.Terminal>>({
        isEnabled: () => getStewardConfiguration().get<boolean>('aiSessionAttention.enabled', true) !== false,
        getOpenProjects,
        getProviders: getRegisteredAiSessionProviders,
        getProjectKey: project => getAttentionProjectKey(project.path),
        getRuntimeById: getAiSessionRuntimeById,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: (items, forceHeartbeat) => aiSessionAttentionBridgeClient.publish(items, forceHeartbeat),
        scheduleRefresh: reason => scheduleAiSessionRefresh(reason),
        postProjectsUpdated: projects => postAiSessionAttentionProjectsUpdated(projects),
        nowMs: () => Date.now(),
    });
    const aiSessionExecutionController = new AiSessionExecutionController({
        getActiveSessions: () => aiSessionRuntimeCoordinator.getActive()
            .filter(runtime => runtimeBelongsToCurrentWorkspace(runtime)
                && runtime.state !== 'conflict' && Boolean(runtime.identity.sessionId))
            .map(runtime => ({
                provider: runtime.identity.provider,
                sessionId: runtime.identity.sessionId as string,
                workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
                cwd: runtime.identity.cwd,
                runStartedAtMs: runtime.runStartedAtMs,
            })),
        getProviders: getRegisteredAiSessionProviders,
        getSessionKey: getAiSessionKey,
        scheduleRefresh: reason => scheduleAiSessionRefresh(reason),
        nowMs: () => Date.now(),
    });
    const getAiSessionAttentionEventIds = (identity: ActiveAiSessionTerminalIdentity): string[] => {
        const sessionKey = getAiSessionKey(identity.provider, identity.sessionId);
        return aiSessionAttentionController.getRecoverySessionEvents()
            .find(session => session.sessionKey === sessionKey)?.eventIds || [];
    };
    const acknowledgeAiSessionAttentionEventIds = async (eventIds: string[]): Promise<void> => {
        const uniqueEventIds = Array.from(new Set(eventIds.filter(eventId => Boolean(eventId))));
        if (!uniqueEventIds.length) {
            return;
        }
        aiSessionAttentionController.acknowledge(uniqueEventIds);
        await aiSessionAttentionBridgeClient.acknowledge(uniqueEventIds);
        refreshAiSessionViewsIncrementally();
    };
    const acknowledgeAiSessionAttention = async (
        identity: ActiveAiSessionTerminalIdentity
    ): Promise<void> => {
        await acknowledgeAiSessionAttentionEventIds(getAiSessionAttentionEventIds(identity));
    };
    type RuntimeLifecycleCandidate = AiSessionRuntimeLifecycleCandidate & {
        runtime: AiSessionRuntimeSnapshot<vscode.Terminal>;
    };
    const queuedAiSessionRuntimeSettlements = new Map<string, RuntimeLifecycleCandidate>();
    const settlingAiSessionRuntimeKeys = new Set<string>();
    let aiSessionRuntimeSettlementInFlight: Promise<void> | null = null;
    const runSafeAiSessionRuntimeLifecycleTask = (
        operation: string,
        task: () => unknown | Promise<unknown>
    ): Promise<void> => runAiSessionRuntimeLifecycleTask(
        operation,
        task,
        (failedOperation, category) => logAiSessionDiagnostic({
            event: 'runtime-lifecycle-task-failed',
            operation: failedOperation,
            category,
        })
    );
    const queueAiSessionRuntimeSettlements = (
        runtimes: readonly AiSessionRuntimeSnapshot<vscode.Terminal>[]
    ): void => {
        for (const runtime of runtimes) {
            if (!runtimeBelongsToCurrentWorkspace(runtime)) {
                continue;
            }
            const sessionId = runtime.identity.sessionId;
            if (!sessionId || (runtime.state !== 'completed' && runtime.state !== 'stopped')) {
                continue;
            }
            const key = `${runtime.identity.workspaceScopeIdentity}:${runtime.identity.provider}:${sessionId}:${runtime.runStartedAtMs}:${runtime.backend}`;
            if (settlingAiSessionRuntimeKeys.has(key)) {
                continue;
            }
            queuedAiSessionRuntimeSettlements.set(key, {
                key,
                sessionKey: key,
                state: runtime.state,
                runtime: {
                    ...runtime,
                    identity: cloneAiSessionRuntimeIdentity(runtime.identity),
                    ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
                },
            });
        }
        if (!aiSessionRuntimeSettlementInFlight && queuedAiSessionRuntimeSettlements.size) {
            aiSessionRuntimeSettlementInFlight = runSafeAiSessionRuntimeLifecycleTask(
                'settle-runtime-lifecycles',
                drainAiSessionRuntimeSettlements
            );
        }
    };
    const drainAiSessionRuntimeSettlements = async (): Promise<void> => {
        try {
            while (queuedAiSessionRuntimeSettlements.size) {
                const candidates = [...queuedAiSessionRuntimeSettlements.values()]
                    .sort((left, right) => left.key.localeCompare(right.key));
                queuedAiSessionRuntimeSettlements.clear();
                candidates.forEach(candidate => settlingAiSessionRuntimeKeys.add(candidate.key));
                try {
                    const settled = await settleAiSessionRuntimeLifecycles({
                        candidates: candidates,
                        evaluateAttention: () => evaluateAiSessionAttention(
                            candidates.map(candidate => ({
                                providerId: candidate.runtime.identity.provider,
                                sessionId: candidate.runtime.identity.sessionId as string,
                                attentionKey: candidate.key,
                                runtime: candidate.runtime,
                            }))
                        ),
                        release: async candidate => {
                            if (candidate.runtime.backend === 'tmux') {
                                const acknowledgement = await tmuxRuntimeDiscovery
                                    .acknowledgeInactive(candidate.runtime);
                                if (acknowledgement === 'stale') {
                                    throw new Error('The tmux lifecycle acknowledgement became stale.');
                                }
                                return;
                            }
                            aiSessionTerminalService.releaseCompletedSession(
                                candidate.runtime.identity.provider,
                                candidate.runtime.identity.sessionId as string,
                                candidate.runtime.identity.workspaceScopeIdentity
                            );
                        },
                        reportFailure: (operation, category, key) => logAiSessionDiagnostic({
                            event: 'runtime-lifecycle-settlement-failed',
                            operation,
                            category,
                            hasRuntimeKey: Boolean(key),
                        }),
                    });
                    if (settled.releasedKeys.length) {
                        refreshAiSessionViewsIncrementally();
                        activeAiSessionTerminalHighlighter.sync();
                    }
                } finally {
                    candidates.forEach(candidate => settlingAiSessionRuntimeKeys.delete(candidate.key));
                }
            }
        } catch (_error) {
            logAiSessionDiagnostic({
                event: 'runtime-lifecycle-settlement-failed',
                operation: 'drain',
                category: 'unexpected',
            });
        } finally {
            aiSessionRuntimeSettlementInFlight = null;
            if (queuedAiSessionRuntimeSettlements.size) {
                queueAiSessionRuntimeSettlements([]);
            }
        }
    };
    aiSessionAttentionBridgeClient = new AttentionBridgeClient(
        aggregate => {
            if (aiSessionAttentionController.setRemoteAggregate(aggregate)) {
                scheduleAiSessionRefresh('attention');
                postAiSessionAttentionProjectsUpdated(aiSessionAttentionController.getProjectSummaries());
            }
        },
        error => logError('AI session attention bridge unavailable; using local-window monitoring.', error)
    );
    const aiSessionAttentionInterval = setInterval(() => {
        void runSafeAiSessionRuntimeLifecycleTask(
            'evaluate-attention-interval', evaluateAiSessionAttention
        );
    }, 10_000);
    setTimeout(() => {
        void runSafeAiSessionRuntimeLifecycleTask(
            'evaluate-attention-startup', evaluateAiSessionAttention
        );
    }, 0);
    const aiSessionExecutionInterval = setInterval(() => { aiSessionExecutionController.evaluate(); }, 1_000);
    setTimeout(() => { aiSessionExecutionController.evaluate(); }, 0);
    const aiSessionDashboardController = new AiSessionDashboardController({
        providerIds: aiSessionProviders.map(provider => provider.id),
        isVisible: () => provider.visible,
        invalidateCache: providerId => invalidateAiSessionCache(providerId),
        watchSessionChanges: (providerId, onDidChange) => getRegisteredAiSessionProvider(providerId).service.watchSessionChanges(onDidChange),
        getGroups: () => projectService.getGroups(),
        getTodoSearchItems: () => todoService.getSearchItems(),
        getCards: getOpenWorkspaceCards,
        nextSequence: () => ++aiSessionUpdateSequence,
        postMessage: message => provider.postMessage(message),
        refresh: refreshStewardViews,
        logError,
        logDiagnostic: logAiSessionDiagnostic,
        beforeRefresh: reason => { currentAiSessionRefreshReason = reason; },
        afterRefresh: () => { currentAiSessionRefreshReason = 'refresh'; },
        debounceMs: AI_SESSION_REFRESH_DEBOUNCE_MS,
        watcherRefreshMinIntervalMs: AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS,
        newSessionRefreshDelaysMs: NEW_AI_SESSION_REFRESH_DELAYS_MS,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: handle => clearTimeout(handle),
    });

    const dashboardMessageRouter = createDashboardMessageRouter({
        getAiSessionProviderIds: () => getRegisteredAiSessionProviders().map(provider => provider.id),
        saveCurrentWorkspace: () => savedWorkspaceProjectAdapter.saveCurrentWorkspace(),
        handlers: {
            'request-projects-panel': async e => {
                if (e.version !== 1 || !Number.isSafeInteger(e.requestId) || e.requestId < 1) {
                    return;
                }
                await provider.postMessage({
                    type: 'projects-panel-content',
                    version: 1,
                    requestId: e.requestId,
                    html: getProjectsPanelContent(projectService.getGroups(), stewardInfos),
                });
            },
            'request-todo-panel': async e => {
                if (e.version !== 1 || !Number.isSafeInteger(e.requestId) || e.requestId < 1) {
                    return;
                }
                await postTodoPanelContent(e.requestId as number);
            },
            'todo-add': async e => {
                const valid = typeof e.title === 'string' && Boolean(e.title.trim());
                await runTodoRequestMutation({
                    requestId: e.requestId,
                    valid,
                    mutate: () => todoService.addTodo({
                        title: e.title as string,
                        notes: typeof e.notes === 'string' ? e.notes : '',
                        priority: e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? e.priority : 'medium',
                        groupId: typeof e.groupId === 'string' ? e.groupId : undefined,
                    }),
                    onSuccess: () => postTodoPanelContent(),
                    postResult: message => provider.postMessage(message),
                    showErrorMessage: message => vscode.window.showErrorMessage(message),
                    logError,
                });
            },
            'todo-add-group': async () => {
                await runTodoPromptMutation({
                    prompt: value => vscode.window.showInputBox({
                        prompt: 'Todo group title',
                        placeHolder: 'Group name',
                        value,
                        ignoreFocusOut: true,
                    }),
                    mutate: title => todoService.addGroup(title),
                    refreshPanel: () => postTodoPanelContent(),
                    showErrorMessage: message => vscode.window.showErrorMessage(message),
                    logError,
                });
            },
            'todo-toggle': async e => {
                if (typeof e.todoId !== 'string') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.completeTodo(e.todoId as string, e.completed === true));
            },
            'todo-delete': async e => {
                if (typeof e.todoId !== 'string') {
                    return;
                }
                await deleteTodoWithConfirmation({
                    todoId: e.todoId,
                    getData: () => todoService.getData(),
                    confirm: title => vscode.window.showWarningMessage(
                        `Delete TODO "${title}"?`,
                        { modal: true },
                        'Delete'
                    ),
                    deleteTodo: todoId => todoService.deleteTodo(todoId),
                    refreshPanel: () => postTodoPanelContent(),
                    showErrorMessage: message => vscode.window.showErrorMessage(message),
                    logError,
                });
            },
            'todo-delete-group': async e => {
                if (typeof e.groupId !== 'string') {
                    return;
                }
                const todoGroup = todoService.getData().groups.find(group => group.id === e.groupId);
                if (!todoGroup) {
                    return;
                }
                const confirmed = await vscode.window.showWarningMessage(
                    `Delete TODO group "${todoGroup.title}" and all of its todos?`,
                    { modal: true },
                    'Delete'
                );
                if (confirmed !== 'Delete') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.deleteGroup(e.groupId as string));
            },
            'todo-rename-group': async e => {
                if (typeof e.groupId !== 'string') {
                    return;
                }
                await renameTodoGroupWithPrompt({
                    groupId: e.groupId,
                    getData: () => todoService.getData(),
                    prompt: value => vscode.window.showInputBox({
                        prompt: 'Todo group title',
                        value,
                        ignoreFocusOut: true,
                    }),
                    renameGroup: (groupId, title) => todoService.renameGroup(groupId, title),
                    refreshPanel: () => postTodoPanelContent(),
                    showErrorMessage: message => vscode.window.showErrorMessage(message),
                    logError,
                });
            },
            'todo-reorder-groups': async e => {
                if (!Array.isArray(e.groupIds)) {
                    return;
                }
                await runTodoPanelMutation(() => todoService.reorderGroups(e.groupIds as string[]));
            },
            'todo-reorder-items': async e => {
                if (typeof e.groupId !== 'string' || !Array.isArray(e.todoIds)) {
                    return;
                }
                await runTodoPanelMutation(() => todoService.reorderTodos(e.groupId as string, e.todoIds as string[]));
            },
            'todo-collapse-group': async e => {
                if (typeof e.groupId !== 'string') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.setGroupCollapsed(e.groupId as string, e.collapsed === true));
            },
            'todo-collapse-groups': async e => {
                await runTodoPanelMutation(() => todoService.setGroupsCollapsed(e.collapsed === true));
            },
            'todo-sort-priority': async e => {
                if (typeof e.groupId !== 'string') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.sortGroupByPriority(e.groupId as string));
            },
            'todo-toggle-show-completed': async e => {
                await runTodoPanelMutation(async () => {
                    const persistedViewState = await todoService.setShowCompleted(e.showCompleted === true);
                    todoViewState.showCompleted = persistedViewState.showCompleted;
                    revealedTodoId = undefined;
                });
            },
            'todo-reveal': async e => {
                if (typeof e.todoId !== 'string' || typeof e.groupId !== 'string') {
                    return;
                }
                await runTodoPanelMutation(async () => {
                    const result = await todoService.revealTodo(e.todoId as string, e.groupId as string);
                    if (result.revealed) {
                        revealedTodoId = e.todoId as string;
                    }
                });
            },
            'todo-update': async e => {
                if (typeof e.todoId !== 'string' || typeof e.title !== 'string') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.updateTodo(e.todoId as string, {
                    title: e.title as string,
                    notes: typeof e.notes === 'string' ? e.notes : '',
                    priority: e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? e.priority : 'medium',
                }));
            },
            'selected-project': async e => {
                let projectId = e.projectId as string;
                let projectOpenType = e.projectOpenType as ProjectOpenType;

                if (projectId.startsWith('__openWorkspaceNavigation-')) {
                    await workspaceNavigationController.open(projectId);
                    return;
                }

                let project = projectService.getProject(projectId) || getOpenProjects().find(p => p.id === projectId);
                if (project == null) {
                    vscode.window.showWarningMessage("Selected Project not found.");
                    return;
                }

                const attentionProject = withAttentionProject(
                    project,
                    aiSessionAttentionController.getEffectiveAggregate()
                );
                await acknowledgeAiSessionAttentionEventIds(attentionProject.aiSessionAttentionEventIds);
                await projectOpenController.openProject(project, projectOpenType);
            },
            'add-project': async e => {
                await projectMutationController.addProject(e.groupId as string);
            },
            'import-from-other-storage': async () => {
                await projectService.copyProjectsFromFilledStorageOptionToEmptyStorageOption();
                refreshAfterMutation();
            },
            'reordered-projects': async e => {
                await projectOrderController.reorderGroups(e.groupOrders as GroupOrder[]);
            },
            'reordered-favorites': async e => {
                await favoriteProjectController.reorderFavoriteProjects(Array.isArray(e.projectIds) ? e.projectIds as string[] : []);
            },
            'remove-project': async e => {
                await projectRemovalController.removeProject(e.projectId as string);
            },
            'edit-project': async e => {
                await projectMutationController.editProject(e.projectId as string);
            },
            'color-project': async e => {
                await projectMutationController.editProjectColor(e.projectId as string);
            },
            'favorite-project': async e => {
                await favoriteProjectController.toggleProjectFavorite(e.projectId as string);
            },
            'toggle-codex-sessions': async e => {
                await aiSessionCommandController.toggleSessionsExpanded(e.projectId as string, Boolean(e.expanded));
            },
            'select-ai-session-provider': async e => {
                await aiSessionCommandController.selectProvider(e.projectId as string, e.provider as string);
            },
            'focus-ai-session-terminal': async e => {
                await aiSessionTerminalCommandController.focusActive(
                    e.projectId as string,
                    e.provider as string,
                    e.sessionId as string
                );
            },
            'focus-pending-ai-session': async e => {
                await aiSessionTerminalCommandController.focusPending(
                    e.projectId as string,
                    e.provider as string,
                    e.createdAt as string
                );
            },
            'close-ai-session-terminal': async e => {
                await aiSessionTerminalCommandController.closeTerminal({
                    projectId: e.projectId as string,
                    providerId: e.provider as string,
                    sessionId: e.sessionId as string,
                    pendingCreatedAt: e.pendingCreatedAt as string,
                    expectedBackend: 'vscode',
                });
            },
            'detach-ai-session-terminal': async e => {
                await aiSessionTerminalCommandController.closeTerminal({
                    projectId: e.projectId as string,
                    providerId: e.provider as string,
                    sessionId: e.sessionId as string,
                    pendingCreatedAt: e.pendingCreatedAt as string,
                    expectedBackend: 'tmux',
                });
            },
            'toggle-ai-session-pin': async e => {
                await aiSessionCommandController.togglePin(e.provider as string, e.sessionId as string);
            },
            'acknowledge-ai-session-attention': async e => {
                const attentionEventIds = Array.isArray(e.eventIds) ? e.eventIds.filter((id: unknown): id is string => typeof id === 'string') : [];
                await acknowledgeAiSessionAttentionEventIds(attentionEventIds);
            },
            'rename-ai-session': async e => {
                await aiSessionCommandController.renameSession(e.provider as string, e.sessionId as string);
            },
            'copy-ai-session-id': async e => {
                await aiSessionCommandController.copySessionId(e.sessionId as string);
            },
            'request-full-refresh': e => {
                logOpenProjectDiagnostic('Renderer', {
                    event: 'full-refresh-requested',
                    reason: typeof e.reason === 'string' ? e.reason.slice(0, 256) : 'unknown',
                });
                refreshStewardViews(typeof e.reason === 'string' ? e.reason.slice(0, 256) : 'webview-requested');
            },
            'open-workspaces-rendered': e => {
                logOpenProjectDiagnostic('Renderer', {
                    event: 'open-workspaces-rendered',
                    semanticRevision: typeof e.semanticRevision === 'string'
                        ? e.semanticRevision.slice(0, 128)
                        : 'invalid',
                    currentWorkspaceCount: (e.currentWorkspaceCount === 0 || e.currentWorkspaceCount === 1)
                        ? e.currentWorkspaceCount as number
                        : -1,
                    navigationWorkspaceCount: Number.isSafeInteger(e.navigationWorkspaceCount)
                        && e.navigationWorkspaceCount >= 0
                        ? e.navigationWorkspaceCount as number
                        : -1,
                    hasOtherWindowsGroup: e.hasOtherWindowsGroup === true,
                    otherWindowsStatus: e.otherWindowsStatus === 'ready'
                        || e.otherWindowsStatus === 'unavailable'
                        || e.otherWindowsStatus === 'update-required'
                        ? e.otherWindowsStatus as string
                        : 'invalid',
                });
            },
            'request-active-ai-session-terminal': () => {
                activeAiSessionTerminalHighlighter.request();
            },
            'request-ai-session-attention-state': () => {
                provider.postMessage({
                    type: 'ai-session-attention-state',
                    sessionEvents: aiSessionAttentionController.getRecoverySessionEvents(),
                    eventIds: aiSessionAttentionController.getAttentionEventIds(),
                });
            },
            'open-settings': async () => {
                await showProjectStewardSettings();
            },
            'open-bridge-extension': async () => {
                await vscode.commands.executeCommand(
                    'workbench.extensions.action.showExtensionsWithIds',
                    ['hzcheng.project-steward-attention-ui-bridge'],
                );
            },
            'archive-ai-sessions': async e => {
                await aiSessionArchiveController.archiveSessions(
                    e.projectId as string,
                    e.provider as string,
                    e.sessionIds
                );
            },
            'edit-group': async e => {
                await groupCommandController.editGroup(e.groupId as string);
            },
            'remove-group': async e => {
                await groupCommandController.removeGroup(e.groupId as string);
            },
            'add-group': async () => {
                await groupCommandController.addGroup();
            },
            'collapse-group': async e => {
                await groupCollapseController.collapseGroup(e.groupId as string, e.collapsed as boolean);
            },
            // Collapse-all is a per-webview convenience action.
            'toggle-all-groups': () => undefined,
        },
        createAiSession: async (e, rootId) => {
            await aiSessionCreationController.createSession(
                e.projectId as string,
                rootId || undefined
            );
        },
        resumeAiSession: async (e, providerId, rootId) => {
            await aiSessionResumeController.resumeProjectSession(
                e.projectId as string,
                providerId as AiSessionProviderId | null,
                e.sessionId as string,
                rootId || undefined
            );
        },
        archiveAiSession: async (e, providerId) => {
            await aiSessionArchiveController.archiveSession(
                e.projectId as string,
                providerId as AiSessionProviderId | null,
                e.sessionId as string
            );
        },
    });
    const provider = new SidebarStewardViewProvider({
        getWebviewOptions: () => getDashboardWebviewOptions(context.extensionPath, vscode.Uri.file),
        renderContent: webview => getStewardContent(
            context,
            webview,
            projectService.getGroups(),
            stewardInfos,
            true,
            getOpenWorkspaceCards(),
            openWorkspaceDashboardController.getState().otherWindows.status,
        ),
        renderError: getErrorContent,
        onMessage: dashboardMessageRouter,
        onVisibleChanged: async visible => {
            setAiSessionWatchersActive(visible);
            activeAiSessionTerminalHighlighter.setVisible(visible);
            if (visible) {
                void tmuxFocusedRuntimeMonitor.request();
            }
            await dashboardRuntimeController.handleAiSessionViewVisibilityChanged(visible);
        },
        logError,
    });
    let openWorkspaceBridgeClient: OpenWorkspaceBridgeClient;
    openWorkspaceController = new OpenWorkspaceController({
        getWorkspace: resolveCurrentOpenWorkspace,
        publishWorkspace: (workspace, followsFocusEvent) =>
            openWorkspaceBridgeClient.publish(workspace, followsFocusEvent),
    });
    const dashboardRuntimeController = new DashboardRuntimeController({
        isVisible: () => provider.visible,
        refreshProvider: () => provider.refresh(),
        logDashboardDiagnostic,
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
        viewType: SidebarStewardViewProvider.viewType,
        publishOpenProjects: () => openWorkspaceController.publish(),
        getOpenProjects,
        syncProjectColorToCurrentWindow: project => projectWindowColorService.syncProjectColorToCurrentWindow(project),
        postMessage: message => provider.postMessage(message),
        logError,
        refreshAiSessionRuntimes: (_reason, force) => aiSessionRuntimeCoordinator.refreshForHost(force),
        logAiSessionRuntimeFailure,
    });
    const openWorkspaceDashboardController = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: getCurrentOpenWorkspace,
        getCurrentWorkspaceAiSessions: workspace => workspaceSessionHydrationController.hydrate(workspace),
        getGroups: () => projectService.getGroups(),
        getTodoSearchItems: () => todoService.getSearchItems(),
        getCollapsed: () => Boolean(groupCollapseController.getOpenProjectsCollapsed()),
        getAttentionAggregate: () => aiSessionAttentionController.getEffectiveAggregate(),
        getBridgeInstanceId: () => openWorkspaceBridgeClient.instanceId,
        postMessage: message => provider.postMessage(message),
        refresh: refreshStewardViews,
        isVisible: () => provider.visible,
        logDiagnostic: logOpenProjectDiagnostic,
        logError,
    });
    workspaceNavigationController = new WorkspaceNavigationController<vscode.Uri>({
        getRecord: cardId => openWorkspaceDashboardController.getNavigationWorkspace(cardId),
        getAvailableCommands: () => vscode.commands.getCommands(true),
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
        parseUri: value => vscode.Uri.parse(value),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        refresh: refreshStewardViews,
    });
    openWorkspaceBridgeClient = new OpenWorkspaceBridgeClient(
        openWorkspaceController.getPublication(),
        aggregate => {
            const statusChanged = openWorkspaceDashboardController.setBridgeStatus('ready');
            if (openWorkspaceDashboardController.setAggregate(aggregate) || statusChanged) {
                postOpenWorkspacesUpdated();
            }
        },
        error => logError('Open workspace bridge unavailable; showing this window only.', error),
        {
            refreshProjects: () => openProjectWorkspaceController.getOpenProjectRecords(),
            reportDiagnostic: event => logOpenProjectDiagnostic('Workspace', event),
            reportBridgeDiagnostic: event => logOpenProjectDiagnostic('Bridge', event),
            onStatusChange: status => {
                if (openWorkspaceDashboardController.setBridgeStatus(status)) {
                    postOpenWorkspacesUpdated();
                }
            },
        }
    );
    const activeAiSessionTerminalHighlighter = new ActiveAiSessionTerminalHighlighter<
        vscode.Terminal,
        AiSessionTerminalEntry<vscode.Terminal>
    >({
        isVisible: () => provider.visible,
        getActiveTerminal: () => vscode.window.activeTerminal || null,
        resolveTerminal: terminal => aiSessionTerminalService.resolveTerminalSession(
            terminal,
            providerId => getAiSessionTerminalCandidates(providerId, aiSessionReadCoordinator)
        ),
        isComplete: resolution => aiSessionTerminalService.isComplete(resolution.entry),
        publish: identity => postActiveAiSessionTerminalChanged(identity),
        onComplete: resolution => {
            if (!resolution.entry.runtimeIdentity) {
                return;
            }
            queueAiSessionRuntimeSettlements([{
                identity: cloneAiSessionRuntimeIdentity(resolution.entry.runtimeIdentity),
                backend: 'vscode',
                state: 'completed',
                markerPath: resolution.entry.markerPath,
                runStartedAtMs: resolution.entry.runStartedAtMs,
                attached: true,
                terminal: resolution.terminal,
            }]);
        },
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    });
    const tmuxFocusedRuntimeMonitor = new TmuxFocusedRuntimeMonitor<vscode.Terminal>({
        isVisible: () => provider.visible,
        getActiveTerminal: () => vscode.window.activeTerminal || null,
        syncFocusedRuntime: terminal => tmuxRuntimeBackend.syncFocusedRuntime(terminal),
        refresh: refreshAiSessionViewsIncrementally,
        onError: error => logAiSessionRuntimeFailure('sync-focused-runtime', error),
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    });
    tmuxFocusedRuntimeMonitor.start();
    const aiSessionTerminalCompletionInterval = setInterval(() => {
        const completedSessions = aiSessionTerminalService.getCompletedSessions();
        const completedRuntimes = completedSessions.filter(resolution =>
            !!resolution.entry.runtimeIdentity).map(resolution => ({
                identity: cloneAiSessionRuntimeIdentity(resolution.entry.runtimeIdentity),
                backend: 'vscode',
                state: 'completed',
                markerPath: resolution.entry.markerPath,
                runStartedAtMs: resolution.entry.runStartedAtMs,
                attached: true,
                terminal: resolution.terminal,
            } as AiSessionRuntimeSnapshot<vscode.Terminal>));
        const inactiveTmuxRuntimes = tmuxRuntimeDiscovery.getInactive()
            .map(runtime => runtime as AiSessionRuntimeSnapshot<vscode.Terminal>);
        queueAiSessionRuntimeSettlements([...completedRuntimes, ...inactiveTmuxRuntimes]);
    }, 1_000);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarStewardViewProvider.viewType, provider));
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal(() => {
            activeAiSessionTerminalHighlighter.sync();
            void tmuxFocusedRuntimeMonitor.request();
            refreshAiSessionViewsIncrementally();
            void runSafeAiSessionRuntimeLifecycleTask(
                'evaluate-attention-active-terminal', evaluateAiSessionAttention
            );
        }));
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(terminal => {
            const closedSessions = aiSessionRuntimeCoordinator.getActive()
                .filter(runtime => runtime.backend === 'vscode' && runtime.terminal === terminal
                    && Boolean(runtime.identity.sessionId))
                .map(runtime => ({
                    provider: runtime.identity.provider,
                    sessionId: runtime.identity.sessionId as string,
                }));
            const hadRuntimeClient = [...aiSessionRuntimeCoordinator.getActive(), ...aiSessionRuntimeCoordinator.getPending()]
                .some(runtime => runtime.terminal === terminal);
            aiSessionRuntimeCoordinator.handleClosedTerminal(terminal);
            aiSessionExecutionController.evaluate();
            activeAiSessionTerminalHighlighter.handleTerminalClosed(terminal);
            if (closedSessions.length || hadRuntimeClient) {
                refreshAiSessionViewsIncrementally();
                void runSafeAiSessionRuntimeLifecycleTask(
                    'evaluate-attention-closed-terminal', evaluateAiSessionAttention
                );
            }
        }));
    context.subscriptions.push(activeAiSessionTerminalHighlighter);
    context.subscriptions.push(tmuxFocusedRuntimeMonitor);
    context.subscriptions.push(openWorkspaceBridgeClient);
    context.subscriptions.push(aiSessionAttentionBridgeClient);
    context.subscriptions.push({
        dispose: () => {
            aiSessionDashboardController.dispose();
            clearInterval(aiSessionAttentionInterval);
            clearInterval(aiSessionExecutionInterval);
            clearInterval(aiSessionTerminalCompletionInterval);
        }
    });

    const stewardInfos: StewardInfos = {
        relevantExtensionsInstalls: {
            remoteSSH: false,
            remoteContainers: false,
        },
        get config() { return getStewardConfiguration() },
        get otherStorageHasData() { return projectService.otherStorageHasData() },
        get favoritesGroupCollapsed() { return groupCollapseController.getFavoritesCollapsed() },
        get openProjects() { return getOpenProjects() },
        get openProjectsGroupCollapsed() { return groupCollapseController.getOpenProjectsCollapsed() },
        get todoSearchItems() { return todoService.getSearchItems() },
    };
    const dashboardStartupController = new DashboardStartupController({
        stewardInfos,
        relevantExtensions: RelevantExtensions,
        isExtensionInstalled: extensionId => vscode.extensions.getExtension(extensionId) !== undefined,
        migrateDataIfNeeded: async () => {
            const projectMigration = settleMigration(() => projectService.migrateDataIfNeeded());
            const todoMigration = settleMigration(() => todoService.migrateDataIfNeeded());
            todoStorageMigration.ready = todoMigration.then(() => undefined, () => undefined);
            const [projects, todos] = await Promise.all([projectMigration, todoMigration]);
            return { projects, todos };
        },
        refreshDashboard: () => provider.refresh(),
        publishOpenProjects: () => openWorkspaceController.publish(),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logError,
        showSteward,
        applyProjectColorToCurrentWindow,
        getReopenReason: () => context.globalState.get(REOPEN_KEY),
        updateReopenReason: reason => context.globalState.update(REOPEN_KEY, reason),
        reopenNoneValue: ReopenStewardReason.None,
        getWorkspaceName: () => vscode.workspace.name,
        getVisibleEditorLanguageIds: () => vscode.window.visibleTextEditors.map(editor => editor.document.languageId),
    });
    const dashboardLifecycleController = new DashboardLifecycleController({
        checkDataMigration: openStewardAfterMigrate => dashboardStartupController.checkDataMigration(openStewardAfterMigrate),
        applyProjectColorToCurrentWindow,
        refresh: refreshStewardViews,
        publishOpenProjects: followsFocusEvent => openWorkspaceController.publish(followsFocusEvent),
        evaluateAiSessionAttention: () => runSafeAiSessionRuntimeLifecycleTask(
            'evaluate-attention-window-state', evaluateAiSessionAttention
        ),
    });
    const activeTerminalFileReferenceController = new ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => vscode.window.activeTextEditor,
        getActiveTerminal: () => vscode.window.activeTerminal,
        asRelativePath: uri => vscode.workspace.asRelativePath(uri as vscode.Uri, false),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
    });

    new DashboardCommandRegistration<vscode.Disposable>({
        registerCommand: (command, callback) => vscode.commands.registerCommand(command, callback),
        pushSubscription: disposable => context.subscriptions.push(disposable),
        handlers: {
            open: () => showSteward(),
            addProject: () => projectMutationController.addProject(),
            saveProject: () => savedWorkspaceProjectAdapter.saveCurrentWorkspace(),
            removeProject: () => projectRemovalController.removeProjectPerCommand(),
            editProjects: () => projectManualEditController.editProjectsManually(),
            addGroup: () => groupCommandController.addGroup(),
            removeGroup: () => groupCommandController.removeGroupPerCommand(),
            addProjectsFromFolder: () => addProjectsFromFolderController.addProjectsFromFolder(),
            addFileToActiveTerminal: () => activeTerminalFileReferenceController.addFileToActiveTerminal(),
        },
    }).register();

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        if (event.affectsConfiguration('projectSteward.aiSessionTerminalMode')
            || event.affectsConfiguration('projectSteward.aiSessionTmuxLayout')
            || event.affectsConfiguration('projectSteward.aiSessionTmuxPath')) {
            await handleAiSessionRuntimeConfigurationChanged();
        }
        await dashboardLifecycleController.handleConfigurationChanged(event);
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        dashboardLifecycleController.handleWorkspaceFoldersChanged();
    }));

    context.subscriptions.push(vscode.window.onDidChangeWindowState(windowState => {
        dashboardLifecycleController.handleWindowStateChanged(windowState);
    }));

    try {
        await savedWorkspaceProjectAdapter.completePendingWorkspaceSave();
    } catch (error) {
        logError('Could not complete the pending workspace save.', error);
    }

    void dashboardStartupController.startUp();

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ Functions ~~~~~~~~~~~~~~~~~~~~~~~~~
    function logAiSessionRuntimeFailure(
        operation: string,
        error: unknown,
        backend: 'vscode' | 'tmux' = 'tmux'
    ): void {
        const detail = error instanceof TmuxRuntimeUnavailableError
            ? { category: error.reason }
            : error instanceof TmuxClientError
                ? { category: error.category, tmuxOperation: error.operation }
                : { category: 'unexpected' };
        logAiSessionDiagnostic({
            event: 'tmux-runtime-failure',
            operation,
            backend,
            ...detail,
        });
    }

    async function chooseAiSessionTmuxFallback(
        fallback: AiSessionTmuxFallbackContext
    ): Promise<'direct' | 'direct-anyway' | 'settings' | 'cancel'> {
        logAiSessionRuntimeFailure(`${fallback.operation}-fallback`, fallback.error);
        const openSettingsAction = 'Open Settings';
        if (fallback.knownHint) {
            const directAction = 'Resume in VS Code Anyway';
            const choice = await vscode.window.showWarningMessage(
                'Project Steward cannot verify the previous tmux runtime. Resuming in VS Code may start a duplicate AI process.',
                { modal: true },
                directAction,
                openSettingsAction
            );
            if (choice === openSettingsAction) {
                await showProjectStewardSettings();
                return 'settings';
            }
            return choice === directAction ? 'direct-anyway' : 'cancel';
        }

        const directAction = 'Use VS Code Terminal This Time';
        const choice = await vscode.window.showWarningMessage(
            'Project Steward cannot use tmux in this extension host.',
            directAction,
            openSettingsAction
        );
        if (choice === openSettingsAction) {
            await showProjectStewardSettings();
            return 'settings';
        }
        return choice === directAction ? 'direct' : 'cancel';
    }

    async function handleAiSessionRuntimeConfigurationChanged(): Promise<void> {
        const nextConfiguration = readAiSessionRuntimeConfiguration(getStewardConfiguration());
        const pathChanged = nextConfiguration.tmuxPath !== aiSessionRuntimeConfiguration.tmuxPath;
        aiSessionRuntimeConfiguration = nextConfiguration;
        // Reapplying the executable also clears the client's cached availability probe.
        tmuxClient.setExecutablePath(nextConfiguration.tmuxPath);
        tmuxRuntimeDiscovery.invalidate();
        logAiSessionDiagnostic({
            event: 'runtime-configuration-changed',
            mode: nextConfiguration.mode,
            layout: nextConfiguration.tmuxLayout,
            pathChanged,
        });
        try {
            await aiSessionRuntimeCoordinator.refreshForHost(true);
        } catch (error) {
            logAiSessionRuntimeFailure('configuration-refresh', error);
        }
    }

    async function evaluateAiSessionAttention(
        runtimeOverrides: ReadonlyArray<{
            providerId: AiSessionProviderId;
            sessionId: string;
            attentionKey: string;
            runtime: AiSessionRuntimeSnapshot<vscode.Terminal>;
        }> = []
    ): Promise<AiSessionAttentionEvaluation> {
        try {
            await tmuxRuntimeDiscovery.loadPersistedInactive();
        } catch (error) {
            logAiSessionRuntimeFailure('attention-inactive-restore', error);
        }
        const hasRelevantTmux = await hasRelevantTmuxRuntime();
        if (hasRelevantTmux && await hasLiveTmuxOwnership()) {
            try {
                await aiSessionRuntimeCoordinator.refreshForHost(false);
            } catch (error) {
                logAiSessionRuntimeFailure('attention-refresh', error);
            }
        }
        return aiSessionAttentionController.evaluate(runtimeOverrides);
    }

    async function hasLiveTmuxOwnership(): Promise<boolean> {
        if (aiSessionRuntimeConfiguration.mode === 'tmux'
            || tmuxRuntimeDiscovery.getActive().length
            || tmuxRuntimeDiscovery.getPending().length
            || tmuxRuntimeBackend.getConflicts().length) {
            return true;
        }
        try {
            const [known, pending] = await Promise.all([
                tmuxRuntimeStore.listKnown(),
                tmuxRuntimeStore.listPending(),
            ]);
            return known.length > 0 || pending.length > 0;
        } catch (error) {
            logAiSessionRuntimeFailure('attention-relevance', error);
            return true;
        }
    }

    async function hasRelevantTmuxRuntime(): Promise<boolean> {
        if (tmuxRuntimeDiscovery.getInactive().length) {
            return true;
        }
        try {
            const inactive = await tmuxRuntimeStore.listInactive();
            return inactive.length > 0 || await hasLiveTmuxOwnership();
        } catch (error) {
            logAiSessionRuntimeFailure('attention-relevance', error);
            return true;
        }
    }

    function getAiSessionRuntimeById(
        providerId: AiSessionProviderId,
        sessionId: string
    ): AiSessionRuntimeSnapshot<vscode.Terminal> | null {
        const workspaceScopeIdentity = getCurrentOpenWorkspace()?.scopeIdentity;
        if (!workspaceScopeIdentity) {
            return null;
        }
        const collision = getAiSessionRuntimeCollision(
            providerId, sessionId, workspaceScopeIdentity
        );
        if (collision) {
            return collision;
        }
        const live = aiSessionRuntimeCoordinator.getById(
            providerId, sessionId, workspaceScopeIdentity
        );
        if (live) {
            return live;
        }
        const liveConflicts = aiSessionRuntimeCoordinator.getActive().filter(runtime =>
            runtime.identity.provider === providerId && runtime.identity.sessionId === sessionId
            && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity);
        if (liveConflicts.length > 1) {
            return { ...liveConflicts[0], state: 'conflict' };
        }
        const inactiveTmux: AiSessionRuntimeSnapshot<vscode.Terminal>[] = tmuxRuntimeDiscovery.getInactive()
            .filter(runtime => runtime.identity.provider === providerId
                && runtime.identity.sessionId === sessionId
                && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity)
            .map(runtime => {
                const { terminal: _terminal, ...detached } = runtime;
                return {
                    ...detached,
                    identity: cloneAiSessionRuntimeIdentity(runtime.identity),
                    ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
                };
            });
        const completedDirect = aiSessionTerminalService.getTrackedTerminalEntries()
            .filter(entry => entry.provider === providerId && entry.sessionId === sessionId
                && aiSessionTerminalService.isComplete(entry) && !!entry.runtimeIdentity
                && entry.runtimeIdentity.workspaceScopeIdentity === workspaceScopeIdentity)
            .map(entry => ({
                identity: cloneAiSessionRuntimeIdentity(entry.runtimeIdentity),
                backend: 'vscode' as const,
                state: 'completed' as const,
                markerPath: entry.markerPath,
                runStartedAtMs: entry.runStartedAtMs,
                attached: true,
                terminal: entry.terminal,
            }));
        const inactive = [...inactiveTmux, ...completedDirect];
        return inactive.length === 1 ? inactive[0] : null;
    }

    function getAiSessionRuntimeCollision(
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<vscode.Terminal> | null {
        return findTmuxCollisionRuntime(
            tmuxRuntimeDiscovery.getDiagnostics(), providerId, sessionId,
            workspaceScopeIdentity
        ) as AiSessionRuntimeSnapshot<vscode.Terminal> | null;
    }

    function getProjectedAiSessionActiveRuntimes(): AiSessionRuntimeSnapshot<vscode.Terminal>[] {
        return aiSessionRuntimeCoordinator.getActive().filter(runtimeBelongsToCurrentWorkspace);
    }

    function getFocusedAiSessionRuntimeIdentity() {
        const activeTerminal = vscode.window.activeTerminal || null;
        const tmuxRuntime = tmuxRuntimeBackend.getFocusedRuntime(activeTerminal);
        return tmuxRuntime && runtimeBelongsToCurrentWorkspace(tmuxRuntime)
            ? tmuxRuntime.identity
            : activeAiSessionTerminalHighlighter.getIdentity();
    }

    function runtimeBelongsToCurrentWorkspace(
        runtime: AiSessionRuntimeSnapshot<vscode.Terminal>
    ): boolean {
        const workspaceScopeIdentity = getCurrentOpenWorkspace()?.scopeIdentity;
        return !!workspaceScopeIdentity
            && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity;
    }

    function getAiSessionTmuxAttachTerminalName(
        runtime: AiSessionRuntimeSnapshot
    ): string | undefined {
        const projects = getOpenProjects();
        const project = projects.find(candidate =>
            normalizeAiSessionProjectPath(getOpenProjectAiSessionTerminalCwd(candidate))
                === normalizeAiSessionProjectPath(runtime.identity.cwd));
        if (runtime.tmux?.layout === 'project') {
            return boundedAiSessionTmuxTitle(
                `Project Steward: ${project?.name || 'AI Project'} [tmux]`
            );
        }
        const sessionId = runtime.identity.sessionId;
        const session = project && sessionId
            ? getProviderProjectAiSessions(
                project, runtime.identity.provider, aiSessionProviders
            ).find(candidate => candidate.id === sessionId)
            : undefined;
        return session
            ? boundedAiSessionTmuxTitle(
                `Project Steward: ${getProviderAiSessionTerminalName(
                    runtime.identity.provider, session, aiSessionProviders
                )} [tmux]`
            )
            : undefined;
    }

    function boundedAiSessionTmuxTitle(value: string): string {
        return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
    }

    async function showSteward() {
        await dashboardRuntimeController.showSteward();
    }

    function getRegisteredAiSessionProvider(providerId: AiSessionProviderId): AiSessionProvider {
        let provider = aiSessionProviderRegistry.get(providerId);
        if (!provider) {
            return null;
        }

        return provider;
    }

    function getRegisteredAiSessionProviders(): AiSessionProvider[] {
        return aiSessionProviders;
    }

    function refreshStewardViews(reason = 'refresh') {
        openWorkspaceController.refresh();
        dashboardRuntimeController.refresh(reason);
    }

    function postOpenWorkspacesUpdated() {
        openWorkspaceDashboardController.postUpdated();
    }

    function postAiSessionAttentionProjectsUpdated(projects = aiSessionAttentionController.getProjectSummaries()) {
        dashboardRuntimeController.postAttentionProjectsUpdated(projects);
    }

    function scheduleAiSessionRefresh(reason = 'refresh') {
        aiSessionDashboardController.scheduleRefresh(reason);
        if (reason === 'execution') {
            publishOpenProjectRecordsSafely();
        }
    }

    function publishOpenProjectRecordsSafely() {
        try {
            openProjectWorkspaceController.publish();
        } catch (error) {
            logError('Failed to publish open project records.', error);
        }
    }

    function setAiSessionWatchersActive(active: boolean) {
        aiSessionDashboardController.setWatchersActive(active);
    }

    function scheduleNewAiSessionRefresh(providerId: AiSessionProviderId) {
        aiSessionDashboardController.scheduleNewSessionRefresh(providerId);
    }

    function refreshAiSessionViewsIncrementally() {
        void aiSessionDashboardController.refreshNow();
        publishOpenProjectRecordsSafely();
    }

    function postBatchArchiveCompletion(message: AiSessionBatchArchiveCompletedMessage) {
        dashboardRuntimeController.postBatchArchiveCompletion(message);
    }

    function postActiveAiSessionTerminalChanged(identity: ActiveAiSessionTerminalIdentity | null) {
        dashboardRuntimeController.postActiveAiSessionTerminalChanged(identity);
    }

    async function postTodoPanelContent(requestId?: number) {
        let html: string;
        try {
            await todoStorageMigration.ready;
            const unsupportedVersionError = todoService.getUnsupportedVersionError();
            if (unsupportedVersionError) {
                throw unsupportedVersionError;
            }
            const todoData = todoService.getData();
            const config = getStewardConfiguration();
            const todoRenderOptions = {
                maxVisibleTodosPerGroup: getMaxVisibleTodosPerGroup(config),
            };
            html = getTodoPanelContent(buildTodoViewModel(todoData, todoViewState, revealedTodoId), todoRenderOptions);
        } catch (error) {
            if (!(error instanceof UnsupportedTodoDataVersionError)) {
                throw error;
            }
            html = getUnsupportedTodoVersionPanelContent(error.version);
        }
        await provider.postMessage(requestId
            ? {
                type: 'todo-panel-content',
                version: 1,
                requestId,
                html,
            }
            : {
                type: 'todo-panel-updated',
                version: 1,
                html,
                searchCatalog: buildWorkspaceDashboardSearchCatalog(
                    projectService.getGroups(),
                    getOpenWorkspaceCards(),
                    todoService.getSearchItems(),
                ),
            });
    }

    async function runTodoPanelMutation(mutate: () => Promise<unknown>): Promise<boolean> {
        return runTodoMutation({
            mutate,
            onSuccess: () => postTodoPanelContent(),
            showErrorMessage: message => vscode.window.showErrorMessage(message),
            logError,
        });
    }

    function getMaxVisibleTodosPerGroup(config: vscode.WorkspaceConfiguration): number {
        const configuredItems = config.get('maxVisibleTodosPerGroup', 5);
        const visibleItems = Math.floor(Number(configuredItems));
        return Number.isFinite(visibleItems) && visibleItems > 0 ? visibleItems : 5;
    }

    function invalidateAiSessionCache(providerId: AiSessionProviderId) {
        getRegisteredAiSessionProvider(providerId)?.service.invalidateCache();
    }

    function refreshAfterMutation() {
        dashboardRuntimeController.refreshAfterMutation();
    }

    function applyProjectColorToCurrentWindow(project: Project = null) {
        dashboardRuntimeController.applyProjectColorToCurrentWindow(project);
    }

    async function showProjectStewardSettings() {
        await dashboardRuntimeController.openSettings();
    }

    function isFolderGitRepo(fPath: string) {
        return gitRepositoryDetector.isGitRepositoryPath(fPath);
    }

    function getOpenProjects(): Project[] {
        const rawOpenProjects = getOpenProjectsFromWorkspace(
            vscode.workspace.workspaceFile,
            vscode.workspace.workspaceFolders,
            {
                savedProjects: projectService.getProjectsFlat(),
                currentRemoteName: vscode.env.remoteName,
                isFolderGitRepo,
            },
        );
        const hydrated = aiSessionProjectHydrationController.hydrate(rawOpenProjects);
        return applyAiSessionRuntimeProjection({
            projects: hydrated,
            providers: AI_SESSION_PROVIDER_DEFINITIONS,
            activeRuntimes: getProjectedAiSessionActiveRuntimes(),
            pendingRuntimes: aiSessionRuntimeCoordinator.getPending()
                .filter(runtimeBelongsToCurrentWorkspace),
            workspaceScopeIdentity: getCurrentOpenWorkspace()?.scopeIdentity || null,
            executionSnapshot: aiSessionExecutionController.getSnapshot(),
            focusedIdentity: getFocusedAiSessionRuntimeIdentity(),
            getProjectCwd: getOpenProjectAiSessionTerminalCwd,
            normalizePath: normalizeAiSessionProjectPath,
        });
    }

    function getOpenWorkspaceCards() {
        return openWorkspaceDashboardController.getCards();
    }

    function getCurrentWorkspaceActionTarget(cardId: string): WorkspaceAiSessionActionTarget | null {
        const workspace = getCurrentOpenWorkspace();
        if (!workspace) {
            return null;
        }
        const card = getOpenWorkspaceCards()
            .find(candidate => candidate.kind === 'current' && candidate.id === cardId);
        return card?.aiSessions
            ? { cardId: card.id, workspace, sessions: card.aiSessions }
            : null;
    }

    function getAiSessionsUpdatedMessage(): AiSessionsUpdatedMessage {
        return aiSessionDashboardController.getUpdatedMessage();
    }

    function getAiSessionPinKey(providerId: AiSessionProviderId, sessionId: string): string {
        return getAiSessionKey(providerId, sessionId);
    }

}




// this method is called when your extension is deactivated
export function deactivate() {
}
