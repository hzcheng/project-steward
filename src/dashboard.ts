'use strict';
import * as vscode from 'vscode';
import { Project, GroupOrder, ProjectRemoteType, StewardInfos, ProjectOpenType, ReopenStewardReason, CodexSession, AiSessionProviderId, isAiSessionProviderId } from './models';
import { getAiSessionsDiv, getProjectSearchText, getProjectsPanelContent, getStewardContent } from './webview/webviewContent';
import { USER_CANCELED, RelevantExtensions, REOPEN_KEY, WSL_DEFAULT_REGEX, OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY } from './constants';

import ColorService from './services/colorService';
import ProjectService from './services/projectService';
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
import { getAttentionProjectKey } from './aiSessions/attentionProject';
import type { ActiveAiSessionTerminalIdentity } from './aiSessions/activeTerminalHighlight';
import { getAiSessionKey } from './aiSessions/sessionHelpers';
import { createAiSessionProviderRegistry, getAiSessionProviderLabel } from './aiSessions/providers';
import { getOpenProjectAiSessionKey, getOpenProjectTerminalCwd as getOpenProjectAiSessionTerminalCwd, normalizeAiSessionProjectPath } from './aiSessions/projectCandidates';
import { getAiSessionComparableCwd as getProviderAiSessionComparableCwd, getAiSessionTerminalCwd as getProviderAiSessionTerminalCwd, getAiSessionTerminalName as getProviderAiSessionTerminalName, getProjectAiSessions as getProviderProjectAiSessions } from './aiSessions/sessionPaths';
import { getAiSessionIdsForCwd } from './aiSessions/pendingTerminals';
import { getAiSessionTerminalCandidates } from './aiSessions/terminalCandidates';
import { getUsableTerminalCwd } from './aiSessions/terminalCwd';
import { AiSessionReadCoordinator } from './aiSessions/readCoordinator';
import { createOpenProjectAiSessionViewModelBuilder } from './aiSessions/viewModels';
import AiSessionTerminalService from './aiSessions/terminalService';
import AiSessionTerminalBindingStore from './aiSessions/terminalBindingStore';
import type { AiSessionBatchArchiveCompletedMessage, AiSessionProvider, AiSessionService, AiSessionTerminalEntry, AiSessionsUpdatedMessage, OpenProjectAiSessionViewModel } from './aiSessions/types';
import { AiSessionDashboardController } from './aiSessions/dashboardController';
import { AiSessionCommandController } from './aiSessions/commandController';
import { AiSessionCreationController } from './aiSessions/creationController';
import { AiSessionArchiveController } from './aiSessions/archiveController';
import { AiSessionResumeController } from './aiSessions/resumeController';
import { AiSessionAttentionController } from './aiSessions/attentionController';
import { AiSessionProjectHydrationController } from './aiSessions/projectHydrationController';
import { getLastPartOfPath, isUriString, parsePathAsUri } from './projects/openProjectService';
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
import OpenProjectBridgeClient from './openProjects/bridgeClient';
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
import { DashboardStartupController } from './dashboard/startupController';
import { getDashboardWebviewOptions } from './dashboard/webviewOptions';
import { OpenProjectDashboardController } from './openProjects/dashboardController';
import { OpenProjectWorkspaceController } from './openProjects/workspaceController';

type TerminalEntry = AiSessionTerminalEntry<vscode.Terminal>;

const NEW_AI_SESSION_REFRESH_DELAYS_MS = [250, 1000, 2500, 5000];
const AI_SESSION_REFRESH_DEBOUNCE_MS = 3000;
const AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS = 10000;
const AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000;

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
        getOpenProjectUri: projectId => openProjectWorkspaceController.getOpenProjectUri(projectId),
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
    await aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals);
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
        setAlias: (providerId, sessionId, alias) => aiSessionAliasController.set(providerId, sessionId, alias),
        syncActiveTerminal: () => activeAiSessionTerminalHighlighter.sync(),
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
    const aiSessionCommandController = new AiSessionCommandController({
        getOpenProjects,
        getProjectKey: getOpenProjectAiSessionKey,
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
    const aiSessionCreationController = new AiSessionCreationController({
        isProviderId: isAiSessionProviderId,
        getOpenProjects,
        getProviderLabel: getAiSessionProviderLabel,
        getProvider: getRegisteredAiSessionProvider,
        getTerminalCwd: getOpenProjectAiSessionTerminalCwd,
        getUsableTerminalCwd,
        showInputBox: options => vscode.window.showInputBox(options),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        createTerminal: options => aiSessionTerminalService.createTerminal({
            ...options,
            logError,
        }),
        getExistingSessionIdsForCwd: (providerId, cwd) => getAiSessionIdsForCwd(providerId, aiSessionReadCoordinator.getProviderResult(providerId, {
            forceRefresh: true,
            candidatePaths: [cwd],
            reason: 'new-session',
        }), cwd, aiSessionProviders),
        getPendingMarkerPath: providerId => aiSessionTerminalService.getPendingMarkerPath(providerId),
        trackPendingTerminal: pending => aiSessionProjectHydrationController.trackPendingTerminal(
            pending.provider,
            pending.terminal,
            pending.markerPath,
            pending.cwd,
            pending.createdAt,
            pending.excludedSessionIds,
            pending.title
        ),
        sendNewSessionCommand: (providerId, terminal, cwd, title, markerPath) => aiSessionTerminalService.sendNewSessionCommand(providerId, terminal, cwd, title, markerPath),
        scheduleNewSessionRefresh: scheduleNewAiSessionRefresh,
    });
    const aiSessionArchiveController = new AiSessionArchiveController<AiSessionTerminalEntry<vscode.Terminal>>({
        isProviderId: isAiSessionProviderId,
        getProvider: getRegisteredAiSessionProvider,
        getProviderLabel: getAiSessionProviderLabel,
        getOpenProjects,
        getProjectSessions: (project, providerId) => getProviderProjectAiSessions(project, providerId, aiSessionProviders),
        getExistingTerminal: (providerId, sessionId) => aiSessionTerminalService.getById(providerId, sessionId),
        isTerminalComplete: entry => aiSessionTerminalService.isComplete(entry),
        deleteEntryMarker: entry => aiSessionTerminalService.deleteEntryMarker(entry),
        untrackTerminal: (providerId, sessionId) => aiSessionTerminalService.untrack(providerId, sessionId),
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
        syncActiveTerminal: () => activeAiSessionTerminalHighlighter.sync(),
        logUnexpectedError: (operation, error, failedSessionId) => logError(`Batch AI session archive failed during ${operation}${failedSessionId ? ` (${failedSessionId})` : ''}.`, error),
    });
    const aiSessionResumeController = new AiSessionResumeController<vscode.Terminal, TerminalEntry>({
        getOpenProjects,
        getProvider: getRegisteredAiSessionProvider,
        getProjectSession: (project, providerId, sessionId) => getProviderProjectAiSessions(project, providerId, aiSessionProviders).find(session => session.id === sessionId),
        getTerminalCwd: (providerId, session, project) => getProviderAiSessionTerminalCwd(providerId, session, project, aiSessionProviders),
        getTerminalName: (providerId, session) => getProviderAiSessionTerminalName(providerId, session, aiSessionProviders),
        getComparableCwd: (providerId, session) => getProviderAiSessionComparableCwd(providerId, session, aiSessionProviders),
        getUsableTerminalCwd,
        normalizeProjectPath: normalizeAiSessionProjectPath,
        getExistingTerminal: (providerId, session) => getAiSessionTerminal(providerId, session),
        isTerminalComplete: entry => aiSessionTerminalService.isComplete(entry),
        beginResume: (providerId, sessionId) => aiSessionTerminalService.beginResume(providerId, sessionId),
        finishResume: (providerId, sessionId) => aiSessionTerminalService.finishResume(providerId, sessionId),
        getMarkerPath: (providerId, sessionId) => aiSessionTerminalService.getMarkerPath(providerId, sessionId),
        findPendingTerminalForSession: (providerId, sessionId, cwd, updatedAt) => aiSessionTerminalService.findPendingTerminalForSession(providerId, sessionId, cwd, updatedAt),
        createTerminal: options => aiSessionTerminalService.createTerminal(options),
        track: (providerId, sessionId, entry) => aiSessionTerminalService.track(providerId, sessionId, entry),
        sendResumeCommand: (providerId, terminal, sessionId, cwd, markerPath) => aiSessionTerminalService.sendResumeCommand(providerId, terminal, sessionId, cwd, markerPath),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        syncActiveTerminal: () => activeAiSessionTerminalHighlighter.sync(),
        logError,
        nowMs: () => Date.now(),
    });
    let aiSessionUpdateSequence = 0;
    let currentAiSessionRefreshReason = 'refresh';
    const aiSessionAttentionController = new AiSessionAttentionController<TerminalEntry>({
        isEnabled: () => getStewardConfiguration().get<boolean>('aiSessionAttention.enabled', true) !== false,
        getOpenProjects,
        getProviders: getRegisteredAiSessionProviders,
        getProjectKey: project => getAttentionProjectKey(project.path),
        getTerminalById: (providerId, sessionId) => aiSessionTerminalService.getById(providerId, sessionId),
        isTerminalComplete: entry => aiSessionTerminalService.isComplete(entry),
        publish: (items, forceHeartbeat) => aiSessionAttentionBridgeClient.publish(items, forceHeartbeat),
        scheduleRefresh: reason => scheduleAiSessionRefresh(reason),
        postProjectsUpdated: projects => postAiSessionAttentionProjectsUpdated(projects),
        nowMs: () => Date.now(),
    });
    const aiSessionAttentionBridgeClient = new AttentionBridgeClient(
        aggregate => {
            if (aiSessionAttentionController.setRemoteAggregate(aggregate)) {
                scheduleAiSessionRefresh('attention');
                postAiSessionAttentionProjectsUpdated(aiSessionAttentionController.getProjectSummaries());
            }
        },
        error => logError('AI session attention bridge unavailable; using local-window monitoring.', error)
    );
    const aiSessionAttentionInterval = setInterval(() => { void aiSessionAttentionController.evaluate(); }, 10_000);
    setTimeout(() => { void aiSessionAttentionController.evaluate(); }, 0);
    const openProjectAiSessionViewModelBuilder = createOpenProjectAiSessionViewModelBuilder();
    const aiSessionDashboardController = new AiSessionDashboardController({
        providerIds: aiSessionProviders.map(provider => provider.id),
        isVisible: () => provider.visible,
        invalidateCache: providerId => invalidateAiSessionCache(providerId),
        watchSessionChanges: (providerId, onDidChange) => getRegisteredAiSessionProvider(providerId).service.watchSessionChanges(onDidChange),
        getGroups: () => projectService.getGroups(),
        getCards: getOpenProjectCards,
        getOpenProjectAiSessionViewModel,
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
            'selected-project': async e => {
                let projectId = e.projectId as string;
                let projectOpenType = e.projectOpenType as ProjectOpenType;

                let project = projectService.getProject(projectId) || getOpenProjects().find(p => p.id === projectId);
                let isProjectNavigation = false;
                if (project === null || project === undefined) {
                    getOpenProjectCards();
                    project = openProjectDashboardController.getNavigationCard(projectId);
                    isProjectNavigation = project !== null && project !== undefined;
                }
                if (project == null) {
                    vscode.window.showWarningMessage("Selected Project not found.");
                    return;
                }

                await projectOpenController.openProject(project, isProjectNavigation ? ProjectOpenType.Default : projectOpenType);
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
            'save-project': async e => {
                await projectMutationController.saveOpenProject(e.projectId as string);
            },
            'toggle-codex-sessions': async e => {
                await aiSessionCommandController.toggleSessionsExpanded(e.projectId as string, Boolean(e.expanded));
            },
            'select-ai-session-provider': async e => {
                await aiSessionCommandController.selectProvider(e.projectId as string, e.provider as string);
            },
            'create-ai-session': async e => {
                await aiSessionCreationController.createSession(e.projectId as string, e.provider as string);
            },
            'toggle-ai-session-pin': async e => {
                await aiSessionCommandController.togglePin(e.provider as string, e.sessionId as string);
            },
            'acknowledge-ai-session-attention': async e => {
                const attentionEventIds = Array.isArray(e.eventIds) ? e.eventIds.filter((id: unknown): id is string => typeof id === 'string') : [];
                aiSessionAttentionController.acknowledge(attentionEventIds);
                await aiSessionAttentionBridgeClient.acknowledge(attentionEventIds);
                refreshAiSessionViewsIncrementally();
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
            'open-projects-rendered': e => {
                logOpenProjectDiagnostic('Renderer', {
                    event: 'rendered',
                    semanticRevision: typeof e.semanticRevision === 'string'
                        ? e.semanticRevision.slice(0, 128)
                        : 'invalid',
                    projectCount: Number.isSafeInteger(e.projectCount) && e.projectCount >= 0
                        ? e.projectCount as number
                        : -1,
                    renderedProjectCount: Number.isSafeInteger(e.renderedProjectCount) && e.renderedProjectCount >= 0
                        ? e.renderedProjectCount as number
                        : -1,
                    renderedNavigationProjectCount: Number.isSafeInteger(e.renderedNavigationProjectCount) && e.renderedNavigationProjectCount >= 0
                        ? e.renderedNavigationProjectCount as number
                        : -1,
                    hasOtherWindowsGroup: e.hasOtherWindowsGroup === true,
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
        resumeAiSession: async (e, providerId) => {
            await aiSessionResumeController.resumeProjectSession(
                e.projectId as string,
                providerId as AiSessionProviderId | null,
                e.sessionId as string
            );
        },
        archiveAiSession: async (e, providerId) => {
            await aiSessionArchiveController.archiveSession(providerId as AiSessionProviderId | null, e.sessionId as string);
        },
    });
    const provider = new SidebarStewardViewProvider({
        getWebviewOptions: () => getDashboardWebviewOptions(context.extensionPath, vscode.Uri.file),
        renderContent: webview => getStewardContent(
            context,
            webview,
            projectService.getGroups(),
            stewardInfos,
            true
        ),
        renderError: getErrorContent,
        onMessage: dashboardMessageRouter,
        onVisibleChanged: visible => {
            setAiSessionWatchersActive(visible);
            activeAiSessionTerminalHighlighter.setVisible(visible);
        },
        logError,
    });
    let openProjectBridgeClient: OpenProjectBridgeClient;
    const openProjectWorkspaceController = new OpenProjectWorkspaceController({
        getWorkspaceFile: () => vscode.workspace.workspaceFile,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getSavedProjects: () => projectService.getProjectsFlat(),
        getCurrentRemoteName: () => vscode.env.remoteName,
        isFolderGitRepo,
        publishRecords: (records, followsFocusEvent) => openProjectBridgeClient.publish(records, followsFocusEvent),
    });
    const dashboardRuntimeController = new DashboardRuntimeController({
        isVisible: () => provider.visible,
        refreshProvider: () => provider.refresh(),
        logDashboardDiagnostic,
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
        viewType: SidebarStewardViewProvider.viewType,
        publishOpenProjects: () => openProjectWorkspaceController.publish(),
        getOpenProjects,
        syncProjectColorToCurrentWindow: project => projectWindowColorService.syncProjectColorToCurrentWindow(project),
        postMessage: message => provider.postMessage(message),
        logError,
    });
    const openProjectDashboardController = new OpenProjectDashboardController({
        getOpenProjects,
        getGroups: () => projectService.getGroups(),
        getStewardInfos: () => stewardInfos,
        getAttentionAggregate: () => aiSessionAttentionController.getEffectiveAggregate(),
        getBridgeInstanceId: () => openProjectBridgeClient.instanceId,
        postMessage: message => provider.postMessage(message),
        refresh: refreshStewardViews,
        isVisible: () => provider.visible,
        logDiagnostic: logOpenProjectDiagnostic,
        logError,
    });
    openProjectBridgeClient = new OpenProjectBridgeClient(
        openProjectWorkspaceController.getOpenProjectRecords(),
        aggregate => {
            if (openProjectDashboardController.setAggregate(aggregate)) {
                postOpenProjectsUpdated();
            }
        },
        error => logError('Open project bridge unavailable; showing current-window projects only.', error),
        {
            reportDiagnostic: event => logOpenProjectDiagnostic('Workspace', event),
            reportBridgeDiagnostic: event => logOpenProjectDiagnostic('Bridge', event),
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
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarStewardViewProvider.viewType, provider));
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal(() => {
            activeAiSessionTerminalHighlighter.sync();
            void aiSessionAttentionController.evaluate();
        }));
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(terminal => {
            aiSessionTerminalService.handleClosedTerminal(terminal);
            activeAiSessionTerminalHighlighter.handleTerminalClosed(terminal);
        }));
    context.subscriptions.push(activeAiSessionTerminalHighlighter);
    context.subscriptions.push(openProjectBridgeClient);
    context.subscriptions.push(aiSessionAttentionBridgeClient);
    context.subscriptions.push({
        dispose: () => {
            aiSessionDashboardController.dispose();
            clearInterval(aiSessionAttentionInterval);
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
        get openProjects() { return getOpenProjectCards() },
        get openProjectsGroupCollapsed() { return groupCollapseController.getOpenProjectsCollapsed() },
    };
    const dashboardStartupController = new DashboardStartupController({
        stewardInfos,
        relevantExtensions: RelevantExtensions,
        isExtensionInstalled: extensionId => vscode.extensions.getExtension(extensionId) !== undefined,
        migrateDataIfNeeded: () => projectService.migrateDataIfNeeded(),
        publishOpenProjects: () => openProjectWorkspaceController.publish(),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
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
        publishOpenProjects: followsFocusEvent => openProjectWorkspaceController.publish(followsFocusEvent),
        evaluateAiSessionAttention: () => aiSessionAttentionController.evaluate(),
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
            saveProject: () => projectMutationController.saveProject(),
            removeProject: () => projectRemovalController.removeProjectPerCommand(),
            editProjects: () => projectManualEditController.editProjectsManually(),
            addGroup: () => groupCommandController.addGroup(),
            removeGroup: () => groupCommandController.removeGroupPerCommand(),
            addProjectsFromFolder: () => addProjectsFromFolderController.addProjectsFromFolder(),
            addFileToActiveTerminal: () => activeTerminalFileReferenceController.addFileToActiveTerminal(),
        },
    }).register();

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        await dashboardLifecycleController.handleConfigurationChanged(event);
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        dashboardLifecycleController.handleWorkspaceFoldersChanged();
    }));

    context.subscriptions.push(vscode.window.onDidChangeWindowState(windowState => {
        dashboardLifecycleController.handleWindowStateChanged(windowState);
    }));

    void dashboardStartupController.startUp();

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ Functions ~~~~~~~~~~~~~~~~~~~~~~~~~
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
        dashboardRuntimeController.refresh(reason);
    }

    function postOpenProjectsUpdated() {
        openProjectDashboardController.postUpdated();
    }

    function postAiSessionAttentionProjectsUpdated(projects = aiSessionAttentionController.getProjectSummaries()) {
        dashboardRuntimeController.postAttentionProjectsUpdated(projects);
    }

    function scheduleAiSessionRefresh(reason = 'refresh') {
        aiSessionDashboardController.scheduleRefresh(reason);
    }

    function setAiSessionWatchersActive(active: boolean) {
        aiSessionDashboardController.setWatchersActive(active);
    }

    function scheduleNewAiSessionRefresh(providerId: AiSessionProviderId) {
        aiSessionDashboardController.scheduleNewSessionRefresh(providerId);
    }

    function refreshAiSessionViewsIncrementally() {
        void aiSessionDashboardController.refreshNow();
    }

    function postBatchArchiveCompletion(message: AiSessionBatchArchiveCompletedMessage) {
        dashboardRuntimeController.postBatchArchiveCompletion(message);
    }

    function postActiveAiSessionTerminalChanged(identity: ActiveAiSessionTerminalIdentity | null) {
        dashboardRuntimeController.postActiveAiSessionTerminalChanged(identity);
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
        return aiSessionProjectHydrationController.hydrate(openProjectWorkspaceController.getRawOpenProjects());
    }

    function getOpenProjectCards(): Project[] {
        return openProjectDashboardController.getCards();
    }

    function getAiSessionsUpdatedMessage(): AiSessionsUpdatedMessage {
        return aiSessionDashboardController.getUpdatedMessage();
    }

    function getOpenProjectAiSessionViewModel(project: Project): OpenProjectAiSessionViewModel {
        return openProjectAiSessionViewModelBuilder.build({
            project,
            providers: getRegisteredAiSessionProviders(),
            getProjectKey: getOpenProjectAiSessionKey,
            getSearchText: getProjectSearchText,
            renderSessionSection: getAiSessionsDiv,
        });
    }

    function getAiSessionPinKey(providerId: AiSessionProviderId, sessionId: string): string {
        return getAiSessionKey(providerId, sessionId);
    }

    function getAiSessionTerminal(providerId: AiSessionProviderId, session: CodexSession): TerminalEntry {
        return aiSessionTerminalService.get(providerId, session);
    }

}




// this method is called when your extension is deactivated
export function deactivate() {
}
