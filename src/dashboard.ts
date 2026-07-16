'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { Project, GroupOrder, Group, ProjectRemoteType, getRemoteType, StewardInfos, ProjectOpenType, ReopenStewardReason, ProjectPathType, sanitizeProjectName, CodexSession, AiSessionProviderId, isAiSessionProviderId } from './models';
import { getAiSessionsDiv, getProjectSearchText, getProjectsPanelContent, getStewardContent } from './webview/webviewContent';
import { USE_PROJECT_COLOR, PREDEFINED_COLORS, USER_CANCELED, SAVE_CURRENT_PROJECT, FixedColorOptions, RelevantExtensions, SSH_REGEX, SSH_REMOTE_PREFIX, REOPEN_KEY, WSL_DEFAULT_REGEX, FAVORITES_GROUP_ID, FAVORITES_GROUP_COLLAPSED_KEY, OPEN_PROJECTS_GROUP_ID, OPEN_PROJECTS_GROUP_COLLAPSED_KEY, OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY } from './constants';

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
import { archiveBatchAiSessionItem as executeBatchAiSessionArchiveItem, executeBatchAiSessionArchiveRequest, formatBatchAiSessionArchiveSummary, formatBatchAiSessionIdForLog, hasBatchAiSessionArchiveIssues } from './aiSessions/archiveBatch';
import type { BatchAiSessionArchiveAttemptStatus, BatchAiSessionArchiveResult, BatchAiSessionArchiveSelection } from './aiSessions/archiveBatch';
import type { AiSessionActiveTerminalChangedMessage, AiSessionBatchArchiveCompletedMessage, AiSessionProvider, AiSessionReadResult, AiSessionService, AiSessionTerminalEntry, AiSessionsUpdatedMessage, OpenProjectAiSessionViewModel } from './aiSessions/types';
import type { AiSessionLifecycleRequest, AiSessionLifecycleSignal } from './aiSessions/lifecycle';
import { AiSessionDashboardController } from './aiSessions/dashboardController';
import { projectPathMatchesWorkspaceUri, uriToProjectPath } from './projects/openProjectMatcher';
import { getLastPartOfPath, getOpenProjectUri as resolveOpenProjectUri, getOpenProjectsFromWorkspace, isUriString, parsePathAsUri } from './projects/openProjectService';
import { getWorkspacePath as resolveWorkspacePath, getWorkspaceUri as resolveCurrentWorkspaceUri, getWorkspaceUris as resolveCurrentWorkspaceUris } from './projects/workspaceHelpers';
import RemoteProjectResolver from './projects/remoteProjectResolver';
import GitRepositoryDetector from './projects/gitRepositoryDetector';
import { withFavoriteProjectOrder, withToggledProjectFavorite } from './projects/favoriteProjectOrder';
import OpenProjectBridgeClient from './openProjects/bridgeClient';
import { createOpenProjectRecords } from './openProjects/projection';
import { SidebarStewardViewProvider } from './dashboard/viewProvider';
import { getStewardConfiguration } from './dashboard/configuration';
import DashboardDiagnostics from './dashboard/diagnostics';
import { getErrorContent } from './dashboard/errorContent';
import { createDashboardMessageRouter } from './dashboard/messageRouter';
import { shouldOpenStewardOnStartup } from './dashboard/startup';
import { getDashboardWebviewOptions } from './dashboard/webviewOptions';
import { OpenProjectDashboardController } from './openProjects/dashboardController';

type TerminalEntry = AiSessionTerminalEntry<vscode.Terminal>;

interface NewAiSessionFields {
    title: string;
}

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
    const projectWindowColorService = new ProjectWindowColorService(context);
    const fileService = new FileService(context);
    const gitRepositoryDetector = new GitRepositoryDetector();
    const codexSessionService = new CodexSessionService();
    const kimiSessionService = new KimiSessionService();
    const claudeSessionService = new ClaudeSessionService();
    const remoteProjectResolver = new RemoteProjectResolver(logError);
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

                await openProject(project, isProjectNavigation ? ProjectOpenType.Default : projectOpenType);
            },
            'add-project': async e => {
                await addProject(e.groupId as string);
            },
            'import-from-other-storage': async () => {
                await projectService.copyProjectsFromFilledStorageOptionToEmptyStorageOption();
                refreshAfterMutation();
            },
            'reordered-projects': async e => {
                await reorderGroups(e.groupOrders as GroupOrder[]);
            },
            'reordered-favorites': async e => {
                await reorderFavoriteProjects(Array.isArray(e.projectIds) ? e.projectIds as string[] : []);
            },
            'remove-project': async e => {
                await removeProject(e.projectId as string);
            },
            'edit-project': async e => {
                await editProject(e.projectId as string);
            },
            'color-project': async e => {
                await editProjectColor(e.projectId as string);
            },
            'favorite-project': async e => {
                await toggleProjectFavorite(e.projectId as string);
            },
            'save-project': async e => {
                await saveOpenProject(e.projectId as string);
            },
            'toggle-codex-sessions': async e => {
                await toggleCodexSessions(e.projectId as string, Boolean(e.expanded));
            },
            'select-ai-session-provider': async e => {
                await selectAiSessionProvider(e.projectId as string, e.provider as AiSessionProviderId);
            },
            'create-ai-session': async e => {
                await createAiSession(e.projectId as string, e.provider as AiSessionProviderId);
            },
            'toggle-ai-session-pin': async e => {
                await toggleAiSessionPin(e.provider as AiSessionProviderId, e.sessionId as string);
            },
            'acknowledge-ai-session-attention': async e => {
                const attentionEventIds = Array.isArray(e.eventIds) ? e.eventIds.filter((id: unknown): id is string => typeof id === 'string') : [];
                aiSessionAttentionMonitor.acknowledge(attentionEventIds);
                await aiSessionAttentionBridgeClient.acknowledge(attentionEventIds);
                refreshAiSessionViewsIncrementally();
            },
            'rename-ai-session': async e => {
                await renameAiSession(e.provider as AiSessionProviderId, e.sessionId as string);
            },
            'copy-ai-session-id': async e => {
                await copyAiSessionId(e.sessionId as string);
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
                await archiveAiSessions(
                    e.projectId as string,
                    e.provider as AiSessionProviderId,
                    e.sessionIds
                );
            },
            'edit-group': async e => {
                await editGroup(e.groupId as string);
            },
            'remove-group': async e => {
                await removeGroup(e.groupId as string);
            },
            'add-group': async () => {
                await addGroup();
            },
            'collapse-group': async e => {
                await collapseGroup(e.groupId as string, e.collapsed as boolean);
            },
            // Collapse-all is a per-webview convenience action.
            'toggle-all-groups': () => undefined,
        },
        resumeAiSession: async (e, providerId) => {
            await resumeProjectAiSession(
                e.projectId as string,
                providerId as AiSessionProviderId | null,
                e.sessionId as string
            );
        },
        archiveAiSession: async (e, providerId) => {
            await archiveAiSession(providerId as AiSessionProviderId | null, e.sessionId as string);
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
        createOpenProjectRecords(getRawOpenProjects()),
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
        get favoritesGroupCollapsed() { return context.globalState.get(FAVORITES_GROUP_COLLAPSED_KEY) as boolean },
        get openProjects() { return getOpenProjectCards() },
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

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        if (event.affectsConfiguration("projectSteward.storeProjectsInSettings")
            || event.affectsConfiguration("dashboard.storeProjectsInSettings")) {
            await checkDataMigration(false);
        }

        if (event.affectsConfiguration("projectSteward")
            || event.affectsConfiguration("dashboard")) {
            applyProjectColorToCurrentWindow();
            refreshStewardViews('configuration-changed');
            publishOpenProjects();
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        applyProjectColorToCurrentWindow();
        refreshStewardViews('workspace-folders-changed');
        publishOpenProjects();
    }));

    context.subscriptions.push(vscode.window.onDidChangeWindowState(windowState => {
        if (windowState.focused) {
            publishOpenProjects(true);
        }
        void evaluateAiSessionAttention();
    }));

    startUp();

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ Functions ~~~~~~~~~~~~~~~~~~~~~~~~~
    async function checkDataMigration(openStewardAfterMigrate: boolean = false) {
        let migrated = await projectService.migrateDataIfNeeded();
        if (migrated) {
            publishOpenProjects();
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
        publishOpenProjects();
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
        publishOpenProjects();
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
            let currentlyOpenPath = resolveWorkspacePath(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders);
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

        let projectKey = getOpenProjectAiSessionKey(project);
        await aiSessionProjectStateStore.setExpanded(projectKey, expanded);
    }

    async function selectAiSessionProvider(projectId: string, providerId: AiSessionProviderId) {
        if (!isAiSessionProviderId(providerId)) {
            return;
        }

        let project = getOpenProjects().find(p => p.id === projectId);
        if (!project) {
            return;
        }

        await aiSessionProjectStateStore.setActiveProvider(getOpenProjectAiSessionKey(project), providerId);
        refreshAiSessionViewsIncrementally();
    }

    async function toggleAiSessionPin(providerId: AiSessionProviderId, sessionId: string) {
        if (!isAiSessionProviderId(providerId) || !sessionId) {
            return;
        }

        if (!aiSessionPinController.toggle(providerId, sessionId)) {
            return;
        }

        refreshAiSessionViewsIncrementally();
    }

    async function renameAiSession(providerId: AiSessionProviderId, sessionId: string) {
        if (!isAiSessionProviderId(providerId) || !sessionId) {
            return;
        }

        let aliases = aiSessionAliasController.getAll();
        let sessionKey = getAiSessionPinKey(providerId, sessionId);
        let originalName = aiSessionAliasController.getOriginalName(providerId, sessionId);
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

        aiSessionAliasController.saveAll(aliases);
        refreshAiSessionViewsIncrementally();
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

        await createProviderAiSession(providerId, project, fields);
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

    async function createProviderAiSession(
        providerId: AiSessionProviderId,
        project: Project,
        fields: NewAiSessionFields
    ) {
        let sessionProvider = getRegisteredAiSessionProvider(providerId);
        let cwd = getUsableTerminalCwd(getOpenProjectAiSessionTerminalCwd(project));
        let pendingTerminalCwd = cwd || getOpenProjectAiSessionTerminalCwd(project);
        let terminalName = `${sessionProvider.terminalNamePrefix}: ${project.name || 'New Session'}`;
        let terminal = aiSessionTerminalService.createTerminal({
            name: terminalName,
            cwd,
            cwdFailureMessage: `Failed to create ${sessionProvider.label} terminal with cwd.`,
            cwdWarningMessage: `Could not open the ${sessionProvider.label} terminal at the project directory. Starting without a working directory.`,
            logError,
        }).terminal;
        let existingSessionIds = getAiSessionIdsForCwd(providerId, aiSessionReadCoordinator.getProviderResult(providerId, {
            forceRefresh: true,
            candidatePaths: [pendingTerminalCwd],
            reason: 'new-session',
        }), pendingTerminalCwd, aiSessionProviders);
        let createdAt = new Date().toISOString();
        let markerPath = aiSessionTerminalService.getPendingMarkerPath(providerId);
        trackPendingAiSessionTerminal(providerId, terminal, markerPath, pendingTerminalCwd, createdAt, existingSessionIds, fields.title);

        terminal.show();
        await aiSessionTerminalService.sendNewSessionCommand(providerId, terminal, cwd, fields.title, markerPath);
        scheduleNewAiSessionRefresh(providerId);
    }

    async function resumeProjectAiSession(projectId: string, providerId: AiSessionProviderId | null, sessionId: string) {
        if (!providerId) {
            return;
        }

        await resumeAiSession(
            providerId,
            projectId,
            sessionId,
            project => getProviderProjectAiSessions(project, providerId, aiSessionProviders).find(s => s.id === sessionId),
            (session, project) => getProviderAiSessionTerminalCwd(providerId, session, project, aiSessionProviders),
            session => getAiSessionTerminal(providerId, session)
        );
    }

    async function resumeAiSession(
        providerId: AiSessionProviderId,
        projectId: string,
        sessionId: string,
        getSession: (project: Project) => CodexSession,
        getTerminalCwd: (session: CodexSession, project: Project) => string,
        getExistingTerminal: (session: CodexSession) => TerminalEntry
    ) {
        let sessionProvider = getRegisteredAiSessionProvider(providerId);
        let project = getOpenProjects().find(p => p.id === projectId);
        let session = project ? getSession(project) : null;
        if (!project || !session) {
            vscode.window.showWarningMessage(`Selected ${sessionProvider.label} session not found.`);
            return;
        }

        let cwd = getUsableTerminalCwd(getTerminalCwd(session, project));
        let existingTerminal = getExistingTerminal(session);
        if (existingTerminal && !aiSessionTerminalService.isComplete(existingTerminal)) {
            existingTerminal.terminal.show();
            return;
        }

        if (!aiSessionTerminalService.beginResume(providerId, session.id)) {
            return;
        }

        let terminalName = getProviderAiSessionTerminalName(providerId, session, aiSessionProviders);
        let terminal: vscode.Terminal = existingTerminal?.terminal;
        let terminalEnv = { [sessionProvider.terminalEnvKey]: session.id };
        let markerPath = existingTerminal?.markerPath || aiSessionTerminalService.getMarkerPath(providerId, session.id);

        try {
            if (!terminal) {
                let sessionCwd = normalizeAiSessionProjectPath(getProviderAiSessionComparableCwd(providerId, session, aiSessionProviders));
                let pendingTerminal = sessionCwd
                    ? aiSessionTerminalService.findPendingTerminalForSession(providerId, session.id, sessionCwd, session.updatedAt)
                    : null;
                if (pendingTerminal) {
                    terminal = pendingTerminal.terminal;
                    markerPath = pendingTerminal.markerPath;
                } else {
                    let createResult = aiSessionTerminalService.createTerminal({
                        name: terminalName,
                        cwd,
                        env: terminalEnv,
                        cwdFailureMessage: `Failed to create ${sessionProvider.label} terminal with cwd.`,
                        cwdWarningMessage: `Could not open the ${sessionProvider.label} terminal at the session directory. Resuming without a working directory.`,
                        logError,
                    });
                    terminal = createResult.terminal;
                    if (!createResult.cwdAccepted) {
                        cwd = null;
                    }
                }
            }

            aiSessionTerminalService.track(providerId, session.id, { terminal, markerPath, runStartedAtMs: Date.now() });
            terminal.show();
            await aiSessionTerminalService.sendResumeCommand(providerId, terminal, session.id, cwd, markerPath);
            activeAiSessionTerminalHighlighter.sync();
        } finally {
            aiSessionTerminalService.finishResume(providerId, session.id);
        }
    }

    async function archiveAiSession(providerId: AiSessionProviderId | null, sessionId: string) {
        if (!providerId || !sessionId) {
            return;
        }

        let sessionProvider = getRegisteredAiSessionProvider(providerId);
        let existingTerminal = aiSessionTerminalService.getById(providerId, sessionId);
        if (existingTerminal && !aiSessionTerminalService.isComplete(existingTerminal)) {
            vscode.window.showWarningMessage(`This ${sessionProvider.label} session is open in a terminal. Exit or close that terminal before archiving it.`);
            existingTerminal.terminal.show();
            return;
        }

        let accepted = await vscode.window.showWarningMessage(`Archive this ${sessionProvider.label} session?`, { modal: true }, "Archive");
        if (!accepted) {
            return;
        }

        let status = archiveAiSessionItem(providerId, sessionId);
        if (status === 'running') {
            existingTerminal = aiSessionTerminalService.getById(providerId, sessionId);
            vscode.window.showWarningMessage(`This ${sessionProvider.label} session is open in a terminal. Exit or close that terminal before archiving it.`);
            existingTerminal?.terminal.show();
            return;
        }

        if (status === 'failed') {
            vscode.window.showErrorMessage(`Could not archive ${sessionProvider.label} session.`);
            return;
        }

        activeAiSessionTerminalHighlighter.sync();
        refreshAiSessionViewsIncrementally();
    }

    function archiveAiSessionItem(
        providerId: AiSessionProviderId,
        sessionId: string
    ): BatchAiSessionArchiveAttemptStatus {
        let sessionProvider = getRegisteredAiSessionProvider(providerId);
        let existingTerminal = aiSessionTerminalService.getById(providerId, sessionId);
        return executeBatchAiSessionArchiveItem(sessionId, {
            isRunning: () => Boolean(existingTerminal && !aiSessionTerminalService.isComplete(existingTerminal)),
            archiveSession: () => sessionProvider.service.archiveSession(sessionId),
            deleteEntryMarker: () => {
                if (existingTerminal) {
                    aiSessionTerminalService.deleteEntryMarker(existingTerminal);
                }
            },
            untrackTerminal: () => aiSessionTerminalService.untrack(providerId, sessionId),
            deletePin: () => aiSessionPinController.remove(providerId, sessionId),
            deleteAlias: () => aiSessionAliasController.remove(providerId, sessionId),
        });
    }

    async function archiveAiSessions(projectId: string, providerId: AiSessionProviderId, sessionIds: unknown) {
        await executeBatchAiSessionArchiveRequest({ projectId, provider: providerId, sessionIds }, {
            resolveProject: requestedProjectId => isAiSessionProviderId(providerId)
                ? getOpenProjects().find(candidate => candidate.id === requestedProjectId)
                : null,
            getProjectSessions: project => getProviderProjectAiSessions(project as Project, providerId, aiSessionProviders),
            resolveCurrentSessions: () => {
                let currentProject = getOpenProjects().find(candidate => candidate.id === projectId);
                return currentProject && currentProject.activeAiSessionProvider === providerId
                    ? getProviderProjectAiSessions(currentProject, providerId, aiSessionProviders)
                    : [];
            },
            archiveSession: sessionId => archiveAiSessionItem(providerId, sessionId),
            confirm: async confirmation => {
                let providerLabel = getAiSessionProviderLabel(providerId);
                let pinnedText = confirmation.pinnedCount
                    ? ` ${confirmation.pinnedCount} selected ${confirmation.pinnedCount === 1 ? 'session is' : 'sessions are'} pinned.`
                    : '';
                let accepted = await vscode.window.showWarningMessage(
                    `Archive ${confirmation.eligibleCount} selected ${providerLabel} ${confirmation.eligibleCount === 1 ? 'session' : 'sessions'}?${pinnedText}`,
                    { modal: true },
                    'Archive'
                );
                return Boolean(accepted);
            },
            reportScopeRejected: () => {
                vscode.window.showWarningMessage('The selected AI sessions are no longer in the active project and provider.');
            },
            reportSelectionRejected: selection => {
                logRejectedBatchAiSessionSelections(providerId, selection);
                vscode.window.showWarningMessage('No eligible AI sessions were selected.');
            },
            reportResult: result => {
                logBatchAiSessionArchiveResult(providerId, result);
                let summary = formatBatchAiSessionArchiveSummary(result);
                if (hasBatchAiSessionArchiveIssues(result)) {
                    vscode.window.showWarningMessage(summary);
                } else {
                    vscode.window.showInformationMessage(summary);
                }
            },
            logUnexpectedError: (operation, error, failedSessionId) => {
                logError(`Batch AI session archive failed during ${operation}${failedSessionId ? ` (${failedSessionId})` : ''}.`, error);
            },
            postCompletion: completion => postBatchArchiveCompletion(completion as AiSessionBatchArchiveCompletedMessage),
            refresh: () => refreshAiSessionViewsIncrementally(),
        });
        activeAiSessionTerminalHighlighter.sync();
    }

    function logRejectedBatchAiSessionSelections(
        providerId: AiSessionProviderId,
        selection: Pick<BatchAiSessionArchiveSelection, 'rejectedIds' | 'rejectedIdCount' | 'malformedCount'>
    ) {
        let label = getAiSessionProviderLabel(providerId);
        for (let sessionId of selection.rejectedIds) {
            outputChannel.appendLine(`[Batch Archive] ${label} rejected out-of-scope session: ${formatBatchAiSessionIdForLog(sessionId)}`);
        }
        if (selection.rejectedIdCount > selection.rejectedIds.length) {
            outputChannel.appendLine(`[Batch Archive] ${label} omitted ${selection.rejectedIdCount - selection.rejectedIds.length} additional out-of-scope session(s).`);
        }
        if (selection.malformedCount) {
            outputChannel.appendLine(`[Batch Archive] ${label} rejected ${selection.malformedCount} malformed selection(s).`);
        }
    }

    function logBatchAiSessionArchiveResult(
        providerId: AiSessionProviderId,
        result: BatchAiSessionArchiveResult
    ) {
        let label = getAiSessionProviderLabel(providerId);
        logRejectedBatchAiSessionSelections(providerId, result);
        for (let sessionId of result.runningIds) {
            outputChannel.appendLine(`[Batch Archive] ${label} skipped running session: ${formatBatchAiSessionIdForLog(sessionId)}`);
        }
        for (let sessionId of result.missingIds) {
            outputChannel.appendLine(`[Batch Archive] ${label} session no longer available: ${formatBatchAiSessionIdForLog(sessionId)}`);
        }
        for (let sessionId of result.failedIds) {
            outputChannel.appendLine(`[Batch Archive] ${label} archive failed: ${formatBatchAiSessionIdForLog(sessionId)}`);
        }
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
        return resolveCurrentWorkspaceUris(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders).some(workspaceUri => projectPathMatchesWorkspaceUri(projectPath, workspaceUri));
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
            let currentlyOpenPath = resolveWorkspacePath(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders);
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
        var groups = projectService.getGroups();
        var updatedGroups = withToggledProjectFavorite(groups, projectId);
        if (updatedGroups == null) {
            return;
        }

        await projectService.saveGroups(updatedGroups);
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

    async function reorderFavoriteProjects(projectIds: string[]) {
        var groups = projectService.getGroups();
        var reorderedGroups = withFavoriteProjectOrder(groups, projectIds);
        await projectService.saveGroups(reorderedGroups);
        refreshAfterMutation();
    }

    function isFolderGitRepo(fPath: string) {
        return gitRepositoryDetector.isGitRepositoryPath(fPath);
    }

    function getGroupsTempFilePath(): string {
        var savePath = context.globalStoragePath;
        return `${savePath}/Project Steward Projects.json`;
    }

    function getRawOpenProjects(): Project[] {
        return getOpenProjectsFromWorkspace(
            vscode.workspace.workspaceFile,
            vscode.workspace.workspaceFolders,
            {
                savedProjects: projectService.getProjectsFlat(),
                currentRemoteName: vscode.env.remoteName,
                isFolderGitRepo,
            }
        );
    }

    function getOpenProjects(): Project[] {
        return withAiSessions(getRawOpenProjects());
    }

    function getOpenProjectCards(): Project[] {
        return openProjectDashboardController.getCards();
    }

    function publishOpenProjects(followsFocusEvent = false): void {
        void openProjectBridgeClient.publish(
            createOpenProjectRecords(getRawOpenProjects()),
            followsFocusEvent
        );
    }

    function getOpenProjectUri(projectId: string): vscode.Uri {
        return resolveOpenProjectUri(projectId, vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders);
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

    async function getCurrentProjectDetailsForSave(): Promise<{ path: string, remoteType: ProjectRemoteType }> {
        let workspaceUri = resolveCurrentWorkspaceUri(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders);
        if (workspaceUri == null) {
            return null;
        }

        return getProjectDetailsForSave(workspaceUri);
    }

    async function getProjectDetailsForSave(workspaceUri: vscode.Uri): Promise<{ path: string, remoteType: ProjectRemoteType }> {
        return remoteProjectResolver.getProjectDetailsForSave(workspaceUri, vscode.env.remoteName);
    }

}




// this method is called when your extension is deactivated
export function deactivate() {
}
