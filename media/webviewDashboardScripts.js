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
    return value
        && Array.isArray(value.sessions)
        && Array.isArray(value.openProjects)
        && Array.isArray(value.savedProjects)
        && Array.isArray(value.todos)
        ? value
        : { sessions: [], openProjects: [], savedProjects: [], todos: [] };
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
        { id: 'open-projects', title: 'OPEN PROJECTS', type: 'open-project', items: catalog.openProjects },
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
                button.dataset.searchAction = 'resume-session';
                button.dataset.provider = String(item.provider || '');
                button.dataset.sessionId = String(item.sessionId || '');
                metadata.textContent = [item.projectName, item.provider].filter(Boolean).join(' · ');
            } else if (section.type === 'open-project') {
                button.dataset.searchAction = item.action === 'open-current'
                    ? 'show-current-project'
                    : 'switch-open-project';
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
            if (section.type === 'todo' && item.notesSearchText) {
                var notes = document.createElement('span');
                notes.className = 'dashboard-search-result-notes';
                notes.textContent = String(item.notesSearchText);
                button.appendChild(notes);
            }
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
    var todoState = 'unloaded';
    var todoRequestId = 0;
    var acceptedTodoRequestId = 0;
    var pendingTodoSearchTarget = null;
    var pendingScrollRestoreTab = null;
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

    function ensureProjectsPanel() {
        if (projectsState !== 'unloaded') {
            return;
        }
        projectsState = 'loading';
        projectsRequestId += 1;
        var loadingElement = panels.projects && panels.projects.querySelector
            ? panels.projects.querySelector('.dashboard-projects-loading')
            : null;
        if (loadingElement) {
            loadingElement.hidden = false;
        }
        options.postMessage({
            type: 'request-projects-panel',
            version: 1,
            requestId: projectsRequestId,
        });
    }

    function ensureTodoPanel() {
        if (todoState !== 'unloaded') {
            return;
        }
        todoState = 'loading';
        todoRequestId += 1;
        var loadingElement = panels.todo && panels.todo.querySelector
            ? panels.todo.querySelector('.dashboard-todo-loading')
            : null;
        if (loadingElement) {
            loadingElement.hidden = false;
        }
        options.postMessage({
            type: 'request-todo-panel',
            version: 1,
            requestId: todoRequestId,
        });
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
        if (action === 'show-current-project') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__projectStewardShowCurrentProject === 'function') {
                window.__projectStewardShowCurrentProject(button.dataset.projectId);
            }
            return;
        }
        if (action === 'switch-open-project' || action === 'open-saved-project') {
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

    function applyTodoPanelMessage(message) {
        if (!validateTodoPanelMessage(message)
            || todoState !== 'loading'
            || message.requestId !== todoRequestId
            || message.requestId <= acceptedTodoRequestId
            || !panels.todo) {
            return false;
        }

        acceptedTodoRequestId = message.requestId;
        panels.todo.innerHTML = message.html;
        todoState = 'mounted';
        if (typeof options.onTodoMounted === 'function') {
            options.onTodoMounted(panels.todo);
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

        panels.todo.innerHTML = message.html;
        todoState = 'mounted';
        replaceSearchCatalog(message.searchCatalog);
        if (typeof options.onTodoMounted === 'function') {
            options.onTodoMounted(panels.todo);
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
