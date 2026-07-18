import * as vscode from 'vscode';
import { getAttentionProjectKey } from '../aiSessions/attentionProject';
import * as path from 'path';

import {
    Project,
    Group,
    getRemoteType,
    ProjectRemoteType,
    StewardInfos,
    sanitizeProjectName,
    AiSessionProviderId,
    CodexSession,
} from '../models';
import {
    FAVORITES_GROUP_ID,
    FITTY_OPTIONS,
    INBUILT_COLOR_DEFAULTS,
    OPEN_CURRENT_WORKSPACE_GROUP_ID,
    OPEN_PROJECTS_GROUP_ID,
} from '../constants';
import { getFavoriteProjectsInOrder } from '../projects/favoriteProjectOrder';
import { buildDashboardSearchCatalog, serializeDashboardSearchCatalog } from './dashboardViewModel';
import * as Icons from './webviewIcons';
import type { ActiveAiSessionViewModel, AiSessionTabId } from '../aiSessions/types';

const FAVORITES_GROUP_NAME = 'FAVORITES';
const OPEN_CURRENT_WORKSPACE_GROUP_NAME = 'CURRENT WORKSPACE';
const OPEN_OTHER_WINDOWS_GROUP_NAME = 'OTHER WINDOWS';
const DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP = 5;

type ProjectAttentionMode = 'current' | 'navigation' | 'none';

interface GroupSectionOptions {
    virtual: boolean;
    readOnlyProjects: boolean;
    draggableVirtualProjects: boolean;
    collapsible: boolean;
    className: string;
    systemBadge: string;
    projectAttentionMode: ProjectAttentionMode;
}

export function getStewardContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    groups: Group[],
    infos: StewardInfos,
    isSidebar: boolean = false
): string {
    var stylesPath = getMediaResource(context, webview, 'styles.css');
    var fittyPath = getMediaResource(context, webview, 'fitty.min.js');
    var dragulaPath = getMediaResource(context, webview, 'dragula.min.js');
    var autoScrollerPath = getMediaResource(context, webview, 'dom-autoscroller.min.js');

    var projectScriptsPath = getMediaResource(
        context,
        webview,
        'webviewProjectScripts.js'
    );
    var dndScriptsPath = getMediaResource(
        context,
        webview,
        'webviewDnDScripts.js'
    );
    var dashboardScriptsPath = getMediaResource(
        context,
        webview,
        'webviewDashboardScripts.js'
    );
    var filterScriptsPath = getMediaResource(
        context,
        webview,
        'webviewFilterScripts.js'
    );

    var openProjects = infos.openProjects || [];
    var customCss = infos.config.get('customCss') || '';
    var allGroupsCollapsed = !!infos.openProjectsGroupCollapsed;
    var searchCatalog = serializeDashboardSearchCatalog(buildDashboardSearchCatalog(groups, openProjects, infos.todoSearchItems || []));
    var openProjectsContent = getOpenProjectsGroupContent(openProjects, infos.openProjectsGroupCollapsed, infos);

    return `
<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; img-src * data:; script-src ${webview.cspSource
        } 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline';"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${criticalStartupStyle()}</style>
        <link rel="stylesheet" type="text/css" href="${stylesPath}">
        <style>${colorDefaults()}</style>
        <style>
            /* Custom CSS from configuration */
            ${customCss}
        </style>
        <title>Project Steward</title>
        ${getCustomStyle(infos.config)}
    </head>
    <body class="preload ${isSidebar ? 'steward-sidebar' : ''} ${!groups.length ? 'steward-empty' : ''} ${allGroupsCollapsed ? 'steward-all-collapsed' : ''}">
        <div class="steward-sticky-header">
            <div class="filter-wrapper">
                <div class="search-box">
                    <span class="search-icon">${Icons.search}</span>
                    <input type="search" id="filter" aria-label="Filter Projects">
                    <span id="clear" class="clear-search-icon">${Icons.remove}</span>
                </div>
                <button type="button" class="toggle-all-groups-button" data-action="toggle-all-groups" title="${allGroupsCollapsed ? 'Expand All Groups' : 'Collapse All Groups'}" aria-label="${allGroupsCollapsed ? 'Expand All Groups' : 'Collapse All Groups'}">
                    <span class="toggle-all-groups-collapse-icon">${Icons.collapseAll}</span>
                    <span class="toggle-all-groups-expand-icon">${Icons.expandAll}</span>
                </button>
                <button type="button" class="settings-button" data-action="open-settings" title="Project Steward Settings" aria-label="Project Steward Settings">
                    ${Icons.settings}
                </button>
            </div>
            <div class="dashboard-tab-list" role="tablist" aria-label="Project views">
                <button type="button" id="dashboard-tab-open-button" class="dashboard-tab-button active" role="tab" aria-selected="true" aria-controls="dashboard-tab-open" tabindex="0" data-dashboard-tab="open">OPEN</button>
                <button type="button" id="dashboard-tab-projects-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-tab-projects" tabindex="-1" data-dashboard-tab="projects">PROJECTS</button>
                <button type="button" id="dashboard-tab-todo-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-tab-todo" tabindex="-1" data-dashboard-tab="todo">TODO</button>
            </div>
        </div>
        <main class="dashboard-content">
            <section id="dashboard-tab-open" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-open-button">
                <div class="sticky-groups-wrapper">
                    ${openProjectsContent}
                </div>
            </section>
            <section id="dashboard-tab-projects" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-projects-button" hidden>
                <div class="dashboard-projects-loading" role="status" hidden>Loading projects…</div>
            </section>
            <section id="dashboard-tab-todo" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-todo-button" hidden>
                <div class="dashboard-todo-loading" role="status" hidden>Loading todos…</div>
            </section>
            <section id="dashboard-search-results" class="dashboard-search-results" aria-label="Search results" hidden></section>
        </main>
        <script id="dashboard-search-catalog" type="application/json">${searchCatalog}</script>

        ${getProjectContextMenu()}
        ${getGroupContextMenu()}
        ${getAiSessionContextMenu()}
    </body>

    <script src="${fittyPath}"></script>
    <script src="${dragulaPath}"></script>
    <script src="${autoScrollerPath}"></script>
    <script src="${projectScriptsPath}"></script>
    <script src="${dashboardScriptsPath}"></script>
    <script src="${dndScriptsPath}"></script>
    <script src="${filterScriptsPath}"></script>

    <script>
        (function() {
            window.vscode = acquireVsCodeApi();

            function fitProjectHeaders(root) {
                if (!root || document.body.classList.contains('steward-sidebar')) {
                    return;
                }
                Array.from(root.querySelectorAll('.project-header')).forEach(element =>
                    fitty(element, ${JSON.stringify(FITTY_OPTIONS)})
                );
            }

            window.onload = () => {
                initProjects();
                const storedFilter = sessionStorage.getItem('filterValue') || '';
                let filtering;
                const dashboard = initDashboard({
                    initialSearchQuery: storedFilter,
                    clearSearch: () => filtering && filtering.clear(),
                    postMessage: message => window.vscode.postMessage(message),
                    onProjectsMounted: panel => {
                        fitProjectHeaders(panel);
                        initDnD(panel);
                        window.__projectStewardSyncCollapseButton();
                    },
                    onTodoMounted: () => {
                        window.__projectStewardSyncCollapseButton('todo');
                    },
                    onActiveTabChanged: activeTab => window.__projectStewardSyncCollapseButton(activeTab),
                });
                window.__projectStewardDashboard = dashboard;
                fitProjectHeaders(document.getElementById('dashboard-tab-open'));
                filtering = initFiltering(${infos.config.searchIsActiveByDefault}, dashboard);
                filtering.apply();
            };
        })();
    </script>


</html>`;
}

export function getOpenProjectsGroupContent(
    openProjects: Project[],
    collapsed: boolean,
    infos: StewardInfos,
): string {
    var currentProjects = (openProjects || []).filter(project => project.openProjectCardKind !== 'projectNavigation');
    var navigationProjects = (openProjects || []).filter(project => project.openProjectCardKind === 'projectNavigation');
    var currentGroup = new Group(OPEN_CURRENT_WORKSPACE_GROUP_NAME, currentProjects);
    currentGroup.id = OPEN_CURRENT_WORKSPACE_GROUP_ID;
    currentGroup.collapsed = false;
    var currentSection = getGroupSection(currentGroup, {
        virtual: true,
        readOnlyProjects: true,
        draggableVirtualProjects: false,
        collapsible: false,
        className: 'open-current-workspace-group',
        systemBadge: 'Live',
        projectAttentionMode: 'current',
    }, currentProjects.length
        ? ''
        : getOpenCurrentWorkspaceEmptyState(navigationProjects.length > 0));

    if (!navigationProjects.length) {
        return currentSection;
    }

    var navigationGroup = new Group(OPEN_OTHER_WINDOWS_GROUP_NAME, navigationProjects);
    navigationGroup.id = OPEN_PROJECTS_GROUP_ID;
    navigationGroup.collapsed = collapsed;
    return `${currentSection}\n${getGroupSection(navigationGroup, {
        virtual: true,
        readOnlyProjects: true,
        draggableVirtualProjects: false,
        collapsible: true,
        className: 'open-other-windows-group',
        systemBadge: 'Live',
        projectAttentionMode: 'navigation',
    })}`;
}

export function getProjectsPanelContent(groups: Group[], infos: StewardInfos): string {
    var configuredMaxVisibleProjects = infos.config.get(
        'maxVisibleProjectsPerGroup',
        DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP
    );
    var normalizedMaxVisibleProjects = Math.floor(Number(configuredMaxVisibleProjects));
    var maxVisibleProjectsPerGroup = Number.isFinite(normalizedMaxVisibleProjects)
        && normalizedMaxVisibleProjects > 0
        ? normalizedMaxVisibleProjects
        : DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP;
    var favoriteProjects = getFavoriteProjectsInOrder(
        (groups || []).reduce((projects, group) => projects.concat(group.projects || []), [] as Project[])
    );
    var favoritesGroupCollapsed = infos.favoritesGroupCollapsed !== undefined
        ? infos.favoritesGroupCollapsed
        : (groups || []).every(group => group.collapsed);
    var mainGroups = [
        ...(groups.length ? [getFavoritesGroup(favoriteProjects, favoritesGroupCollapsed)] : []),
        ...groups,
    ];
    var favoriteOptions: GroupSectionOptions = {
        virtual: true,
        readOnlyProjects: false,
        draggableVirtualProjects: true,
        collapsible: true,
        className: 'favorites-group',
        systemBadge: 'Pinned',
        projectAttentionMode: 'none',
    };
    var projectOptions: GroupSectionOptions = {
        virtual: false,
        readOnlyProjects: false,
        draggableVirtualProjects: false,
        collapsible: true,
        className: 'saved-project-group',
        systemBadge: '',
        projectAttentionMode: 'none',
    };

    return `<div class="groups-wrapper ${!infos.config.displayProjectPath ? 'hide-project-path' : ''}" style="--steward-max-visible-projects-per-group: ${maxVisibleProjectsPerGroup};">
        ${mainGroups.length
            ? mainGroups.map(group => getGroupSection(
                group,
                group.id === FAVORITES_GROUP_ID ? favoriteOptions : projectOptions
            )).join('\n')
            : (infos.otherStorageHasData ? getImportDiv() : getNoProjectsDiv())}
    </div>
    ${infos.config.showAddGroupButtonTile ? getTempGroupSection() : ''}`;
}

function getOpenCurrentWorkspaceEmptyState(hasOtherWindows: boolean): string {
    return `<div class="open-current-workspace-empty">${hasOtherWindows
        ? 'No folder is open in this window.'
        : 'Open a folder to see running projects.'}</div>`;
}

function criticalStartupStyle(): string {
    return `
        body {
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            margin: 0;
        }
        .filter-wrapper {
            display: flex;
            align-items: center;
            width: 100%;
            box-sizing: border-box;
        }
        .search-box {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        .search-icon,
        .clear-search-icon,
        .settings-button,
        .toggle-all-groups-button,
        .toggle-all-groups-collapse-icon,
        .toggle-all-groups-expand-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .search-icon,
        .clear-search-icon {
            flex: 0 0 auto;
            width: 16px;
            height: 16px;
            overflow: hidden;
        }
        .search-icon svg,
        .clear-search-icon svg {
            width: 14px;
            height: 14px;
        }
        .clear-search-icon {
            visibility: hidden;
        }
        .settings-button,
        .toggle-all-groups-button {
            width: 30px;
            height: 30px;
            padding: 0;
            overflow: hidden;
        }
        .settings-button svg,
        .toggle-all-groups-button svg {
            width: 18px;
            height: 18px;
            fill: currentColor;
        }
        .toggle-all-groups-expand-icon {
            display: none;
        }
        body.steward-all-collapsed .toggle-all-groups-collapse-icon {
            display: none;
        }
        body.steward-all-collapsed .toggle-all-groups-expand-icon {
            display: inline-flex;
        }
    `;
}

function getGroupSection(
    group: Group,
    options: GroupSectionOptions,
    emptyContent: string = ''
) {
    // Apply changes to HTML here also to getTempGroupSection

    var groupActions = options.virtual
        ? ''
        : `<div class="group-actions right">
            <span data-action="add" title="Add Project">${Icons.add}</span>
            <span data-action="edit" title="Edit Group">${Icons.edit}</span>
            <span data-action="remove" title="Remove Group">${Icons.remove
        }</span>
        </div>`;
    var dragAttribute = options.virtual ? '' : 'data-drag-group';
    var groupName = escapeAttribute(group.groupName || 'Unnamed Group');
    var systemGroupAttribute = options.virtual ? ` data-system-group="${group.id}"` : '';
    var groupTitleText = options.collapsible
        ? `<span class="group-title-text" data-action="collapse" ${dragAttribute}>
            <span class="collapse-icon" title="Open/Collapse Group">${Icons.collapse}</span>
            ${groupName}
        </span>`
        : `<span class="group-title-text">${groupName}</span>`;

    return `
<div class="group steward-section ${options.className} ${group.collapsed ? 'collapsed' : ''} ${group.projects.length === 0 ? 'no-projects' : ''
        }" data-group-id="${group.id}"${options.virtual ? ' data-virtual-group' : ''}${systemGroupAttribute}>
    <div class="group-title steward-section-header steward-group-header">
        ${groupTitleText}
        ${options.systemBadge ? `<span class="group-title-badge">${options.systemBadge}</span>` : ''}
        ${groupActions}
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${group.projects.length
            ? group.projects.map(project => getProjectDiv(project, options)).join('\n')
            : emptyContent}
    </div>       
</div>`;
}

function getFavoritesGroup(favoriteProjects: Project[], collapsed: boolean = false): Group {
    var group = new Group(FAVORITES_GROUP_NAME, favoriteProjects);
    group.id = FAVORITES_GROUP_ID;
    group.collapsed = collapsed;

    return group;
}

function getTempGroupSection() {
    return `
<div class="group" id="tempGroup">
    <div class="group-title steward-section-header steward-group-header" data-action="add-group">
        <span>${Icons.add} New Group</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
    </div>       
</div>`;
}

function getProjectDiv(
    project: Project,
    options: GroupSectionOptions
) {
    var isProjectNavigation = project.openProjectCardKind === 'projectNavigation';
    var showCurrentAttention = options.projectAttentionMode === 'current';
    var showNavigationAttention = options.projectAttentionMode === 'navigation';
    var rawProjectColor = (project.color || '').trim();
    var projectColor = escapeStyleValue(rawProjectColor);
    projectColor = projectColor === rawProjectColor ? projectColor : '';
    var borderStyle = projectColor ? `background: ${projectColor};` : '';
    var projectStyle = projectColor ? `--project-color: ${projectColor};` : '';
    var remoteType = getRemoteType(project);
    var description = sanitizeProjectName(project.description);
    var projectName = escapeAttribute(sanitizeProjectName(project.name));
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var searchText = escapeAttribute(isProjectNavigation
        ? `${project.name || ''} ${description}`.toLowerCase()
        : getProjectSearchText(project));
    var escapedDescription = escapeAttribute(description);
    var projectIcon = getProjectIcon(remoteType);
    var projectIconTitle = getProjectIconTitle(remoteType);
    var favoriteTitle = project.favorite ? 'Remove From Favorites' : 'Add To Favorites';
    var projectActions = options.readOnlyProjects || isProjectNavigation
        ? ''
        : `<span data-action="color" title="Edit Color">${Icons.palette
        }</span>
                <span data-action="edit" title="Edit Project">${Icons.edit
        }</span>
                <span data-action="remove" title="Remove Project">${Icons.remove
        }</span>`;
    var projectActionsWrapper = projectActions
        ? `<div class="project-actions-wrapper">
            <div class="project-actions">
                ${projectActions}
            </div>
        </div>`
        : '';
    var favoriteBadgeIcon = project.favorite ? Icons.starFilled : Icons.star;
    var favoriteBadge = options.readOnlyProjects || isProjectNavigation
        ? ''
        : `<span data-action="favorite" class="project-favorite-badge ${project.favorite ? 'active' : ''}" title="${favoriteTitle}">${favoriteBadgeIcon}</span>`;
    var saveBadge = !isProjectNavigation && project.showSaveAction
        ? `<span data-action="save" class="project-save-badge" title="Save Current Project">${Icons.save}</span>`
        : '';
    var aiSessionCount = codexSessions.length + kimiSessions.length + claudeSessions.length;
    var attentionCount = codexSessions.concat(kimiSessions).concat(claudeSessions).filter(session => session.attention?.unread).length;
    var activeAiSessionCount = (project.activeAiSessions || []).length;
    var projectAttentionCount = project.aiSessionAttentionCount ?? attentionCount;
    var attentionProjectKey = options.projectAttentionMode === 'none'
        ? ''
        : getAttentionProjectKey(project.path);
    var projectAttentionBadge = showNavigationAttention && projectAttentionCount
        ? `<span class="project-ai-attention-badge" title="${projectAttentionCount} AI session${projectAttentionCount === 1 ? ' needs' : 's need'} attention">${projectAttentionCount}</span>`
        : '';
    var aiSessionSummaryLabel = [
        aiSessionCount ? `${aiSessionCount} AI session${aiSessionCount === 1 ? '' : 's'}` : '',
        activeAiSessionCount ? `${activeAiSessionCount} active AI session${activeAiSessionCount === 1 ? '' : 's'}` : '',
        attentionCount ? `${attentionCount} AI session${attentionCount === 1 ? ' needs' : 's need'} attention` : '',
    ].filter(Boolean).join(', ');
    var aiSessionBadge = showCurrentAttention && (aiSessionCount || activeAiSessionCount || attentionCount)
        ? `<span class="project-codex-badge" data-ai-session-total-count="${aiSessionCount}" data-ai-session-active-count="${activeAiSessionCount}" data-ai-session-attention-count="${attentionCount}" title="${escapeAttribute(aiSessionSummaryLabel)}" aria-label="${escapeAttribute(aiSessionSummaryLabel)}">${
            aiSessionCount ? `<span class="ai-session-total-count">AI ${aiSessionCount}</span>` : ''
        }${activeAiSessionCount ? `<span class="ai-session-active-count" aria-label="${activeAiSessionCount} active AI session${activeAiSessionCount === 1 ? '' : 's'}">●${activeAiSessionCount}</span>` : ''
        }${attentionCount ? `<b class="ai-session-attention-count" aria-label="${attentionCount} AI session${attentionCount === 1 ? ' needs' : 's need'} attention">${attentionCount}</b>` : ''
        }</span>`
        : '';
    var codexSessionSection = showCurrentAttention ? getAiSessionsDiv(project) : '';

    var isRemote = remoteType !== ProjectRemoteType.None;

    return `
<div class="project-container"${options.virtual && !options.draggableVirtualProjects ? ' data-nodrag' : ''}>
    <div class="project steward-item-card" style="${projectStyle}" data-id="${project.id}" data-name="${searchText}"${isRemote ? ' data-is-remote' : ''
        }${attentionProjectKey ? ` data-attention-project-key="${attentionProjectKey}"` : ''
        }${options.virtual ? ' data-virtual-project' : ''
        }${options.readOnlyProjects || isProjectNavigation ? ' data-readonly-project' : ''
        }${showCurrentAttention ? ' data-open-project' : ''
        }${isProjectNavigation ? ' data-project-navigation title="Switch to this project"' : ''
        }${!isProjectNavigation && project.codexSessionsExpanded ? ' data-codex-expanded' : ''
        }${!options.readOnlyProjects && !isProjectNavigation ? ' data-has-favorite-toggle' : ''
        }${!isProjectNavigation && project.showSaveAction ? ' data-has-save-action' : ''
        }${!isProjectNavigation && project.favorite ? ' data-favorite-project' : ''
        }${showCurrentAttention ? ' data-current-workspace' : ''
        }>
        <div class="project-aura"></div>
        <div class="project-border steward-item-accent" style="${borderStyle}"></div>
        ${projectAttentionBadge}
        ${favoriteBadge}
        ${saveBadge}
        ${projectActionsWrapper}
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon" title="${projectIconTitle}">
                ${projectIcon}
            </span>
            <h2 class="project-header">
                ${projectName}
            </h2>
        </div>
        <p class="project-description" title="${escapedDescription}">
            ${escapedDescription}
        </p>
        ${aiSessionBadge}
        ${codexSessionSection}
    </div>
</div>`;
}

export function getProjectSearchText(project: Project): string {
    var description = sanitizeProjectName(project.description);
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var aiSessionSearchText = codexSessions
        .concat(kimiSessions)
        .concat(claudeSessions)
        .map(session => session.name || '')
        .join(' ');

    return `${project.name || ''} ${description} ${aiSessionSearchText}`.toLowerCase();
}

export function getAiSessionsDiv(project: Project): string {
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var activeProvider = getActiveAiSessionProvider(project);
    var historySessionsForProvider = activeProvider === 'kimi'
        ? kimiSessions
        : activeProvider === 'claude' ? claudeSessions : codexSessions;
    var activeSessions = project.activeAiSessions || [];
    var selectedTab: AiSessionTabId = project.activeAiSessionTab || (activeSessions.length ? 'active' : 'sessions');
    project = { ...project, activeAiSessionTab: selectedTab } as Project;
    var totalSessionCount = codexSessions.length + kimiSessions.length + claudeSessions.length;

    return `
<div class="codex-sessions" data-selected-ai-session-tab="${selectedTab}">
    <div class="ai-session-module-header">
        <span class="ai-session-module-title">AI SESSIONS</span>
        <button type="button" class="ai-session-create-button" data-action="create-ai-session" aria-label="New AI Session" title="New AI Session"><span aria-hidden="true">+</span><span>NEW</span></button>
    </div>
    <div class="ai-session-tabs" role="tablist" aria-label="AI Session views">
        ${getAiSessionTabButton(project, 'active', activeSessions.length)}
        ${getAiSessionTabButton(project, 'sessions', totalSessionCount)}
    </div>
    ${getActiveAiSessionPanel(project, activeSessions)}
    ${getAiSessionHistoryPanel(project, activeProvider, historySessionsForProvider)}
    <div class="ai-session-live-region" data-ai-session-live-region aria-live="polite" aria-atomic="true"></div>
</div>`;
}

function getAiSessionTabButton(project: Project, tab: AiSessionTabId, count: number): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === tab;
    var isActiveTab = tab === 'active';
    var tabId = `ai-session-${tab}-tab-${projectId}`;
    var panelId = isActiveTab ? `ai-session-active-${projectId}` : `ai-session-history-${projectId}`;
    var attentionCount = isActiveTab
        ? (project.activeAiSessions || []).filter(session => session.needsAttention).length
        : 0;
    var attentionDot = attentionCount
        ? `<span class="ai-session-tab-attention" aria-label="${attentionCount} active AI session${attentionCount === 1 ? ' needs' : 's need'} attention"></span>`
        : '';
    return `<button type="button" id="${tabId}" role="tab" data-action="select-ai-session-tab" data-tab="${tab}" data-ai-session-tab="${tab}" aria-selected="${selected}" aria-controls="${panelId}" tabindex="${selected ? '0' : '-1'}"><span>${isActiveTab ? 'ACTIVE' : 'SESSIONS'}</span><span class="ai-session-tab-count">${count}</span>${attentionDot}</button>`;
}

function getActiveAiSessionPanel(project: Project, sessions: ActiveAiSessionViewModel[]): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === 'active';
    var rows = sessions.length
        ? sessions.map(getActiveAiSessionRow).join('\n')
        : `<div class="codex-sessions-empty ai-session-active-empty">
            <strong>No active sessions</strong>
            <span>Start a new AI session or open one from Sessions.</span>
            <span class="ai-session-empty-actions">
                <button type="button" data-action="create-ai-session">New Session</button>
                <button type="button" data-action="select-ai-session-tab" data-tab="sessions">View Sessions</button>
            </span>
        </div>`;
    return `<div id="ai-session-active-${projectId}" class="ai-session-tab-panel ai-session-active-panel" role="tabpanel" data-ai-session-panel="active" aria-labelledby="ai-session-active-tab-${projectId}"${selected ? '' : ' hidden'}>
        <div class="codex-sessions-list">${rows}</div>
    </div>`;
}

function getAiSessionHistoryPanel(
    project: Project,
    activeProvider: AiSessionProviderId,
    sessions: CodexSession[]
): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === 'sessions';
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var unavailable = activeProvider === 'kimi'
        ? project.kimiSessionsUnavailable
        : activeProvider === 'claude' ? project.claudeSessionsUnavailable : project.codexSessionsUnavailable;
    var providerName = getAiProviderLabel(activeProvider);
    var otherProviderHasHistory = activeProvider !== 'codex' && codexSessions.length
        || activeProvider !== 'kimi' && kimiSessions.length
        || activeProvider !== 'claude' && claudeSessions.length;
    var emptyText = unavailable
        ? `${providerName} session history is unavailable in this environment`
        : `No ${providerName} sessions yet`;
    var sessionRows = sessions.length
        ? sessions.map(session => getCodexSessionRow(session, activeProvider)).join('\n')
        : `<div class="codex-sessions-empty"><span>${emptyText}</span>${otherProviderHasHistory ? '<small>Other providers have sessions.</small>' : ''}</div>`;

    return `<div id="ai-session-history-${projectId}" class="ai-session-tab-panel ai-session-history-panel" role="tabpanel" data-ai-session-panel="sessions" aria-labelledby="ai-session-sessions-tab-${projectId}"${selected ? '' : ' hidden'}>
    <div class="ai-session-provider-controls">
        <label class="ai-session-provider-select-wrapper" title="AI Provider">
            <select class="ai-session-provider-select" data-action="select-ai-provider" aria-label="AI Provider">
                ${getAiProviderOption('codex', 'Codex', codexSessions.length, activeProvider)}
                ${getAiProviderOption('kimi', 'Kimi', kimiSessions.length, activeProvider)}
                ${getAiProviderOption('claude', 'Claude', claudeSessions.length, activeProvider)}
            </select>
        </label>
        ${getManageAiSessionsButton(activeProvider)}
    </div>
    <div class="codex-sessions-list">
        ${sessionRows}
    </div>
    <div class="ai-session-batch-actions" aria-live="polite">
        <div class="ai-session-batch-selection-actions">
            <button type="button" data-action="select-unpinned-ai-sessions" title="Select all unpinned sessions" aria-label="Select all unpinned sessions">All</button>
            <button type="button" data-action="clear-ai-session-selection">Clear</button>
        </div>
        <span class="ai-session-batch-count">0 selected</span>
        <div class="ai-session-batch-submit-actions">
            <button type="button" class="ai-session-batch-archive" data-action="archive-selected-ai-sessions" disabled>Archive</button>
        </div>
    </div>
</div>`;
}

function getAiProviderOption(providerId: AiSessionProviderId, label: string, count: number, activeProvider: AiSessionProviderId): string {
    var isActive = providerId === activeProvider;
    return `<option value="${providerId}"${isActive ? ' selected' : ''}>${label} (${count})</option>`;
}

function getManageAiSessionsButton(activeProvider: AiSessionProviderId): string {
    var label = `Manage ${getAiProviderLabel(activeProvider)} Sessions`;
    return `<button type="button" class="ai-session-manage-button" data-action="manage-ai-sessions" data-provider="${activeProvider}" title="${label}" aria-label="${label}" aria-pressed="false">${Icons.manage}</button>`;
}

function getActiveAiSessionProvider(project: Project): AiSessionProviderId {
    if (isAiProvider(project.activeAiSessionProvider)) {
        return project.activeAiSessionProvider;
    }

    if (!(project.codexSessions || []).length && (project.kimiSessions || []).length) {
        return 'kimi';
    }

    if (!(project.codexSessions || []).length && !(project.kimiSessions || []).length && (project.claudeSessions || []).length) {
        return 'claude';
    }

    return 'codex';
}

function isAiProvider(providerId: string): providerId is AiSessionProviderId {
    return providerId === 'codex' || providerId === 'kimi' || providerId === 'claude';
}

function getAiProviderLabel(providerId: AiSessionProviderId): string {
    switch (providerId) {
        case 'kimi':
            return 'Kimi';
        case 'claude':
            return 'Claude';
        default:
            return 'Codex';
    }
}

function getCodexSessionRow(session: CodexSession, provider: AiSessionProviderId) {
    var sessionName = escapeAttribute(sanitizeProjectName(session.name || session.id));
    var sessionId = escapeAttribute(session.id || '');
    var shortSessionId = escapeAttribute((session.id || '').substring(0, 8));
    var updatedAt = escapeAttribute(formatCodexSessionUpdatedAt(session.updatedAt));
    var shortId = shortSessionId ? `#${shortSessionId}` : '';
    var metadata = [updatedAt, shortId].filter(value => !!value).join(' · ');
    var providerLabel = getAiProviderLabel(provider);
    var pinned = !!session.pinned;
    var needsAttention = !!session.attention?.unread;
    var attentionIndicator = needsAttention
        ? '<span class="ai-session-attention-indicator" title="AI session needs attention" aria-label="AI session needs attention"></span>'
        : '';
    var pinTitle = pinned ? 'Unpin Session' : 'Pin Session';
    var active = session.active === true;
    var batchCheckbox = `<input type="checkbox" class="ai-session-batch-checkbox" aria-label="Select ${sessionName}"${active ? ' disabled' : ''}>`;
    var pinAction = `<button type="button" class="codex-session-pin ${pinned ? 'active' : ''}" data-action="toggle-ai-session-pin" title="${pinTitle}" aria-label="${pinTitle}">${Icons.pin}</button>`;
    var archiveAction = active
        ? `<button type="button" class="codex-session-archive" disabled title="Close the active terminal before archiving." aria-label="Close the active terminal before archiving.">${Icons.archive}</button>`
        : `<button type="button" class="codex-session-archive" data-action="archive-${provider}-session" title="Archive Session" aria-label="Archive Session">${Icons.archive}</button>`;
    var activeStatus = active ? '<span class="ai-session-history-active-status">Active</span>' : '';

    return `
<div class="codex-session-row"${pinned ? ' data-session-pinned' : ''}${active ? ' data-session-active' : ''}${needsAttention ? ' data-ai-session-attention data-session-event-id="' + escapeAttribute(session.attention.eventId) + '"' : ''} data-session-id="${sessionId}" data-session-provider="${provider}" tabindex="0" title="${active ? 'Focus' : 'Resume'} ${providerLabel} Session">
    ${attentionIndicator}
    ${batchCheckbox}
    <span class="codex-session-icon">${Icons.terminalLine}</span>
    <span class="codex-session-text">
        <span class="codex-session-name">${sessionName}</span>
        <span class="codex-session-meta">${activeStatus}${active && metadata ? ' · ' : ''}${metadata}</span>
    </span>
    <span class="codex-session-actions">
        ${pinAction}
        ${archiveAction}
    </span>
</div>`;
}

function getActiveAiSessionRow(model: ActiveAiSessionViewModel): string {
    var providerLabel = getAiProviderLabel(model.provider);
    var sessionName = escapeAttribute(sanitizeProjectName(model.name || model.sessionId || `New ${providerLabel} session`));
    var sessionId = escapeAttribute(model.sessionId || '');
    var shortSessionId = sessionId ? `#${escapeAttribute(sessionId.substring(0, 8))}` : '';
    var createdAt = escapeAttribute(formatCodexSessionUpdatedAt(model.updatedAt || model.createdAt));
    var statusLabel = model.status === 'needsAttention' ? 'Needs attention'
        : model.status === 'focused' ? 'Focused'
            : model.status === 'starting' ? 'Starting'
                : 'Running';
    var metadata = [providerLabel, statusLabel, createdAt, shortSessionId].filter(Boolean).join(' · ');
    var attentionIndicator = model.needsAttention
        ? '<span class="ai-session-attention-indicator" title="AI session needs attention" aria-label="AI session needs attention"></span>'
        : '';
    var pinTitle = model.pinned ? 'Unpin Session' : 'Pin Session';
    var pinAction = model.pending
        ? ''
        : `<button type="button" class="codex-session-pin ${model.pinned ? 'active' : ''}" data-action="toggle-ai-session-pin" title="${pinTitle}" aria-label="${pinTitle}">${Icons.pin}</button>`;
    var closeAction = `<button type="button" class="ai-session-close-terminal" data-action="close-ai-session-terminal" title="Close Terminal…" aria-label="Close Terminal">${Icons.remove}</button>`;
    var pendingAttributes = model.pending
        ? ` data-session-pending data-pending-created-at="${escapeAttribute(model.createdAt || '')}"`
        : ` data-session-active data-session-id="${sessionId}"`;
    var attentionAttributes = model.needsAttention && model.attentionEventId
        ? ` data-ai-session-attention data-session-event-id="${escapeAttribute(model.attentionEventId)}"`
        : '';
    return `<div class="codex-session-row active-ai-session-row" data-session-provider="${model.provider}" data-session-status="${model.status}"${pendingAttributes}${model.pinned ? ' data-session-pinned' : ''}${model.focused ? ' data-session-focused' : ''}${attentionAttributes} tabindex="0" title="${model.pending ? 'Focus pending' : 'Focus'} ${providerLabel} Session">
        ${attentionIndicator}
        <span class="codex-session-icon">${Icons.terminalLine}</span>
        <span class="codex-session-text">
            <span class="codex-session-name">${sessionName}</span>
            <span class="codex-session-meta">${metadata}</span>
        </span>
        <span class="codex-session-actions">${pinAction}${closeAction}</span>
    </div>`;
}

function formatCodexSessionUpdatedAt(updatedAt: string): string {
    if (!updatedAt) {
        return '';
    }

    let date = new Date(updatedAt);
    if (isNaN(date.getTime())) {
        return '';
    }

    return date.toISOString().substring(0, 10);
}

function getProjectIcon(remoteType: ProjectRemoteType): string {
    switch (remoteType) {
        case ProjectRemoteType.SSH:
        case ProjectRemoteType.WSL:
        case ProjectRemoteType.Remote:
            return Icons.terminal;
        case ProjectRemoteType.DevContainer:
            return Icons.container;
        default:
            return Icons.folder;
    }
}

function getProjectIconTitle(remoteType: ProjectRemoteType): string {
    switch (remoteType) {
        case ProjectRemoteType.SSH:
            return 'SSH Project';
        case ProjectRemoteType.DevContainer:
            return 'Dev Container Project';
        case ProjectRemoteType.WSL:
        case ProjectRemoteType.Remote:
            return 'Remote Project';
        default:
            return 'Local Project';
    }
}

function escapeAttribute(value: string): string {
    return (value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeStyleValue(value: string): string {
    return (value || '').replace(/[;"<>]/g, '').trim();
}

function getNoProjectsDiv() {
    return `
<div class="project-container">
    <div class="project no-projects" data-action="add-project" data-nodrag>
        No projects have been added yet.
        <br/>
        Click here to add one.
    </div>
</div>`;
}

function getImportDiv() {
    return `
<div class="project-container">
    <div class="project no-projects import-data" data-action="import-from-other-storage" data-nodrag>
        Project Steward is empty, but there are projects in your other storage.
        <br/>
        This can happen if the storage option has been changed on a different device that is synced via Settings Sync.
        <p>Click here to import.</p>
    </div>
</div>`;
}

function getProjectContextMenu() {
    return `
<div id="projectContextMenu" class="custom-context-menu">
    <div class="custom-context-menu-item" data-action="open">
        Open Project In Current Window
    </div>
    <div class="custom-context-menu-item not-remote" data-action="open-add-to-workspace">
        Add To Workspace
    </div>

    <div class="custom-context-menu-separator"></div>
    
    <div class="custom-context-menu-item" data-action="color">
        Edit Color
    </div>
    <div class="custom-context-menu-item" data-action="edit">
        Edit Project
    </div>
    <div class="custom-context-menu-item" data-action="remove">
        Remove Project
    </div>
</div>
`;
}

function getGroupContextMenu() {
    return `
<div id="groupContextMenu" class="custom-context-menu">   
    <div class="custom-context-menu-item" data-action="add">
        Add Project
    </div>
    <div class="custom-context-menu-item" data-action="edit">
        Edit Group
    </div>
    <div class="custom-context-menu-item" data-action="remove">
        Remove Group
    </div>
</div>
`;
}

function getAiSessionContextMenu() {
    return `
<div id="aiSessionContextMenu" class="custom-context-menu" role="menu" aria-label="AI Session actions">
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="resume">
        Focus / Resume Chat
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="rename">
        Rename Chat
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="copy-id">
        Copy Chat ID
    </div>

    <div class="custom-context-menu-separator" role="separator"></div>

    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="pin">
        Pin / Unpin Chat
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="close-terminal">
        Close Terminal…
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="archive">
        Archive Chat
    </div>
</div>
`;
}

function colorDefaults() {
    var colors = INBUILT_COLOR_DEFAULTS
        .map(color => `${color.name}: ${color.defaultValue};`)
        .join('\n');

    return `html { \n${colors}\n}`;
}

function getCustomStyle(config: vscode.WorkspaceConfiguration) {
    var {
        customProjectCardBackground,
        customProjectNameColor,
        customProjectPathColor,
        projectTileWidth,
    } = config;

    // Nested Template Strings, hooray! \o/
    return `
<style>
    :root {
        ${customProjectCardBackground && customProjectCardBackground.trim()
            ? `--steward-project-card-bg: ${customProjectCardBackground};`
            : ''
        }
        ${customProjectNameColor && customProjectNameColor.trim()
            ? `--steward-foreground: ${customProjectNameColor};`
            : ''
        }
        ${customProjectPathColor && customProjectPathColor.trim()
            ? `--steward-path: ${customProjectPathColor};`
            : ''
        }
        ${projectTileWidth && !isNaN(+projectTileWidth)
            ? `--column-width: ${projectTileWidth}px;`
            : ''
        }
        --steward-ai-session-list-max-height: ${getAiSessionListMaxHeight(config)}px;
    }
</style>`;
}

function getAiSessionListMaxHeight(config: vscode.WorkspaceConfiguration): number {
    var visibleRows = getMaxVisibleAiSessions(config);
    return visibleRows * 42 + Math.max(visibleRows - 1, 0) * 2;
}

function getMaxVisibleAiSessions(config: vscode.WorkspaceConfiguration): number {
    var configuredRows = config.get('maxVisibleAiSessions', 3);
    var visibleRows = Math.floor(Number(configuredRows));
    return Number.isFinite(visibleRows) && visibleRows > 0 ? visibleRows : 3;
}

function getMediaResource(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    name: string
) {
    let resource = vscode.Uri.file(
        path.join(context.extensionPath, 'media', name)
    );
    resource = webview.asWebviewUri(resource);

    return resource;
}
