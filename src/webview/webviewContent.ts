import * as vscode from 'vscode';
import * as path from 'path';

import {
    Project,
    Group,
    getRemoteType,
    ProjectRemoteType,
    DashboardInfos,
    sanitizeProjectName,
} from '../models';
import { FAVORITES_GROUP_ID, FITTY_OPTIONS, INBUILT_COLOR_DEFAULTS, REMOTE_REGEX } from '../constants';
import * as Icons from './webviewIcons';

const FAVORITES_GROUP_NAME = 'Favorites';

export function getDashboardContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    groups: Group[],
    infos: DashboardInfos,
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
    var allGroups = groups.length
        ? [getFavoritesGroup(favoriteProjects, favoritesGroupCollapsed), ...groups]
        : [];

    var allGroupsCollapsed = groups.length && groups.every(group => group.collapsed);

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
        <link rel="stylesheet" type="text/css" href="${stylesPath}">
        <style>${colorDefaults()}</style>
        <style>
            /* Custom CSS from configuration */
            ${customCss}
        </style>
        <title>Dashboard</title>
        ${getCustomStyle(infos.config)}
    </head>
    <body class="preload ${isSidebar ? 'dashboard-sidebar' : ''} ${!groups.length ? 'dashboard-empty' : ''} ${allGroupsCollapsed ? 'dashboard-all-collapsed' : ''}">
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
        <div class="">
            <div class="groups-wrapper ${!infos.config.displayProjectPath ? 'hide-project-path' : ''
        }">
        ${groups.length
            ? allGroups
                .map((group) => getGroupSection(group, allGroups.length, infos))
                .join('\n')
            : (infos.otherStorageHasData ? getImportDiv() : getNoProjectsDiv())
        }
        
            </div>

            ${infos.config.showAddGroupButtonTile ? getTempGroupSection(allGroups.length) : ''}
        </div>

        ${getProjectContextMenu()}
        ${getGroupContextMenu()}
    </body>

    <script src="${fittyPath}"></script>
    <script src="${dragulaPath}"></script>
    <script src="${autoScrollerPath}"></script>
    <script src="${projectScriptsPath}"></script>
    <script src="${dndScriptsPath}"></script>
    <script src="${filterScriptsPath}"></script>

    <script>
        (function() {
            fitty('.project-header', ${JSON.stringify(FITTY_OPTIONS)});

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

function getGroupSection(
    group: Group,
    totalGroupCount: number,
    infos: DashboardInfos
) {
    // Apply changes to HTML here also to getTempGroupSection

    var showAddProjectButton = infos.config.showAddProjectButtonTile;
    var isVirtualGroup = group.id === FAVORITES_GROUP_ID;
    var groupActions = isVirtualGroup
        ? ''
        : `<div class="group-actions right">
            <span data-action="add" title="Add Project">${Icons.add}</span>
            <span data-action="edit" title="Edit Group">${Icons.edit}</span>
            <span data-action="remove" title="Remove Group">${Icons.remove
        }</span>
        </div>`;
    var dragAttribute = isVirtualGroup ? '' : 'data-drag-group';

    return `
<div class="group ${group.collapsed ? 'collapsed' : ''} ${group.projects.length === 0 ? 'no-projects' : ''
        }" data-group-id="${group.id}"${isVirtualGroup ? ' data-virtual-group' : ''}>
    <div class="group-title">
        <span class="group-title-text" data-action="collapse" ${dragAttribute}>
            <span class="collapse-icon" title="Open/Collapse Group">${Icons.collapse
        }</span>
            ${group.groupName || 'Unnamed Group'}
        </span>
        ${groupActions}
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${group.projects.map((p) => getProjectDiv(p, isVirtualGroup)).join('\n')}
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

function getProjectDiv(project: Project, isVirtualProject: boolean = false) {
    var borderStyle = `background: ${project.color};`;
    var remoteType = getRemoteType(project);
    var trimmedPath = (project.path || '').replace(REMOTE_REGEX, '');
    var description = sanitizeProjectName(project.description);
    var searchText = escapeAttribute(`${project.name || ''} ${description} ${trimmedPath}`.toLowerCase());
    var escapedDescription = escapeAttribute(description);
    var projectIcon = getProjectIcon(remoteType);
    var projectIconTitle = getProjectIconTitle(remoteType);
    var favoriteIcon = project.favorite ? Icons.starFilled : Icons.star;
    var favoriteTitle = project.favorite ? 'Remove From Favorites' : 'Add To Favorites';

    var isRemote = remoteType !== ProjectRemoteType.None;

    return `
<div class="project-container"${isVirtualProject ? ' data-nodrag' : ''}>
    <div class="project" data-id="${project.id}" data-name="${searchText}"${isRemote ? ' data-is-remote' : ''
        }${isVirtualProject ? ' data-virtual-project' : ''
        }>
        <div class="project-border" style="${borderStyle}"></div>
        <div class="project-actions-wrapper">
            <div class="project-actions">
                <span data-action="favorite" title="${favoriteTitle}" class="favorite-action ${project.favorite ? 'active' : ''
        }">${favoriteIcon
        }</span>
                <span data-action="open-new-window" title="Open Project In New Window">${Icons.openNewWindow
        }</span>
                <span data-action="color" title="Edit Color">${Icons.palette
        }</span>
                <span data-action="edit" title="Edit Project">${Icons.edit
        }</span>
                <span data-action="remove" title="Remove Project">${Icons.remove
        }</span>
            </div>
        </div>
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon" title="${projectIconTitle}">
                ${projectIcon}
            </span>
            <h2 class="project-header">
                ${project.name}
            </h2>
        </div>
        <p class="project-description" title="${escapedDescription}">
            ${description}
        </p>
    </div>
</div>`;
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
        Your dashboard is empty, but there are projects in your other storage. 
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
        Open Project
    </div>
    <div class="custom-context-menu-item" data-action="open-new-window">
        Open Project In New Window
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
            ? `--dashboard-project-card-bg: ${customProjectCardBackground};`
            : ''
        }
        ${customProjectNameColor && customProjectNameColor.trim()
            ? `--dashboard-foreground: ${customProjectNameColor};`
            : ''
        }
        ${customProjectPathColor && customProjectPathColor.trim()
            ? `--dashboard-path: ${customProjectPathColor};`
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
