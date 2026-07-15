'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { Project, GroupOrder, Group, ProjectRemoteType, getRemoteType, StewardInfos, ProjectOpenType, ReopenStewardReason, ProjectPathType, sanitizeProjectName, CodexSession, AiSessionProviderId, isAiSessionProviderId } from './models';
import { getAiSessionsDiv, getProjectSearchText, getStewardContent } from './webview/webviewContent';
import { USE_PROJECT_COLOR, PREDEFINED_COLORS, StartupOptions, USER_CANCELED, SAVE_CURRENT_PROJECT, FixedColorOptions, RelevantExtensions, SSH_REGEX, SSH_REMOTE_PREFIX, REOPEN_KEY, WSL_DEFAULT_REGEX, FAVORITES_GROUP_ID, FAVORITES_GROUP_COLLAPSED_KEY, OPEN_PROJECTS_GROUP_ID, OPEN_PROJECTS_GROUP_COLLAPSED_KEY, OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY, OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY, OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY, LEGACY_DASHBOARD_CONFIG_SECTION, PROJECT_STEWARD_CONFIG_SECTION } from './constants';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import ColorService from './services/colorService';
import ProjectService from './services/projectService';
import FileService from './services/fileService';
import CodexSessionService from './services/codexSessionService';
import KimiSessionService from './services/kimiSessionService';
import ClaudeSessionService from './services/claudeSessionService';
import ProjectWindowColorService from './services/projectWindowColorService';
import AiSessionPinStore from './aiSessions/pinStore';
import ActiveAiSessionTerminalHighlighter from './aiSessions/activeTerminalHighlight';
import AiSessionAttentionMonitor from './aiSessions/attentionMonitor';
import AttentionBridgeClient from './aiSessions/attentionBridgeClient';
import { aggregateAttentionSnapshots, AttentionAggregate } from './aiSessions/attentionAggregate';
import type { AttentionPayloadItem } from './aiSessions/attentionPayload';
import { getAttentionProjectKey, getAttentionProjectSummaries, withAttentionProject } from './aiSessions/attentionProject';
import type { ActiveAiSessionTerminalIdentity } from './aiSessions/activeTerminalHighlight';
import { assignAiSessionsToProjects, compareAiSessionUpdatedAt, getAiSessionKey, normalizeAiSessionComparablePath, prepareAiSessionsForDisplay } from './aiSessions/sessionHelpers';
import { AI_SESSION_PROVIDER_IDS, getAiSessionProviderDefinition, getAiSessionProviderLabel } from './aiSessions/providers';
import AiSessionTerminalService, { PendingAiSessionTerminal } from './aiSessions/terminalService';
import { archiveBatchAiSessionItem as executeBatchAiSessionArchiveItem, executeBatchAiSessionArchiveRequest, formatBatchAiSessionArchiveSummary, formatBatchAiSessionIdForLog, hasBatchAiSessionArchiveIssues } from './aiSessions/archiveBatch';
import type { BatchAiSessionArchiveAttemptStatus, BatchAiSessionArchiveResult, BatchAiSessionArchiveSelection } from './aiSessions/archiveBatch';
import type { AiSessionActiveTerminalChangedMessage, AiSessionBatchArchiveCompletedMessage, AiSessionProvider, AiSessionReadResult, AiSessionService, AiSessionTerminalEntry, AiSessionViewModel, AiSessionsUpdatedMessage, OpenProjectAiSessionViewModel } from './aiSessions/types';
import { findSavedProjectForOpenProject, getProjectPathPart, normalizeComparableProjectPath, projectPathMatchesWorkspaceUri, uriToProjectPath } from './projects/openProjectMatcher';
import { getLastPartOfPath, getOpenProjectUri as resolveOpenProjectUri, getOpenProjectsFromWorkspace, getWorkspaceUri as resolveWorkspaceUri, getWorkspaceUris as resolveWorkspaceUris, isUriString, parsePathAsUri } from './projects/openProjectService';
import RemoteProjectResolver from './projects/remoteProjectResolver';
import GitRepositoryDetector from './projects/gitRepositoryDetector';
import { getCurrentWorkspaceProjectIds as resolveCurrentWorkspaceProjectIds } from './projects/currentWorkspaceState';
import { withFavoriteProjectOrder, withToggledProjectFavorite } from './projects/favoriteProjectOrder';
import OpenProjectBridgeClient from './openProjects/bridgeClient';
import type { OpenProjectAggregate } from './openProjects/protocol';
import { createOpenProjectRecords, projectOpenProjectCards } from './openProjects/projection';

type TerminalEntry = AiSessionTerminalEntry<vscode.Terminal>;

interface NewAiSessionFields {
    title: string;
}

const NEW_AI_SESSION_REFRESH_DELAYS_MS = [250, 1000, 2500, 5000];
const AI_SESSION_REFRESH_DEBOUNCE_MS = 3000;
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
            setAiSessionWatchersActive(webviewView.visible);

            webviewView.webview.onDidReceiveMessage(async (e) => {
                await handleStewardMessage(e);
            });

            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this.refresh();
                }
                setAiSessionWatchersActive(webviewView.visible);
                activeAiSessionTerminalHighlighter.setVisible(webviewView.visible);
            });
        }

        get visible() {
            return Boolean(this._view?.visible);
        }

        refresh() {
            if (this._view) {
                try {
                    this._view.webview.html = getStewardContent(
                        context,
                        this._view.webview,
                        getGroupsWithAiSessionAttention(projectService.getGroups()),
                        stewardInfos,
                        true
                    );
                } catch (error) {
                    logError('Failed to render Project Steward view.', error);
                    this._view.webview.html = getErrorContent(error);
                }
            }
        }

        postMessage(message: unknown): Thenable<boolean> {
            if (!this._view) {
                return Promise.resolve(false);
            }

            return this._view.webview.postMessage(message);
        }
    }

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
    const aiSessionTerminalService = new AiSessionTerminalService(context.globalStoragePath, providerId => getRegisteredAiSessionProvider(providerId));
    const aiSessionPinStore = new AiSessionPinStore(context.globalStoragePath);
    migrateLegacyPinnedAiSessions();
    let aiSessionRefreshTimeout: NodeJS.Timeout = null;
    let aiSessionWatcherDisposables: { dispose(): void }[] = [];
    let aiSessionUpdateSequence = 0;
    const aiSessionAttentionMonitor = new AiSessionAttentionMonitor();
    let aiSessionAttentionAggregate: AttentionAggregate | null = null;
    let aiSessionAttentionLocalItems: AttentionPayloadItem[] = [];
    const aiSessionAttentionBridgeClient = new AttentionBridgeClient(
        aggregate => {
            if (aggregate.aggregateRevision !== aiSessionAttentionAggregate?.aggregateRevision) {
                aiSessionAttentionAggregate = aggregate;
                scheduleAiSessionRefresh();
                postAiSessionAttentionProjectsUpdated();
            }
        },
        error => logError('AI session attention bridge unavailable; using local-window monitoring.', error)
    );
    const aiSessionAttentionInterval = setInterval(() => { void evaluateAiSessionAttention(); }, 10_000);
    setTimeout(() => { void evaluateAiSessionAttention(); }, 0);

    const provider = new SidebarStewardViewProvider();
    let openProjectAggregate: OpenProjectAggregate | null = null;
    let openProjectNavigationCardsById = new Map<string, Project>();
    const openProjectBridgeClient = new OpenProjectBridgeClient(
        createOpenProjectRecords(getRawOpenProjects()),
        aggregate => {
            if (aggregate.semanticRevision !== openProjectAggregate?.semanticRevision) {
                openProjectAggregate = aggregate;
                refreshStewardViews();
            }
        },
        error => logError('Open project bridge unavailable; showing current-window projects only.', error)
    );
    const activeAiSessionTerminalHighlighter = new ActiveAiSessionTerminalHighlighter<
        vscode.Terminal,
        AiSessionTerminalEntry<vscode.Terminal>
    >({
        isVisible: () => provider.visible,
        getActiveTerminal: () => vscode.window.activeTerminal || null,
        resolveTerminal: terminal => aiSessionTerminalService.resolveTerminalSession(
            terminal,
            providerId => getAiSessionTerminalCandidates(providerId)
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
            aiSessionTerminalService.removePendingForTerminal(terminal);
            activeAiSessionTerminalHighlighter.handleTerminalClosed(terminal);
        }));
    context.subscriptions.push(activeAiSessionTerminalHighlighter);
    context.subscriptions.push(openProjectBridgeClient);
    context.subscriptions.push(aiSessionAttentionBridgeClient);
    context.subscriptions.push({
        dispose: () => {
            stopAiSessionWatchers();
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
        get currentWorkspaceProjectIds() { return getCurrentWorkspaceProjectIds() },
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
            refreshStewardViews();
            publishOpenProjects();
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        applyProjectColorToCurrentWindow();
        refreshStewardViews();
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

    async function showSteward() {
        publishOpenProjects();
        await revealSidebarSteward();
        refreshStewardViews();
    }

    function revealSidebarSteward(): Thenable<void> {
        return vscode.commands.executeCommand('workbench.view.extension.project-steward')
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

    function getRegisteredAiSessionProvider(providerId: AiSessionProviderId): AiSessionProvider {
        let definition = getAiSessionProviderDefinition(providerId);
        let service = aiSessionServices[providerId];
        if (!definition || !service) {
            return null;
        }

        return {
            ...definition,
            service,
        };
    }

    function getAiSessionTerminalCandidates(providerId: AiSessionProviderId): readonly CodexSession[] {
        return getRegisteredAiSessionProvider(providerId).service.getSessions().sessions;
    }

    function refreshStewardViews() {
        if (!provider.visible) {
            return;
        }

        provider.refresh();
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

    function getGroupsWithAiSessionAttention(groups: Group[]): Group[] {
        const aggregate = getEffectiveAiSessionAttentionAggregate();
        return (groups || []).map(group => ({
            ...group,
            projects: (group.projects || []).map(project => withAttentionProject(project, aggregate)),
        }));
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

    function scheduleAiSessionRefresh() {
        if (!provider.visible) {
            return;
        }

        if (aiSessionRefreshTimeout) {
            clearTimeout(aiSessionRefreshTimeout);
        }

        aiSessionRefreshTimeout = setTimeout(() => {
            aiSessionRefreshTimeout = null;
            refreshAiSessionViewsIncrementally();
        }, AI_SESSION_REFRESH_DEBOUNCE_MS);
    }

    function setAiSessionWatchersActive(active: boolean) {
        if (active) {
            startAiSessionWatchers();
        } else {
            stopAiSessionWatchers();
        }
    }

    async function evaluateAiSessionAttention() {
        if (getStewardConfiguration().get<boolean>('aiSessionAttention.enabled', true) === false) {
            aiSessionAttentionMonitor.evaluate([]);
            aiSessionAttentionAggregate = null;
            aiSessionAttentionLocalItems = [];
            await aiSessionAttentionBridgeClient.publish([], true);
            scheduleAiSessionRefresh();
            postAiSessionAttentionProjectsUpdated();
            return;
        }
        const inputs: Array<{ key: string; activityToken?: string; completed?: boolean; ownerVisible?: boolean }> = [];
        const projects = getOpenProjects();
        for (const project of projects) {
            for (const providerId of AI_SESSION_PROVIDER_IDS) {
                const definition = getRegisteredAiSessionProvider(providerId);
                for (const session of project[definition.projectSessionsKey] || []) {
                    const key = getAiSessionKey(providerId, session.id);
                    const terminal = aiSessionTerminalService.getById(providerId, session.id);
                    if (!terminal) {
                        continue;
                    }
                    inputs.push({
                        key,
                        activityToken: [session.updatedAt || '', session.name || '', session.cwd || session.workDir || ''].join('|'),
                        completed: aiSessionTerminalService.isComplete(terminal),
                        ownerVisible: vscode.window.state.focused && vscode.window.activeTerminal === terminal.terminal,
                    });
                }
            }
        }
        if (aiSessionAttentionMonitor.evaluate(inputs).length) {
            scheduleAiSessionRefresh();
        }
        const snapshot = aiSessionAttentionMonitor.getSnapshot();
        const items: AttentionPayloadItem[] = [];
        for (const project of projects) {
            const projectKey = getAttentionProjectKey(project.attentionProjectPath || project.path);
            if (!projectKey) {
                continue;
            }
            for (const providerId of AI_SESSION_PROVIDER_IDS) {
                const definition = getRegisteredAiSessionProvider(providerId);
                for (const session of project[definition.projectSessionsKey] || []) {
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

    function startAiSessionWatchers() {
        if (aiSessionWatcherDisposables.length) {
            return;
        }

        aiSessionWatcherDisposables = AI_SESSION_PROVIDER_IDS
            .map(providerId => getRegisteredAiSessionProvider(providerId).service.watchSessionChanges(() => scheduleAiSessionRefresh()));
    }

    function stopAiSessionWatchers() {
        for (let disposable of aiSessionWatcherDisposables) {
            disposable.dispose();
        }

        aiSessionWatcherDisposables = [];
        if (aiSessionRefreshTimeout) {
            clearTimeout(aiSessionRefreshTimeout);
            aiSessionRefreshTimeout = null;
        }
    }

    function scheduleNewAiSessionRefresh(providerId: AiSessionProviderId) {
        for (let delay of NEW_AI_SESSION_REFRESH_DELAYS_MS) {
            setTimeout(() => {
                invalidateAiSessionCache(providerId);
                refreshAiSessionViewsIncrementally();
            }, delay);
        }
    }

    function refreshAiSessionViewsIncrementally() {
        if (!provider.visible) {
            return;
        }

        try {
            let message = getAiSessionsUpdatedMessage();
            provider.postMessage(message).then(delivered => {
                if (!delivered) {
                    refreshStewardViews();
                }
            }, error => {
                logError('Failed to post AI session update message.', error);
                refreshStewardViews();
            });
        } catch (error) {
            logError('Failed to update AI sessions incrementally.', error);
            refreshStewardViews();
        }
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

    function getAiSessionProviderFromMessage(e: any, action: 'resume' | 'archive'): AiSessionProviderId | null {
        if (isAiSessionProviderId(e?.provider)) {
            return e.provider;
        }

        let messageType = String(e?.type || '');
        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            if (messageType === `${action}-${providerId}-session`) {
                return providerId;
            }
        }

        return null;
    }

    function refreshAfterMutation() {
        applyProjectColorToCurrentWindow();
        refreshStewardViews();
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

    async function handleStewardMessage(e: any) {
        let projectId: string, groupId: string;
        switch (e.type) {
            case 'selected-project':
                projectId = e.projectId as string;
                let projectOpenType = e.projectOpenType as ProjectOpenType;

                let project = projectService.getProject(projectId) || getOpenProjects().find(p => p.id === projectId);
                let isProjectNavigation = false;
                if (project === null || project === undefined) {
                    getOpenProjectCards();
                    project = openProjectNavigationCardsById.get(projectId);
                    isProjectNavigation = project !== null && project !== undefined;
                }
                if (project == null) {
                    vscode.window.showWarningMessage("Selected Project not found.");
                    break;
                }

                await openProject(project, isProjectNavigation ? ProjectOpenType.Default : projectOpenType);
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
            case 'reordered-favorites':
                await reorderFavoriteProjects(Array.isArray(e.projectIds) ? e.projectIds : []);
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
            case 'acknowledge-ai-session-attention':
                const attentionEventIds = Array.isArray(e.eventIds) ? e.eventIds.filter((id: unknown): id is string => typeof id === 'string') : [];
                aiSessionAttentionMonitor.acknowledge(attentionEventIds);
                await aiSessionAttentionBridgeClient.acknowledge(attentionEventIds);
                refreshAiSessionViewsIncrementally();
                break;
            case 'rename-ai-session':
                await renameAiSession(e.provider as AiSessionProviderId, e.sessionId as string);
                break;
            case 'copy-ai-session-id':
                await copyAiSessionId(e.sessionId as string);
                break;
            case 'request-full-refresh':
                refreshStewardViews();
                break;
            case 'request-active-ai-session-terminal':
                activeAiSessionTerminalHighlighter.request();
                break;
            case 'request-ai-session-attention-state':
                provider.postMessage({
                    type: 'ai-session-attention-state',
                    eventIds: Array.from(new Set([
                        ...Object.values(aiSessionAttentionMonitor.getSnapshot())
                            .map(snapshot => snapshot.event?.eventId)
                            .filter((id): id is string => Boolean(id)),
                        ...getEffectiveAiSessionAttentionAggregate().sessions
                            .reduce((eventIds, item) => eventIds.concat(item.eventIds), [] as string[]),
                    ])),
                });
                break;
            case 'open-settings':
                await showProjectStewardSettings();
                break;
            case 'resume-ai-session':
            case 'resume-codex-session':
            case 'resume-kimi-session':
            case 'resume-claude-session':
                projectId = e.projectId as string;
                await resumeProjectAiSession(projectId, getAiSessionProviderFromMessage(e, 'resume'), e.sessionId as string);
                break;
            case 'archive-ai-sessions':
                await archiveAiSessions(
                    e.projectId as string,
                    e.provider as AiSessionProviderId,
                    e.sessionIds
                );
                break;
            case 'archive-ai-session':
            case 'archive-codex-session':
            case 'archive-kimi-session':
            case 'archive-claude-session':
                await archiveAiSession(getAiSessionProviderFromMessage(e, 'archive'), e.sessionId as string);
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
        refreshAiSessionViewsIncrementally();
    }

    async function toggleAiSessionPin(providerId: AiSessionProviderId, sessionId: string) {
        if (!isAiSessionProviderId(providerId) || !sessionId) {
            return;
        }

        let sessionKey = getAiSessionPinKey(providerId, sessionId);
        try {
            aiSessionPinStore.toggle(sessionKey);
        } catch (error) {
            logError('Failed to update the pinned AI session.', error);
            vscode.window.showErrorMessage('Could not update the pinned chat.');
            return;
        }

        refreshAiSessionViewsIncrementally();
    }

    function deletePinnedAiSession(providerId: AiSessionProviderId, sessionId: string) {
        let sessionKey = getAiSessionPinKey(providerId, sessionId);
        try {
            aiSessionPinStore.remove(sessionKey);
        } catch (error) {
            logError('Failed to delete the pinned AI session.', error);
        }
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
        let cwd = getUsableTerminalCwd(getOpenProjectTerminalCwd(project));
        let pendingTerminalCwd = cwd || getOpenProjectTerminalCwd(project);
        let terminalName = `${sessionProvider.terminalNamePrefix}: ${project.name || 'New Session'}`;
        let terminal = aiSessionTerminalService.createTerminal({
            name: terminalName,
            cwd,
            cwdFailureMessage: `Failed to create ${sessionProvider.label} terminal with cwd.`,
            cwdWarningMessage: `Could not open the ${sessionProvider.label} terminal at the project directory. Starting without a working directory.`,
            logError,
        }).terminal;
        let existingSessionIds = getAiSessionIdsForCwd(providerId, sessionProvider.service.getSessions({
            forceRefresh: true,
            candidatePaths: [pendingTerminalCwd],
        }), pendingTerminalCwd);
        let createdAt = new Date().toISOString();
        let markerPath = getPendingAiSessionTerminalMarkerPath(providerId);
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
            project => getProjectAiSessions(project, providerId).find(s => s.id === sessionId),
            (session, project) => getAiSessionTerminalCwd(providerId, session, project),
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

        let terminalName = getAiSessionTerminalName(providerId, session);
        let terminal: vscode.Terminal = existingTerminal?.terminal;
        let terminalEnv = { [sessionProvider.terminalEnvKey]: session.id };
        let markerPath = existingTerminal?.markerPath || getAiSessionTerminalMarkerPath(providerId, session.id);

        try {
            if (!terminal) {
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

            aiSessionTerminalService.track(providerId, session.id, { terminal, markerPath });
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
            deletePin: () => deletePinnedAiSession(providerId, sessionId),
            deleteAlias: () => deleteAiSessionAlias(providerId, sessionId),
        });
    }

    async function archiveAiSessions(projectId: string, providerId: AiSessionProviderId, sessionIds: unknown) {
        await executeBatchAiSessionArchiveRequest({ projectId, provider: providerId, sessionIds }, {
            resolveProject: requestedProjectId => isAiSessionProviderId(providerId)
                ? getOpenProjects().find(candidate => candidate.id === requestedProjectId)
                : null,
            getProjectSessions: project => getProjectAiSessions(project as Project, providerId),
            resolveCurrentSessions: () => {
                let currentProject = getOpenProjects().find(candidate => candidate.id === projectId);
                return currentProject && currentProject.activeAiSessionProvider === providerId
                    ? getProjectAiSessions(currentProject, providerId)
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
        return getWorkspaceUris().some(workspaceUri => projectPathMatchesWorkspaceUri(projectPath, workspaceUri));
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
        let cards = projectOpenProjectCards(getOpenProjects(), openProjectAggregate, openProjectBridgeClient.instanceId);
        openProjectNavigationCardsById = new Map(
            cards
                .filter(card => card.openProjectCardKind === 'projectNavigation')
                .map(card => [card.id, card] as [string, Project])
        );
        return cards;
    }

    function publishOpenProjects(followsFocusEvent = false): void {
        void openProjectBridgeClient.publish(
            createOpenProjectRecords(getRawOpenProjects()),
            followsFocusEvent
        );
    }

    function getCurrentWorkspaceProjectIds(): string[] {
        return resolveCurrentWorkspaceProjectIds(
            projectService.getProjectsFlat(),
            resolveWorkspaceUris(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders),
            vscode.env.remoteName,
            findSavedProjectForOpenProject
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
        resolvePendingAiSessionTerminals(sessionResults);
        let assignments = getAiSessionAssignments(openProjects, sessionResults);
        let expandedProjects = getExpandedCodexSessionProjects();
        let activeProviders = getActiveAiSessionProviders();
        // Results are scoped to this window, so missing sessions cannot be used to prune persisted pins.
        let pinnedSessions = getPinnedAiSessionKeys();
        let aliases = getAiSessionAliases();

        return openProjects.map(project => {
            const projectKey = getAttentionProjectKey(project.attentionProjectPath || project.path);
            const aggregate = getEffectiveAiSessionAttentionAggregate();
            for (let providerId of AI_SESSION_PROVIDER_IDS) {
                let sessionProvider = getRegisteredAiSessionProvider(providerId);
                let sessionResult = sessionResults[providerId];
                project[sessionProvider.projectSessionsKey] = prepareAiSessionsForDisplay(assignments[providerId].get(project.id) || [], providerId, pinnedSessions, aliases).map(session => {
                    const attention = aiSessionAttentionMonitor.getSnapshot()[getAiSessionKey(providerId, session.id)];
                    const aggregateAttention = aggregate.sessions.find(item =>
                        item.projectId === projectKey
                        && item.sessionKey === getAiSessionKey(providerId, session.id));
                    const localAttention = aiSessionAttentionAggregate ? null : attention;
                    const event = aggregateAttention ? {
                        eventId: aggregateAttention.eventIds[0] || `${aggregateAttention.sessionKey}:${aggregateAttention.observedAtMs}`,
                        reason: aggregateAttention.reasons[0] || 'quiet' as const,
                    } : localAttention?.event;
                    return event ? {
                        ...session,
                        attention: {
                            eventId: event.eventId,
                            reason: event.reason,
                            unread: aggregateAttention ? true : localAttention?.state === 'needsAttention',
                        },
                    } : session;
                });
                project[sessionProvider.projectSessionsUnavailableKey] = !sessionResult.available;
            }
            project.codexSessionsExpanded = expandedProjects.has(getOpenProjectCodexExpansionKey(project));
            project.activeAiSessionProvider = getActiveAiSessionProvider(project, activeProviders);
            return withAttentionProject(project, aggregate);
        });
    }

    function getAiSessionsUpdatedMessage(): AiSessionsUpdatedMessage {
        return {
            type: 'ai-sessions-updated',
            version: 1,
            sequence: ++aiSessionUpdateSequence,
            generatedAt: new Date().toISOString(),
            openProjects: getOpenProjects().map(project => getOpenProjectAiSessionViewModel(project)),
        };
    }

    function getOpenProjectAiSessionViewModel(project: Project): OpenProjectAiSessionViewModel {
        let sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>> = {};
        let providers = AI_SESSION_PROVIDER_IDS.map(providerId => {
            let sessionProvider = getRegisteredAiSessionProvider(providerId);
            let sessions = project[sessionProvider.projectSessionsKey] || [];
            sessionsByProvider[providerId] = sessions.map(session => ({
                ...session,
                provider: providerId,
            }));
            return {
                id: providerId,
                label: sessionProvider.label,
                count: sessions.length,
                unavailable: Boolean(project[sessionProvider.projectSessionsUnavailableKey]),
            };
        });

        return {
            projectId: project.id,
            projectKey: getOpenProjectCodexExpansionKey(project),
            activeProvider: project.activeAiSessionProvider,
            expanded: Boolean(project.codexSessionsExpanded),
            providers,
            sessionsByProvider,
            unavailableProviders: providers.filter(item => item.unavailable).map(item => item.id),
            searchText: getProjectSearchText(project),
            aiSessionCount: AI_SESSION_PROVIDER_IDS.reduce((count, providerId) => {
                let sessionProvider = getRegisteredAiSessionProvider(providerId);
                return count + (project[sessionProvider.projectSessionsKey] || []).length;
            }, 0),
            attentionCount: project.aiSessionAttentionCount ?? AI_SESSION_PROVIDER_IDS.reduce((count, providerId) => {
                const sessionProvider = getRegisteredAiSessionProvider(providerId);
                return count + (project[sessionProvider.projectSessionsKey] || []).filter(session => session.attention?.unread).length;
            }, 0),
            sessionSectionHtml: getAiSessionsDiv(project),
        };
    }

    function getAiSessionResults(openProjects: Project[] = []): Record<AiSessionProviderId, AiSessionReadResult> {
        let results = {} as Record<AiSessionProviderId, AiSessionReadResult>;
        let candidatePaths = getAiSessionCandidatePaths(openProjects);
        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            results[providerId] = getRegisteredAiSessionProvider(providerId).service.getSessions({ candidatePaths });
        }

        return results;
    }

    function getAiSessionAssignments(openProjects: Project[], sessionResults: Record<AiSessionProviderId, AiSessionReadResult>): Record<AiSessionProviderId, Map<string, CodexSession[]>> {
        let assignments = {} as Record<AiSessionProviderId, Map<string, CodexSession[]>>;
        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            assignments[providerId] = getAiSessionAssignmentsForProvider(openProjects, providerId, sessionResults[providerId]);
        }

        return assignments;
    }

    function getAiSessionAssignmentsForProvider(openProjects: Project[], providerId: AiSessionProviderId, sessionResult: AiSessionReadResult): Map<string, CodexSession[]> {
        if (!sessionResult.available || !sessionResult.sessions.length) {
            return new Map<string, CodexSession[]>();
        }

        return assignAiSessionsToProjects(getCodexOpenProjectCandidates(openProjects), sessionResult.sessions, session => getAiSessionComparableCwd(providerId, session));
    }

    function getPinnedAiSessionKeys(): Set<string> {
        try {
            return aiSessionPinStore.getAll();
        } catch (error) {
            logError('Failed to read pinned AI sessions.', error);
            return new Set<string>();
        }
    }

    function migrateLegacyPinnedAiSessions() {
        let pinnedSessions = context.globalState.get(OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY) as string[];
        try {
            aiSessionPinStore.migrateLegacy(Array.isArray(pinnedSessions) ? pinnedSessions : []);
            context.globalState.update(OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY, undefined).then(undefined, error => {
                logError('Failed to clear legacy pinned AI session state.', error);
            });
        } catch (error) {
            logError('Failed to migrate pinned AI sessions.', error);
        }
    }

    function getAiSessionIdsForCwd(providerId: AiSessionProviderId, sessionResult: AiSessionReadResult, cwd: string): string[] {
        let comparableCwd = normalizeCodexComparablePath(cwd);
        if (!sessionResult.available || !comparableCwd) {
            return [];
        }

        return sessionResult.sessions
            .filter(session => normalizeCodexComparablePath(getAiSessionComparableCwd(providerId, session)) === comparableCwd)
            .map(session => session.id)
            .filter(id => !!id);
    }

    function trackPendingAiSessionTerminal(providerId: AiSessionProviderId, terminal: vscode.Terminal, markerPath: string, cwd: string, createdAt: string, excludedSessionIds: string[], title: string = null) {
        let comparableCwd = normalizeCodexComparablePath(cwd);
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

    function resolvePendingAiSessionTerminals(sessionResults: Record<AiSessionProviderId, AiSessionReadResult>) {
        let pendingTerminals = aiSessionTerminalService.getPendingTerminals();
        if (!pendingTerminals.length) {
            return;
        }

        let remainingPendingTerminals: PendingAiSessionTerminal[] = [];
        let claimedSessionKeys = getTrackedAiSessionTerminalKeys();
        let matchedPendingTerminal = false;

        for (let pendingTerminal of pendingTerminals) {
            let sessionResult = sessionResults[pendingTerminal.provider];
            let session = findPendingAiSessionTerminalMatch(pendingTerminal, sessionResult, claimedSessionKeys);
            if (!session) {
                remainingPendingTerminals.push(pendingTerminal);
                continue;
            }

            let entry = {
                terminal: pendingTerminal.terminal,
                markerPath: pendingTerminal.markerPath,
            };
            aiSessionTerminalService.track(pendingTerminal.provider, session.id, entry);
            setAiSessionAlias(pendingTerminal.provider, session.id, pendingTerminal.title);
            claimedSessionKeys.add(getAiSessionPinKey(pendingTerminal.provider, session.id));
            matchedPendingTerminal = true;
        }

        aiSessionTerminalService.replacePendingTerminals(remainingPendingTerminals);
        if (matchedPendingTerminal) {
            activeAiSessionTerminalHighlighter.sync();
        }
    }

    function getTrackedAiSessionTerminalKeys(): Set<string> {
        return aiSessionTerminalService.getTrackedSessionKeys(getAiSessionPinKey);
    }

    function findPendingAiSessionTerminalMatch(pendingTerminal: PendingAiSessionTerminal, sessionResult: AiSessionReadResult, claimedSessionKeys: Set<string>): CodexSession {
        if (!sessionResult.available) {
            return null;
        }

        let createdAt = Date.parse(pendingTerminal.createdAt);
        return sessionResult.sessions
            .filter(session => {
                let sessionKey = getAiSessionPinKey(pendingTerminal.provider, session.id);
                let sessionCwd = normalizeCodexComparablePath(getAiSessionComparableCwd(pendingTerminal.provider, session));
                let updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
                return sessionCwd === pendingTerminal.cwd
                    && !pendingTerminal.excludedSessionIds.includes(session.id)
                    && !claimedSessionKeys.has(sessionKey)
                    && !isNaN(updatedAt)
                    && updatedAt >= createdAt;
            })
            .sort((a, b) => compareAiSessionUpdatedAt(a.updatedAt, b.updatedAt))[0] || null;
    }

    function getAiSessionPinKey(providerId: AiSessionProviderId, sessionId: string): string {
        return getAiSessionKey(providerId, sessionId);
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
        let sessionProvider = getRegisteredAiSessionProvider(providerId);
        let sessionResult = sessionProvider.service.getSessions();
        let session = sessionResult.sessions.find(candidate => candidate.id === sessionId);

        return session?.name || sessionId;
    }

    function sanitizeAiSessionAlias(value: string): string {
        return String(value || '').replace(/[\r\n]+/g, ' ').trim();
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

        for (let providerId of AI_SESSION_PROVIDER_IDS) {
            let sessionProvider = getRegisteredAiSessionProvider(providerId);
            if (project[sessionProvider.projectSessionsKey]?.length) {
                return providerId;
            }
        }

        return 'codex';
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

    function getAiSessionCandidatePaths(openProjects: Project[]): string[] {
        if (!openProjects.length) {
            return [];
        }

        return getCodexOpenProjectCandidates(openProjects).map(candidate => candidate.path);
    }

    function normalizeCodexComparablePath(projectPath: string): string {
        if (!projectPath) {
            return "";
        }

        return normalizeAiSessionComparablePath(projectPath);
    }

    function getExpandedCodexSessionProjects(): Set<string> {
        let expandedProjects = context.globalState.get(OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY) as string[];
        return new Set(Array.isArray(expandedProjects) ? expandedProjects : []);
    }

    function getOpenProjectCodexExpansionKey(project: Project): string {
        return normalizeCodexComparablePath(getProjectPathPart(project.path)) || project.id;
    }

    function getOpenProjectTerminalCwd(project: Project): string {
        return normalizeCodexComparablePath(getProjectPathPart(project.path)) || null;
    }

    function getProjectAiSessions(project: Project, providerId: AiSessionProviderId): CodexSession[] {
        let sessionProvider = getRegisteredAiSessionProvider(providerId);
        return sessionProvider ? project[sessionProvider.projectSessionsKey] || [] : [];
    }

    function getAiSessionTerminalCwd(providerId: AiSessionProviderId, session: CodexSession, project: Project): string {
        let sessionCwd = getAiSessionComparableCwd(providerId, session);
        if (sessionCwd) {
            return sessionCwd;
        }

        return normalizeCodexComparablePath(getProjectPathPart(project.path)) || null;
    }

    function getAiSessionComparableCwd(providerId: AiSessionProviderId, session: CodexSession): string {
        let sessionProvider = getRegisteredAiSessionProvider(providerId);
        if (!sessionProvider) {
            return session.workDir || session.cwd || null;
        }

        for (let field of sessionProvider.terminalCwdFields) {
            if (session[field]) {
                return session[field];
            }
        }

        return null;
    }

    function getAiSessionTerminal(providerId: AiSessionProviderId, session: CodexSession): TerminalEntry {
        return aiSessionTerminalService.get(providerId, session);
    }

    function getAiSessionTerminalName(providerId: AiSessionProviderId, session: CodexSession): string {
        return aiSessionTerminalService.getTerminalName(providerId, session);
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

    function getAiSessionTerminalMarkerPath(providerId: AiSessionProviderId, sessionId: string): string {
        return aiSessionTerminalService.getMarkerPath(providerId, sessionId);
    }

    function getPendingAiSessionTerminalMarkerPath(providerId: AiSessionProviderId): string {
        return aiSessionTerminalService.getPendingMarkerPath(providerId);
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
        return remoteProjectResolver.getProjectDetailsForSave(workspaceUri, vscode.env.remoteName);
    }

    function getWorkspaceUri(): vscode.Uri {
        return resolveWorkspaceUri(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders);
    }

    function getWorkspaceUris(): vscode.Uri[] {
        return resolveWorkspaceUris(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders);
    }

}




// this method is called when your extension is deactivated
export function deactivate() {
}
