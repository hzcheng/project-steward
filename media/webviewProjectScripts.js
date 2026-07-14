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
        sessions.filter(session => !session.pinned).forEach(session =>
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

        if (projectDiv.hasAttribute("data-open-project")) {
            toggleCodexSessions(projectDiv, dataId);
            return;
        }

        var currentWindow = e.ctrlKey || e.metaKey;
        var newWindow = e.button === 1;
        openProject(dataId, currentWindow ? ProjectOpenType.CurrentWindow : newWindow ? ProjectOpenType.NewWindow : ProjectOpenType.Default);

    }

    function onTriggerAiSessionAction(target, projectId) {
        var providerAction = target.closest('[data-action="select-ai-provider"]');
        if (providerAction) {
            if (providerAction.tagName !== "SELECT") {
                selectAiSessionProvider(projectId, providerAction.getAttribute("data-provider"));
            }

            return true;
        }

        var createAction = target.closest('[data-action="create-ai-session"][data-provider]');
        if (createAction) {
            var createProvider = createAction.getAttribute("data-provider");
            if (isAiSessionProvider(createProvider)) {
                window.vscode.postMessage({
                    type: 'create-ai-session',
                    projectId,
                    provider: createProvider,
                });
            }

            return true;
        }

        var projectDiv = target.closest('.project[data-id]');
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
                var sessions = Array.from(projectDiv.querySelectorAll('.codex-session-row[data-session-id]'))
                    .filter(row => (row.getAttribute("data-session-provider") || "codex") === batchAiSessionState.provider)
                    .map(row => ({
                        id: row.getAttribute("data-session-id"),
                        pinned: row.hasAttribute("data-session-pinned"),
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

        var managedSessionRow = target.closest('.codex-session-row[data-session-id]');
        if (managedSessionRow) {
            var managedSessionProvider = managedSessionRow.getAttribute("data-session-provider") || "codex";
            if (isActiveAiSessionBatchScope(projectId, managedSessionProvider)) {
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
                window.vscode.postMessage({
                    type: getArchiveAiSessionMessageType(archiveProvider),
                    projectId,
                    sessionId: archiveSessionId,
                });
            }

            return true;
        }

        var sessionRow = target.closest('.codex-session-row[data-session-id]');
        if (!sessionRow)
            return false;

        var sessionId = sessionRow.getAttribute("data-session-id");
        if (!sessionId)
            return true;
        var sessionProvider = sessionRow.getAttribute("data-session-provider") || "codex";

        if (sessionRow.hasAttribute('data-ai-session-attention')) {
            var attentionEventId = sessionRow.getAttribute('data-ai-session-event-id');
            if (attentionEventId) {
                window.vscode.postMessage({
                    type: 'acknowledge-ai-session-attention',
                    eventIds: [attentionEventId],
                });
            }
        }

        if (isAiSessionProvider(sessionProvider)) {
            window.vscode.postMessage({
                type: getResumeAiSessionMessageType(sessionProvider),
                projectId,
                sessionId,
            });
        }

        return true;
    }

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
        projectDiv.querySelectorAll('.codex-session-row[data-session-id]').forEach(row => {
            var rowProvider = row.getAttribute("data-session-provider") || "codex";
            var isSelected = isScoped
                && rowProvider === snapshot.provider
                && selectedIds.has(row.getAttribute("data-session-id"));
            row.toggleAttribute("data-ai-session-selected", isSelected);
            var checkbox = row.querySelector('.ai-session-batch-checkbox');
            if (checkbox) {
                checkbox.checked = isSelected;
                checkbox.disabled = isScoped && snapshot.pending;
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
        syncAiSessionBatchManagementDom(findOpenProjectDiv(projectId));
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
    }

    function onTriggerProjectAction(target, projectId) {
        var actionDiv = target.closest('[data-action]')
        if (actionDiv == null)
            return false;

        var action = actionDiv.getAttribute("data-action");
        if (!action)
            return false;

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
            contextMenuAiSessionId = sessionRow.getAttribute("data-session-id");
            contextMenuAiSessionProvider = sessionRow.getAttribute("data-session-provider");
            var sessionProjectDiv = sessionRow.closest('.project[data-id]');
            contextMenuAiSessionProjectId = sessionProjectDiv ? sessionProjectDiv.getAttribute("data-id") : null;
            if (!contextMenuAiSessionId || !isAiSessionProvider(contextMenuAiSessionProvider))
                return;

            e.preventDefault();
            var sessionContextMenuElement = document.getElementById("aiSessionContextMenu");
            if (!sessionContextMenuElement)
                return;

            showContextMenu(sessionContextMenuElement, e);
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

        if (action == null || contextMenuAiSessionId == null || contextMenuAiSessionProvider == null)
            return;

        switch (action) {
            case 'resume':
                window.vscode.postMessage({
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
                window.vscode.postMessage({
                    type: getArchiveAiSessionMessageType(contextMenuAiSessionProvider),
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
        }

        closeContextMenus();
    }

    function closeContextMenus() {
        contextMenuProjectId = null;
        contextMenuGroupId = null;
        contextMenuAiSessionId = null;
        contextMenuAiSessionProvider = null;
        contextMenuAiSessionProjectId = null;
        document.querySelectorAll(".custom-context-menu").forEach(element =>
            element.classList.remove("visible")
        );
    }

    function updateToggleAllGroupsButton(collapsed) {
        document.body.classList.toggle("steward-all-collapsed", collapsed);

        var button = document.querySelector('[data-action="toggle-all-groups"]');
        if (!button)
            return;

        var label = collapsed ? "Expand All Groups" : "Collapse All Groups";
        button.setAttribute("title", label);
        button.setAttribute("aria-label", label);
    }

    function toggleAllGroups() {
        var groups = [...document.querySelectorAll('.groups-wrapper > .group[data-group-id]')];
        var shouldCollapse = groups.some(group => !group.classList.contains("collapsed"));

        groups.forEach(group => group.classList.toggle("collapsed", shouldCollapse));
        updateToggleAllGroupsButton(shouldCollapse);
    }

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

        if (e.target.closest('[data-action="add-group"]')) {
            window.vscode.postMessage({
                type: 'add-group'
            });
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
        if (message && message.type === 'active-ai-session-terminal-changed') {
            activeAiSessionTerminalState.provider = isAiSessionProvider(message.provider) ? message.provider : null;
            activeAiSessionTerminalState.sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
            syncActiveAiSessionTerminalDom();
            return;
        }

        if (message && message.type === 'ai-session-attention-state') {
            window.__projectStewardAttentionEvents = window.__projectStewardAttentionEvents || {};
            (message.eventIds || []).forEach(eventId => {
                if (typeof eventId === 'string') window.__projectStewardAttentionEvents[eventId] = true;
            });
            return;
        }

        if (message && message.type === 'ai-session-batch-archive-completed') {
            if (message.projectId === batchAiSessionState.projectId
                && message.provider === batchAiSessionState.provider) {
                batchAiSessionManager.complete(message.status);
                syncAiSessionBatchManagementDom(findOpenProjectDiv(message.projectId));
            }
            return;
        }

        if (!message || message.type !== 'ai-sessions-updated') {
            return;
        }

        applyAiSessionsUpdate(message);
    }

    function applyAiSessionsUpdate(message) {
        if (message.version !== 1 || typeof message.sequence !== 'number' || !Array.isArray(message.openProjects)) {
            requestFullRefresh('unsupported-ai-session-message');
            return;
        }

        if (message.sequence <= latestAiSessionUpdateSequence) {
            return;
        }

        latestAiSessionUpdateSequence = message.sequence;

        if (batchAiSessionState.projectId && !findOpenProjectDiv(batchAiSessionState.projectId)) {
            exitAiSessionBatchManagement();
        }

        for (var projectUpdate of message.openProjects) {
            var projectDiv = findOpenProjectDiv(projectUpdate.projectId);
            if (!projectDiv) {
                if (projectUpdate.projectId === batchAiSessionState.projectId) {
                    exitAiSessionBatchManagement();
                }
                requestFullRefresh('missing-open-project');
                return;
            }

            if (!updateOpenProjectAiSessions(projectDiv, projectUpdate)) {
                return;
            }
        }

        updateStickyGroupHeaderOffset();
        if (typeof window.__projectStewardApplyFilter === 'function') {
            window.__projectStewardApplyFilter();
        }
    }

    function findOpenProjectDiv(projectId) {
        if (!projectId) {
            return null;
        }

        var projects = document.querySelectorAll('.project[data-open-project][data-id]');
        for (var projectDiv of projects) {
            if (projectDiv.getAttribute("data-id") === projectId) {
                return projectDiv;
            }
        }

        return null;
    }

    function updateOpenProjectAiSessions(projectDiv, projectUpdate) {
        if (typeof projectUpdate.sessionSectionHtml !== 'string') {
            requestFullRefresh('invalid-ai-session-html');
            return false;
        }

        projectDiv.toggleAttribute("data-codex-expanded", !!projectUpdate.expanded);

        if (typeof projectUpdate.searchText === 'string') {
            projectDiv.setAttribute("data-name", projectUpdate.searchText);
        }

        updateOpenProjectAiSessionBadge(projectDiv, projectUpdate.aiSessionCount || 0, projectUpdate.attentionCount || 0);

        var sessionSection = projectDiv.querySelector('.codex-sessions');
        if (sessionSection) {
            sessionSection.outerHTML = projectUpdate.sessionSectionHtml;
        } else if (projectUpdate.sessionSectionHtml) {
            projectDiv.insertAdjacentHTML('beforeend', projectUpdate.sessionSectionHtml);
        }

        if (projectUpdate.projectId === batchAiSessionState.projectId) {
            var activeProvider = getProjectActiveAiSessionProvider(projectDiv);
            var remainingIds = Array.from(projectDiv.querySelectorAll('.codex-session-row[data-session-id]'))
                .filter(row => (row.getAttribute("data-session-provider") || "codex") === activeProvider)
                .map(row => row.getAttribute("data-session-id"))
                .filter(sessionId => !!sessionId);
            batchAiSessionManager.reconcile(projectUpdate.projectId, activeProvider, remainingIds);
            syncAiSessionBatchManagementDom(projectDiv);
        }

        syncActiveAiSessionTerminalDom();
        animateNewAiSessionAttention(projectDiv);

        return true;
    }

    function animateNewAiSessionAttention(root) {
        if (!root) return;
        window.__projectStewardAttentionEvents = window.__projectStewardAttentionEvents || {};
        root.querySelectorAll('.codex-session-row[data-ai-session-attention][data-session-event-id]').forEach(row => {
            var eventId = row.getAttribute('data-session-event-id');
            if (!eventId || window.__projectStewardAttentionEvents[eventId]) return;
            window.__projectStewardAttentionEvents[eventId] = true;
            row.classList.add('attention-animate');
            var badge = root.closest('.project')?.querySelector('.project-codex-badge.has-attention');
            if (badge) {
                badge.classList.add('attention-animate');
                window.setTimeout(() => badge.classList.remove('attention-animate'), 2800);
            }
            window.setTimeout(() => row.classList.remove('attention-animate'), 2800);
        });
    }

    function updateOpenProjectAiSessionBadge(projectDiv, aiSessionCount, attentionCount) {
        var badge = projectDiv.querySelector('.project-codex-badge');
        if (!aiSessionCount) {
            if (badge) {
                badge.remove();
            }
            return;
        }

        if (!badge) {
            var sessionSection = projectDiv.querySelector('.codex-sessions');
            if (sessionSection) {
                sessionSection.insertAdjacentHTML('beforebegin', '<span class="project-codex-badge" title="AI Sessions"></span>');
            } else {
                projectDiv.insertAdjacentHTML('beforeend', '<span class="project-codex-badge" title="AI Sessions"></span>');
            }
            badge = projectDiv.querySelector('.project-codex-badge');
        }

        badge.textContent = 'AI ' + aiSessionCount;
        badge.classList.toggle('has-attention', !!attentionCount);
        var attentionBadge = badge.querySelector('.ai-session-attention-count');
        if (attentionCount && !attentionBadge) {
            badge.insertAdjacentHTML('beforeend', ' <b class="ai-session-attention-count"></b>');
            attentionBadge = badge.querySelector('.ai-session-attention-count');
        }
        if (attentionBadge) {
            attentionBadge.textContent = attentionCount ? String(attentionCount) : '';
            attentionBadge.hidden = !attentionCount;
        }
    }

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

    document.addEventListener('mousedown', (e) => {
        if (e.target.closest('.codex-session-row')) {
            return;
        }

        if (e.button === 1) {
            onMouseEvent(e);
        }
    });

    document
        .querySelectorAll('[data-action="add-project"]')
        .forEach(element =>
            element.addEventListener("click", onAddProjectClicked)
        );

    document
        .querySelectorAll('[data-action="import-from-other-storage"]')
        .forEach(element =>
            element.addEventListener("click", onImportFromOtherStorageClicked)
        );

    document.addEventListener('contextmenu', (e) => {
        if (!e.target)
            return;

        onContextMenu(e);
    });

    document.addEventListener("keydown", e => {
        if (e.key === "Escape") {
            closeContextMenus();
            if (batchAiSessionState.projectId && !batchAiSessionState.pending) {
                exitAiSessionBatchManagement();
            }
        }
    });

    window.addEventListener('message', onWindowMessage);
    window.vscode.postMessage({ type: 'request-active-ai-session-terminal' });
    window.vscode.postMessage({ type: 'request-ai-session-attention-state' });

    observeStickyGroupHeaderOffset();
}
