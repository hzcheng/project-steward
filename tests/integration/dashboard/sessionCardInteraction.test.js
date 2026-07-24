'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectWebviewSource = fs.readFileSync(
    path.join(__dirname, '../../../src/webview/webviewProjectScripts.js'),
    'utf8'
);

function loadCardActivation() {
    const context = {};
    vm.runInNewContext(projectWebviewSource, context, {
        filename: 'webviewProjectScripts.js',
    });
    return context.getAiSessionCardActivation;
}

const getAiSessionCardActivation = loadCardActivation();

function normalizeRealmValue(value) {
    return JSON.parse(JSON.stringify(value));
}

function createRow(attributes) {
    const values = new Map(Object.entries(attributes));
    return {
        getAttribute(name) {
            return values.get(name) || null;
        },
        hasAttribute(name) {
            return values.has(name);
        },
        closest(selector) {
            return selector === '.codex-session-row' ? this : null;
        },
    };
}

function createTarget(row, options = {}) {
    return {
        closest(selector) {
            if (selector === '[data-action="activate-ai-session"]') {
                return options.primary ? this : null;
            }
            if (selector === 'button, input, select, textarea, a[href], [data-action]') {
                return options.interactive || options.primary ? this : null;
            }
            if (selector === '.codex-session-row') {
                return row;
            }
            return null;
        },
    };
}

test('WEBVIEW-AI-SESSION-CARD-ACTIVATION-001 maps card bodies and the primary action to exact host messages', () => {
    const active = createRow({
        'data-session-id': 'active-session',
        'data-session-provider': 'codex',
        'data-session-active': '',
    });
    const inactive = createRow({
        'data-session-id': 'inactive-session',
        'data-session-provider': 'kimi',
    });
    const pending = createRow({
        'data-session-provider': 'claude',
        'data-session-pending': '',
        'data-pending-created-at': '2026-07-24T00:00:00.000Z',
    });

    assert.deepEqual(
        normalizeRealmValue(getAiSessionCardActivation(createTarget(active), 'project-a').message),
        {
            type: 'focus-ai-session-terminal',
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'active-session',
        }
    );
    assert.deepEqual(
        normalizeRealmValue(getAiSessionCardActivation(createTarget(inactive), 'project-a').message),
        {
            type: 'resume-kimi-session',
            projectId: 'project-a',
            sessionId: 'inactive-session',
        }
    );
    assert.deepEqual(
        normalizeRealmValue(getAiSessionCardActivation(createTarget(pending), 'project-a').message),
        {
            type: 'focus-pending-ai-session',
            projectId: 'project-a',
            provider: 'claude',
            createdAt: '2026-07-24T00:00:00.000Z',
        }
    );
    assert.deepEqual(
        normalizeRealmValue(
            getAiSessionCardActivation(createTarget(active, { primary: true }), 'project-a').message
        ),
        {
            type: 'focus-ai-session-terminal',
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'active-session',
        }
    );
});

test('WEBVIEW-AI-SESSION-CARD-ACTIVATION-001 consumes nested controls without activating their session', () => {
    const row = createRow({
        'data-session-id': 'session-a',
        'data-session-provider': 'codex',
        'data-session-active': '',
    });
    const result = getAiSessionCardActivation(
        createTarget(row, { interactive: true }),
        'project-a'
    );

    assert.equal(result.handled, true);
    assert.equal(result.sessionRow, null);
    assert.equal(result.message, null);
});
