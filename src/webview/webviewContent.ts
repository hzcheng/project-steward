import * as vscode from 'vscode';
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
import { FAVORITES_GROUP_ID, FITTY_OPTIONS, INBUILT_COLOR_DEFAULTS, OPEN_PROJECTS_GROUP_ID } from '../constants';
import * as Icons from './webviewIcons';

const FAVORITES_GROUP_NAME = 'FAVORITES';
const OPEN_PROJECTS_GROUP_NAME = 'OPEN PROJECT';

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
    var filterScriptsPath = getMediaResource(
        context,
        webview,
        'webviewFilterScripts.js'
    );

    var customCss = infos.config.get('customCss') || '';
    var favoriteProjects = groups
        .reduce((projects, group) => projects.concat(group.projects || []), [] as Project[])
        .filter(project => project.favorite);
    var favoritesGroupCollapsed = infos.favoritesGroupCollapsed !== undefined
        ? infos.favoritesGroupCollapsed
        : groups.every(group => group.collapsed);
    var openProjects = infos.openProjects || [];
    var openProjectsGroup = openProjects.length
        ? getOpenProjectsGroup(openProjects, infos.openProjectsGroupCollapsed)
        : null;
    var mainGroups = [
        ...(groups.length ? [getFavoritesGroup(favoriteProjects, favoritesGroupCollapsed)] : []),
        ...groups,
    ];
    var allGroups = [
        ...(openProjectsGroup ? [openProjectsGroup] : []),
        ...mainGroups,
    ];

    var allGroupsCollapsed = allGroups.length && allGroups.every(group => group.collapsed);

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
            </div>
            ${openProjectsGroup ? `<div class="sticky-groups-wrapper">
                ${getGroupSection(openProjectsGroup, allGroups.length, infos)}
            </div>` : ''}
        </div>
        <div class="">
            <div class="groups-wrapper ${!infos.config.displayProjectPath ? 'hide-project-path' : ''
        }">
        ${mainGroups.length
            ? mainGroups
                .map((group) => getGroupSection(group, allGroups.length, infos))
                .join('\n')
            : (infos.otherStorageHasData ? getImportDiv() : getNoProjectsDiv())
        }
        
            </div>

            ${infos.config.showAddGroupButtonTile ? getTempGroupSection(allGroups.length) : ''}
        </div>

        ${getProjectContextMenu()}
        ${getGroupContextMenu()}
        ${getAiSessionContextMenu()}
    </body>

    <script src="${fittyPath}"></script>
    <script src="${dragulaPath}"></script>
    <script src="${autoScrollerPath}"></script>
    <script src="${projectScriptsPath}"></script>
    <script src="${dndScriptsPath}"></script>
    <script src="${filterScriptsPath}"></script>

    <script>
        (function() {
            if (!document.body.classList.contains('steward-sidebar')) {
                fitty('.project-header', ${JSON.stringify(FITTY_OPTIONS)});
            }

            window.vscode = acquireVsCodeApi();      
            
            window.onload = () => {
                initProjects();
                initDnD();
                initFiltering(${infos.config.searchIsActiveByDefault});
            }
        })();
    </script>


</html>`;
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
        .toggle-all-groups-button {
            width: 28px;
            height: 28px;
            padding: 0;
            overflow: hidden;
        }
        .toggle-all-groups-button svg {
            width: 13px;
            height: 13px;
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
    totalGroupCount: number,
    infos: StewardInfos
) {
    // Apply changes to HTML here also to getTempGroupSection

    var showAddProjectButton = infos.config.showAddProjectButtonTile;
    var isVirtualGroup = isVirtualGroupId(group.id);
    var groupActions = isVirtualGroup
        ? ''
        : `<div class="group-actions right">
            <span data-action="add" title="Add Project">${Icons.add}</span>
            <span data-action="edit" title="Edit Group">${Icons.edit}</span>
            <span data-action="remove" title="Remove Group">${Icons.remove
        }</span>
        </div>`;
    var dragAttribute = isVirtualGroup ? '' : 'data-drag-group';
    var groupName = escapeAttribute(group.groupName || 'Unnamed Group');
    var systemGroupAttribute = isVirtualGroup ? ` data-system-group="${group.id}"` : '';
    var systemGroupBadge = group.id === OPEN_PROJECTS_GROUP_ID
        ? 'Live'
        : group.id === FAVORITES_GROUP_ID
            ? 'Pinned'
            : '';

    return `
<div class="group ${group.collapsed ? 'collapsed' : ''} ${group.projects.length === 0 ? 'no-projects' : ''
        }" data-group-id="${group.id}"${isVirtualGroup ? ' data-virtual-group' : ''}${systemGroupAttribute}>
    <div class="group-title">
        <span class="group-title-text" data-action="collapse" ${dragAttribute}>
            <span class="collapse-icon" title="Open/Collapse Group">${Icons.collapse
        }</span>
            ${groupName}
        </span>
        ${systemGroupBadge ? `<span class="group-title-badge">${systemGroupBadge}</span>` : ''}
        ${groupActions}
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${group.projects.map((p) => getProjectDiv(p, isVirtualGroup, group.id === OPEN_PROJECTS_GROUP_ID)).join('\n')}
        ${showAddProjectButton && !isVirtualGroup ? getAddProjectDiv(group.id) : ''}
    </div>       
</div>`;
}

function getFavoritesGroup(favoriteProjects: Project[], collapsed: boolean = false): Group {
    var group = new Group(FAVORITES_GROUP_NAME, favoriteProjects);
    group.id = FAVORITES_GROUP_ID;
    group.collapsed = collapsed;

    return group;
}

function getOpenProjectsGroup(openProjects: Project[], collapsed: boolean = false): Group {
    var group = new Group(OPEN_PROJECTS_GROUP_NAME, openProjects);
    group.id = OPEN_PROJECTS_GROUP_ID;
    group.collapsed = collapsed;

    return group;
}

function isVirtualGroupId(groupId: string): boolean {
    return groupId === FAVORITES_GROUP_ID || groupId === OPEN_PROJECTS_GROUP_ID;
}

function getTempGroupSection(totalGroupCount: number) {
    return `
<div class="group" id="tempGroup">
    <div class="group-title" data-action="add-group">
        <span>${Icons.add} New Group</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
    </div>       
</div>     
    </div>       
</div>`;
}

function getProjectDiv(project: Project, isVirtualProject: boolean = false, isReadOnlyProject: boolean = false) {
    var borderStyle = `background: ${project.color};`;
    var remoteType = getRemoteType(project);
    var description = sanitizeProjectName(project.description);
    var projectName = escapeAttribute(sanitizeProjectName(project.name));
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var searchText = escapeAttribute(getProjectSearchText(project));
    var escapedDescription = escapeAttribute(description);
    var projectIcon = getProjectIcon(remoteType);
    var projectIconTitle = getProjectIconTitle(remoteType);
    var favoriteTitle = project.favorite ? 'Remove From Favorites' : 'Add To Favorites';
    var projectActions = isReadOnlyProject
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
    var favoriteBadge = isReadOnlyProject
        ? ''
        : `<span data-action="favorite" class="project-favorite-badge ${project.favorite ? 'active' : ''}" title="${favoriteTitle}">${favoriteBadgeIcon}</span>`;
    var saveBadge = project.showSaveAction
        ? `<span data-action="save" class="project-save-badge" title="Save Current Project">${Icons.save}</span>`
        : '';
    var aiSessionCount = codexSessions.length + kimiSessions.length + claudeSessions.length;
    var aiSessionBadge = isReadOnlyProject && aiSessionCount
        ? `<span class="project-codex-badge" title="AI Sessions">AI ${aiSessionCount}</span>`
        : '';
    var codexSessionSection = isReadOnlyProject ? getAiSessionsDiv(project) : '';

    var isRemote = remoteType !== ProjectRemoteType.None;

    return `
<div class="project-container"${isVirtualProject ? ' data-nodrag' : ''}>
    <div class="project" data-id="${project.id}" data-name="${searchText}"${isRemote ? ' data-is-remote' : ''
        }${isVirtualProject ? ' data-virtual-project' : ''
        }${isReadOnlyProject ? ' data-readonly-project' : ''
        }${isReadOnlyProject ? ' data-open-project' : ''
        }${project.codexSessionsExpanded ? ' data-codex-expanded' : ''
        }${!isReadOnlyProject ? ' data-has-favorite-toggle' : ''
        }${project.showSaveAction ? ' data-has-save-action' : ''
        }${project.favorite ? ' data-favorite-project' : ''
        }>
        <div class="project-border" style="${borderStyle}"></div>
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
    var activeSessions = activeProvider === 'kimi' ? kimiSessions : activeProvider === 'claude' ? claudeSessions : codexSessions;
    var unavailable = activeProvider === 'kimi' ? project.kimiSessionsUnavailable : activeProvider === 'claude' ? project.claudeSessionsUnavailable : project.codexSessionsUnavailable;
    var providerName = getAiProviderLabel(activeProvider);
    var emptyText = unavailable ? `No ${providerName} history found` : 'No sessions yet';
    var sessionRows = activeSessions.length
        ? activeSessions.map(session => getCodexSessionRow(session, activeProvider)).join('\n')
        : `<div class="codex-sessions-empty">${emptyText}</div>`;

    return `
<div class="codex-sessions">
    <div class="ai-session-provider-controls">
        <label class="ai-session-provider-select-wrapper" title="AI Provider">
            <select class="ai-session-provider-select" data-action="select-ai-provider" aria-label="AI Provider">
                ${getAiProviderOption('codex', 'Codex', codexSessions.length, activeProvider)}
                ${getAiProviderOption('kimi', 'Kimi', kimiSessions.length, activeProvider)}
                ${getAiProviderOption('claude', 'Claude', claudeSessions.length, activeProvider)}
            </select>
        </label>
        ${getCreateAiSessionButton(activeProvider)}
    </div>
    <div class="codex-sessions-list">
        ${sessionRows}
    </div>
</div>`;
}

function getAiProviderOption(providerId: AiSessionProviderId, label: string, count: number, activeProvider: AiSessionProviderId): string {
    var isActive = providerId === activeProvider;
    return `<option value="${providerId}"${isActive ? ' selected' : ''}>${label} (${count})</option>`;
}

function getCreateAiSessionButton(activeProvider: AiSessionProviderId): string {
    var providerLabel = getAiProviderLabel(activeProvider);
    return `<button class="ai-session-create-button" data-action="create-ai-session" data-provider="${activeProvider}" title="New ${providerLabel} Session">${Icons.add}</button>`;
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
    var metadata = [updatedAt, shortSessionId].filter(value => !!value).join(' · ');
    var providerLabel = getAiProviderLabel(provider);
    var pinned = !!session.pinned;
    var pinTitle = pinned ? 'Unpin Session' : 'Pin Session';
    var pinAction = `<span class="codex-session-pin ${pinned ? 'active' : ''}" data-action="toggle-ai-session-pin" title="${pinTitle}">${Icons.pin}</span>`;
    var archiveAction = `<span class="codex-session-archive" data-action="archive-${provider}-session" title="Archive Session">${Icons.archive}</span>`;

    return `
<div class="codex-session-row"${pinned ? ' data-session-pinned' : ''} data-session-id="${sessionId}" data-session-provider="${provider}" title="Resume ${providerLabel} Session">
    <span class="codex-session-icon">${Icons.terminalLine}</span>
    <span class="codex-session-text">
        <span class="codex-session-name">${sessionName}</span>
        <span class="codex-session-meta">${metadata}</span>
    </span>
    ${pinAction}
    ${archiveAction}
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

function getAddProjectDiv(groupId: string) {
    return `
<span class="project-container slim last" data-nodrag>
    <div class="project add-project" data-action="add-project" data-group-id="${groupId}">
        <h2 class="add-project-header">
            +
        </h2>
    </div>
</span>`;
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
<div id="aiSessionContextMenu" class="custom-context-menu">
    <div class="custom-context-menu-item" data-action="resume">
        Resume Chat
    </div>
    <div class="custom-context-menu-item" data-action="rename">
        Rename Chat
    </div>
    <div class="custom-context-menu-item" data-action="copy-id">
        Copy Chat ID
    </div>

    <div class="custom-context-menu-separator"></div>

    <div class="custom-context-menu-item" data-action="pin">
        Pin / Unpin Chat
    </div>
    <div class="custom-context-menu-item" data-action="archive">
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
    }
</style>`;
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
