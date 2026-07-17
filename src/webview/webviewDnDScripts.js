function isFavoritesProjectContainer(container) {
    return Boolean(container && container.closest('[data-system-group="__favorites"]'));
}

function canMoveProject(el, source) {
    if (!el || !source || el.hasAttribute('data-nodrag')) {
        return false;
    }

    return isFavoritesProjectContainer(source) || !source.closest('[data-virtual-group]');
}

function canAcceptProject(target, source) {
    if (!target || !source) {
        return false;
    }
    if (isFavoritesProjectContainer(source)) {
        return target === source;
    }

    return !isFavoritesProjectContainer(target) && !target.closest('[data-virtual-group]');
}

function canAcceptTodoGroup(target, source) {
    return Boolean(target && source && target === source && target.matches('.todo-groups'));
}

function canMoveTodoGroup(el, source, handle) {
    return Boolean(el && source && handle
        && el.matches('.todo-group')
        && source.matches('.todo-groups')
        && handle.closest('[data-drag-todo-group]'));
}

function canAcceptTodoItem(target, source) {
    return Boolean(target && source && target === source && target.matches('.todo-list'));
}

function canMoveTodoItem(el, source, handle) {
    return Boolean(el && source && handle
        && el.matches('.todo-item')
        && source.matches('.todo-list')
        && !handle.closest('button, input, textarea, select, label, a, [data-action], .todo-edit-form'));
}

function getTodoGroupIds(root) {
    return [].slice.call(root.querySelectorAll('.todo-groups > .todo-group[data-todo-group-id]'))
        .map(group => group.getAttribute('data-todo-group-id'))
        .filter(groupId => Boolean(groupId));
}

function getTodoIds(container) {
    return [].slice.call(container.querySelectorAll(':scope > .todo-item[data-todo-id]'))
        .map(todo => todo.getAttribute('data-todo-id'))
        .filter(todoId => Boolean(todoId));
}

function disposeDnD(root) {
    var dnd = root && root.__projectStewardDnD;
    if (!dnd) {
        return;
    }

    [dnd.projectDrake, dnd.groupsDrake, dnd.todoGroupsDrake, dnd.todoItemsDrake]
        .filter(drake => drake && typeof drake.destroy === 'function')
        .forEach(drake => drake.destroy());
    if (dnd.scroll && typeof dnd.scroll.destroy === 'function') {
        dnd.scroll.destroy(true);
    }
    if (dnd.onKeyDown) {
        window.removeEventListener('keydown', dnd.onKeyDown);
    }
    delete root.__projectStewardDnDInitialized;
    delete root.__projectStewardDnD;
}

function initDnD(root) {
    if (!root || root.__projectStewardDnDInitialized) {
        return root && root.__projectStewardDnD;
    }

    const projectsContainerSelector = ".group-list";
    const groupsContainerSelector = ".groups-wrapper";
    const todoGroupsContainerSelector = ".todo-groups";
    const todoItemsContainerSelector = ".todo-list";

    root.__projectStewardDnDInitialized = true;

    var projectsContainers = root.querySelectorAll(projectsContainerSelector);
    var projectDrake = dragula([].slice.call(projectsContainers), {
        moves: function (el, source, handle, sibling) {
            return canMoveProject(el, source);
        },
        accepts: function (el, target, source, sibling) {
            return canAcceptProject(target, source);
        },
    });
    projectDrake.on('drop', function (el, target, source) {
        if (isFavoritesProjectContainer(source)) {
            onFavoritesReordered(source);
            return;
        }
        onReordered();
    });
    projectDrake.on('drag', () => document.body.classList.add('project-dragging'));
    projectDrake.on('dragend', () => document.body.classList.remove('project-dragging'));

    var groupsContainers = root.querySelectorAll(groupsContainerSelector);
    var groupsDrake = dragula([].slice.call(groupsContainers), {
        moves: function (el, source, handle, sibling) {
            return handle.hasAttribute("data-drag-group");
        },
    });
    groupsDrake.on('drop', onReordered);

    var todoGroupsContainers = root.querySelectorAll(todoGroupsContainerSelector);
    var todoGroupsDrake = todoGroupsContainers.length
        ? dragula([].slice.call(todoGroupsContainers), {
            moves: function (el, source, handle) {
                return canMoveTodoGroup(el, source, handle);
            },
            accepts: function (el, target, source) {
                return canAcceptTodoGroup(target, source);
            },
        })
        : null;
    if (todoGroupsDrake) {
        todoGroupsDrake.on('drop', function () {
            window.vscode.postMessage({
                type: 'todo-reorder-groups',
                groupIds: getTodoGroupIds(root),
            });
        });
    }

    var todoItemsContainers = root.querySelectorAll(todoItemsContainerSelector);
    var todoItemsDrake = todoItemsContainers.length
        ? dragula([].slice.call(todoItemsContainers), {
            moves: function (el, source, handle) {
                return canMoveTodoItem(el, source, handle);
            },
            accepts: function (el, target, source) {
                return canAcceptTodoItem(target, source);
            },
        })
        : null;
    if (todoItemsDrake) {
        todoItemsDrake.on('drop', function (el, target, source) {
            var todoGroup = source && source.closest('.todo-group[data-todo-group-id]');
            if (!todoGroup) {
                return;
            }
            window.vscode.postMessage({
                type: 'todo-reorder-items',
                groupId: todoGroup.getAttribute('data-todo-group-id'),
                todoIds: getTodoIds(source),
            });
        });
    }

    const scroll = autoScroll(window, {
        margin: 20,
        autoScroll: function () {
            return this.down && (projectDrake.dragging || groupsDrake.dragging
                || (todoGroupsDrake && todoGroupsDrake.dragging)
                || (todoItemsDrake && todoItemsDrake.dragging));
        }
    });

    var onKeyDown = function (e) {
        if (e.key === "Escape") {
            projectDrake.cancel(true);
            groupsDrake.cancel(true);
            if (todoGroupsDrake) todoGroupsDrake.cancel(true);
            if (todoItemsDrake) todoItemsDrake.cancel(true);
        }
    };
    window.addEventListener("keydown", onKeyDown);

    function onReordered() {
        // Build reordering object
        let groupElements = [...root.querySelectorAll(`${groupsContainerSelector} > [data-group-id]:not([data-virtual-group])`)];
        // If a project was dropped on the Create New Group element...
        let tempGroupElement = root.querySelector('#tempGroup');
        if (tempGroupElement && tempGroupElement.querySelector("[data-id]")) {
            // ... Handle it as a new group
            groupElements.push(tempGroupElement);
        }

        let groupOrders = [];
        for (let groupElement of groupElements) {
            var groupOrder = {
                groupId: groupElement.getAttribute("data-group-id") || "",
                projectIds: [].slice.call(groupElement.querySelectorAll("[data-id]:not([data-virtual-project])")).map(p => p.getAttribute("data-id")),
            };
            groupOrders.push(groupOrder);
        }

        window.vscode.postMessage({
            type: 'reordered-projects',
            groupOrders,
        });
    }

    function onFavoritesReordered(favoritesContainer) {
        let projectIds = [].slice.call(favoritesContainer.querySelectorAll('.project[data-id]'))
            .map(project => project.getAttribute('data-id'));

        window.vscode.postMessage({
            type: 'reordered-favorites',
            projectIds,
        });
    }

    root.__projectStewardDnD = {
        projectDrake,
        groupsDrake,
        todoGroupsDrake,
        todoItemsDrake,
        scroll,
        onKeyDown,
    };
    return root.__projectStewardDnD;
};
