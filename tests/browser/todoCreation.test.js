'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { getTodoPanelContent } = require('../../out/todos/webviewContent');
const { buildTodoViewModel } = require('../../out/todos/viewModel');

const projectScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectScripts.js'),
    'utf8'
);
const todoScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoScripts.js'),
    'utf8'
);
const snapshot = {
    version: 1,
    revision: 1,
    showCompleted: false,
    data: {
        version: 1,
        groups: [{ id: 'group-a', title: 'Planning', collapsed: false, order: 0 }],
        todos: [],
    },
};

test('TODO-SINGLE-CREATE-DISPATCH-001 submits one group composer through only the dedicated Todo controller', async t => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    const panel = getTodoPanelContent(
        buildTodoViewModel(snapshot.data, { showCompleted: snapshot.showCompleted }),
        { maxVisibleTodosPerGroup: 5 }
    );

    await page.setContent(`<!doctype html>
        <html>
            <body class="steward-sidebar">
                <div class="steward-sticky-header"></div>
                <section id="dashboard-tab-todo">
                    <div id="todo-host">${panel}</div>
                </section>
            </body>
        </html>`);
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.vscode = {
            getState: () => undefined,
            setState: () => undefined,
            postMessage: message => window.__postedMessages.push(message),
        };
    });
    await page.addScriptTag({ content: projectScript });
    await page.addScriptTag({ content: todoScript });
    await page.evaluate(value => {
        initProjects();
        window.__todoController = initTodos({
            postMessage: message => window.__postedMessages.push(message),
        });
        window.__todoController.mount(document.getElementById('todo-host'), value);
        window.__postedMessages.length = 0;
    }, snapshot);

    await page.locator('[data-action="todo-quick-add"][data-group-id="group-a"]').click();
    const form = page.locator('form[data-todo-form="quick-add"][data-group-id="group-a"]');
    await form.locator('[name="title"]').fill('One task');
    await form.locator('[name="notes"]').fill('Created once');
    await form.dispatchEvent('submit');

    const addIntents = await page.evaluate(() => window.__postedMessages.filter(message =>
        (message.type === 'todo-command' && message.action === 'add')
        || message.type === 'todo-add'
    ));
    assert.deepEqual(
        addIntents.map(message => message.type),
        ['todo-command']
    );
});
