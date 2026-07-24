'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { getTodoPanelContent } = require('../../../out/todos/webviewContent');
const { buildTodoViewModel } = require('../../../out/todos/viewModel');

const NOW = '2026-07-24T00:00:00.000Z';
const todoScript = fs.readFileSync(
    path.join(__dirname, '../../../src/webview/webviewTodoScripts.js'),
    'utf8'
);
const styles = fs.readFileSync(
    path.join(__dirname, '../../../media/styles.scss'),
    'utf8'
);

function renderPanel() {
    const data = {
        version: 1,
        groups: [{ id: 'group-a', title: 'Work', collapsed: false, order: 0 }],
        todos: [
            {
                id: 'todo-medium',
                groupId: 'group-a',
                title: 'A deliberately long title that needs room to reveal its real meaning',
                notes: 'Context that belongs in the focused detail surface.',
                priority: 'medium',
                completed: false,
                createdAt: NOW,
                updatedAt: NOW,
                order: 0,
            },
            {
                id: 'todo-high',
                groupId: 'group-a',
                title: 'Urgent',
                notes: '',
                priority: 'high',
                completed: false,
                createdAt: NOW,
                updatedAt: NOW,
                order: 1,
            },
        ],
    };
    return getTodoPanelContent(buildTodoViewModel(data, { showCompleted: false }));
}

test('TODO-TODO-CONTINUOUS-LAYOUT-001 renders one stable continuous list without per-group height limits', () => {
    const html = renderPanel();

    assert.match(html, /class="todo-panel"/);
    assert.match(html, /class="todo-list-surface"/);
    assert.match(html, /class="todo-detail-surface"[^>]* hidden/);
    assert.doesNotMatch(html, /--todo-list-max-height/);
    assert.doesNotMatch(html, /maxVisibleTodosPerGroup/);
});

test('TODO-TODO-FOCUSED-DETAIL-001 makes the title the detail entry point and drag a separate affordance', () => {
    const html = renderPanel();

    assert.match(html, /data-action="todo-open-detail" data-todo-id="todo-medium"/);
    assert.match(html, /class="todo-title-text"[\s\S]*A deliberately long title/);
    assert.match(html, /data-drag-todo-item="todo-medium"/);
    assert.match(html, /aria-label="Drag A deliberately long title/);
    assert.doesNotMatch(html, /data-action="todo-toggle-expanded"/);
});

test('TODO-TODO-PRIORITY-SIGNAL-001 hides the default medium badge while retaining exceptional priority badges', () => {
    const html = renderPanel();

    assert.doesNotMatch(html, />MED<\/span>/);
    assert.match(html, />HIGH<\/span>/);
});

test('TODO-GROUP-DISCLOSURE-001 uses one centered SVG chevron with distinct expanded and collapsed directions', () => {
    const html = renderPanel();

    assert.match(html, /class="todo-group-chevron collapse-icon"[\s\S]*<svg/);
    assert.match(todoScript, /class="todo-group-chevron collapse-icon"[\s\S]*<svg/);
    assert.doesNotMatch(todoScript, /<span class="collapse-icon"[^>]*>⌄<\/span>/);
    assert.match(styles, /\.todo-group-chevron\s*\{[\s\S]*display:\s*grid[\s\S]*place-items:\s*center/);
    assert.match(styles, /\.todo-group\.collapsed \.todo-group-chevron svg\s*\{[\s\S]*transform:\s*rotate\(-90deg\)/);
});
