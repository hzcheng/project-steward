'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { getAttentionProjectKey } = require('../../../out/aiSessions/attentionProject');

function loadRenderer() {
    const vscode = createFakeVscode({});
    vscode.Uri = { file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }) };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        delete require.cache[require.resolve('../../../out/webview/webviewContent')];
        return require('../../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const renderer = loadRenderer();
const config = {
    get: (_key, defaultValue) => defaultValue,
    displayProjectPath: false,
    searchIsActiveByDefault: false,
    showAddGroupButtonTile: false,
};

function stewardContent(openProjects) {
    return renderer.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test-source', asWebviewUri: uri => uri.toString() },
        [],
        {
            config,
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
            openProjects,
        },
        true
    );
}

test('ATTENTION-ATTENTION-PROJECT-RENDERING-001 saved project cards never expose runtime attention ownership', () => {
    const path = '/work/remote-repo';
    const projectKey = getAttentionProjectKey(path);
    const html = renderer.getProjectsPanelContent([{
        id: 'group', groupName: 'Work', collapsed: false,
        projects: [{
            id: 'saved-remote', name: 'Remote Repo', path, color: '#00aacc',
            aiSessionAttentionCount: 2,
            aiSessionAttentionEventIds: ['event-1', 'event-2'],
        }],
    }], { config, otherStorageHasData: false });

    assert.ok(!html.includes(`data-attention-project-key="${projectKey}"`));
    assert.doesNotMatch(html, /class="project-ai-attention-badge"/);
    assert.doesNotMatch(html, /\/work\/remote-repo" data-attention-project-key/);
});

test('ATTENTION-ATTENTION-PROJECT-RENDERING-001 OPEN cards render positive counts and hide quiet or stale attention', () => {
    const activeHtml = stewardContent([{
        id: 'open-project', name: 'Open Repo', path: '/work/open-repo', color: '#00aacc',
        aiSessionAttentionCount: 2,
        codexSessions: [{
            id: 'codex-one', name: 'Codex One', active: true,
            attention: { eventId: 'local-event', reason: 'input-required', unread: true },
        }],
        activeAiSessions: [{
            key: 'codex:codex-one', provider: 'codex', sessionId: 'codex-one', name: 'Codex One',
            executionState: 'stopped', focused: false, needsAttention: true, pending: false,
            backend: 'vscode', attached: true, stale: false,
        }],
    }]);
    assert.doesNotMatch(activeHtml, /class="project-ai-attention-badge"/);
    assert.match(activeHtml, /class="project-codex-badge"/);
    assert.doesNotMatch(activeHtml, /project-codex-badge has-attention/);
    assert.match(activeHtml, /class="ai-session-total-count">AI 1<\/span>/);
    assert.match(activeHtml, /class="ai-session-active-count" aria-label="1 active AI session">/);
    assert.match(activeHtml, /class="ai-session-attention-count" aria-label="1 AI session needs attention">1<\/b>/);
    assert.match(activeHtml, /data-ai-session-attention data-session-event-id="local-event"/);

    const quietHtml = stewardContent([{
        id: 'quiet-project', name: 'Quiet', path: '/work/quiet', color: '#00aacc',
        codexSessions: [{ id: 'history', name: 'History' }], activeAiSessions: [],
    }]);
    assert.doesNotMatch(quietHtml, /class="ai-session-active-count"/);
    assert.doesNotMatch(quietHtml, /class="ai-session-attention-count"/);

    const staleHtml = stewardContent([{
        id: 'stale-project', name: 'Stale', path: '/work/stale', color: '#00aacc',
        codexSessions: [{ id: 'stale-session', name: 'Stale Session', active: true }],
        activeAiSessions: [{
            key: 'codex:stale-session', provider: 'codex', sessionId: 'stale-session',
            name: 'Stale Session', executionState: 'unknown', focused: false,
            needsAttention: false, pending: false, backend: 'tmux', attached: false, stale: true,
        }],
    }]);
    assert.match(staleHtml, /data-session-stale/);
    assert.match(staleHtml, /Runtime status is stale/);
    const staleRow = staleHtml.match(/<div class="codex-session-row active-ai-session-row"[\s\S]*?<\/div><\/div>/)?.[0];
    assert.ok(staleRow, 'the stale runtime row is rendered');
    assert.doesNotMatch(staleRow, /data-ai-session-attention|data-session-needs-attention/);
    assert.doesNotMatch(staleHtml, /class="ai-session-attention-count"/);
});
