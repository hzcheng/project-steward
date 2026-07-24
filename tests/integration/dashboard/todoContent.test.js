'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    getTodoPanelContent,
    getUnsupportedTodoVersionPanelContent,
} = require('../../../out/todos/webviewContent');
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
const dashboardSource = fs.readFileSync(
    path.join(__dirname, '../../../src/dashboard.ts'),
    'utf8'
);
const packageJson = fs.readFileSync(
    path.join(__dirname, '../../../package.json'),
    'utf8'
);

function renderPanel(options) {
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
    return getTodoPanelContent(buildTodoViewModel(data, { showCompleted: false }), options);
}

test('TODO-TODO-CONTINUOUS-LAYOUT-001 renders one stable page with inline list details', () => {
    const html = renderPanel();

    assert.match(html, /class="todo-panel"/);
    assert.match(html, /class="todo-list-surface"/);
    assert.doesNotMatch(html, /class="todo-detail-surface"/);
});

test('TODO-QUICK-CREATE-001 renders the full add form with a fixed group', () => {
    const html = renderPanel();
    const quickAddMarkup = html.match(
        /<form class="[^"]*" data-todo-form="quick-add"[\s\S]*?<\/form>/
    )[0];

    assert.match(quickAddMarkup, /class="todo-add-form todo-compose-panel steward-card"/);
    assert.match(quickAddMarkup, /name="title"/);
    assert.match(quickAddMarkup, /name="notes"/);
    assert.match(quickAddMarkup, /name="priority"/);
    assert.match(quickAddMarkup, /name="groupId" value="group-a"/);
    assert.match(quickAddMarkup, />Work<\/span>/);
    assert.doesNotMatch(quickAddMarkup, /<select name="groupId"/);
});

test('TODO-MAX-VISIBLE-PER-GROUP-001 applies the configured per-group viewport and safe fallback', () => {
    const configuredHtml = renderPanel({ maxVisibleTodosPerGroup: 2.9 });
    const fallbackHtml = renderPanel({ maxVisibleTodosPerGroup: 0 });

    assert.match(
        configuredHtml,
        /class="todo-panel" style="--todo-visible-items: 2; --todo-collapsed-item-height: 58px; --todo-list-max-height: 123px;"/
    );
    assert.match(
        fallbackHtml,
        /class="todo-panel" style="--todo-visible-items: 5; --todo-collapsed-item-height: 58px; --todo-list-max-height: 318px;"/
    );
    assert.match(
        styles,
        /\.todo-list\s*\{[\s\S]*max-height:\s*calc\(var\(--todo-list-max-height\) \+ var\(--todo-list-expanded-extra-height,\s*0px\)\)[\s\S]*overflow-y:\s*auto/
    );
    assert.match(
        styles,
        /\.todo-item\.expanded\s*\{[\s\S]*height:\s*var\(--todo-expanded-item-height,\s*auto\) !important/
    );
    assert.match(dashboardSource, /function getMaxVisibleTodosPerGroup\(/);
    assert.match(
        dashboardSource,
        /maxVisibleTodosPerGroup:\s*getMaxVisibleTodosPerGroup\(config\)/
    );
    assert.match(
        packageJson,
        /Maximum number of TODO cards visible in each group before the group list scrolls\./
    );
});

test('TODO-PAGE-HIERARCHY-001 separates the page command bar from real group headers', () => {
    const html = renderPanel();
    const pageHeaderMarkup = html.match(/<header class="todo-page-header[^>]*>[\s\S]*?<\/header>/)[0];
    const pageHeader = pageHeaderMarkup.match(/<header class="todo-page-header[^"]*"/)[0];
    const errorPageHeader = getUnsupportedTodoVersionPanelContent(2)
        .match(/<header class="todo-page-header[^"]*"/)[0];

    assert.match(pageHeader, /todo-page-command-bar/);
    assert.doesNotMatch(pageHeader, /(?:group-title|steward-group-header)/);
    assert.match(errorPageHeader, /todo-page-command-bar/);
    assert.doesNotMatch(errorPageHeader, /(?:group-title|steward-group-header)/);
    assert.match(html, /class="todo-group-header group-title steward-group-header"/);
    assert.match(todoScript, /todo-page-header todo-page-command-bar/);
    assert.doesNotMatch(todoScript, /todo-page-header group-title steward-group-header/);
    assert.equal((pageHeaderMarkup.match(/<svg /g) || []).length, 3);
    assert.match(todoScript, /aria-label="Add todo">'\s*\+\s*renderTodoCommandIcon\('add'\)/);
    assert.match(todoScript, /aria-label="Add group">'\s*\+\s*renderTodoCommandIcon\('group'\)/);
    assert.match(todoScript, /<span>'\s*\+\s*renderTodoCommandIcon\('completed'\)/);
    assert.doesNotMatch(todoScript, /aria-label="Add todo">＋<\/button>/);
    assert.doesNotMatch(todoScript, /aria-label="Add group">☷<\/button>/);
    assert.match(styles, /\.todo-page-command-bar\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/);
    assert.match(styles, /\.todo-page-command-bar \.todo-summary-actions\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*all/);
    assert.match(styles, /\.todo-page-command-bar \.todo-summary-actions svg\s*\{[^}]*width:\s*14px[^}]*height:\s*14px/);
});

test('TODO-TODO-FOCUSED-DETAIL-001 makes the title an inline disclosure and drag a separate affordance', () => {
    const html = renderPanel();

    assert.match(html, /data-action="todo-open-detail" data-todo-id="todo-medium"/);
    assert.match(html, /data-action="todo-open-detail"[^>]*aria-expanded="false"/);
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
