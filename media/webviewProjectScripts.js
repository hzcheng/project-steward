function normalizeAiSessionTab(value) {
    return value === 'active' ? 'active' : 'sessions';
}

function getAdjacentAiSessionTab(tab, key) {
    tab = normalizeAiSessionTab(tab);
    if (key === 'ArrowLeft' || key === 'ArrowRight') return tab === 'active' ? 'sessions' : 'active';
    if (key === 'Home') return 'active';
    if (key === 'End') return 'sessions';
    return tab;
}

function readAiSessionTabState(vscodeApi) {
    var state = vscodeApi && typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    return state.aiSessionTabs && typeof state.aiSessionTabs === 'object' && !Array.isArray(state.aiSessionTabs)
        ? Object.assign({}, state.aiSessionTabs)
        : {};
}

function writeAiSessionTabState(vscodeApi, projectId, tab) {
    if (!vscodeApi || typeof vscodeApi.setState !== 'function' || !projectId) return;
    var state = typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    var tabs = readAiSessionTabState(vscodeApi);
    tabs[projectId] = normalizeAiSessionTab(tab);
    vscodeApi.setState(Object.assign({}, state, { aiSessionTabs: tabs }));
}

function selectAiSessionTabDom(projectDiv, tab) {
    if (!projectDiv || typeof projectDiv.querySelectorAll !== 'function') return null;
    tab = normalizeAiSessionTab(tab);
    var sessionSection = projectDiv.querySelector('.codex-sessions');
    if (sessionSection && typeof sessionSection.setAttribute === 'function') {
        sessionSection.setAttribute('data-selected-ai-session-tab', tab);
    }
    var selectedTab = null;
    projectDiv.querySelectorAll('[data-ai-session-tab]').forEach(tabElement => {
        var selected = tabElement.getAttribute('data-ai-session-tab') === tab;
        tabElement.setAttribute('aria-selected', selected ? 'true' : 'false');
        tabElement.setAttribute('tabindex', selected ? '0' : '-1');
        if (selected) selectedTab = tabElement;
    });
    projectDiv.querySelectorAll('[data-ai-session-panel]').forEach(panel => {
        var selected = panel.getAttribute('data-ai-session-panel') === tab;
        panel.toggleAttribute('hidden', !selected);
    });
    return selectedTab;
}

function restoreAiSessionTabsFromState(root, vscodeApi) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    var tabs = readAiSessionTabState(vscodeApi);
    root.querySelectorAll('.workspace-card[data-current-workspace][data-id]').forEach(projectDiv => {
        var projectId = projectDiv.getAttribute('data-id');
        if (Object.prototype.hasOwnProperty.call(tabs, projectId)) {
            selectAiSessionTabDom(projectDiv, tabs[projectId]);
        }
    });
}

function getSelectedAiSessionTab(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') return null;
    var selected = projectDiv.querySelector('[data-ai-session-tab][aria-selected="true"]');
    return selected ? normalizeAiSessionTab(selected.getAttribute('data-ai-session-tab')) : null;
}

function captureAiSessionViewState(projectDiv) {
    var activeList = projectDiv.querySelector('.ai-session-active-panel .codex-sessions-list');
    var historyList = projectDiv.querySelector('.ai-session-history-panel .codex-sessions-list');
    var focused = typeof document !== 'undefined' ? document.activeElement : null;
    var focusedInside = focused && typeof focused.closest === 'function' && focused.closest('.project[data-id]') === projectDiv;
    var focusedRow = focusedInside ? focused.closest('.codex-session-row') : null;
    var focusedTab = focusedInside ? focused.closest('[data-ai-session-tab]') : null;
    return {
        selectedTab: getSelectedAiSessionTab(projectDiv),
        activeScrollTop: activeList && typeof activeList.scrollTop === 'number' ? activeList.scrollTop : 0,
        historyScrollTop: historyList && typeof historyList.scrollTop === 'number' ? historyList.scrollTop : 0,
        pendingCount: projectDiv.querySelectorAll('.active-ai-session-row[data-session-pending]').length,
        activeCount: projectDiv.querySelectorAll('.active-ai-session-row[data-session-active]').length,
        restoreFocus: !!focusedInside,
        focusedTab: focusedTab && focusedTab.getAttribute('data-ai-session-tab'),
        focusedRow: focusedRow ? {
            provider: focusedRow.getAttribute('data-session-provider') || '',
            sessionId: focusedRow.getAttribute('data-session-id') || '',
            pendingCreatedAt: focusedRow.getAttribute('data-pending-created-at') || '',
            panel: focusedRow.closest('[data-ai-session-panel]')?.getAttribute('data-ai-session-panel') || '',
        } : null,
    };
}

function restoreAiSessionViewState(projectDiv, viewState, requestedTab) {
    var activeList = projectDiv.querySelector('.ai-session-active-panel .codex-sessions-list');
    var historyList = projectDiv.querySelector('.ai-session-history-panel .codex-sessions-list');
    selectAiSessionTabDom(projectDiv, 'active');
    restoreAiSessionListScroll(activeList, viewState.activeScrollTop);
    selectAiSessionTabDom(projectDiv, 'sessions');
    restoreAiSessionListScroll(historyList, viewState.historyScrollTop);
    var selectedTab = selectAiSessionTabDom(projectDiv, requestedTab);
    if (!viewState.restoreFocus) return;

    if (viewState.focusedTab) {
        var tabToFocus = Array.from(projectDiv.querySelectorAll('[data-ai-session-tab]'))
            .find(tab => tab.getAttribute('data-ai-session-tab') === viewState.focusedTab);
        (tabToFocus || selectedTab)?.focus();
        return;
    }

    if (!viewState.focusedRow) return;
    var rows = Array.from(projectDiv.querySelectorAll('.codex-session-row'));
    var match = rows.find(row => {
        var panel = row.closest('[data-ai-session-panel]');
        return (row.getAttribute('data-session-provider') || '') === viewState.focusedRow.provider
            && (row.getAttribute('data-session-id') || '') === viewState.focusedRow.sessionId
            && (row.getAttribute('data-pending-created-at') || '') === viewState.focusedRow.pendingCreatedAt
            && (!viewState.focusedRow.panel || panel?.getAttribute('data-ai-session-panel') === viewState.focusedRow.panel);
    });
    var selectedPanel = projectDiv.querySelector('[data-ai-session-panel="' + normalizeAiSessionTab(requestedTab) + '"]');
    var rowToFocus = match || selectedPanel?.querySelector('.codex-session-row');
    (rowToFocus?.querySelector('.ai-session-primary-action') || selectedTab)?.focus();
}

function restoreAiSessionListScroll(list, requestedScrollTop) {
    if (!list) return;
    var scrollTop = Number.isFinite(requestedScrollTop) ? Math.max(0, requestedScrollTop) : 0;
    var maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.min(scrollTop, maxScrollTop);
}

function getWorkspaceUpdateDomState(root) {
    var currentGroup = root.matches?.('.open-current-workspace-group')
        ? root
        : root.querySelector('.open-current-workspace-group');
    return {
        currentWorkspaceCount: currentGroup
            ? currentGroup.querySelectorAll('.workspace-card[data-workspace-scope-identity]').length
            : 0,
    };
}

function isWorkspaceUpdateDomConsistent(message, root) {
    if (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1) {
        return false;
    }
    return getWorkspaceUpdateDomState(root).currentWorkspaceCount === message.currentWorkspaceCount;
}

function applyWorkspaceUpdate(message) {
    if (!message
        || message.type !== 'workspace-updated'
        || message.version !== 2
        || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
        || typeof message.html !== 'string') {
        return false;
    }

    var wrapper = document.querySelector('.sticky-groups-wrapper');
    var currentGroup = wrapper && wrapper.querySelector('.open-current-workspace-group');
    if (!wrapper || !currentGroup || typeof document.createElement !== 'function') {
        return false;
    }
    var currentCards = Array.from(wrapper.querySelectorAll('.workspace-card[data-current-workspace][data-workspace-scope-identity]'));
    if (currentCards.some(card => !currentGroup.contains(card))) {
        return false;
    }

    var holder = document.createElement('div');
    holder.innerHTML = message.html.trim();
    var replacement = holder.firstElementChild;
    if (!replacement
        || holder.children.length !== 1
        || !replacement.matches('.open-current-workspace-group')
        || !isWorkspaceUpdateDomConsistent(message, replacement)) {
        return false;
    }

    currentGroup.replaceWith(replacement);
    if (typeof restoreAiSessionTabsFromState === 'function') {
        restoreAiSessionTabsFromState(replacement, window.vscode);
    }
    if (typeof window.__projectStewardSyncCollapseButton === 'function') {
        window.__projectStewardSyncCollapseButton();
    }
    if (typeof window.__projectStewardRevealPendingWorkspaceSession === 'function') {
        window.__projectStewardRevealPendingWorkspaceSession();
    }
    return true;
}

var lastAppliedOpenWorkspacesSemanticRevision = null;

function applyOpenWorkspacesUpdate(message) {
    if (!message
        || message.type !== 'open-workspaces-updated'
        || message.version !== 2
        || typeof message.semanticRevision !== 'string'
        || !message.semanticRevision
        || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
        || !Number.isSafeInteger(message.navigationWorkspaceCount)
        || message.navigationWorkspaceCount < 0
        || (message.otherWindowsStatus !== 'ready'
            && message.otherWindowsStatus !== 'unavailable'
            && message.otherWindowsStatus !== 'update-required')
        || typeof message.html !== 'string'
        || typeof normalizeDashboardSearchCatalog !== 'function'
        || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
        || message.searchCatalog.version !== 2) {
        return false;
    }
    if (message.semanticRevision === lastAppliedOpenWorkspacesSemanticRevision) {
        return true;
    }
    var wrapper = document.querySelector('.sticky-groups-wrapper');
    if (!wrapper) return false;
    var previousHtml = wrapper.innerHTML;
    wrapper.innerHTML = message.html;
    if (!isOpenWorkspacesUpdateDomConsistent(message)) {
        wrapper.innerHTML = previousHtml;
        return false;
    }
    if (window.__projectStewardDashboard) {
        window.__projectStewardDashboard.replaceSearchCatalog(message.searchCatalog);
    }
    if (typeof restoreAiSessionTabsFromState === 'function') {
        restoreAiSessionTabsFromState(document, window.vscode);
    }
    if (typeof window.__projectStewardSyncCollapseButton === 'function') {
        window.__projectStewardSyncCollapseButton();
    }
    lastAppliedOpenWorkspacesSemanticRevision = message.semanticRevision;
    return true;
}

function getOpenWorkspacesUpdateDomState() {
    var otherWindowsGroup = document.querySelector(
        '.sticky-groups-wrapper .open-other-windows-group[data-other-windows-status]'
    );
    return {
        currentWorkspaceCount: document.querySelectorAll(
            '.sticky-groups-wrapper .workspace-card[data-current-workspace][data-workspace-scope-identity]'
        ).length,
        navigationWorkspaceCount: document.querySelectorAll(
            '.sticky-groups-wrapper .workspace-card[data-other-workspace][data-workspace-navigation-identity]'
        ).length,
        hasOtherWindowsGroup: document.querySelectorAll(
            '.sticky-groups-wrapper .open-other-windows-group'
        ).length > 0,
        otherWindowsStatus: otherWindowsGroup
            ? otherWindowsGroup.getAttribute('data-other-windows-status')
            : 'ready',
    };
}

function isOpenWorkspacesUpdateDomConsistent(message) {
    var rendered = getOpenWorkspacesUpdateDomState();
    return rendered.currentWorkspaceCount === message.currentWorkspaceCount
        && rendered.navigationWorkspaceCount === message.navigationWorkspaceCount
        && rendered.otherWindowsStatus === message.otherWindowsStatus
        && ((message.navigationWorkspaceCount === 0 && message.otherWindowsStatus === 'ready')
            ? !rendered.hasOtherWindowsGroup
            : rendered.hasOtherWindowsGroup)
        && message.searchCatalog.openWorkspaces.length
            === message.currentWorkspaceCount + message.navigationWorkspaceCount;
}

function getCollapseButtonState(tab, collapsedStates) {
    tab = tab === 'projects' || tab === 'todo' ? tab : 'open';
    var labels = tab === 'todo'
        ? {
            empty: 'No TODO groups to collapse',
            collapse: 'Collapse TODO Groups',
            expand: 'Expand TODO Groups',
        }
        : tab === 'open'
            ? {
                empty: 'No other windows to collapse',
                collapse: 'Collapse Other Windows',
                expand: 'Expand Other Windows',
            }
            : {
                empty: 'No project groups to collapse',
                collapse: 'Collapse All Groups',
                expand: 'Expand All Groups',
            };
    if (!collapsedStates.length) {
        return {
            disabled: true,
            collapsed: false,
            title: labels.empty,
        };
    }

    var collapsed = collapsedStates.every(Boolean);
    return {
        disabled: false,
        collapsed,
        title: collapsed ? labels.expand : labels.collapse,
    };
}

function syncTodoGroupCollapseControl(group) {
    if (!group || typeof group.querySelector !== 'function') {
        return;
    }
    var control = group.querySelector('[data-action="todo-collapse-group"]');
    if (!control) {
        return;
    }
    var collapsed = group.classList.contains('collapsed');
    var action = collapsed ? 'Expand' : 'Collapse';
    var heading = group.querySelector('h2');
    var groupTitle = heading ? String(heading.textContent || '').trim() : '';
    control.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    control.setAttribute('title', action + ' todo group');
    control.setAttribute('aria-label', action + (groupTitle ? ' ' + groupTitle : ' todo group'));
}

function syncTodoExpandControl(item, expanded) {
    if (!item || typeof item.querySelector !== 'function') {
        return;
    }
    var control = item.querySelector('[data-action="todo-toggle-expanded"]');
    if (!control) {
        return;
    }
    var action = expanded ? 'Collapse' : 'Expand';
    var titleElement = item.querySelector('.todo-title-text');
    var todoTitle = titleElement ? String(titleElement.textContent || '').trim() : '';
    control.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    control.setAttribute('title', action + ' todo');
    control.setAttribute('aria-label', action + (todoTitle ? ' ' + todoTitle : ' todo'));
}

function collapseTodoGroups(groups, collapsed, postMessage) {
    groups.forEach(group => {
        group.classList.toggle('collapsed', collapsed);
        syncTodoGroupCollapseControl(group);
    });
    postMessage({
        type: 'todo-collapse-groups',
        collapsed,
    });
}

var nextTodoMutationRequestId = 0;

function getTodoFormValue(form, name) {
    var checkedElement = form.querySelector('[name="' + name + '"]:checked');
    if (checkedElement) {
        return String(checkedElement.value || '').trim();
    }
    var element = form.querySelector('[name="' + name + '"]');
    return element ? String(element.value || '').trim() : '';
}

function setTodoComposePending(form, pending) {
    form.setAttribute('data-todo-pending', pending ? 'true' : 'false');
    var submitButton = form.querySelector('[type="submit"]');
    if (!submitButton)
        return;

    submitButton.disabled = pending;
    if (pending) {
        submitButton.setAttribute('aria-busy', 'true');
    } else {
        submitButton.removeAttribute('aria-busy');
    }
}

function submitTodoComposeForm(form, postMessage) {
    if (form.getAttribute('data-todo-pending') === 'true')
        return false;

    var title = getTodoFormValue(form, 'title');
    if (!title)
        return false;

    nextTodoMutationRequestId += 1;
    var requestId = nextTodoMutationRequestId;
    form.setAttribute('data-todo-request-id', String(requestId));
    setTodoComposePending(form, true);
    postMessage({
        type: 'todo-add',
        requestId,
        title,
        notes: getTodoFormValue(form, 'notes'),
        priority: getTodoFormValue(form, 'priority'),
        groupId: getTodoFormValue(form, 'groupId'),
    });
    return true;
}

function applyTodoMutationResult(message, root) {
    if (!message
        || message.type !== 'todo-mutation-result'
        || message.version !== 1
        || !Number.isSafeInteger(message.requestId)
        || message.requestId < 1
        || typeof message.success !== 'boolean') {
        return false;
    }

    var form = root.querySelector('.todo-add-form[data-todo-request-id="' + message.requestId + '"]');
    if (!form)
        return false;
    if (!message.success) {
        setTodoComposePending(form, false);
        form.removeAttribute('data-todo-request-id');
    } else if (message.panelRefreshed === false) {
        form.reset();
        setTodoComposePending(form, false);
        form.removeAttribute('data-todo-request-id');
    }
    return true;
}

function initProjects() {

    const ProjectOpenType = {
        Default: 0,
        NewWindow: 1,
        AddToWorkspace: 2,
        CurrentWindow: 3,
    };

    var batchAiSessionState = {
        projectId: null,
        provider: null,
        selectedIds: new Set(),
        pending: false,
    };
    var activeAiSessionTerminalState = { provider: null, sessionId: null };
    var pendingWorkspaceSessionReveal = null;

    function enter(projectId, provider) {
        if (batchAiSessionState.pending)
            return;
        batchAiSessionState.projectId = projectId;
        batchAiSessionState.provider = provider;
        batchAiSessionState.selectedIds = new Set();
        batchAiSessionState.pending = false;
    }

    function toggle(sessionId) {
        if (!sessionId || batchAiSessionState.pending)
            return;
        if (batchAiSessionState.selectedIds.has(sessionId))
            batchAiSessionState.selectedIds.delete(sessionId);
        else
            batchAiSessionState.selectedIds.add(sessionId);
    }

    function selectUnpinned(sessions) {
        if (batchAiSessionState.pending)
            return;
        sessions.filter(session => !session.pinned && !session.active).forEach(session =>
            batchAiSessionState.selectedIds.add(session.id)
        );
    }

    function clear() {
        if (!batchAiSessionState.pending)
            batchAiSessionState.selectedIds.clear();
    }

    function reconcile(projectId, provider, remainingIds) {
        if (projectId !== batchAiSessionState.projectId || provider !== batchAiSessionState.provider) {
            exit();
            return;
        }
        let selectedIds = batchAiSessionState.selectedIds;
        batchAiSessionState.selectedIds = new Set(
            remainingIds.filter(sessionId => selectedIds.has(sessionId))
        );
    }

    function submit() {
        if (batchAiSessionState.pending || !batchAiSessionState.selectedIds.size)
            return;
        batchAiSessionState.pending = true;
        window.vscode.postMessage({
            type: 'archive-ai-sessions',
            projectId: batchAiSessionState.projectId,
            provider: batchAiSessionState.provider,
            sessionIds: Array.from(batchAiSessionState.selectedIds),
        });
    }

    function complete(status) {
        if (status === 'finished') {
            exit();
            return;
        }
        batchAiSessionState.pending = false;
    }

    function exit() {
        batchAiSessionState.projectId = null;
        batchAiSessionState.provider = null;
        batchAiSessionState.selectedIds = new Set();
        batchAiSessionState.pending = false;
    }

    function snapshot() {
        return {
            projectId: batchAiSessionState.projectId,
            provider: batchAiSessionState.provider,
            selectedIds: Array.from(batchAiSessionState.selectedIds),
            pending: batchAiSessionState.pending,
        };
    }

    var batchAiSessionManager = {
        enter, toggle, selectUnpinned, clear, reconcile, submit, complete, exit, snapshot,
    };
    window.__projectStewardBatchAiSessions = batchAiSessionManager;

    function openProject(projectId, projectOpenType) {
        window.vscode.postMessage({
            type: 'selected-project',
            projectId,
            projectOpenType,
        });
    }

    function onAddProjectClicked(e) {
        if (!e.target)
            return;

        var projectDiv = e.target.closest('.project');
        if (!projectDiv)
            return;

        var groupId = projectDiv.getAttribute("data-group-id");

        window.vscode.postMessage({
            type: 'add-project',
            groupId,
        });
    }

    function onImportFromOtherStorageClicked(e) {
        if (!e.target)
            return;

        window.vscode.postMessage({
            type: 'import-from-other-storage',
        });
    }

    function onInsideProjectClick(e, projectDiv) {
        projectDiv = projectDiv || e.target.closest(".project");
        var dataId = projectDiv && projectDiv.getAttribute("data-id");
        if (dataId == null)
            return;

        if (onTriggerAiSessionAction(e.target, dataId))
            return;

        if (onTriggerProjectAction(e.target, dataId))
            return;

        if (projectDiv.hasAttribute("data-current-workspace")) {
            toggleCodexSessions(projectDiv, dataId);
            return;
        }

        if (projectDiv.hasAttribute("data-workspace-navigation")) {
            openProject(dataId, ProjectOpenType.Default);
            return;
        }

        var currentWindow = e.ctrlKey || e.metaKey;
        var newWindow = e.button === 1;
        openProject(dataId, currentWindow ? ProjectOpenType.CurrentWindow : newWindow ? ProjectOpenType.NewWindow : ProjectOpenType.Default);

    }

    function onTriggerAiSessionAction(target, projectId) {
        var projectDiv = target.closest('.project[data-id]');
        if (target.closest('[data-action="open-new-session-in"]')) {
            return true;
        }
        var tabAction = target.closest('[data-action="select-ai-session-tab"][data-tab]');
        if (tabAction) {
            var selectedTab = normalizeAiSessionTab(tabAction.getAttribute('data-tab'));
            selectAiSessionTabDom(projectDiv, selectedTab);
            writeAiSessionTabState(window.vscode, projectId, selectedTab);
            return true;
        }

        var providerAction = target.closest('[data-action="select-ai-provider"]');
        if (providerAction) {
            if (providerAction.tagName !== "SELECT") {
                selectAiSessionProvider(projectId, providerAction.getAttribute("data-provider"));
            }

            return true;
        }

        var createAction = target.closest('[data-action="create-ai-session"]');
        if (createAction) {
            window.vscode.postMessage({
                type: 'create-ai-session',
                projectId,
            });

            return true;
        }

        var newSessionInAction = target.closest('[data-action="new-session-in"][data-root-id]');
        if (newSessionInAction) {
            var rootId = newSessionInAction.getAttribute('data-root-id');
            if (rootId) {
                window.vscode.postMessage({
                    type: 'new-session-in',
                    projectId,
                    rootId,
                });
                newSessionInAction.closest('details')?.removeAttribute('open');
            }
            return true;
        }

        var manageAction = target.closest('[data-action="manage-ai-sessions"][data-provider]');
        if (manageAction) {
            if (batchAiSessionState.pending)
                return true;

            var manageProvider = manageAction.getAttribute("data-provider");
            if (projectDiv && isAiSessionProvider(manageProvider)) {
                if (isActiveAiSessionBatchScope(projectId, manageProvider)) {
                    exitAiSessionBatchManagement();
                } else {
                    batchAiSessionManager.enter(projectId, manageProvider);
                    syncAiSessionBatchManagementDom(projectDiv);
                }
            }

            return true;
        }

        var selectUnpinnedAction = target.closest('[data-action="select-unpinned-ai-sessions"]');
        if (selectUnpinnedAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                var sessions = Array.from(projectDiv.querySelectorAll('.ai-session-history-panel .codex-session-row[data-session-id]'))
                    .filter(row => (row.getAttribute("data-session-provider") || "codex") === batchAiSessionState.provider)
                    .map(row => ({
                        id: row.getAttribute("data-session-id"),
                        pinned: row.hasAttribute("data-session-pinned"),
                        active: row.hasAttribute("data-session-active"),
                    }));
                batchAiSessionManager.selectUnpinned(sessions);
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var clearSelectionAction = target.closest('[data-action="clear-ai-session-selection"]');
        if (clearSelectionAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                batchAiSessionManager.clear();
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var archiveSelectedAction = target.closest('[data-action="archive-selected-ai-sessions"]');
        if (archiveSelectedAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                batchAiSessionManager.submit();
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var terminalAction = target.closest('[data-action="close-ai-session-terminal"], [data-action="detach-ai-session-terminal"]');
        if (terminalAction) {
            var terminalRow = terminalAction.closest('.codex-session-row[data-session-provider][data-session-backend]');
            var terminalProvider = terminalRow && terminalRow.getAttribute('data-session-provider');
            var terminalBackend = terminalRow && terminalRow.getAttribute('data-session-backend');
            var requestedDetach = terminalAction.getAttribute('data-action') === 'detach-ai-session-terminal';
            if (terminalRow && isAiSessionProvider(terminalProvider)
                && ((requestedDetach && terminalBackend === 'tmux')
                    || (!requestedDetach && terminalBackend === 'vscode'))) {
                var terminalMessage = {
                    type: requestedDetach ? 'detach-ai-session-terminal' : 'close-ai-session-terminal',
                    projectId,
                    provider: terminalProvider,
                };
                if (terminalRow.hasAttribute('data-session-pending')) {
                    terminalMessage.pendingCreatedAt = terminalRow.getAttribute('data-pending-created-at');
                } else {
                    terminalMessage.sessionId = terminalRow.getAttribute('data-session-id');
                }
                window.vscode.postMessage(terminalMessage);
            }
            return true;
        }

        var managedSessionRow = target.closest('.codex-session-row[data-session-id]');
        if (managedSessionRow) {
            var managedSessionProvider = managedSessionRow.getAttribute("data-session-provider") || "codex";
            if (isActiveAiSessionBatchScope(projectId, managedSessionProvider)
                && !managedSessionRow.hasAttribute('data-session-active')) {
                batchAiSessionManager.toggle(managedSessionRow.getAttribute("data-session-id"));
                syncAiSessionBatchManagementDom(projectDiv);
                return true;
            }
        }

        var pinAction = target.closest('[data-action="toggle-ai-session-pin"]');
        if (pinAction) {
            var pinRow = pinAction.closest('.codex-session-row[data-session-id]');
            var pinSessionId = pinRow && pinRow.getAttribute("data-session-id");
            var pinProvider = pinRow && pinRow.getAttribute("data-session-provider") || "codex";
            if (pinSessionId) {
                window.vscode.postMessage({
                    type: 'toggle-ai-session-pin',
                    projectId,
                    provider: pinProvider,
                    sessionId: pinSessionId,
                });
            }

            return true;
        }

        var archiveAction = target.closest('[data-action="archive-codex-session"], [data-action="archive-kimi-session"], [data-action="archive-claude-session"]');
        if (archiveAction) {
            var archiveRow = archiveAction.closest('.codex-session-row[data-session-id]');
            var archiveSessionId = archiveRow && archiveRow.getAttribute("data-session-id");
            var archiveProvider = archiveRow && archiveRow.getAttribute("data-session-provider") || "codex";
            if (archiveSessionId && isAiSessionProvider(archiveProvider)) {
                acknowledgeAiSessionRow(archiveRow);
                window.vscode.postMessage({
                    type: getArchiveAiSessionMessageType(archiveProvider),
                    projectId,
                    sessionId: archiveSessionId,
                });
            }

            return true;
        }

        var primarySessionAction = target.closest('[data-action="activate-ai-session"]');
        var pendingSessionRow = primarySessionAction
            ? primarySessionAction.closest('.codex-session-row[data-session-pending]') : null;
        if (pendingSessionRow) {
            var pendingProvider = pendingSessionRow.getAttribute('data-session-provider');
            var pendingCreatedAt = pendingSessionRow.getAttribute('data-pending-created-at');
            if (isAiSessionProvider(pendingProvider) && pendingCreatedAt) {
                window.vscode.postMessage({
                    type: 'focus-pending-ai-session',
                    projectId,
                    provider: pendingProvider,
                    createdAt: pendingCreatedAt,
                });
            }
            return true;
        }

        var sessionRow = primarySessionAction
            ? primarySessionAction.closest('.codex-session-row[data-session-id]') : null;
        if (!sessionRow)
            return !!target.closest('.codex-session-row');

        var sessionId = sessionRow.getAttribute("data-session-id");
        if (!sessionId)
            return true;
        var sessionProvider = sessionRow.getAttribute("data-session-provider") || "codex";

        acknowledgeAiSessionRow(sessionRow);

        if (isAiSessionProvider(sessionProvider)) {
            if (sessionRow.hasAttribute('data-session-active')) {
                window.vscode.postMessage({
                    type: 'focus-ai-session-terminal',
                    projectId,
                    provider: sessionProvider,
                    sessionId,
                });
            } else {
                window.vscode.postMessage({
                    type: getResumeAiSessionMessageType(sessionProvider),
                    projectId,
                    sessionId,
                });
            }
        }

        return true;
    }

    function acknowledgeAiSessionRow(sessionRow) {
        if (!sessionRow || !sessionRow.hasAttribute('data-ai-session-attention')) return;
        var provider = sessionRow.getAttribute('data-session-provider') || 'codex';
        var sessionId = sessionRow.getAttribute('data-session-id') || '';
        var fallback = sessionRow.getAttribute('data-session-event-id') || sessionRow.getAttribute('data-ai-session-event-id');
        acknowledgeAiSession(provider, sessionId, fallback);
    }

    function acknowledgeAiSession(provider, sessionId, fallbackEventId) {
        var sessionKey = provider + ':' + sessionId;
        window.__projectStewardAttentionSessionEvents = window.__projectStewardAttentionSessionEvents || {};
        var eventIds = window.__projectStewardAttentionSessionEvents[sessionKey] || [];
        if (!eventIds.length && fallbackEventId) {
            eventIds = [fallbackEventId];
        }
        eventIds = Array.from(new Set(eventIds.filter(eventId => typeof eventId === 'string' && !!eventId)));
        if (eventIds.length) {
            window.vscode.postMessage({ type: 'acknowledge-ai-session-attention', eventIds: eventIds });
        }
    }

    window.__projectStewardAcknowledgeSession = (provider, sessionId) => {
        if (isAiSessionProvider(provider) && sessionId) {
            acknowledgeAiSession(provider, sessionId);
        }
    };

    function selectAiSessionProvider(projectId, provider) {
        if (!projectId || !isAiSessionProvider(provider))
            return;

        exitAiSessionBatchManagement();
        window.vscode.postMessage({
            type: 'select-ai-session-provider',
            projectId,
            provider,
        });
    }

    function isAiSessionProvider(provider) {
        return provider === "codex" || provider === "kimi" || provider === "claude";
    }

    function getResumeAiSessionMessageType(provider) {
        if (provider === "kimi")
            return 'resume-kimi-session';
        if (provider === "claude")
            return 'resume-claude-session';

        return 'resume-codex-session';
    }

    function getArchiveAiSessionMessageType(provider) {
        if (provider === "kimi")
            return 'archive-kimi-session';
        if (provider === "claude")
            return 'archive-claude-session';

        return 'archive-codex-session';
    }

    function toggleCodexSessions(projectDiv, projectId) {
        var expanded = !projectDiv.hasAttribute("data-codex-expanded");
        if (!expanded && batchAiSessionState.projectId === projectId) {
            exitAiSessionBatchManagement();
        }
        projectDiv.toggleAttribute("data-codex-expanded", expanded);
        updateStickyGroupHeaderOffset();

        window.vscode.postMessage({
            type: 'toggle-codex-sessions',
            projectId,
            expanded,
        });
    }

    function isActiveAiSessionBatchScope(projectId, provider) {
        return projectId === batchAiSessionState.projectId && provider === batchAiSessionState.provider;
    }

    function getProjectActiveAiSessionProvider(projectDiv) {
        if (!projectDiv)
            return null;

        var providerSelect = projectDiv.querySelector('select[data-action="select-ai-provider"]');
        return providerSelect && providerSelect.value;
    }

    function syncActiveAiSessionTerminalDom() {
        document.querySelectorAll('.codex-session-row[data-session-id]').forEach(row => {
            var provider = row.getAttribute('data-session-provider') || 'codex';
            var sessionId = row.getAttribute('data-session-id');
            row.toggleAttribute(
                'data-ai-session-active-terminal',
                provider === activeAiSessionTerminalState.provider
                    && sessionId === activeAiSessionTerminalState.sessionId
            );
        });
    }

    function syncAiSessionBatchManagementDom(projectDiv) {
        var snapshot = batchAiSessionManager.snapshot();
        document.querySelectorAll('.project[data-ai-session-managing], .project[data-ai-session-pending]').forEach(project => {
            if (project !== projectDiv || project.getAttribute("data-id") !== snapshot.projectId) {
                project.removeAttribute("data-ai-session-managing");
                project.removeAttribute("data-ai-session-pending");
                var inactiveManageButton = project.querySelector('[data-action="manage-ai-sessions"]');
                if (inactiveManageButton) {
                    inactiveManageButton.setAttribute('aria-pressed', 'false');
                    inactiveManageButton.disabled = false;
                }
            }
        });

        if (!projectDiv)
            return;

        var projectId = projectDiv.getAttribute("data-id");
        var activeProvider = getProjectActiveAiSessionProvider(projectDiv);
        var isScoped = projectId === snapshot.projectId && activeProvider === snapshot.provider;
        projectDiv.toggleAttribute("data-ai-session-managing", isScoped);
        projectDiv.toggleAttribute("data-ai-session-pending", isScoped && snapshot.pending);
        var manageButton = projectDiv.querySelector('[data-action="manage-ai-sessions"]');
        if (manageButton) {
            manageButton.setAttribute('aria-pressed', isScoped ? 'true' : 'false');
            manageButton.disabled = isScoped && snapshot.pending;
        }

        var selectedIds = new Set(snapshot.selectedIds);
        projectDiv.querySelectorAll('.ai-session-history-panel .codex-session-row[data-session-id]').forEach(row => {
            var rowProvider = row.getAttribute("data-session-provider") || "codex";
            var isActive = row.hasAttribute('data-session-active');
            var isSelected = isScoped
                && !isActive
                && rowProvider === snapshot.provider
                && selectedIds.has(row.getAttribute("data-session-id"));
            row.toggleAttribute("data-ai-session-selected", isSelected);
            var checkbox = row.querySelector('.ai-session-batch-checkbox');
            if (checkbox) {
                checkbox.checked = isSelected;
                checkbox.disabled = isActive || (isScoped && snapshot.pending);
            }
        });

        var count = isScoped ? snapshot.selectedIds.length : 0;
        var countElement = projectDiv.querySelector('.ai-session-batch-count');
        if (countElement) {
            countElement.textContent = count + ' selected';
        }
        projectDiv.querySelectorAll('.ai-session-batch-actions button').forEach(button => {
            button.disabled = isScoped && snapshot.pending;
        });
        var archiveButton = projectDiv.querySelector('[data-action="archive-selected-ai-sessions"]');
        if (archiveButton) {
            archiveButton.disabled = !isScoped || snapshot.pending || count === 0;
        }
    }

    function exitAiSessionBatchManagement() {
        var projectId = batchAiSessionState.projectId;
        batchAiSessionManager.exit();
        syncAiSessionBatchManagementDom(findCurrentWorkspaceDiv(projectId));
    }

    function onInsideGroupClick(e, groupDiv) {
        var groupId = groupDiv.getAttribute("data-group-id");
        if (groupId == null)
            return;

        var actionDiv = e.target.closest('[data-action]')
        var action = actionDiv != null ? actionDiv.getAttribute("data-action") : null;
        if (!action)
            return;

        if (action === "add") {
            window.vscode.postMessage({
                type: 'add-project',
                groupId: groupId,
            });

            return;
        }

        var collapsed = groupDiv.classList.contains("collapsed");
        if (action === "collapse") {
            groupDiv.classList.toggle("collapsed");
            collapsed = groupDiv.classList.contains("collapsed");
        }

        window.vscode.postMessage({
            type: action + '-group',
            groupId: groupId,
            collapsed,
        });
        syncCollapseButton();
    }

    function onTodoAction(e) {
        var addTodoAction = e.target.closest('[data-action="todo-add"]');
        if (addTodoAction && !addTodoAction.closest('.todo-add-form')) {
            setTodoAddFormVisible(true, addTodoAction.getAttribute('data-group-id'));
            return true;
        }

        var addGroupAction = e.target.closest('[data-action="todo-add-group"]');
        if (addGroupAction) {
            window.vscode.postMessage({
                type: 'todo-add-group',
            });
            return true;
        }

        var toggleAction = e.target.closest('[data-action="todo-toggle"]');
        if (toggleAction) {
            window.vscode.postMessage({
                type: 'todo-toggle',
                todoId: toggleAction.getAttribute('data-todo-id'),
                completed: toggleAction.checked === true,
            });
            return true;
        }

        var deleteAction = e.target.closest('[data-action="todo-delete"]');
        if (deleteAction) {
            window.vscode.postMessage({
                type: 'todo-delete',
                todoId: deleteAction.getAttribute('data-todo-id'),
            });
            return true;
        }

        var deleteGroupAction = e.target.closest('[data-action="todo-delete-group"]');
        if (deleteGroupAction) {
            window.vscode.postMessage({
                type: 'todo-delete-group',
                groupId: deleteGroupAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var renameGroupAction = e.target.closest('[data-action="todo-rename-group"]');
        if (renameGroupAction) {
            window.vscode.postMessage({
                type: 'todo-rename-group',
                groupId: renameGroupAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var collapseGroupAction = e.target.closest('[data-action="todo-collapse-group"]');
        if (collapseGroupAction) {
            var todoGroup = collapseGroupAction.closest('.todo-group');
            if (!todoGroup)
                return true;
            todoGroup.classList.toggle('collapsed');
            syncTodoGroupCollapseControl(todoGroup);
            window.vscode.postMessage({
                type: 'todo-collapse-group',
                groupId: todoGroup.getAttribute('data-todo-group-id'),
                collapsed: todoGroup.classList.contains('collapsed'),
            });
            syncCollapseButton('todo');
            return true;
        }

        var sortAction = e.target.closest('[data-action="todo-sort-priority"]');
        if (sortAction) {
            window.vscode.postMessage({
                type: 'todo-sort-priority',
                groupId: sortAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var showCompletedAction = e.target.closest('[data-action="todo-toggle-show-completed"]');
        if (showCompletedAction) {
            window.vscode.postMessage({
                type: 'todo-toggle-show-completed',
                showCompleted: showCompletedAction.checked === true,
            });
            return true;
        }

        var focusAddAction = e.target.closest('[data-action="todo-focus-add"]');
        if (focusAddAction) {
            setTodoAddFormVisible(true, focusAddAction.getAttribute('data-group-id'));
            return true;
        }

        var cancelAddAction = e.target.closest('[data-action="todo-cancel-add"]');
        if (cancelAddAction) {
            setTodoAddFormVisible(false);
            return true;
        }

        var editAction = e.target.closest('[data-action="todo-edit"]');
        if (editAction) {
            setTodoEditing(editAction.getAttribute('data-todo-id'), true);
            return true;
        }

        var expandAction = e.target.closest('[data-action="todo-toggle-expanded"]');
        if (expandAction) {
            toggleTodoItemExpanded(expandAction.closest('.todo-item'));
            return true;
        }

        var cancelEditAction = e.target.closest('[data-action="todo-cancel-edit"]');
        if (cancelEditAction) {
            setTodoEditing(cancelEditAction.getAttribute('data-todo-id'), false);
            return true;
        }

        return false;
    }

    function syncTodoPrioritySegment(segment) {
        if (!segment)
            return;

        Array.from(segment.querySelectorAll('.todo-priority-choice')).forEach(choice => {
            var input = choice.querySelector('input[name="priority"]');
            choice.classList.toggle('active', !!input && input.checked === true);
        });
    }

    function resetTodoEditForm(form) {
        form.reset();
        syncTodoPrioritySegment(form.querySelector('.todo-priority-segment'));
    }

    function syncTodoListExpandedHeight(list) {
        if (!list)
            return;

        var panel = list.closest('.todo-panel');
        var collapsedHeightValue = panel
            ? getComputedStyle(panel).getPropertyValue('--todo-collapsed-item-height')
            : '';
        var collapsedHeight = parseFloat(collapsedHeightValue) || 58;
        var expandedExtraHeight = Array.from(list.querySelectorAll('.todo-item.expanded'))
            .reduce((total, expandedItem) => total + Math.max(0, expandedItem.offsetHeight - collapsedHeight), 0);
        list.style.setProperty('--todo-list-expanded-extra-height', expandedExtraHeight + 'px');
    }

    function toggleTodoItemExpanded(item, expanded) {
        if (!item)
            return;

        var nextExpanded = typeof expanded === 'boolean'
            ? expanded
            : !item.classList.contains('expanded');
        item.classList.toggle('expanded', nextExpanded);
        syncTodoExpandControl(item, nextExpanded);
        syncTodoListExpandedHeight(item.closest('.todo-list'));
    }

    function isTodoInteractiveTarget(target) {
        return !!(target && target.closest && target.closest('button, input, textarea, select, label, a, [data-action], .todo-edit-form'));
    }

    function setTodoAddFormVisible(visible, groupId) {
        var form = document.querySelector('.todo-add-form');
        if (!form)
            return;

        var groupSelect = form.querySelector('[name="groupId"]');
        if (visible && groupSelect) {
            groupSelect.value = groupId || '';
        }
        form.hidden = !visible;
        if (!visible)
            return;

        var titleInput = form.querySelector('[name="title"]');
        if (titleInput) {
            titleInput.focus();
        }
        form.scrollIntoView({ block: 'nearest' });
    }

    function setTodoEditing(todoId, editing) {
        if (!todoId)
            return;

        var item = Array.from(document.querySelectorAll('.todo-item[data-todo-id]'))
            .find(candidate => candidate.getAttribute('data-todo-id') === todoId);
        if (!item)
            return;

        var wasEditing = item.classList.contains('editing');
        var expandedBeforeEdit = item.getAttribute('data-expanded-before-edit');
        if (editing && !wasEditing) {
            item.setAttribute(
                'data-expanded-before-edit',
                item.classList.contains('expanded') ? 'true' : 'false'
            );
            expandedBeforeEdit = item.getAttribute('data-expanded-before-edit');
        }
        var view = item.querySelector('.todo-item-view');
        var form = item.querySelector('.todo-edit-form');
        var list = item.closest('.todo-list');
        if (form && !editing) {
            resetTodoEditForm(form);
        }
        item.classList.toggle('editing', editing);
        if (view) {
            view.hidden = false;
        }
        if (form) {
            form.hidden = !editing;
        }
        toggleTodoItemExpanded(item, editing ? true : expandedBeforeEdit === 'true');
        if (!editing) {
            item.removeAttribute('data-expanded-before-edit');
        }
        if (list) {
            list.classList.toggle('has-editing-item', !!list.querySelector('.todo-item.editing'));
        }
        if (form && editing) {
            var titleInput = form.querySelector('[name="title"]');
            if (titleInput) {
                titleInput.focus();
            }
            item.scrollIntoView({ block: 'nearest' });
        }
    }

    function onTodoFormSubmit(e) {
        var addForm = e.target && e.target.closest ? e.target.closest('.todo-add-form') : null;
        if (addForm) {
            e.preventDefault();
            submitTodoComposeForm(addForm, message => window.vscode.postMessage(message));
            return;
        }

        var editForm = e.target && e.target.closest ? e.target.closest('.todo-edit-form') : null;
        if (editForm) {
            e.preventDefault();
            var todoId = editForm.getAttribute('data-todo-id');
            var editTitle = getTodoFormValue(editForm, 'title');
            if (!todoId || !editTitle)
                return;
            window.vscode.postMessage({
                type: 'todo-update',
                todoId,
                title: editTitle,
                notes: getTodoFormValue(editForm, 'notes'),
                priority: getTodoFormValue(editForm, 'priority'),
            });
        }
    }

    function onTriggerProjectAction(target, projectId) {
        var actionDiv = target.closest('[data-action]')
        if (actionDiv == null)
            return false;

        var action = actionDiv.getAttribute("data-action");
        if (!action)
            return false;

        if (action === 'save-current-workspace') {
            window.vscode.postMessage({
                type: 'save-current-workspace',
                projectId,
            });
            return true;
        }

        window.vscode.postMessage({
            type: action + '-project',
            projectId,
        });

        return true;
    }

    var contextMenuProjectId = null;
    var contextMenuGroupId = null;
    var contextMenuAiSessionId = null;
    var contextMenuAiSessionProvider = null;
    var contextMenuAiSessionProjectId = null;
    var contextMenuAiSessionActive = false;
    var contextMenuAiSessionBackend = null;
    var contextMenuAiSessionConflict = false;
    var contextMenuAiSessionOrigin = null;
    var latestAiSessionUpdateSequence = 0;

    function showContextMenu(contextMenuElement, e) {
        contextMenuElement.style.visibility = "hidden";
        contextMenuElement.style.left = "0px";
        contextMenuElement.style.top = "0px";
        contextMenuElement.classList.add("visible");

        var rect = contextMenuElement.getBoundingClientRect();
        var viewportPadding = 4;
        var left = e.clientX;
        var top = e.clientY;

        if (left + rect.width + viewportPadding > window.innerWidth) {
            left = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
        }

        if (top + rect.height + viewportPadding > window.innerHeight) {
            top = Math.max(viewportPadding, window.innerHeight - rect.height - viewportPadding);
        }

        contextMenuElement.style.left = left + "px";
        contextMenuElement.style.top = top + "px";
        contextMenuElement.style.visibility = "";
    }

    function onContextMenu(e) {
        closeContextMenus(); // Close previews

        var sessionRow = e.target.closest('.codex-session-row[data-session-id][data-session-provider]');
        if (sessionRow) {
            contextMenuAiSessionOrigin = sessionRow.querySelector('.ai-session-primary-action') || sessionRow;
            contextMenuAiSessionId = sessionRow.getAttribute("data-session-id");
            contextMenuAiSessionProvider = sessionRow.getAttribute("data-session-provider");
            var sessionProjectDiv = sessionRow.closest('.project[data-id]');
            contextMenuAiSessionProjectId = sessionProjectDiv ? sessionProjectDiv.getAttribute("data-id") : null;
            contextMenuAiSessionActive = sessionRow.hasAttribute('data-session-active');
            contextMenuAiSessionBackend = sessionRow.getAttribute('data-session-backend') || 'vscode';
            contextMenuAiSessionConflict = sessionRow.hasAttribute('data-session-conflict');
            if (!contextMenuAiSessionId || !isAiSessionProvider(contextMenuAiSessionProvider))
                return;

            e.preventDefault();
            var sessionContextMenuElement = document.getElementById("aiSessionContextMenu");
            if (!sessionContextMenuElement)
                return;
            sessionContextMenuElement.querySelectorAll(':scope > *').forEach(element => element.classList.remove('disabled'));
            var archiveMenuItem = sessionContextMenuElement.querySelector('[data-action="archive"]');
            var closeMenuItem = sessionContextMenuElement.querySelector('[data-action="close-terminal"]');
            if (archiveMenuItem) archiveMenuItem.classList.toggle('disabled', contextMenuAiSessionActive);
            if (closeMenuItem) {
                var terminalActionLabel = contextMenuAiSessionBackend === 'tmux'
                    ? 'Detach Terminal…' : 'Close Terminal…';
                closeMenuItem.textContent = terminalActionLabel;
                closeMenuItem.setAttribute('aria-label', terminalActionLabel);
                closeMenuItem.toggleAttribute('hidden', contextMenuAiSessionConflict);
                closeMenuItem.classList.toggle(
                    'disabled', !contextMenuAiSessionActive || contextMenuAiSessionConflict
                );
            }

            showContextMenu(sessionContextMenuElement, e);
            if (e.keyboardTrigger) {
                var firstMenuItem = sessionContextMenuElement.querySelector('.custom-context-menu-item[data-action]:not(.disabled)');
                firstMenuItem?.focus();
            }
            return;
        }

        var projectDiv = e.target.closest('.project[data-id]');
        var groupDiv = e.target.closest('.group-title')
        if (!projectDiv && !groupDiv)
            return;

        if (projectDiv && projectDiv.hasAttribute("data-readonly-project"))
            return;

        e.preventDefault();

        let contextMenuForProject = projectDiv != null;
        var contextMenuElement;
        if (contextMenuForProject) {
            contextMenuProjectId = projectDiv.getAttribute("data-id");
            if (contextMenuProjectId == null)
                return;

            contextMenuElement = document.getElementById("projectContextMenu");
        } else {
            let groupIdDiv = groupDiv.closest(".group[data-group-id]");
            if (groupIdDiv && groupIdDiv.hasAttribute("data-virtual-group"))
                return;

            contextMenuGroupId = groupIdDiv ? groupIdDiv.getAttribute("data-group-id") : null;
            if (contextMenuGroupId == null)
                return;

            contextMenuElement = document.getElementById("groupContextMenu");
        }

        // disable elements if needed
        contextMenuElement.querySelectorAll(":scope > *").forEach(e => e.classList.remove("disabled"));

        if (projectDiv && projectDiv.hasAttribute("data-is-remote")) {
            contextMenuElement.querySelectorAll(".not-remote").forEach(e => e.classList.add("disabled"));
        }

        // place and show contextmenu

        showContextMenu(contextMenuElement, e);
    }

    function onProjectContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");

        if (action == null || contextMenuProjectId == null)
            return;

        switch (action) {
            case 'open':
                openProject(contextMenuProjectId, ProjectOpenType.CurrentWindow);
                break;
            case 'open-add-to-workspace':
                openProject(contextMenuProjectId, ProjectOpenType.AddToWorkspace);
                break;
            default:
                window.vscode.postMessage({
                    type: action + '-project',
                    projectId: contextMenuProjectId,
                });
                break;
        }

        closeContextMenus();
    }

    function onGroupContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");

        if (action == null || contextMenuGroupId == null)
            return;

        switch (action) {
            case 'add':
                window.vscode.postMessage({
                    type: 'add-project',
                    groupId: contextMenuGroupId,
                });
                break;
            default:
                window.vscode.postMessage({
                    type: action + '-group',
                    groupId: contextMenuGroupId,
                });
                break;
        }

        closeContextMenus();
    }

    function onAiSessionContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");
        var origin = contextMenuAiSessionOrigin;

        if (action == null || contextMenuAiSessionId == null || contextMenuAiSessionProvider == null)
            return;

        switch (action) {
            case 'resume':
                window.vscode.postMessage(contextMenuAiSessionActive ? {
                    type: 'focus-ai-session-terminal',
                    provider: contextMenuAiSessionProvider,
                    projectId: contextMenuAiSessionProjectId,
                    sessionId: contextMenuAiSessionId,
                } : {
                    type: getResumeAiSessionMessageType(contextMenuAiSessionProvider),
                    provider: contextMenuAiSessionProvider,
                    projectId: contextMenuAiSessionProjectId,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'rename':
                window.vscode.postMessage({
                    type: 'rename-ai-session',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'copy-id':
                window.vscode.postMessage({
                    type: 'copy-ai-session-id',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'pin':
                window.vscode.postMessage({
                    type: 'toggle-ai-session-pin',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'archive':
                if (contextMenuAiSessionActive) break;
                window.vscode.postMessage({
                    type: getArchiveAiSessionMessageType(contextMenuAiSessionProvider),
                    projectId: contextMenuAiSessionProjectId,
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'close-terminal':
                if (!contextMenuAiSessionActive || contextMenuAiSessionConflict) break;
                window.vscode.postMessage({
                    type: contextMenuAiSessionBackend === 'tmux'
                        ? 'detach-ai-session-terminal' : 'close-ai-session-terminal',
                    projectId: contextMenuAiSessionProjectId,
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
        }

        closeContextMenus();
        origin?.focus();
    }

    function closeContextMenus() {
        contextMenuProjectId = null;
        contextMenuGroupId = null;
        contextMenuAiSessionId = null;
        contextMenuAiSessionProvider = null;
        contextMenuAiSessionProjectId = null;
        contextMenuAiSessionActive = false;
        contextMenuAiSessionBackend = null;
        contextMenuAiSessionConflict = false;
        contextMenuAiSessionOrigin = null;
        document.querySelectorAll(".custom-context-menu").forEach(element =>
            element.classList.remove("visible")
        );
    }

    function updateToggleAllGroupsButton(state) {
        document.body.classList.toggle("steward-all-collapsed", state.collapsed);
        var button = document.querySelector('[data-action="toggle-all-groups"]');
        if (!button)
            return;

        button.disabled = state.disabled;
        button.setAttribute('aria-disabled', state.disabled ? 'true' : 'false');
        button.setAttribute("title", state.title);
        button.setAttribute("aria-label", state.title);
    }

    function getActiveCollapsibleGroups(activeTab) {
        var dashboard = window.__projectStewardDashboard;
        activeTab = activeTab || (dashboard && typeof dashboard.getActiveTab === 'function'
            ? dashboard.getActiveTab()
            : 'open');
        var selector = activeTab === 'projects'
            ? '#dashboard-tab-projects .group[data-group-id]'
            : activeTab === 'todo'
                ? '#dashboard-tab-todo .todo-group[data-todo-group-id]'
                : '#dashboard-tab-open .open-other-windows-group[data-group-id]';
        return [...document.querySelectorAll(selector)];
    }

    function setGroupCollapsed(group, collapsed, persist) {
        group.classList.toggle('collapsed', collapsed);
        if (persist) {
            var isTodoGroup = group.classList.contains('todo-group');
            window.vscode.postMessage({
                type: isTodoGroup ? 'todo-collapse-group' : 'collapse-group',
                groupId: isTodoGroup
                    ? group.getAttribute('data-todo-group-id')
                    : group.getAttribute('data-group-id'),
                collapsed,
            });
        }
    }

    function syncCollapseButton(activeTab) {
        var dashboard = window.__projectStewardDashboard;
        activeTab = activeTab || (dashboard && typeof dashboard.getActiveTab === 'function'
            ? dashboard.getActiveTab()
            : 'open');
        var groups = getActiveCollapsibleGroups(activeTab);
        updateToggleAllGroupsButton(getCollapseButtonState(
            activeTab,
            groups.map(group => group.classList.contains('collapsed'))
        ));
    }

    function toggleAllGroups() {
        var dashboard = window.__projectStewardDashboard;
        var activeTab = dashboard && typeof dashboard.getActiveTab === 'function'
            ? dashboard.getActiveTab()
            : 'open';
        var groups = getActiveCollapsibleGroups();
        var shouldCollapse = groups.some(group => !group.classList.contains("collapsed"));

        if (activeTab === 'todo') {
            collapseTodoGroups(groups, shouldCollapse, message => window.vscode.postMessage(message));
            syncCollapseButton();
            return;
        }

        groups.forEach(group => setGroupCollapsed(group, shouldCollapse, true));
        syncCollapseButton();
    }

    window.__projectStewardSyncCollapseButton = syncCollapseButton;

    function onMouseEvent(e) {
        if (!e.target || e.target.closest(".disabled"))
            return;

        var contextMenuElement = e.target.closest("#projectContextMenu [data-action]");
        if (contextMenuElement) {
            onProjectContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#aiSessionContextMenu [data-action]");
        if (contextMenuElement) {
            onAiSessionContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#groupContextMenu [data-action]");
        if (contextMenuElement) {
            onGroupContextMenuActionClicked(contextMenuElement);
            return;
        }

        closeContextMenus();

        if (e.target.closest('[data-action="toggle-all-groups"]')) {
            toggleAllGroups();
            return;
        }

        if (e.target.closest('[data-action="open-settings"]')) {
            window.vscode.postMessage({
                type: 'open-settings'
            });
            return;
        }

        if (e.target.closest('[data-action="open-bridge-extension"]')) {
            window.vscode.postMessage({
                type: 'open-bridge-extension'
            });
            return;
        }

        if (e.target.closest('[data-action="add-group"]')) {
            window.vscode.postMessage({
                type: 'add-group'
            });
            return;
        }

        if (e.target.closest('[data-action="add-project"]')) {
            onAddProjectClicked(e);
            return;
        }

        if (e.target.closest('[data-action="import-from-other-storage"]')) {
            onImportFromOtherStorageClicked(e);
            return;
        }

        if (onTodoAction(e)) {
            return;
        }

        var todoItem = e.target.closest('.todo-item[data-todo-id]');
        if (todoItem && !todoItem.classList.contains('editing') && !isTodoInteractiveTarget(e.target)) {
            toggleTodoItemExpanded(todoItem);
            return;
        }

        var projectDiv = e.target.closest('.project');
        if (projectDiv) {
            onInsideProjectClick(e, projectDiv);
            return;
        }

        var groupDiv = e.target.closest('.group');
        if (groupDiv) {
            onInsideGroupClick(e, groupDiv);
            return;
        }
    }

    function onChangeEvent(e) {
        if (!e.target)
            return;

        var todoPriorityInput = e.target.closest('.todo-priority-choice input[name="priority"]');
        if (todoPriorityInput) {
            syncTodoPrioritySegment(todoPriorityInput.closest('.todo-priority-segment'));
            return;
        }

        var providerSelect = e.target.closest('select[data-action="select-ai-provider"]');
        if (!providerSelect)
            return;

        var projectDiv = providerSelect.closest('.project[data-id]');
        var projectId = projectDiv && projectDiv.getAttribute("data-id");
        selectAiSessionProvider(projectId, providerSelect.value);
    }

    function updateStickyGroupHeaderOffset() {
        window.requestAnimationFrame(() => {
            var stickyHeader = document.querySelector('.steward-sticky-header');
            var offset = stickyHeader ? Math.ceil(stickyHeader.getBoundingClientRect().height) : 0;
            document.body.style.setProperty('--steward-sticky-header-height', offset + 'px');
        });
    }

    function onWindowMessage(e) {
        var message = e && e.data;
        if (message && message.type === 'todo-mutation-result') {
            applyTodoMutationResult(message, document);
            return;
        }
        if (message && (message.type === 'todo-panel-content' || message.type === 'todo-panel-updated')) {
            window.setTimeout(() => {
                var todoRoot = document.querySelector('#dashboard-tab-todo');
                if (todoRoot && typeof initDnD === 'function' && typeof disposeDnD === 'function') {
                    disposeDnD(todoRoot);
                    initDnD(todoRoot);
                    syncCollapseButton('todo');
                }
            }, 0);
        }
        if (message && message.type === 'workspace-updated') {
            if (!applyWorkspaceUpdate(message)) {
                requestFullRefresh('invalid-workspace-update');
                return;
            }
            if (batchAiSessionState.projectId) {
                syncAiSessionBatchManagementDom(findCurrentWorkspaceDiv(batchAiSessionState.projectId));
            }
            syncActiveAiSessionTerminalDom();
            updateStickyGroupHeaderOffset();
            var renderedWorkspaceState = getWorkspaceUpdateDomState(document);
            window.vscode.postMessage({
                type: 'workspace-rendered',
                version: 2,
                currentWorkspaceCount: renderedWorkspaceState.currentWorkspaceCount,
            });
            return;
        }
        if (message && message.type === 'open-workspaces-updated') {
            if (!applyOpenWorkspacesUpdate(message)) {
                requestFullRefresh('invalid-open-workspaces-update');
                return;
            }
            syncActiveAiSessionTerminalDom();
            updateStickyGroupHeaderOffset();
            var renderedOpenWorkspaceState = getOpenWorkspacesUpdateDomState();
            window.vscode.postMessage({
                type: 'open-workspaces-rendered',
                version: 2,
                semanticRevision: message.semanticRevision,
                currentWorkspaceCount: renderedOpenWorkspaceState.currentWorkspaceCount,
                navigationWorkspaceCount: renderedOpenWorkspaceState.navigationWorkspaceCount,
                hasOtherWindowsGroup: renderedOpenWorkspaceState.hasOtherWindowsGroup,
                otherWindowsStatus: renderedOpenWorkspaceState.otherWindowsStatus,
            });
            return;
        }
        if (message && message.type === 'ai-session-tab-selection-requested') {
            var requestedProject = findCurrentWorkspaceDiv(message.projectId);
            if (requestedProject && (message.tab === 'active' || message.tab === 'sessions')) {
                selectAiSessionTabDom(requestedProject, message.tab);
                writeAiSessionTabState(window.vscode, message.projectId, message.tab);
            }
            return;
        }

        if (message && message.type === 'ai-session-status-announcement') {
            var announcementProject = findCurrentWorkspaceDiv(message.projectId);
            var announcement = typeof message.message === 'string' ? message.message.trim().slice(0, 256) : '';
            var announcementRegion = announcementProject && announcementProject.querySelector('[data-ai-session-live-region]');
            if (announcementRegion && announcement) announcementRegion.textContent = announcement;
            return;
        }

        if (message && message.type === 'active-ai-session-terminal-changed') {
            activeAiSessionTerminalState.provider = isAiSessionProvider(message.provider) ? message.provider : null;
            activeAiSessionTerminalState.sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
            syncActiveAiSessionTerminalDom();
            return;
        }

        if (message && message.type === 'ai-session-attention-state') {
            window.__projectStewardAttentionEvents = window.__projectStewardAttentionEvents || {};
            window.__projectStewardAttentionSessionEvents = {};
            (Array.isArray(message.sessionEvents) ? message.sessionEvents.slice(0, 1000) : []).forEach(session => {
                if (!session || typeof session.sessionKey !== 'string' || !Array.isArray(session.eventIds)) return;
                var separator = session.sessionKey.indexOf(':');
                if (separator <= 0 || !isAiSessionProvider(session.sessionKey.slice(0, separator))) return;
                var eventIds = Array.from(new Set(session.eventIds
                    .slice(0, 1000)
                    .filter(eventId => typeof eventId === 'string' && !!eventId)));
                if (eventIds.length) window.__projectStewardAttentionSessionEvents[session.sessionKey] = eventIds;
            });
            (message.eventIds || []).forEach(eventId => {
                if (typeof eventId === 'string') window.__projectStewardAttentionEvents[eventId] = true;
            });
            return;
        }

        if (message && message.type === 'ai-session-batch-archive-completed') {
            if (message.projectId === batchAiSessionState.projectId
                && message.provider === batchAiSessionState.provider) {
                batchAiSessionManager.complete(message.status);
                syncAiSessionBatchManagementDom(findCurrentWorkspaceDiv(message.projectId));
            }
            return;
        }

        if (!message || message.type !== 'ai-sessions-updated') {
            return;
        }

        applyAiSessionsUpdate(message);
    }

    function applyAiSessionsUpdate(message) {
        if (message.version !== 2
            || typeof message.sequence !== 'number'
            || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
            || typeof message.html !== 'string'
            || typeof normalizeDashboardSearchCatalog !== 'function'
            || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
            || message.searchCatalog.version !== 2) {
            requestFullRefresh('unsupported-ai-session-message');
            return;
        }

        if (message.sequence <= latestAiSessionUpdateSequence) {
            return;
        }

        if (!applyWorkspaceUpdate({
            type: 'workspace-updated',
            version: 2,
            currentWorkspaceCount: message.currentWorkspaceCount,
            html: message.html,
        })) {
            requestFullRefresh('invalid-ai-session-workspace-update');
            return;
        }

        latestAiSessionUpdateSequence = message.sequence;
        if (batchAiSessionState.projectId) {
            var projectDiv = findCurrentWorkspaceDiv(batchAiSessionState.projectId);
            if (projectDiv) {
                syncAiSessionBatchManagementDom(projectDiv);
            } else {
                exitAiSessionBatchManagement();
            }
        }
        syncActiveAiSessionTerminalDom();
        updateStickyGroupHeaderOffset();
        if (window.__projectStewardDashboard) {
            window.__projectStewardDashboard.replaceSearchCatalog(message.searchCatalog);
        }
    }

    function findCurrentWorkspaceDiv(projectId) {
        if (!projectId) {
            return null;
        }

        var projects = document.querySelectorAll('.workspace-card[data-current-workspace][data-id]');
        for (var projectDiv of projects) {
            if (projectDiv.getAttribute("data-id") === projectId) {
                return projectDiv;
            }
        }

        return null;
    }

    function findWorkspaceDiv(navigationIdentity) {
        if (!navigationIdentity) {
            return null;
        }
        var workspaces = document.querySelectorAll('.workspace-card[data-workspace-navigation-identity]');
        for (var workspaceDiv of workspaces) {
            if (workspaceDiv.getAttribute('data-workspace-navigation-identity') === navigationIdentity) {
                return workspaceDiv;
            }
        }
        return null;
    }

    function focusSearchRevealTarget(target) {
        target.setAttribute('tabindex', '-1');
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
        target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }

    window.__projectStewardRevealWorkspace = navigationIdentity => {
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        focusSearchRevealTarget(workspaceDiv);
        return true;
    };

    function revealWorkspaceSession(navigationIdentity, provider, sessionId) {
        if (!isAiSessionProvider(provider) || !sessionId) {
            return false;
        }
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        var workspaceId = workspaceDiv.getAttribute('data-id');
        if (!workspaceDiv.hasAttribute('data-codex-expanded')) {
            toggleCodexSessions(workspaceDiv, workspaceId);
        }
        selectAiSessionTabDom(workspaceDiv, 'sessions');
        writeAiSessionTabState(window.vscode, workspaceId, 'sessions');
        var sessionRow = Array.from(workspaceDiv.querySelectorAll('.codex-session-row[data-session-id][data-session-provider]'))
            .find(row => row.getAttribute('data-session-provider') === provider
                && row.getAttribute('data-session-id') === sessionId);
        if (sessionRow) {
            pendingWorkspaceSessionReveal = null;
            focusSearchRevealTarget(sessionRow);
            return true;
        }
        if (getProjectActiveAiSessionProvider(workspaceDiv) !== provider) {
            pendingWorkspaceSessionReveal = { navigationIdentity, provider, sessionId };
            selectAiSessionProvider(workspaceId, provider);
            return true;
        }
        pendingWorkspaceSessionReveal = null;
        focusSearchRevealTarget(workspaceDiv);
        return false;
    }

    window.__projectStewardRevealWorkspaceSession = revealWorkspaceSession;
    window.__projectStewardRevealPendingWorkspaceSession = () => {
        if (!pendingWorkspaceSessionReveal) {
            return false;
        }
        var pending = pendingWorkspaceSessionReveal;
        return revealWorkspaceSession(
            pending.navigationIdentity,
            pending.provider,
            pending.sessionId
        );
    };

    function requestFullRefresh(reason) {
        window.vscode.postMessage({
            type: 'request-full-refresh',
            reason,
        });
    }

    function observeStickyGroupHeaderOffset() {
        updateStickyGroupHeaderOffset();
        window.addEventListener('resize', updateStickyGroupHeaderOffset);

        var stickyHeader = document.querySelector('.steward-sticky-header');
        if (stickyHeader && typeof ResizeObserver !== 'undefined') {
            var observer = new ResizeObserver(updateStickyGroupHeaderOffset);
            observer.observe(stickyHeader);
            window.__stewardStickyHeaderObserver = observer;
        }
    }

    // Middle mouse button requires mousedown, as it does not fire click event when scroll option is available.
    document.addEventListener('click', (e) => {
        if (e.button !== 1) {
            onMouseEvent(e);
        }
    });

    document.addEventListener('change', onChangeEvent);
    document.addEventListener('submit', onTodoFormSubmit);

    document.addEventListener('mousedown', (e) => {
        if (e.target.closest('.codex-session-row')) {
            return;
        }

        if (e.button === 1) {
            onMouseEvent(e);
        }
    });

    document.addEventListener('contextmenu', (e) => {
        if (!e.target)
            return;

        onContextMenu(e);
    });

    document.addEventListener("keydown", e => {
        var aiSessionMenuItem = e.target && e.target.closest
            ? e.target.closest('#aiSessionContextMenu [role="menuitem"]')
            : null;
        if (aiSessionMenuItem) {
            var aiSessionMenu = aiSessionMenuItem.closest('#aiSessionContextMenu');
            var enabledMenuItems = Array.from(aiSessionMenu.querySelectorAll('[role="menuitem"]'))
                .filter(item => !item.classList.contains('disabled'));
            var currentMenuIndex = enabledMenuItems.indexOf(aiSessionMenuItem);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                var nextMenuIndex = e.key === 'Home' ? 0
                    : e.key === 'End' ? enabledMenuItems.length - 1
                        : (currentMenuIndex + (e.key === 'ArrowDown' ? 1 : -1) + enabledMenuItems.length)
                            % enabledMenuItems.length;
                enabledMenuItems[nextMenuIndex]?.focus();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onAiSessionContextMenuActionClicked(aiSessionMenuItem);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                var menuOrigin = contextMenuAiSessionOrigin;
                closeContextMenus();
                menuOrigin?.focus();
                return;
            }
            if (e.key === 'Tab') {
                closeContextMenus();
            }
        }

        var tab = e.target && e.target.closest ? e.target.closest('[data-ai-session-tab]') : null;
        if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            var nextTabId = getAdjacentAiSessionTab(tab.getAttribute('data-ai-session-tab'), e.key);
            var projectDiv = tab.closest('.project[data-id]');
            var nextTab = projectDiv && Array.from(projectDiv.querySelectorAll('[data-ai-session-tab]'))
                .find(candidate => candidate.getAttribute('data-ai-session-tab') === nextTabId);
            nextTab?.focus();
            return;
        }
        if (tab && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            var tabProject = tab.closest('.project[data-id]');
            var tabProjectId = tabProject && tabProject.getAttribute('data-id');
            if (tabProjectId) onTriggerAiSessionAction(tab, tabProjectId);
            return;
        }

        var sessionRow = e.target && e.target.closest ? e.target.closest('.codex-session-row') : null;
        var interactiveChild = e.target && e.target.closest
            ? e.target.closest('button, input, select, textarea, a[href]')
            : null;
        var primarySessionAction = e.target && e.target.closest
            ? e.target.closest('.ai-session-primary-action') : null;
        if (sessionRow && (!interactiveChild || primarySessionAction)
            && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
            e.preventDefault();
            var sessionRowRect = sessionRow.getBoundingClientRect();
            onContextMenu({
                target: primarySessionAction || sessionRow,
                preventDefault: () => {},
                clientX: sessionRowRect.left + 8,
                clientY: sessionRowRect.top + 8,
                keyboardTrigger: true,
            });
            return;
        }
        if (e.key === "Escape") {
            var editForm = e.target && e.target.closest ? e.target.closest('.todo-edit-form') : null;
            if (editForm) {
                e.preventDefault();
                setTodoEditing(editForm.getAttribute('data-todo-id'), false);
                return;
            }
            closeContextMenus();
            if (batchAiSessionState.projectId && !batchAiSessionState.pending) {
                exitAiSessionBatchManagement();
            }
        }
    });

    window.addEventListener('message', onWindowMessage);
    restoreAiSessionTabsFromState(document, window.vscode);
    window.vscode.postMessage({ type: 'request-active-ai-session-terminal' });
    window.vscode.postMessage({ type: 'request-ai-session-attention-state' });

    observeStickyGroupHeaderOffset();
}
