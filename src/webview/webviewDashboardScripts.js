function normalizeDashboardTab(tab) {
    return tab === 'projects' || tab === 'todo' ? tab : 'open';
}

function getAdjacentDashboardTab(tab, key) {
    tab = normalizeDashboardTab(tab);
    var tabs = ['open', 'projects', 'todo'];
    var currentIndex = tabs.indexOf(tab);
    if (key === 'ArrowRight') {
        return tabs[(currentIndex + 1) % tabs.length];
    }
    if (key === 'ArrowLeft') {
        return tabs[(currentIndex + tabs.length - 1) % tabs.length];
    }
    return tab;
}

function validateProjectsPanelMessage(message) {
    return !!message
        && message.type === 'projects-panel-content'
        && message.version === 1
        && Number.isSafeInteger(message.requestId)
        && message.requestId > 0
        && typeof message.html === 'string';
}

function validateProjectsPanelUpdatedMessage(message) {
    if (!message
        || message.type !== 'projects-panel-updated'
        || message.version !== 1
        || !Number.isSafeInteger(message.sequence)
        || message.sequence < 1
        || (message.mode !== 'replace' && message.mode !== 'preserve-order')
        || typeof message.html !== 'string'
        || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
        || !Array.isArray(message.groupOrders)
        || !Array.isArray(message.favoriteProjectIds)) {
        return false;
    }
    var groupIds = new Set();
    var savedProjectIds = new Set();
    for (var group of message.groupOrders) {
        if (!group
            || typeof group.groupId !== 'string'
            || !group.groupId
            || groupIds.has(group.groupId)
            || !Array.isArray(group.projectIds)) {
            return false;
        }
        groupIds.add(group.groupId);
        for (var projectId of group.projectIds) {
            if (typeof projectId !== 'string'
                || !projectId
                || savedProjectIds.has(projectId)) {
                return false;
            }
            savedProjectIds.add(projectId);
        }
    }
    var favoriteIds = new Set();
    for (var favoriteId of message.favoriteProjectIds) {
        if (typeof favoriteId !== 'string'
            || !favoriteId
            || favoriteIds.has(favoriteId)) {
            return false;
        }
        favoriteIds.add(favoriteId);
    }
    return true;
}

function validateTodoPanelMessage(message) {
    return !!message
        && message.type === 'todo-panel-content'
        && message.version === 1
        && Number.isSafeInteger(message.requestId)
        && message.requestId > 0
        && typeof message.html === 'string';
}

function validateTodoPanelUpdatedMessage(message) {
    return !!message
        && message.type === 'todo-panel-updated'
        && message.version === 1
        && typeof message.html === 'string'
        && normalizeDashboardSearchCatalog(message.searchCatalog) === message.searchCatalog;
}

function normalizeDashboardSearchCatalog(value) {
    if (value
        && value.version === 2
        && Array.isArray(value.sessions)
        && Array.isArray(value.openWorkspaces)
        && Array.isArray(value.savedProjects)
        && Array.isArray(value.todos)) {
        return value;
    }
    return { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] };
}

function replaceDashboardSearchCatalogState(state, catalog) {
    return Object.assign({}, state, {
        catalog: normalizeDashboardSearchCatalog(catalog),
    });
}

function readInitialDashboardSearchCatalog() {
    var element = document.getElementById('dashboard-search-catalog');
    try {
        return normalizeDashboardSearchCatalog(JSON.parse(element ? element.textContent || '' : ''));
    } catch (_error) {
        return normalizeDashboardSearchCatalog(null);
    }
}

function globToDashboardRegex(value) {
    var escaped = String(value || '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(escaped, 'i');
}

function filterDashboardCatalog(catalog, query) {
    catalog = normalizeDashboardSearchCatalog(catalog);
    var regex = globToDashboardRegex(query);
    var sections = [
        { id: 'ai-sessions', title: 'AI SESSIONS', type: 'session', items: catalog.sessions },
        { id: 'open-workspaces', title: 'OPEN WORKSPACES', type: 'open-workspace', items: catalog.openWorkspaces },
        { id: 'saved-projects', title: 'SAVED PROJECTS', type: 'saved-project', items: catalog.savedProjects },
        { id: 'todos', title: 'TODO RESULTS', type: 'todo', items: catalog.todos },
    ];
    return sections
        .map(section => ({
            id: section.id,
            title: section.title,
            type: section.type,
            items: section.items.filter(item => regex.test(String(item.searchText || ''))),
        }))
        .filter(section => section.items.length > 0);
}

function renderDashboardSearchResults(container, sections) {
    if (!container) {
        return;
    }
    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }
    if (!sections.length) {
        var empty = document.createElement('div');
        empty.className = 'dashboard-search-empty';
        empty.setAttribute('role', 'status');
        empty.textContent = 'No matching projects or AI sessions.';
        container.appendChild(empty);
        return;
    }

    sections.forEach(section => {
        var sectionElement = document.createElement('section');
        sectionElement.className = 'dashboard-search-section';
        sectionElement.dataset.sectionType = section.type;
        var heading = document.createElement('h2');
        heading.className = 'dashboard-search-section-title';
        heading.textContent = section.title;
        sectionElement.appendChild(heading);

        section.items.forEach(item => {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'dashboard-search-result';
            button.dataset.projectId = String(item.projectId || '');

            var title = document.createElement('span');
            title.className = 'dashboard-search-result-title';
            title.textContent = String(item.name || item.title || '');
            button.appendChild(title);

            var metadata = document.createElement('span');
            metadata.className = 'dashboard-search-result-meta';
            if (section.type === 'session') {
                button.dataset.provider = String(item.provider || '');
                button.dataset.sessionId = String(item.sessionId || '');
                button.dataset.searchAction = 'reveal-workspace-session';
                button.dataset.workspaceId = String(item.workspaceId || '');
                button.dataset.workspaceNavigationIdentity = String(item.workspaceNavigationIdentity || '');
                metadata.textContent = [item.workspaceName, item.provider].filter(Boolean).join(' · ');
                if (item.active === true) {
                    var activeBadge = document.createElement('span');
                    activeBadge.className = 'dashboard-search-result-status active';
                    activeBadge.textContent = 'Active';
                    metadata.appendChild(activeBadge);
                }
            } else if (section.type === 'open-workspace') {
                button.dataset.workspaceId = String(item.workspaceId || '');
                button.dataset.workspaceNavigationIdentity = String(item.navigationIdentity || '');
                button.dataset.searchAction = item.current === true
                    ? 'show-current-workspace'
                    : 'switch-open-workspace';
                metadata.textContent = [item.description, item.environmentLabel].filter(Boolean).join(' · ');
            } else if (section.type === 'todo') {
                button.dataset.searchAction = 'show-todo';
                button.dataset.todoId = String(item.todoId || '');
                button.dataset.groupId = String(item.groupId || '');
                button.classList.toggle('completed', item.completed === true);
                var groupBadge = document.createElement('span');
                groupBadge.className = 'dashboard-search-result-group steward-badge';
                groupBadge.textContent = String(item.groupTitle || '');
                metadata.appendChild(groupBadge);
                var priority = document.createElement('span');
                priority.className = 'dashboard-search-result-priority';
                priority.textContent = String(item.priority || '').toUpperCase();
                metadata.appendChild(priority);
                if (item.completed === true) {
                    var status = document.createElement('span');
                    status.className = 'dashboard-search-result-status';
                    status.textContent = 'Completed';
                    metadata.appendChild(status);
                }
            } else {
                button.dataset.searchAction = 'open-saved-project';
                metadata.textContent = [item.description].concat(item.groupLabels || []).filter(Boolean).join(' · ');
            }
            button.appendChild(metadata);
            sectionElement.appendChild(button);
        });
        container.appendChild(sectionElement);
    });
}

function initDashboard(options) {
    options = options || {};
    var storageKey = 'projectSteward.activeDashboardTab';
    var scrollPositions = { open: 0, projects: 0, todo: 0 };
    var activeTab = normalizeDashboardTab(sessionStorage.getItem(storageKey));
    var projectsState = 'unloaded';
    var projectsRequestId = 0;
    var acceptedProjectsRequestId = 0;
    var acceptedProjectsUpdateSequence = 0;
    var projectsRequestAttempts = 0;
    var projectsRequestTimer = null;
    var todoState = 'unloaded';
    var todoRequestId = 0;
    var acceptedTodoRequestId = 0;
    var todoRequestAttempts = 0;
    var todoRequestTimer = null;
    var pendingTodoSearchTarget = null;
    var pendingScrollRestoreTab = null;
    var panelRequestTimeoutMs = Number(options.panelRequestTimeoutMs) > 0
        ? Number(options.panelRequestTimeoutMs)
        : 5000;
    var scheduleTimeout = options.setTimeout
        || (typeof setTimeout === 'function' ? setTimeout : null);
    var cancelTimeout = options.clearTimeout
        || (typeof clearTimeout === 'function' ? clearTimeout : function () {});
    var catalog = readInitialDashboardSearchCatalog();
    var searchQuery = String(options.initialSearchQuery || '').trim();
    var tabButtons = Array.from(document.querySelectorAll('[data-dashboard-tab]'));
    var panels = {
        open: document.getElementById('dashboard-tab-open'),
        projects: document.getElementById('dashboard-tab-projects'),
        todo: document.getElementById('dashboard-tab-todo'),
    };
    var tablist = document.querySelector ? document.querySelector('[role="tablist"]') : null;
    var collapseButton = document.querySelector ? document.querySelector('[data-action="toggle-all-groups"]') : null;
    var searchResults = document.getElementById('dashboard-search-results');

    function restoreScroll(tab) {
        requestAnimationFrame(() => {
            window.scrollTo(0, scrollPositions[normalizeDashboardTab(tab)] || 0);
        });
    }

    function renderActiveTab() {
        Object.keys(panels).forEach(tab => {
            if (panels[tab]) {
                panels[tab].hidden = tab !== activeTab;
            }
        });
        tabButtons.forEach(button => {
            var selected = normalizeDashboardTab(button.getAttribute('data-dashboard-tab')) === activeTab;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.setAttribute('tabindex', selected ? '0' : '-1');
            button.classList.toggle('active', selected);
        });
    }

    function renderSearchMode() {
        var active = searchQuery.length > 0;
        if (tablist) {
            tablist.hidden = active;
        }
        if (collapseButton) {
            collapseButton.hidden = active;
        }
        Object.keys(panels).forEach(tab => {
            if (panels[tab]) {
                panels[tab].hidden = active || tab !== activeTab;
            }
        });
        if (searchResults) {
            searchResults.hidden = !active;
        }
        document.body.classList.toggle('dashboard-search-active', active);
        if (active) {
            renderDashboardSearchResults(searchResults, filterDashboardCatalog(catalog, searchQuery));
        }
    }

    function notifyActiveTabChanged() {
        if (typeof options.onActiveTabChanged === 'function') {
            options.onActiveTabChanged(activeTab);
        }
    }

    function getPanelLoadingElement(tab) {
        var panel = panels[tab];
        if (!panel || !panel.querySelector) {
            return null;
        }
        return panel.querySelector(tab === 'projects'
            ? '.dashboard-projects-loading'
            : '.dashboard-todo-loading');
    }

    function showPanelLoading(tab) {
        var loadingElement = getPanelLoadingElement(tab);
        if (!loadingElement) {
            return;
        }
        loadingElement.textContent = tab === 'projects' ? 'Loading projects…' : 'Loading todos…';
        loadingElement.hidden = false;
    }

    function showPanelUnavailable(tab) {
        var loadingElement = getPanelLoadingElement(tab);
        if (!loadingElement) {
            return;
        }
        loadingElement.textContent = (tab === 'projects' ? 'Projects' : 'TODO')
            + ' are temporarily unavailable. Select this tab to retry.';
        loadingElement.hidden = false;
    }

    function scheduleProjectsRequestTimeout(requestId) {
        if (!scheduleTimeout) {
            return;
        }
        if (projectsRequestTimer !== null) {
            cancelTimeout(projectsRequestTimer);
        }
        projectsRequestTimer = scheduleTimeout(function () {
            projectsRequestTimer = null;
            if (projectsState !== 'loading' || requestId !== projectsRequestId) {
                return;
            }
            projectsState = 'unloaded';
            if (projectsRequestAttempts < 2 && activeTab === 'projects' && !searchQuery) {
                ensureProjectsPanel();
                return;
            }
            showPanelUnavailable('projects');
        }, panelRequestTimeoutMs);
    }

    function scheduleTodoRequestTimeout(requestId) {
        if (!scheduleTimeout) {
            return;
        }
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
        }
        todoRequestTimer = scheduleTimeout(function () {
            todoRequestTimer = null;
            if (todoState !== 'loading' || requestId !== todoRequestId) {
                return;
            }
            todoState = 'unloaded';
            if (todoRequestAttempts < 2 && activeTab === 'todo' && !searchQuery) {
                ensureTodoPanel();
                return;
            }
            showPanelUnavailable('todo');
        }, panelRequestTimeoutMs);
    }

    function ensureProjectsPanel() {
        if (projectsState !== 'unloaded') {
            return;
        }
        projectsState = 'loading';
        projectsRequestAttempts += 1;
        projectsRequestId += 1;
        showPanelLoading('projects');
        options.postMessage({
            type: 'request-projects-panel',
            version: 1,
            requestId: projectsRequestId,
        });
        scheduleProjectsRequestTimeout(projectsRequestId);
    }

    function ensureTodoPanel() {
        if (todoState !== 'unloaded') {
            return;
        }
        todoState = 'loading';
        todoRequestAttempts += 1;
        todoRequestId += 1;
        showPanelLoading('todo');
        options.postMessage({
            type: 'request-todo-panel',
            version: 1,
            requestId: todoRequestId,
        });
        scheduleTodoRequestTimeout(todoRequestId);
    }

    function activateTab(tab, saveScroll) {
        tab = normalizeDashboardTab(tab);
        saveScroll = saveScroll !== false;
        if (tab !== activeTab) {
            if (saveScroll) {
                scrollPositions[activeTab] = window.scrollY || 0;
            }
            activeTab = tab;
            sessionStorage.setItem(storageKey, activeTab);
        }
        renderActiveTab();
        if (searchQuery) {
            renderSearchMode();
            notifyActiveTabChanged();
            return;
        }
        if (activeTab === 'projects') {
            if (projectsState === 'mounted') {
                restoreScroll('projects');
            } else {
                pendingScrollRestoreTab = 'projects';
                ensureProjectsPanel();
            }
        } else if (activeTab === 'todo') {
            if (todoState === 'mounted') {
                restoreScroll('todo');
            } else {
                pendingScrollRestoreTab = 'todo';
                ensureTodoPanel();
            }
        } else {
            restoreScroll('open');
        }
        notifyActiveTabChanged();
    }

    function setSearchQuery(query) {
        var nextQuery = String(query || '').trim();
        var wasActive = searchQuery.length > 0;
        if (!wasActive && nextQuery) {
            scrollPositions[activeTab] = window.scrollY || 0;
        }
        searchQuery = nextQuery;
        renderSearchMode();
        if (!searchQuery && wasActive) {
            renderActiveTab();
            if (activeTab === 'projects' && projectsState !== 'mounted') {
                pendingScrollRestoreTab = 'projects';
                ensureProjectsPanel();
            } else if (activeTab === 'todo' && todoState !== 'mounted') {
                pendingScrollRestoreTab = 'todo';
                ensureTodoPanel();
            } else {
                restoreScroll(activeTab);
            }
        }
        notifyActiveTabChanged();
    }

    function replaceSearchCatalog(nextCatalog) {
        var state = replaceDashboardSearchCatalogState({
            activeTab,
            searchQuery,
            scrollPositions,
            catalog,
        }, nextCatalog);
        catalog = state.catalog;
        if (searchQuery) {
            renderDashboardSearchResults(searchResults, filterDashboardCatalog(catalog, searchQuery));
        }
    }

    function onSearchResultClick(event) {
        var button = event.target && event.target.closest
            ? event.target.closest('.dashboard-search-result[data-search-action]')
            : null;
        if (!button) {
            return;
        }
        var action = button.dataset.searchAction;
        if (action === 'resume-session') {
            var provider = button.dataset.provider;
            if (provider !== 'codex' && provider !== 'kimi' && provider !== 'claude') {
                return;
            }
            if (typeof window.__projectStewardAcknowledgeSession === 'function') {
                window.__projectStewardAcknowledgeSession(provider, button.dataset.sessionId);
            }
            options.postMessage({
                type: 'resume-' + provider + '-session',
                provider,
                projectId: button.dataset.projectId,
                sessionId: button.dataset.sessionId,
            });
            return;
        }
        if (action === 'reveal-workspace-session') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__projectStewardRevealWorkspaceSession === 'function') {
                window.__projectStewardRevealWorkspaceSession(
                    button.dataset.workspaceNavigationIdentity,
                    button.dataset.provider,
                    button.dataset.sessionId
                );
            }
            return;
        }
        if (action === 'show-current-workspace') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__projectStewardRevealWorkspace === 'function') {
                window.__projectStewardRevealWorkspace(button.dataset.workspaceNavigationIdentity);
            }
            return;
        }
        if (action === 'switch-open-workspace') {
            options.postMessage({
                type: 'selected-workspace',
                workspaceId: button.dataset.workspaceId,
                navigationIdentity: button.dataset.workspaceNavigationIdentity,
            });
            return;
        }
        if (action === 'open-saved-project') {
            options.postMessage({
                type: 'selected-project',
                projectId: button.dataset.projectId,
                projectOpenType: 0,
            });
            return;
        }
        if (action === 'show-todo') {
            pendingTodoSearchTarget = {
                todoId: String(button.dataset.todoId || ''),
                groupId: String(button.dataset.groupId || ''),
                revealRequested: false,
                focusScheduled: false,
            };
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('todo', false);
            if (todoState === 'mounted') {
                revealPendingTodoSearchTarget();
            }
        }
    }

    function revealPendingTodoSearchTarget() {
        if (!pendingTodoSearchTarget || !panels.todo || pendingTodoSearchTarget.focusScheduled) {
            return false;
        }
        var scheduledTarget = pendingTodoSearchTarget;
        scheduledTarget.focusScheduled = true;
        requestAnimationFrame(() => {
            if (pendingTodoSearchTarget !== scheduledTarget) {
                return;
            }
            scheduledTarget.focusScheduled = false;
            if (window.__projectStewardTodo
                && typeof window.__projectStewardTodo.openDetail === 'function'
                && window.__projectStewardTodo.openDetail(scheduledTarget.todoId)) {
                pendingTodoSearchTarget = null;
                return;
            }
            var todoItem = Array.from(panels.todo.querySelectorAll('.todo-item[data-todo-id]'))
                .find(item => item.getAttribute('data-todo-id') === scheduledTarget.todoId);
            var todoGroup = todoItem && todoItem.closest ? todoItem.closest('.todo-group') : null;
            if (!todoItem || (todoGroup && todoGroup.classList.contains('collapsed'))) {
                if (!scheduledTarget.revealRequested) {
                    scheduledTarget.revealRequested = true;
                    options.postMessage({
                        type: 'todo-reveal',
                        todoId: scheduledTarget.todoId,
                        groupId: scheduledTarget.groupId,
                    });
                }
                return;
            }
            if (!todoItem.isConnected) {
                return;
            }

            todoItem.setAttribute('tabindex', '-1');
            try {
                todoItem.scrollIntoView({ block: 'nearest' });
                todoItem.focus();
            } catch (_error) {
                todoItem.removeAttribute('tabindex');
                return;
            }
            if (!todoItem.isConnected || document.activeElement !== todoItem) {
                todoItem.removeAttribute('tabindex');
                return;
            }
            pendingTodoSearchTarget = null;
            todoItem.addEventListener('blur', () => todoItem.removeAttribute('tabindex'), { once: true });
        });
        return true;
    }

    function applyProjectsPanelMessage(message) {
        if (!validateProjectsPanelMessage(message)
            || projectsState !== 'loading'
            || message.requestId !== projectsRequestId
            || message.requestId <= acceptedProjectsRequestId
            || !panels.projects) {
            return false;
        }

        acceptedProjectsRequestId = message.requestId;
        if (projectsRequestTimer !== null) {
            cancelTimeout(projectsRequestTimer);
            projectsRequestTimer = null;
        }
        projectsRequestAttempts = 0;
        panels.projects.innerHTML = message.html;
        projectsState = 'mounted';
        if (typeof options.onProjectsMounted === 'function') {
            options.onProjectsMounted(panels.projects);
        }
        if (pendingScrollRestoreTab === 'projects') {
            pendingScrollRestoreTab = null;
            if (activeTab === 'projects' && !searchQuery) {
                restoreScroll('projects');
            }
        }
        return true;
    }

    function getProjectIdsFromGroup(group) {
        return Array.from(group.querySelectorAll('.project[data-id]:not([data-virtual-project])'))
            .map(project => project.getAttribute('data-id'));
    }

    function arraysEqual(left, right) {
        return left.length === right.length
            && left.every((value, index) => value === right[index]);
    }

    function isProjectsPanelOrderConsistent(message) {
        if (!panels.projects || typeof panels.projects.querySelectorAll !== 'function') {
            return false;
        }
        var groups = Array.from(panels.projects.querySelectorAll(
            '.groups-wrapper > .group[data-group-id]:not([data-virtual-group])'
        ));
        if (groups.length !== message.groupOrders.length) {
            return false;
        }
        for (var index = 0; index < groups.length; index += 1) {
            var expected = message.groupOrders[index];
            if (groups[index].getAttribute('data-group-id') !== expected.groupId
                || !arraysEqual(getProjectIdsFromGroup(groups[index]), expected.projectIds)) {
                return false;
            }
        }
        var favoritesGroup = panels.projects.querySelector(
            '.group[data-system-group="__favorites"]'
        );
        var favoriteIds = favoritesGroup
            ? Array.from(favoritesGroup.querySelectorAll('.project[data-id]'))
                .map(project => project.getAttribute('data-id'))
            : [];
        return arraysEqual(favoriteIds, message.favoriteProjectIds);
    }

    function getProjectsFocusTarget() {
        var activeElement = document.activeElement;
        if (!activeElement || !panels.projects || !panels.projects.contains(activeElement)) {
            return null;
        }
        var project = activeElement.closest ? activeElement.closest('.project[data-id]') : null;
        var action = activeElement.closest ? activeElement.closest('[data-action]') : null;
        return project ? {
            projectId: project.getAttribute('data-id'),
            action: action ? action.getAttribute('data-action') : null,
        } : null;
    }

    function restoreProjectsFocus(target) {
        if (!target || !panels.projects) {
            return;
        }
        var project = Array.from(panels.projects.querySelectorAll('.project[data-id]'))
            .find(candidate => candidate.getAttribute('data-id') === target.projectId);
        if (!project) {
            return;
        }
        var focusTarget = project;
        if (target.action) {
            focusTarget = Array.from(project.querySelectorAll('[data-action]'))
                .find(candidate => candidate.getAttribute('data-action') === target.action)
                || project;
        }
        if (focusTarget && typeof focusTarget.focus === 'function') {
            focusTarget.focus();
        }
    }

    function replaceProjectsPanelHtml(html) {
        var focusTarget = getProjectsFocusTarget();
        panels.projects.innerHTML = html;
        projectsState = 'mounted';
        if (typeof options.onProjectsMounted === 'function') {
            options.onProjectsMounted(panels.projects);
        }
        restoreProjectsFocus(focusTarget);
    }

    function applyProjectsPanelUpdatedMessage(message) {
        if (!validateProjectsPanelUpdatedMessage(message)
            || message.sequence <= acceptedProjectsUpdateSequence
            || !panels.projects) {
            return false;
        }
        acceptedProjectsUpdateSequence = message.sequence;
        replaceSearchCatalog(message.searchCatalog);
        if (projectsState !== 'mounted') {
            return true;
        }
        if (message.mode === 'preserve-order' && isProjectsPanelOrderConsistent(message)) {
            return true;
        }
        replaceProjectsPanelHtml(message.html);
        return true;
    }

    function applyTodoPanelMessage(message) {
        if (!validateTodoPanelMessage(message)
            || todoState !== 'loading'
            || message.requestId !== todoRequestId
            || message.requestId <= acceptedTodoRequestId
            || !panels.todo) {
            return false;
        }

        acceptedTodoRequestId = message.requestId;
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
            todoRequestTimer = null;
        }
        todoRequestAttempts = 0;
        panels.todo.innerHTML = message.html;
        todoState = 'mounted';
        if (normalizeDashboardSearchCatalog(message.searchCatalog) === message.searchCatalog) {
            replaceSearchCatalog(message.searchCatalog);
        }
        if (typeof options.onTodoMounted === 'function') {
            options.onTodoMounted(panels.todo, message);
        }
        if (pendingScrollRestoreTab === 'todo') {
            pendingScrollRestoreTab = null;
            if (activeTab === 'todo' && !searchQuery) {
                restoreScroll('todo');
            }
        }
        revealPendingTodoSearchTarget();
        return true;
    }

    function applyTodoPanelUpdatedMessage(message) {
        if (!validateTodoPanelUpdatedMessage(message) || !panels.todo) {
            return false;
        }

        var activeElement = document.activeElement;
        var restoreShowCompletedFocus = !!activeElement
            && panels.todo.contains(activeElement)
            && activeElement.getAttribute('data-action') === 'todo-toggle-show-completed';
        panels.todo.innerHTML = message.html;
        todoState = 'mounted';
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
            todoRequestTimer = null;
        }
        todoRequestAttempts = 0;
        replaceSearchCatalog(message.searchCatalog);
        if (typeof options.onTodoMounted === 'function') {
            options.onTodoMounted(panels.todo, message);
        }
        if (restoreShowCompletedFocus) {
            var showCompletedToggle = panels.todo.querySelector('[data-action="todo-toggle-show-completed"]');
            if (showCompletedToggle) {
                showCompletedToggle.focus();
            }
        }
        revealPendingTodoSearchTarget();
        return true;
    }

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            activateTab(button.getAttribute('data-dashboard-tab'));
        });
        button.addEventListener('keydown', event => {
            var tab = normalizeDashboardTab(button.getAttribute('data-dashboard-tab'));
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                var adjacentTab = getAdjacentDashboardTab(tab, event.key);
                var adjacentButton = tabButtons.find(candidate =>
                    normalizeDashboardTab(candidate.getAttribute('data-dashboard-tab')) === adjacentTab
                );
                if (adjacentButton) {
                    adjacentButton.focus();
                }
                return;
            }
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activateTab(tab);
            }
        });
    });

    window.addEventListener('message', event => {
        if (event && event.data && event.data.type === 'projects-panel-content') {
            applyProjectsPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'projects-panel-updated') {
            if (validateProjectsPanelUpdatedMessage(event.data)
                && event.data.sequence <= acceptedProjectsUpdateSequence) {
                return;
            }
            if (!applyProjectsPanelUpdatedMessage(event.data)) {
                options.postMessage({
                    type: 'request-full-refresh',
                    reason: 'invalid-projects-panel-update',
                });
            }
        }
        if (event && event.data && event.data.type === 'todo-panel-content') {
            applyTodoPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'todo-panel-updated') {
            applyTodoPanelUpdatedMessage(event.data);
        }
    });
    if (searchResults) {
        searchResults.addEventListener('click', onSearchResultClick);
    }
    renderActiveTab();
    if (searchQuery) {
        renderSearchMode();
    } else if (activeTab === 'projects') {
        pendingScrollRestoreTab = 'projects';
        ensureProjectsPanel();
    } else if (activeTab === 'todo') {
        pendingScrollRestoreTab = 'todo';
        ensureTodoPanel();
    }
    document.body.classList.remove('preload');
    notifyActiveTabChanged();

    return {
        activateTab,
        applyProjectsPanelMessage,
        applyProjectsPanelUpdatedMessage,
        applyTodoPanelMessage,
        applyTodoPanelUpdatedMessage,
        ensureProjectsPanel,
        ensureTodoPanel,
        getActiveTab: () => activeTab,
        getProjectsState: () => projectsState,
        getTodoState: () => todoState,
        getScrollPosition: tab => scrollPositions[normalizeDashboardTab(tab)],
        isSearchActive: () => searchQuery.length > 0,
        replaceSearchCatalog,
        setSearchQuery,
    };
}
