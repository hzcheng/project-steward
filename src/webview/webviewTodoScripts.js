function initTodos(options) {
    'use strict';

    options = options || {};
    var postMessage = typeof options.postMessage === 'function'
        ? options.postMessage
        : function (message) { window.vscode.postMessage(message); };
    var state = {
        snapshot: null,
        selectedTodoId: null,
        restoreFocusTodoId: null,
        draft: null,
        composeGroupId: undefined,
        nextRequestId: 0,
        lastRevision: 0,
        pending: new Map(),
        undo: null,
        undoTimer: null,
        announcement: '',
        renderedSurfaceHtml: '',
    };
    var panelHost = null;
    var root = null;

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function isSnapshot(value) {
        return !!value
            && value.version === 1
            && value.data
            && value.data.version === 1
            && Array.isArray(value.data.groups)
            && Array.isArray(value.data.todos)
            && typeof value.showCompleted === 'boolean';
    }

    function orderedGroups() {
        return state.snapshot.data.groups.slice().sort(function (left, right) {
            return left.order - right.order;
        });
    }

    function orderedTodos(groupId) {
        var todos = state.snapshot.data.todos
            .filter(function (todo) { return todo.groupId === groupId; })
            .sort(function (left, right) { return left.order - right.order; });
        var incomplete = todos.filter(function (todo) { return !todo.completed; });
        var completed = todos.filter(function (todo) { return todo.completed; });
        var visibleCompleted = state.snapshot.showCompleted
            ? completed
            : completed.filter(function (todo) {
                return todo.id === state.snapshot.revealedTodoId;
            });
        return incomplete.concat(visibleCompleted);
    }

    function findTodo(todoId) {
        return state.snapshot && state.snapshot.data.todos.find(function (todo) {
            return todo.id === todoId;
        });
    }

    function findGroup(groupId) {
        return state.snapshot && state.snapshot.data.groups.find(function (group) {
            return group.id === groupId;
        });
    }

    function renderPriorityOptions(selected) {
        return ['high', 'medium', 'low'].map(function (priority) {
            return '<option value="' + priority + '"' + (priority === selected ? ' selected' : '') + '>'
                + priority.toUpperCase() + '</option>';
        }).join('');
    }

    function renderGroupOptions(selected) {
        return '<option value=""' + (!selected ? ' selected' : '') + '>Inbox</option>'
            + orderedGroups().map(function (group) {
            return '<option value="' + escapeHtml(group.id) + '"'
                + (group.id === selected ? ' selected' : '') + '>'
                + escapeHtml(group.title) + '</option>';
        }).join('');
    }

    function todoClassName(todo) {
        return 'todo-item steward-item-card todo-priority-' + escapeHtml(todo.priority)
            + (todo.completed ? ' completed' : '')
            + (state.selectedTodoId === todo.id ? ' expanded' : '');
    }

    function renderTodoBody(todo) {
        var checked = todo.completed ? ' checked' : '';
        var expanded = state.selectedTodoId === todo.id;
        var priorityBadge = todo.priority === 'medium'
            ? ''
            : '<span class="todo-priority-badge steward-badge">'
                + escapeHtml(todo.priority.toUpperCase()) + '</span>';
        return '<span class="todo-item-accent steward-item-accent" aria-hidden="true"></span>'
            + '<div class="todo-item-view"><div class="todo-item-main">'
            + '<label class="todo-check"><input type="checkbox" data-action="todo-toggle" data-todo-id="'
            + escapeHtml(todo.id) + '" aria-label="Complete ' + escapeHtml(todo.title) + '"' + checked + '>'
            + '<span class="todo-checkbox-visual"></span></label>'
            + '<div class="todo-item-content"><div class="todo-title-line">'
            + '<button class="todo-title-button" type="button" data-action="todo-open-detail" data-todo-id="'
            + escapeHtml(todo.id) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '" title="'
            + (expanded ? 'Collapse details' : 'Expand details') + '"><span class="todo-title-text">'
            + escapeHtml(todo.title) + '</span></button>' + priorityBadge + '</div></div>'
            + '<div class="todo-item-actions">'
            + '<button class="todo-icon-button steward-icon-button danger" type="button" data-action="todo-delete" '
            + 'data-todo-id="' + escapeHtml(todo.id) + '" title="Delete todo" aria-label="Delete todo">×</button>'
            + '<button class="todo-drag-handle todo-icon-button steward-icon-button" type="button" draggable="true" '
            + 'data-drag-todo-item="' + escapeHtml(todo.id) + '" title="Drag to reorder" aria-label="Drag '
            + escapeHtml(todo.title) + '">⋮⋮</button></div>'
            + '</div>' + (expanded ? renderInlineDetail(todo) : '') + '</div>';
    }

    function renderTodo(todo) {
        return '<li class="' + todoClassName(todo) + '" data-todo-id="' + escapeHtml(todo.id) + '">'
            + renderTodoBody(todo) + '</li>';
    }

    function renderQuickAdd(group) {
        var visible = state.composeGroupId === group.id;
        return '<form class="todo-quick-add-form" data-todo-form="quick-add" data-group-id="'
            + escapeHtml(group.id) + '"' + (visible ? '' : ' hidden') + '>'
            + '<input type="text" name="title" placeholder="Add to ' + escapeHtml(group.title)
            + '" aria-label="New todo in ' + escapeHtml(group.title) + '">'
            + '<button class="todo-primary-button steward-button steward-button-primary" type="submit">Add</button>'
            + '<button class="todo-quiet-button" type="button" data-action="todo-cancel-quick-add">Cancel</button>'
            + '</form>';
    }

    function renderGroupChevron() {
        return '<span class="todo-group-chevron collapse-icon" aria-hidden="true">'
            + '<svg viewBox="0 0 320 512"><path d="M143 352.3L7 216.3c-9.4-9.4-9.4-24.6 '
            + '0-33.9l22.6-22.6c9.4-9.4 24.6-9.4 33.9 0l96.4 96.4 96.4-96.4c9.4-9.4 '
            + '24.6-9.4 33.9 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9l-136 136c-9.2 '
            + '9.4-24.4 9.4-33.8 0z"></path></svg></span>';
    }

    function renderGroup(group) {
        var allTodos = state.snapshot.data.todos.filter(function (todo) {
            return todo.groupId === group.id;
        });
        var incompleteCount = allTodos.filter(function (todo) { return !todo.completed; }).length;
        var completedCount = allTodos.length - incompleteCount;
        var visibleTodos = orderedTodos(group.id);
        var hiddenCompleted = completedCount
            - visibleTodos.filter(function (todo) { return todo.completed; }).length;
        var meta = incompleteCount + ' open'
            + (state.snapshot.showCompleted && completedCount ? ' · ' + completedCount + ' done' : '');
        return '<section class="todo-group group steward-section' + (group.collapsed ? ' collapsed' : '')
            + '" data-todo-group-id="' + escapeHtml(group.id) + '">'
            + '<header class="todo-group-header group-title steward-group-header">'
            + '<div class="todo-group-title-block group-title-text">'
            + '<button class="todo-group-collapse-button" type="button" data-action="todo-collapse-group" '
            + 'data-todo-group-id="' + escapeHtml(group.id) + '" aria-expanded="'
            + (group.collapsed ? 'false' : 'true') + '" aria-label="'
            + (group.collapsed ? 'Expand ' : 'Collapse ') + escapeHtml(group.title) + '">'
            + renderGroupChevron() + '</button>'
            + '<h2 data-drag-todo-group title="' + escapeHtml(group.title) + '">' + escapeHtml(group.title) + '</h2>'
            + '<span class="todo-group-count">' + meta + '</span></div>'
            + '<div class="todo-group-actions group-actions right">'
            + '<button class="todo-group-action" type="button" data-action="todo-quick-add" data-group-id="'
            + escapeHtml(group.id) + '" title="Quick add todo" aria-label="Quick add todo">＋</button>'
            + '<button class="todo-group-action" type="button" data-action="todo-sort-priority" data-group-id="'
            + escapeHtml(group.id) + '" title="Sort by priority" aria-label="Sort by priority">⇅</button>'
            + '<button class="todo-group-action" type="button" data-action="todo-rename-group" data-group-id="'
            + escapeHtml(group.id) + '" title="Rename todo group" aria-label="Rename todo group">✎</button>'
            + '<button class="todo-group-action danger" type="button" data-action="todo-delete-group" data-group-id="'
            + escapeHtml(group.id) + '" title="Delete todo group" aria-label="Delete todo group">×</button>'
            + '</div></header>' + renderQuickAdd(group)
            + (visibleTodos.length
                ? '<ul class="todo-list">' + visibleTodos.map(renderTodo).join('') + '</ul>'
                : '<p class="todo-group-empty">No visible todos</p>')
            + (hiddenCompleted > 0
                ? '<p class="todo-hidden-completed">' + hiddenCompleted + ' completed hidden</p>'
                : '')
            + '</section>';
    }

    function renderGlobalCompose() {
        var visible = state.composeGroupId === null;
        return '<form class="todo-add-form todo-compose-panel steward-card" data-todo-form="add"'
            + (visible ? '' : ' hidden') + '>'
            + '<div class="todo-compose-primary"><span class="todo-compose-icon">＋</span>'
            + '<input class="todo-title-input" type="text" name="title" placeholder="Add a todo" aria-label="Todo title">'
            + '</div><textarea class="todo-notes-input" name="notes" rows="2" placeholder="Notes" '
            + 'aria-label="Todo notes"></textarea><div class="todo-form-row todo-compose-meta">'
            + '<select name="priority" aria-label="Todo priority">' + renderPriorityOptions('medium') + '</select>'
            + '<select name="groupId" aria-label="Todo group">' + renderGroupOptions('') + '</select>'
            + '<button class="todo-primary-button steward-button steward-button-primary" type="submit">Add</button>'
            + '<button class="todo-secondary-button steward-button" type="button" '
            + 'data-action="todo-cancel-add">Cancel</button></div></form>';
    }

    function renderListSurface() {
        var todos = state.snapshot.data.todos;
        var incomplete = todos.filter(function (todo) { return !todo.completed; }).length;
        var completed = todos.length - incomplete;
        var groups = orderedGroups();
        var meta = incomplete + ' open · ' + groups.length + (groups.length === 1 ? ' group' : ' groups')
            + ' · ' + (state.snapshot.showCompleted ? completed + ' completed shown' : 'completed hidden');
        return '<div class="todo-list-surface">'
            + '<header class="todo-page-header group-title steward-group-header">'
            + '<div class="todo-summary-copy"><strong>TODO</strong>'
            + '<span class="todo-summary-meta steward-meta">' + meta + '</span></div>'
            + '<div class="todo-summary-actions group-actions right">'
            + '<button class="todo-square-button steward-icon-button" type="button" data-action="todo-add" '
            + 'title="Add todo" aria-label="Add todo">＋</button>'
            + '<button class="todo-square-button steward-icon-button" type="button" data-action="todo-add-group" '
            + 'title="Add group" aria-label="Add group">☷</button>'
            + '<label class="todo-square-toggle steward-icon-button'
            + (state.snapshot.showCompleted ? ' active' : '') + '" title="Show completed" aria-label="Show completed">'
            + '<input type="checkbox" data-action="todo-toggle-show-completed"'
            + (state.snapshot.showCompleted ? ' checked' : '') + '><span>✓</span></label>'
            + '</div></header>' + renderGlobalCompose()
            + (groups.length
                ? '<div class="todo-groups">' + groups.map(renderGroup).join('') + '</div>'
                : '<p class="todo-empty-state steward-empty-state">No todos yet</p>')
            + '</div>';
    }

    function detailDraft(todo) {
        return state.draft || {
            title: todo.title,
            notes: todo.notes || '',
            priority: todo.priority,
            groupId: todo.groupId,
        };
    }

    function renderInlineDetail(todo) {
        var group = findGroup(todo.groupId);
        var groupName = group ? group.title : 'Unknown group';
        if (state.draft) {
            var draft = detailDraft(todo);
            return '<form class="todo-inline-detail todo-detail-edit-form" data-todo-form="detail-edit" '
                + 'aria-label="Edit ' + escapeHtml(todo.title) + '" '
                + 'data-todo-id="' + escapeHtml(todo.id) + '">'
                + '<label class="todo-field-label">Title</label>'
                + '<textarea class="todo-title-input" name="title" rows="3" aria-label="Todo title">'
                + escapeHtml(draft.title) + '</textarea>'
                + '<label class="todo-field-label">Notes</label>'
                + '<textarea class="todo-notes-input" name="notes" rows="8" aria-label="Todo notes">'
                + escapeHtml(draft.notes) + '</textarea>'
                + '<label class="todo-field-label">Priority</label><select name="priority" aria-label="Todo priority">'
                + renderPriorityOptions(draft.priority) + '</select>'
                + '<label class="todo-field-label">Group</label><select name="groupId" aria-label="Todo group">'
                + renderGroupOptions(draft.groupId) + '</select>'
                + '<div class="todo-detail-actions"><button class="todo-primary-button steward-button '
                + 'steward-button-primary" type="submit">Save</button>'
                + '<button class="todo-secondary-button steward-button" type="button" '
                + 'data-action="todo-cancel-detail-edit">Cancel</button></div></form>';
        }
        return '<section class="todo-inline-detail" role="region" aria-label="Details for '
            + escapeHtml(todo.title) + '">'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Notes</span>'
            + '<p class="todo-inline-value todo-detail-notes">' + escapeHtml(todo.notes || 'No notes') + '</p></div>'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Group</span>'
            + '<span class="todo-inline-value">' + escapeHtml(groupName) + '</span></div>'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Priority</span>'
            + '<span class="todo-inline-value">' + escapeHtml(todo.priority.toUpperCase()) + '</span></div>'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Created</span>'
            + '<span class="todo-inline-value">' + escapeHtml(String(todo.createdAt || '').slice(0, 10)) + '</span></div>'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Updated</span>'
            + '<span class="todo-inline-value">' + escapeHtml(String(todo.updatedAt || '').slice(0, 10)) + '</span></div>'
            + (todo.completedAt
                ? '<div class="todo-inline-row"><span class="todo-inline-label">Completed</span>'
                    + '<span class="todo-inline-value">'
                    + escapeHtml(String(todo.completedAt).slice(0, 10)) + '</span></div>'
                : '')
            + '<div class="todo-detail-actions">'
            + '<button class="todo-primary-button steward-button" type="button" data-action="todo-toggle-detail" '
            + 'data-todo-id="' + escapeHtml(todo.id) + '">' + (todo.completed ? 'Reopen' : 'Complete') + '</button>'
            + '<button class="todo-secondary-button steward-button" type="button" data-action="todo-edit-detail">Edit</button>'
            + '<button class="todo-secondary-button steward-button danger" type="button" data-action="todo-delete" '
            + 'data-todo-id="' + escapeHtml(todo.id) + '">Delete</button>'
            + '</div></section>';
    }

    function renderUndo() {
        if (!state.undo) {
            return '<div class="todo-undo-region" role="status" aria-live="polite" hidden></div>';
        }
        return '<div class="todo-undo-region" role="status" aria-live="polite" style="display:flex">'
            + '<span>' + escapeHtml(state.undo.label) + '</span>'
            + '<button class="todo-primary-button steward-button" type="button" data-action="todo-undo">Undo</button></div>';
    }

    function updateFeedback() {
        if (!root || !root.querySelector) {
            return;
        }
        var undoRegion = root.querySelector('.todo-undo-region');
        if (undoRegion) {
            undoRegion.hidden = !state.undo;
            if (undoRegion.style) {
                undoRegion.style.display = state.undo ? 'flex' : '';
            }
            undoRegion.innerHTML = state.undo
                ? '<span>' + escapeHtml(state.undo.label) + '</span>'
                    + '<button class="todo-primary-button steward-button" type="button" '
                    + 'data-action="todo-undo">Undo</button>'
                : '';
        }
        var liveRegion = root.querySelector('.todo-live-region');
        if (liveRegion) {
            liveRegion.textContent = state.announcement;
        }
    }

    function render(force) {
        if (!root || !isSnapshot(state.snapshot)) {
            return false;
        }
        if (state.selectedTodoId && !findTodo(state.selectedTodoId)) {
            state.selectedTodoId = null;
            state.draft = null;
        }
        var surfaceHtml = renderListSurface();
        if (!force && surfaceHtml === state.renderedSurfaceHtml) {
            updateFeedback();
            return false;
        }
        var surface = !force && root.querySelector
            ? root.querySelector('.todo-list-surface')
            : null;
        if (surface && typeof surface.outerHTML === 'string') {
            surface.outerHTML = surfaceHtml;
        } else {
            root.innerHTML = surfaceHtml
                + renderUndo()
                + '<div class="todo-live-region" role="status" aria-live="polite" aria-atomic="true">'
                + escapeHtml(state.announcement) + '</div>';
        }
        state.renderedSurfaceHtml = surfaceHtml;
        updateFeedback();
        if (typeof options.onRendered === 'function') {
            options.onRendered(panelHost);
        }
        return true;
    }

    function patchTodoElements(todoIds) {
        if (!root || !root.querySelector) {
            render();
            return false;
        }
        var patches = [];
        var uniqueTodoIds = todoIds.filter(function (todoId, index) {
            return todoId && todoIds.indexOf(todoId) === index;
        });
        for (var index = 0; index < uniqueTodoIds.length; index += 1) {
            var todoId = uniqueTodoIds[index];
            var todo = findTodo(todoId);
            var selector = '.todo-item[data-todo-id="' + String(todoId).replace(/"/g, '\\"') + '"]';
            var item = root.querySelector(selector);
            if (!todo || !item || typeof item.innerHTML !== 'string') {
                render();
                return false;
            }
            patches.push({ item: item, todo: todo });
        }
        patches.forEach(function (patch) {
            patch.item.className = todoClassName(patch.todo);
            patch.item.innerHTML = renderTodoBody(patch.todo);
        });
        state.renderedSurfaceHtml = renderListSurface();
        updateFeedback();
        return true;
    }

    function patchGroupElements(groupIds) {
        if (!root || !root.querySelector) {
            render();
            return false;
        }
        var patches = [];
        for (var index = 0; index < groupIds.length; index += 1) {
            var groupId = groupIds[index];
            var group = findGroup(groupId);
            var selector = '.todo-group[data-todo-group-id="' + String(groupId).replace(/"/g, '\\"') + '"]';
            var groupElement = root.querySelector(selector);
            var button = groupElement && groupElement.querySelector
                ? groupElement.querySelector('[data-action="todo-collapse-group"]')
                : null;
            if (!group || !groupElement || !groupElement.classList || !button) {
                render();
                return false;
            }
            patches.push({ group: group, element: groupElement, button: button });
        }
        patches.forEach(function (patch) {
            patch.element.classList.toggle('collapsed', patch.group.collapsed);
            patch.button.setAttribute('aria-expanded', patch.group.collapsed ? 'false' : 'true');
            patch.button.setAttribute('aria-label',
                (patch.group.collapsed ? 'Expand ' : 'Collapse ') + patch.group.title);
        });
        state.renderedSurfaceHtml = renderListSurface();
        updateFeedback();
        return true;
    }

    function announce(message) {
        state.announcement = message;
        render();
    }

    function mount(nextPanelHost, snapshotValue) {
        var nextRoot = nextPanelHost && nextPanelHost.querySelector
            ? nextPanelHost.querySelector('.todo-panel')
            : null;
        if (!nextRoot || !isSnapshot(snapshotValue)) {
            return false;
        }
        if (root && root !== nextRoot && root.removeEventListener) {
            root.removeEventListener('click', onClick);
            root.removeEventListener('change', onChange);
            root.removeEventListener('submit', onSubmit);
            root.removeEventListener('keydown', onKeyDown);
            root.removeEventListener('input', onInput);
        }
        panelHost = nextPanelHost;
        root = nextRoot;
        state.renderedSurfaceHtml = '';
        state.snapshot = clone(snapshotValue);
        state.selectedTodoId = null;
        state.draft = null;
        state.composeGroupId = undefined;
        root.addEventListener('click', onClick);
        root.addEventListener('change', onChange);
        root.addEventListener('submit', onSubmit);
        root.addEventListener('keydown', onKeyDown);
        root.addEventListener('input', onInput);
        render(true);
        return true;
    }

    function openDetail(todoId) {
        var todo = findTodo(todoId);
        if (!todo) {
            return false;
        }
        var group = findGroup(todo.groupId);
        var rendered = orderedTodos(todo.groupId).some(function (item) {
            return item.id === todoId;
        });
        if (!rendered || (group && group.collapsed)) {
            return false;
        }
        if (state.selectedTodoId === todoId) {
            return true;
        }
        var previousTodoId = state.selectedTodoId;
        state.restoreFocusTodoId = todoId;
        state.selectedTodoId = todoId;
        state.draft = null;
        state.composeGroupId = undefined;
        patchTodoElements([previousTodoId, todoId]);
        return true;
    }

    function backToList() {
        if (!state.selectedTodoId) {
            return false;
        }
        var focusTodoId = state.selectedTodoId;
        state.selectedTodoId = null;
        state.draft = null;
        patchTodoElements([focusTodoId]);
        if (focusTodoId && root && root.querySelector) {
            var selector = '[data-action="todo-open-detail"][data-todo-id="' + focusTodoId.replace(/"/g, '\\"') + '"]';
            var focusTarget = root.querySelector(selector);
            if (focusTarget && focusTarget.focus) {
                focusTarget.focus();
            }
        }
        return true;
    }

    function toggleDetail(todoId) {
        if (state.selectedTodoId === todoId) {
            return backToList();
        }
        return openDetail(todoId);
    }

    function optimisticMutation(action, payload) {
        if (action === 'complete') {
            var completedTodo = findTodo(payload.todoId);
            if (completedTodo) {
                completedTodo.completed = payload.completed === true;
                completedTodo.completedAt = payload.completed ? new Date().toISOString() : undefined;
            }
        } else if (action === 'delete') {
            state.snapshot.data.todos = state.snapshot.data.todos.filter(function (todo) {
                return todo.id !== payload.todoId;
            });
            if (state.selectedTodoId === payload.todoId) {
                state.selectedTodoId = null;
                state.draft = null;
            }
        } else if (action === 'collapse-group') {
            var group = findGroup(payload.groupId);
            if (group) {
                group.collapsed = payload.collapsed === true;
            }
        } else if (action === 'collapse-groups') {
            state.snapshot.data.groups.forEach(function (item) {
                item.collapsed = payload.collapsed === true;
            });
        } else if (action === 'show-completed') {
            state.snapshot.showCompleted = payload.showCompleted === true;
        } else if (action === 'update') {
            var updated = findTodo(payload.todoId);
            if (updated) {
                ['title', 'notes', 'priority', 'groupId'].forEach(function (key) {
                    if (payload[key] !== undefined) {
                        updated[key] = payload[key];
                    }
                });
            }
        } else if (action === 'reorder-items' && Array.isArray(payload.todoIds)) {
            payload.todoIds.forEach(function (todoId, index) {
                var todo = findTodo(todoId);
                if (todo && todo.groupId === payload.groupId) {
                    todo.order = index;
                }
            });
        } else if (action === 'reorder-groups' && Array.isArray(payload.groupIds)) {
            payload.groupIds.forEach(function (groupId, index) {
                var reorderedGroup = findGroup(groupId);
                if (reorderedGroup) {
                    reorderedGroup.order = index;
                }
            });
        }
    }

    function dispatch(action, payload) {
        if (!state.snapshot) {
            return 0;
        }
        var requestId = ++state.nextRequestId;
        state.pending.set(requestId, {
            snapshot: clone(state.snapshot),
            selectedTodoId: state.selectedTodoId,
            draft: clone(state.draft),
            action: action,
            payload: clone(payload || {}),
        });
        optimisticMutation(action, payload || {});
        if (action === 'collapse-group') {
            patchGroupElements([payload.groupId]);
        } else if (action === 'collapse-groups') {
            patchGroupElements(state.snapshot.data.groups.map(function (group) { return group.id; }));
        } else if (action === 'reorder-items' || action === 'reorder-groups') {
            state.renderedSurfaceHtml = renderListSurface();
            updateFeedback();
        } else {
            render();
        }
        postMessage({
            type: 'todo-command',
            version: 2,
            requestId: requestId,
            action: action,
            payload: payload || {},
        });
        return requestId;
    }

    function errorMessage(code) {
        if (code === 'conflict') return 'TODO data changed elsewhere. The latest saved version is shown.';
        if (code === 'not-found') return 'That TODO no longer exists.';
        if (code === 'invalid') return 'Check the TODO fields and try again.';
        if (code === 'undo-expired') return 'The Undo window has expired.';
        return 'Could not save the TODO change. Your saved list has been restored.';
    }

    function showUndo(token, action) {
        if (state.undoTimer) {
            clearTimeout(state.undoTimer);
        }
        state.undo = {
            token: token,
            label: action === 'delete' ? 'TODO deleted' : 'TODO updated',
        };
        state.undoTimer = setTimeout(function () {
            state.undo = null;
            state.undoTimer = null;
            updateFeedback();
        }, 5000);
    }

    function applyCommandResult(message) {
        if (!message
            || message.type !== 'todo-command-result'
            || message.version !== 2
            || !Number.isSafeInteger(message.revision)
            || message.revision <= state.lastRevision
            || !isSnapshot(message.snapshot)) {
            return false;
        }
        state.lastRevision = message.revision;
        var pending = state.pending.get(message.requestId);
        state.pending.delete(message.requestId);
        state.snapshot = clone(message.snapshot);
        Array.from(state.pending.entries())
            .sort(function (left, right) { return left[0] - right[0]; })
            .forEach(function (entry) {
                optimisticMutation(entry[1].action, entry[1].payload);
            });
        if (message.searchCatalog
            && typeof options.replaceSearchCatalog === 'function') {
            options.replaceSearchCatalog(message.searchCatalog);
        }
        if (message.success === true) {
            if (pending && pending.action === 'update') {
                state.draft = null;
            }
            if (message.undoToken) {
                showUndo(message.undoToken, pending ? pending.action : '');
            }
            state.announcement = pending && pending.action === 'add'
                ? 'TODO added'
                : 'TODO saved';
        } else {
            if (pending) {
                state.selectedTodoId = pending.selectedTodoId;
                state.draft = pending.draft;
            }
            state.announcement = errorMessage(message.errorCode);
        }
        render();
        return true;
    }

    function undo() {
        if (!state.undo) {
            return false;
        }
        var token = state.undo.token;
        state.undo = null;
        if (state.undoTimer) {
            clearTimeout(state.undoTimer);
            state.undoTimer = null;
        }
        dispatch('undo', { undoToken: token });
        return true;
    }

    function submitQuickAdd(groupId, title) {
        var normalizedTitle = String(title || '').trim();
        if (!normalizedTitle) {
            announce('Enter a TODO title.');
            return false;
        }
        state.composeGroupId = undefined;
        dispatch('add', {
            title: normalizedTitle,
            notes: '',
            priority: 'medium',
            groupId: groupId,
        });
        return true;
    }

    function readValue(form, name) {
        var field = form && form.querySelector ? form.querySelector('[name="' + name + '"]') : null;
        return field ? String(field.value || '') : '';
    }

    function onSubmit(event) {
        var form = event.target;
        if (!form || !form.getAttribute) {
            return;
        }
        var kind = form.getAttribute('data-todo-form');
        if (!kind) {
            return;
        }
        event.preventDefault();
        if (kind === 'quick-add') {
            submitQuickAdd(form.getAttribute('data-group-id'), readValue(form, 'title'));
        } else if (kind === 'add') {
            var title = readValue(form, 'title').trim();
            if (!title) {
                announce('Enter a TODO title.');
                return;
            }
            state.composeGroupId = undefined;
            dispatch('add', {
                title: title,
                notes: readValue(form, 'notes'),
                priority: readValue(form, 'priority') || 'medium',
                groupId: readValue(form, 'groupId'),
            });
        } else if (kind === 'detail-edit') {
            var todoId = form.getAttribute('data-todo-id');
            var detailTitle = readValue(form, 'title').trim();
            if (!detailTitle) {
                announce('Enter a TODO title.');
                return;
            }
            dispatch('update', {
                todoId: todoId,
                title: detailTitle,
                notes: readValue(form, 'notes'),
                priority: readValue(form, 'priority') || 'medium',
                groupId: readValue(form, 'groupId'),
            });
        }
    }

    function closest(target, selector) {
        return target && target.closest ? target.closest(selector) : null;
    }

    function onClick(event) {
        var actionTarget = closest(event.target, '[data-action]');
        if (!actionTarget) {
            var item = closest(event.target, '.todo-item[data-todo-id]');
            if (item
                && !closest(event.target, '.todo-inline-detail')
                && !closest(event.target, 'button, input, textarea, select, label, a')) {
                toggleDetail(item.getAttribute('data-todo-id'));
            }
            return;
        }
        var action = actionTarget.getAttribute('data-action');
        var todoId = actionTarget.getAttribute('data-todo-id');
        var groupId = actionTarget.getAttribute('data-group-id')
            || actionTarget.getAttribute('data-todo-group-id');
        if (action === 'todo-open-detail') {
            toggleDetail(todoId);
        } else if (action === 'todo-back') {
            backToList();
        } else if (action === 'todo-edit-detail') {
            var todo = findTodo(state.selectedTodoId);
            state.draft = todo ? detailDraft(todo) : null;
            patchTodoElements([state.selectedTodoId]);
        } else if (action === 'todo-cancel-detail-edit') {
            state.draft = null;
            patchTodoElements([state.selectedTodoId]);
        } else if (action === 'todo-toggle-detail') {
            var detailTodo = findTodo(todoId);
            if (detailTodo) dispatch('complete', { todoId: todoId, completed: !detailTodo.completed });
        } else if (action === 'todo-delete') {
            dispatch('delete', { todoId: todoId });
        } else if (action === 'todo-undo') {
            undo();
        } else if (action === 'todo-add') {
            state.composeGroupId = null;
            render();
            focusCompose(null);
        } else if (action === 'todo-cancel-add' || action === 'todo-cancel-quick-add') {
            state.composeGroupId = undefined;
            render();
        } else if (action === 'todo-quick-add') {
            state.composeGroupId = groupId;
            render();
            focusCompose(groupId);
        } else if (action === 'todo-collapse-group') {
            var group = findGroup(groupId);
            if (group) dispatch('collapse-group', { groupId: groupId, collapsed: !group.collapsed });
        } else if (action === 'todo-sort-priority') {
            dispatch('sort-priority', { groupId: groupId });
        } else if (action === 'todo-add-group'
            || action === 'todo-rename-group'
            || action === 'todo-delete-group') {
            postMessage({
                type: action,
                groupId: groupId,
            });
        }
    }

    function onChange(event) {
        onInput(event);
        var toggle = closest(event.target, '[data-action="todo-toggle"]');
        if (toggle) {
            dispatch('complete', {
                todoId: toggle.getAttribute('data-todo-id'),
                completed: toggle.checked === true,
            });
            return;
        }
        var showCompleted = closest(event.target, '[data-action="todo-toggle-show-completed"]');
        if (showCompleted) {
            dispatch('show-completed', { showCompleted: showCompleted.checked === true });
        }
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            if (state.draft) {
                state.draft = null;
                render();
                event.preventDefault();
            } else if (state.selectedTodoId) {
                backToList();
                event.preventDefault();
            } else if (state.composeGroupId !== undefined) {
                state.composeGroupId = undefined;
                render();
                event.preventDefault();
            }
        } else if (event.altKey && event.key === 'ArrowLeft' && state.selectedTodoId) {
            backToList();
            event.preventDefault();
        }
    }

    function onInput(event) {
        var field = event.target;
        if (!state.draft
            || !field
            || !field.closest
            || !field.closest('.todo-detail-edit-form')
            || !field.getAttribute) {
            return;
        }
        var name = field.getAttribute('name');
        if (name === 'title' || name === 'notes' || name === 'priority' || name === 'groupId') {
            state.draft[name] = String(field.value || '');
            state.renderedSurfaceHtml = renderListSurface();
        }
    }

    function focusCompose(groupId) {
        if (!root || !root.querySelector) {
            return;
        }
        var selector = groupId === null
            ? '.todo-add-form [name="title"]'
            : '.todo-quick-add-form[data-group-id="' + String(groupId).replace(/"/g, '\\"') + '"] [name="title"]';
        var input = root.querySelector(selector);
        if (input && input.focus) {
            input.focus();
        }
    }

    function onWindowMessage(event) {
        if (event && event.data && event.data.type === 'todo-command-result') {
            applyCommandResult(event.data);
        }
    }

    window.addEventListener('message', onWindowMessage);

    var controller = {
        mount: mount,
        openDetail: openDetail,
        toggleDetail: toggleDetail,
        backToList: backToList,
        dispatch: dispatch,
        applyCommandResult: applyCommandResult,
        submitQuickAdd: submitQuickAdd,
        undo: undo,
        getState: function () { return state; },
        getRoot: function () { return root; },
    };
    window.__projectStewardTodo = controller;
    return controller;
}
