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
import AiSessionAliasStore, { sanitizeAiSessionAlias } from './aiSessions/aliasStore';
import AiSessionAliasController from './aiSessions/aliasController';
import AiSessionPinStore from './aiSessions/pinStore';
import AiSessionPinController from './aiSessions/pinController';
import AiSessionProjectStateStore from './aiSessions/projectStateStore';
import ActiveAiSessionTerminalHighlighter from './aiSessions/activeTerminalHighlight';
import AiSessionAttentionMonitor from './aiSessions/attentionMonitor';
import AttentionBridgeClient from './aiSessions/attentionBridgeClient';
import { aggregateAttentionSnapshots, AttentionAggregate } from './aiSessions/attentionAggregate';
import type { AttentionPayloadItem } from './aiSessions/attentionPayload';
import { buildAttentionSessionIndex, getAttentionProjectKey, getAttentionProjectSummaries } from './aiSessions/attentionProject';
import type { ActiveAiSessionTerminalIdentity } from './aiSessions/activeTerminalHighlight';
import { getAiSessionKey } from './aiSessions/sessionHelpers';
import { createAiSessionProviderRegistry, getAiSessionProviderLabel } from './aiSessions/providers';
import { getAiSessionCandidatePaths as getOpenProjectAiSessionCandidatePaths, getAiSessionOpenProjectCandidates, getOpenProjectAiSessionKey, getOpenProjectTerminalCwd as getOpenProjectAiSessionTerminalCwd, normalizeAiSessionProjectPath } from './aiSessions/projectCandidates';
import { getAiSessionComparableCwd as getProviderAiSessionComparableCwd, getAiSessionTerminalCwd as getProviderAiSessionTerminalCwd, getAiSessionTerminalName as getProviderAiSessionTerminalName, getProjectAiSessions as getProviderProjectAiSessions } from './aiSessions/sessionPaths';
import { getAiSessionIdsForCwd } from './aiSessions/pendingTerminals';
import { resolvePendingAiSessionTerminals as resolvePendingAiSessionTerminalMatches } from './aiSessions/pendingTerminalResolver';
import { getAiSessionTerminalCandidates } from './aiSessions/terminalCandidates';
import { getAiSessionScanMaxFiles } from './aiSessions/scanOptions';
import { getUsableTerminalCwd } from './aiSessions/terminalCwd';
import { hydrateOpenProjectsWithAiSessions } from './aiSessions/projectHydration';
import { AiSessionReadCoordinator } from './aiSessions/readCoordinator';
import { buildOpenProjectAiSessionViewModel } from './aiSessions/viewModels';
import AiSessionTerminalService from './aiSessions/terminalService';
import AiSessionTerminalBindingStore from './aiSessions/terminalBindingStore';
import type { AiSessionActiveTerminalChangedMessage, AiSessionBatchArchiveCompletedMessage, AiSessionProvider, AiSessionReadResult, AiSessionService, AiSessionTerminalEntry, AiSessionsUpdatedMessage, OpenProjectAiSessionViewModel } from './aiSessions/types';
import type { AiSessionLifecycleRequest, AiSessionLifecycleSignal } from './aiSessions/lifecycle';
import { AiSessionDashboardController } from './aiSessions/dashboardController';
import { AiSessionCommandController } from './aiSessions/commandController';
import { AiSessionCreationController } from './aiSessions/creationController';
import { AiSessionArchiveController } from './aiSessions/archiveController';
import { AiSessionResumeController } from './aiSessions/resumeController';
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
import DashboardDiagnostics from './dashboard/diagnostics';
import { getErrorContent } from './dashboard/errorContent';
import { GroupCollapseController } from './dashboard/groupCollapseController';
import { createDashboardMessageRouter } from './dashboard/messageRouter';
import { shouldOpenStewardOnStartup } from './dashboard/startup';
import { getDashboardWebviewOptions } from './dashboard/webviewOptions';
import { OpenProjectDashboardController } from './openProjects/dashboardController';
import { OpenProjectWorkspaceController } from './openProjects/workspaceController';

type TerminalEntry = AiSessionTerminalEntry<vscode.Terminal>;

const NEW_AI_SESSION_REFRESH_DELAYS_MS = [250, 1000, 2500, 5000];
const AI_SESSION_REFRESH_DEBOUNCE_MS = 3000;
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
        trackPendingTerminal: pending => trackPendingAiSessionTerminal(
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
    const aiSessionAttentionMonitor = new AiSessionAttentionMonitor();
    let aiSessionAttentionAggregate: AttentionAggregate | null = null;
    let aiSessionAttentionLocalItems: AttentionPayloadItem[] = [];
    const aiSessionAttentionBridgeClient = new AttentionBridgeClient(
        aggregate => {
            if (aggregate.aggregateRevision !== aiSessionAttentionAggregate?.aggregateRevision) {
                aiSessionAttentionAggregate = aggregate;
                scheduleAiSessionRefresh('attention');
                postAiSessionAttentionProjectsUpdated();
            }
        },
        error => logError('AI session attention bridge unavailable; using local-window monitoring.', error)
    );
    const aiSessionAttentionInterval = setInterval(() => { void evaluateAiSessionAttention(); }, 10_000);
    setTimeout(() => { void evaluateAiSessionAttention(); }, 0);
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
        beforeRefresh: reason => { currentAiSessionRefreshReason = reason; },
        afterRefresh: () => { currentAiSessionRefreshReason = 'refresh'; },
        debounceMs: AI_SESSION_REFRESH_DEBOUNCE_MS,
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
                aiSessionAttentionMonitor.acknowledge(attentionEventIds);
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
                });
            },
            'request-active-ai-session-terminal': () => {
                activeAiSessionTerminalHighlighter.request();
            },
            'request-ai-session-attention-state': () => {
                provider.postMessage({
                    type: 'ai-session-attention-state',
                    sessionEvents: getAiSessionAttentionRecoverySessionEvents(),
                    eventIds: Array.from(new Set([
                        ...Object.values(aiSessionAttentionMonitor.getSnapshot())
                            .map(snapshot => snapshot.event?.eventId)
                            .filter((id): id is string => Boolean(id)),
                        ...getEffectiveAiSessionAttentionAggregate().sessions
                            .reduce((eventIds, item) => eventIds.concat(item.eventIds), [] as string[]),
                    ])),
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
    const openProjectDashboardController = new OpenProjectDashboardController({
        getOpenProjects,
        getGroups: () => projectService.getGroups(),
        getStewardInfos: () => stewardInfos,
        getAttentionAggregate: getEffectiveAiSessionAttentionAggregate,
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
            void evaluateAiSessionAttention();
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

    const openCommand = vscode.commands.registerCommand('projectSteward.open', () => {
        showSteward();
    });

    const addProjectCommand = vscode.commands.registerCommand('projectSteward.addProject', async () => {
        await projectMutationController.addProject();
    });

    const saveProjectCommand = vscode.commands.registerCommand('projectSteward.saveProject', async () => {
        await projectMutationController.saveProject();
    });

    const removeProjectCommand = vscode.commands.registerCommand('projectSteward.removeProject', async () => {
        await projectRemovalController.removeProjectPerCommand();
    });

    const editProjectsManuallyCommand = vscode.commands.registerCommand('projectSteward.editProjects', async () => {
        await projectManualEditController.editProjectsManually();
    });

    const addGroupCommand = vscode.commands.registerCommand('projectSteward.addGroup', async () => {
        await groupCommandController.addGroup();
    });

    const removeGroupCommand = vscode.commands.registerCommand('projectSteward.removeGroup', async () => {
        await groupCommandController.removeGroupPerCommand();
    });
    const addProjectsFromFolderCommand = vscode.commands.registerCommand('projectSteward.addProjectsFromFolder', async () => {
        await addProjectsFromFolderController.addProjectsFromFolder();
    });

    context.subscriptions.push(openCommand);
    context.subscriptions.push(addProjectCommand);
    context.subscriptions.push(saveProjectCommand);
    context.subscriptions.push(removeProjectCommand);
    context.subscriptions.push(editProjectsManuallyCommand);
    context.subscriptions.push(addGroupCommand);
    context.subscriptions.push(removeGroupCommand);
    context.subscriptions.push(addProjectsFromFolderCommand);

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        if (event.affectsConfiguration("projectSteward.storeProjectsInSettings")
            || event.affectsConfiguration("dashboard.storeProjectsInSettings")) {
            await checkDataMigration(false);
        }

        if (event.affectsConfiguration("projectSteward")
            || event.affectsConfiguration("dashboard")) {
            applyProjectColorToCurrentWindow();
            refreshStewardViews('configuration-changed');
            openProjectWorkspaceController.publish();
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        applyProjectColorToCurrentWindow();
        refreshStewardViews('workspace-folders-changed');
        openProjectWorkspaceController.publish();
    }));

    context.subscriptions.push(vscode.window.onDidChangeWindowState(windowState => {
        if (windowState.focused) {
            openProjectWorkspaceController.publish(true);
        }
        void evaluateAiSessionAttention();
    }));

    startUp();

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ Functions ~~~~~~~~~~~~~~~~~~~~~~~~~
    async function checkDataMigration(openStewardAfterMigrate: boolean = false) {
        let migrated = await projectService.migrateDataIfNeeded();
        if (migrated) {
            openProjectWorkspaceController.publish();
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
        applyProjectColorToCurrentWindow();

        let reopenStewardReason = context.globalState.get(REOPEN_KEY) as ReopenStewardReason;
        context.globalState.update(REOPEN_KEY, ReopenStewardReason.None);
        if (shouldOpenStewardOnStartup({
            reopenReason: reopenStewardReason,
            reopenNoneValue: ReopenStewardReason.None,
            openOnStartup: stewardInfos.config.openOnStartup,
            workspaceName: vscode.workspace.name,
            visibleEditorLanguageIds: vscode.window.visibleTextEditors.map(editor => editor.document.languageId),
        })) {
            showSteward();
        }
    }

    async function showSteward() {
        openProjectWorkspaceController.publish();
        await revealSidebarSteward();
        refreshStewardViews('show-steward');
    }

    function revealSidebarSteward(): Thenable<void> {
        return vscode.commands.executeCommand('workbench.view.extension.project-steward')
            .then(() => vscode.commands.executeCommand(`${SidebarStewardViewProvider.viewType}.focus`))
            .then(undefined, () => vscode.commands.executeCommand(`${SidebarStewardViewProvider.viewType}.focus`))
            .then(undefined, () => { });
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
        if (!provider.visible) {
            return;
        }

        logDashboardDiagnostic({
            event: 'full-refresh',
            reason,
        });
        provider.refresh();
    }

    function postOpenProjectsUpdated() {
        openProjectDashboardController.postUpdated();
    }

    function getEffectiveAiSessionAttentionAggregate(): AttentionAggregate {
        const now = Date.now();
        return aiSessionAttentionAggregate || aggregateAttentionSnapshots([{
            version: 1,
            generatedAtMs: now,
            items: aiSessionAttentionLocalItems,
            instanceId: '00000000000000000000000000000000',
            sequence: 0,
            heartbeat: 0,
        }], new Set<string>(), now);
    }

    function getAiSessionAttentionRecoverySessionEvents(): Array<{ sessionKey: string; eventIds: string[] }> {
        const bySession = new Map<string, Set<string>>();
        const addEvent = (sessionKey: string, eventId: string) => {
            if (!sessionKey || !eventId) {
                return;
            }
            const eventIds = bySession.get(sessionKey) || new Set<string>();
            eventIds.add(eventId);
            bySession.set(sessionKey, eventIds);
        };
        Object.entries(aiSessionAttentionMonitor.getSnapshot()).forEach(([sessionKey, snapshot]) => {
            if (snapshot.event?.eventId) {
                addEvent(sessionKey, snapshot.event.eventId);
            }
        });
        getEffectiveAiSessionAttentionAggregate().sessions.forEach(session => {
            session.eventIds.forEach(eventId => addEvent(session.sessionKey, eventId));
        });
        return Array.from(bySession.entries())
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .slice(0, 1000)
            .map(([sessionKey, eventIds]) => ({ sessionKey, eventIds: Array.from(eventIds).slice(0, 1000) }));
    }

    function postAiSessionAttentionProjectsUpdated() {
        if (!provider.visible) {
            return;
        }

        void provider.postMessage({
            type: 'ai-session-attention-projects-updated',
            projects: getAttentionProjectSummaries(getEffectiveAiSessionAttentionAggregate()),
        });
    }

    function scheduleAiSessionRefresh(reason = 'refresh') {
        aiSessionDashboardController.scheduleRefresh(reason);
    }

    function setAiSessionWatchersActive(active: boolean) {
        aiSessionDashboardController.setWatchersActive(active);
    }

    async function evaluateAiSessionAttention() {
        if (getStewardConfiguration().get<boolean>('aiSessionAttention.enabled', true) === false) {
            aiSessionAttentionMonitor.evaluate([]);
            aiSessionAttentionAggregate = null;
            aiSessionAttentionLocalItems = [];
            await aiSessionAttentionBridgeClient.publish([], true);
            scheduleAiSessionRefresh('attention');
            postAiSessionAttentionProjectsUpdated();
            return;
        }
        const projects = getOpenProjects();
        const registeredProviders = getRegisteredAiSessionProviders();
        const ownedSessions = new Map<string, {
            providerId: AiSessionProviderId;
            session: CodexSession;
            terminal: TerminalEntry;
        }>();
        for (const project of projects) {
            for (const sessionProvider of registeredProviders) {
                const providerId = sessionProvider.id;
                for (const session of project[sessionProvider.projectSessionsKey] || []) {
                    const key = getAiSessionKey(providerId, session.id);
                    const terminal = aiSessionTerminalService.getById(providerId, session.id);
                    if (!terminal || ownedSessions.has(key)) {
                        continue;
                    }
                    ownedSessions.set(key, { providerId, session, terminal });
                }
            }
        }

        const requestsByProvider = registeredProviders.reduce((result, sessionProvider) => {
            result[sessionProvider.id] = [];
            return result;
        }, {} as Record<AiSessionProviderId, AiSessionLifecycleRequest[]>);
        for (const owned of ownedSessions.values()) {
            requestsByProvider[owned.providerId].push({
                sessionId: owned.session.id,
                runStartedAtMs: owned.terminal.runStartedAtMs,
            });
        }

        const signalsByProvider = registeredProviders.reduce((result, sessionProvider) => {
            const providerId = sessionProvider.id;
            const requests = requestsByProvider[providerId];
            result[providerId] = requests.length
                ? sessionProvider.service.getLifecycleSignals(requests)
                : {};
            return result;
        }, {} as Record<AiSessionProviderId, Record<string, AiSessionLifecycleSignal>>);

        const inputs = Array.from(ownedSessions, ([key, owned]) => {
            const signal = aiSessionTerminalService.isComplete(owned.terminal)
                ? {
                    token: `terminal-exit:${owned.terminal.runStartedAtMs}`,
                    phase: 'needsAttention' as const,
                    reason: 'completed' as const,
                    occurredAtMs: owned.terminal.runStartedAtMs,
                }
                : signalsByProvider[owned.providerId][owned.session.id];
            return {
                key,
                signal,
                observedAt: signal?.occurredAtMs,
            };
        });
        if (aiSessionAttentionMonitor.evaluate(inputs).length) {
            scheduleAiSessionRefresh('attention');
        }
        const snapshot = aiSessionAttentionMonitor.getSnapshot();
        const items: AttentionPayloadItem[] = [];
        for (const project of projects) {
            const projectKey = getAttentionProjectKey(project.path);
            if (!projectKey) {
                continue;
            }
            for (const sessionProvider of registeredProviders) {
                const providerId = sessionProvider.id;
                for (const session of project[sessionProvider.projectSessionsKey] || []) {
                    const attention = snapshot[getAiSessionKey(providerId, session.id)];
                    if (!attention?.event) {
                        continue;
                    }
                    items.push({
                        projectId: projectKey,
                        sessionKey: getAiSessionKey(providerId, session.id),
                        state: attention.state === 'needsAttention' ? 'needsAttention' : 'acknowledged',
                        eventId: attention.event.eventId,
                        reason: attention.event.reason,
                        observedAtMs: attention.stateChangedAt,
                    });
                }
            }
        }
        aiSessionAttentionLocalItems = items;
        if (!aiSessionAttentionAggregate) {
            postAiSessionAttentionProjectsUpdated();
        }
        await aiSessionAttentionBridgeClient.publish(items);
    }

    function scheduleNewAiSessionRefresh(providerId: AiSessionProviderId) {
        aiSessionDashboardController.scheduleNewSessionRefresh(providerId);
    }

    function refreshAiSessionViewsIncrementally() {
        void aiSessionDashboardController.refreshNow();
    }

    function postBatchArchiveCompletion(message: AiSessionBatchArchiveCompletedMessage) {
        provider.postMessage(message).then(undefined, error => {
            logError('Failed to post batch AI session archive completion.', error);
        });
    }

    function postActiveAiSessionTerminalChanged(identity: ActiveAiSessionTerminalIdentity | null) {
        let message: AiSessionActiveTerminalChangedMessage = {
            type: 'active-ai-session-terminal-changed',
            provider: identity?.provider || null,
            sessionId: identity?.sessionId || null,
        };
        provider.postMessage(message).then(undefined, error => {
            logError('Failed to post the active AI session terminal.', error);
        });
    }

    function invalidateAiSessionCache(providerId: AiSessionProviderId) {
        getRegisteredAiSessionProvider(providerId)?.service.invalidateCache();
    }

    function refreshAfterMutation() {
        applyProjectColorToCurrentWindow();
        refreshStewardViews('project-mutation');
        openProjectWorkspaceController.publish();
    }

    function applyProjectColorToCurrentWindow(project: Project = null) {
        project = project || getOpenProjects()[0];
        if (project?.showSaveAction) {
            project = null;
        }
        projectWindowColorService.syncProjectColorToCurrentWindow(project).then(undefined, error => {
            logError('Failed to apply project color to current window.', error);
        });
    }

    async function showProjectStewardSettings() {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:hzcheng.project-steward');
    }

    function isFolderGitRepo(fPath: string) {
        return gitRepositoryDetector.isGitRepositoryPath(fPath);
    }

    function getOpenProjects(): Project[] {
        return withAiSessions(openProjectWorkspaceController.getRawOpenProjects());
    }

    function getOpenProjectCards(): Project[] {
        return openProjectDashboardController.getCards();
    }

    function withAiSessions(openProjects: Project[]): Project[] {
        if (!openProjects.length) {
            return openProjects;
        }

        let sessionResults = getAiSessionResults(openProjects);
        resolvePendingAiSessionTerminalMatches({
            terminalService: aiSessionTerminalService,
            sessionResults,
            providers: aiSessionProviders,
            getSessionKey: getAiSessionPinKey,
            setAlias: (providerId, sessionId, alias) => aiSessionAliasController.set(providerId, sessionId, alias),
            syncActiveTerminal: () => activeAiSessionTerminalHighlighter.sync(),
        });
        let assignments = getAiSessionAssignments(openProjects, sessionResults);
        let expandedProjects = getExpandedCodexSessionProjects();
        let activeProviders = getActiveAiSessionProviders();
        // Results are scoped to this window, so missing sessions cannot be used to prune persisted pins.
        let pinnedSessions = aiSessionPinController.getAll();
        let aliases = aiSessionAliasController.getAll();
        const aggregate = getEffectiveAiSessionAttentionAggregate();
        const aggregateByProjectAndSession = buildAttentionSessionIndex(aggregate);
        const localAttentionBySession = aiSessionAttentionMonitor.getSnapshot();
        return hydrateOpenProjectsWithAiSessions({
            projects: openProjects,
            providers: getRegisteredAiSessionProviders(),
            sessionResults,
            assignments,
            expandedProjects,
            activeProviders,
            pinnedSessions,
            aliases,
            aggregateByProjectAndSession,
            localAttentionBySession,
            includeLocalAttention: !aiSessionAttentionAggregate,
            getProjectKey: getOpenProjectAiSessionKey,
        });
    }

    function getAiSessionsUpdatedMessage(): AiSessionsUpdatedMessage {
        return aiSessionDashboardController.getUpdatedMessage();
    }

    function getOpenProjectAiSessionViewModel(project: Project): OpenProjectAiSessionViewModel {
        return buildOpenProjectAiSessionViewModel({
            project,
            providers: getRegisteredAiSessionProviders(),
            getProjectKey: getOpenProjectAiSessionKey,
            getSearchText: getProjectSearchText,
            renderSessionSection: getAiSessionsDiv,
        });
    }

    function getAiSessionResults(openProjects: Project[] = [], reason = currentAiSessionRefreshReason): Record<AiSessionProviderId, AiSessionReadResult> {
        let candidatePaths = getOpenProjectAiSessionCandidatePaths(openProjects, vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders);
        let maxFiles = getAiSessionScanMaxFiles(reason, AI_SESSION_INCREMENTAL_SCAN_MAX_FILES);
        return aiSessionReadCoordinator.getResults({ candidatePaths, reason, maxFiles });
    }

    function getAiSessionAssignments(openProjects: Project[], sessionResults: Record<AiSessionProviderId, AiSessionReadResult>): Record<AiSessionProviderId, Map<string, CodexSession[]>> {
        return aiSessionReadCoordinator.getAssignments(
            getAiSessionOpenProjectCandidates(openProjects, vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders),
            sessionResults,
            (providerId, session) => getProviderAiSessionComparableCwd(providerId, session, aiSessionProviders)
        );
    }

    function trackPendingAiSessionTerminal(providerId: AiSessionProviderId, terminal: vscode.Terminal, markerPath: string, cwd: string, createdAt: string, excludedSessionIds: string[], title: string = null) {
        let comparableCwd = normalizeAiSessionProjectPath(cwd);
        if (!terminal || !markerPath || !comparableCwd) {
            return;
        }

        aiSessionTerminalService.trackPending({
            provider: providerId,
            terminal,
            markerPath,
            cwd: comparableCwd,
            createdAt,
            excludedSessionIds: Array.isArray(excludedSessionIds) ? excludedSessionIds.filter(id => !!id) : [],
            title: sanitizeAiSessionAlias(title),
        });
    }

    function getAiSessionPinKey(providerId: AiSessionProviderId, sessionId: string): string {
        return getAiSessionKey(providerId, sessionId);
    }

    function getActiveAiSessionProviders(): Record<string, AiSessionProviderId> {
        return aiSessionProjectStateStore.getActiveProviders();
    }

    function getExpandedCodexSessionProjects(): Set<string> {
        return aiSessionProjectStateStore.getExpandedProjects();
    }

    function getAiSessionTerminal(providerId: AiSessionProviderId, session: CodexSession): TerminalEntry {
        return aiSessionTerminalService.get(providerId, session);
    }

}




// this method is called when your extension is deactivated
export function deactivate() {
}
