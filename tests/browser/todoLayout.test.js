'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { getTodoPanelContent } = require('../../out/todos/webviewContent');
const { buildTodoViewModel } = require('../../out/todos/viewModel');

const NOW = '2026-07-24T00:00:00.000Z';
const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const todoScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoScripts.js'),
    'utf8'
);

function createSnapshot() {
    return {
        version: 1,
        revision: 1,
        showCompleted: false,
        data: {
            version: 1,
            groups: [{ id: 'group-a', title: 'Work', collapsed: false, order: 0 }],
            todos: [{
                id: 'todo-a',
                groupId: 'group-a',
                title: 'A deliberately long title that must remain fully readable in a narrow sidebar without clipping',
                notes: Array.from(
                    { length: 12 },
                    (_, index) => `Detailed context line ${index + 1} that wraps in the sidebar.`
                ).join('\n'),
                priority: 'high',
                completed: false,
                createdAt: NOW,
                updatedAt: NOW,
                order: 0,
            }, {
                id: 'todo-b',
                groupId: 'group-a',
                title: 'Following card',
                notes: '',
                priority: 'medium',
                completed: false,
                createdAt: NOW,
                updatedAt: NOW,
                order: 1,
            }],
        },
    };
}

function renderInitialPanel(snapshot) {
    return getTodoPanelContent(
        buildTodoViewModel(snapshot.data, { showCompleted: snapshot.showCompleted }),
        { maxVisibleTodosPerGroup: 1 }
    );
}

test('TODO-BROWSER-EXPANDED-LAYOUT-001 gives an expanded card its full Chromium layout height', async t => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 280, height: 900 } });
    const snapshot = createSnapshot();
    const panel = renderInitialPanel(snapshot);

    await page.setContent(`<!doctype html>
        <html>
            <head><style>${styles}</style></head>
            <body class="steward-sidebar">
                <section id="todo-host">${panel}</section>
            </body>
        </html>`);
    await page.addScriptTag({ content: todoScript });
    await page.evaluate(value => {
        window.vscode = { postMessage() {} };
        window.__todoController = initTodos({ postMessage() {} });
        window.__todoController.mount(document.getElementById('todo-host'), value);
        window.__siblingTodo = document.querySelector('[data-todo-id="todo-b"]');
    }, snapshot);

    const collapsedHeight = await page.locator('.todo-list').evaluate(element => element.clientHeight);
    await page.locator('[data-action="todo-open-detail"][data-todo-id="todo-a"]').click();
    await page.waitForFunction(() => {
        const item = document.querySelector('[data-todo-id="todo-a"]');
        return item
            && item.classList.contains('expanded')
            && parseFloat(getComputedStyle(item).height) > 58;
    });

    const expanded = await page.evaluate(() => {
        const list = document.querySelector('.todo-list');
        const item = document.querySelector('[data-todo-id="todo-a"]');
        const detail = item.querySelector('.todo-inline-detail');
        const sibling = document.querySelector('[data-todo-id="todo-b"]');
        const itemRect = item.getBoundingClientRect();
        const detailRect = detail.getBoundingClientRect();
        const siblingRect = sibling.getBoundingClientRect();
        return {
            listClientHeight: list.clientHeight,
            listScrollHeight: list.scrollHeight,
            itemClientHeight: item.clientHeight,
            itemScrollHeight: item.scrollHeight,
            detailBottom: detailRect.bottom,
            itemBottom: itemRect.bottom,
            siblingTop: siblingRect.top,
            siblingPreserved: sibling === window.__siblingTodo,
        };
    });

    assert.ok(expanded.listClientHeight > collapsedHeight);
    assert.ok(expanded.itemClientHeight + 1 >= expanded.itemScrollHeight);
    assert.ok(expanded.itemBottom + 1 >= expanded.detailBottom);
    assert.ok(expanded.siblingTop + 1 >= expanded.itemBottom);
    assert.ok(expanded.listScrollHeight >= expanded.itemClientHeight);
    assert.equal(expanded.siblingPreserved, true);

    await page.locator('[data-action="todo-open-detail"][data-todo-id="todo-a"]').click();
    await page.waitForFunction(() =>
        !document.querySelector('[data-todo-id="todo-a"]').classList.contains('expanded')
    );
    const restored = await page.locator('.todo-list').evaluate(element => ({
        clientHeight: element.clientHeight,
        expandedExtra: element.style.getPropertyValue('--todo-list-expanded-extra-height'),
    }));
    assert.equal(restored.clientHeight, collapsedHeight);
    assert.equal(restored.expandedExtra, '0px');
});
