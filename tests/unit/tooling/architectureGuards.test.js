'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateArchitectureGuards } = require('../../../scripts/run-architecture-guards');
const repositoryRoot = path.resolve(__dirname, '../../..');

function writeFixture(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-architecture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [relativePath, contents] of Object.entries(files)) {
        const target = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    return root;
}

function copyGuardFixture(t, mutationPath, mutate) {
    const relativePaths = [
        'src/dashboard.ts',
        'src/aiSessions/projectHydrationController.ts',
        'src/aiSessions/dashboardController.ts',
        'src/aiSessions/providers.ts',
        'src/openProjects/protocol.ts',
        'src/aiSessions/attentionPayload.ts',
        'src/aiSessions/attentionBridgeClient.ts',
        'extensions/attention-ui-bridge/src/openProjectCoordinator.ts',
        'extensions/attention-ui-bridge/src/extension.ts',
        'package.json',
        'extensions/attention-ui-bridge/package.json',
    ];
    const files = Object.fromEntries(relativePaths.map(relativePath => {
        const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
        return [relativePath, relativePath === mutationPath ? mutate(source) : source];
    }));
    return writeFixture(t, files);
}

test('ARCH-AI-SESSION-SCAN-BOUNDARY-001 reports the ID and unbounded-scan risk', t => {
    const root = writeFixture(t, {});
    assert.throws(
        () => validateArchitectureGuards(root, { ids: ['ARCH-AI-SESSION-SCAN-BOUNDARY-001'] }),
        error => /ARCH-AI-SESSION-SCAN-BOUNDARY-001/.test(error.message)
            && /risk:/i.test(error.message)
            && /unbounded/i.test(error.message)
    );
});

test('ARCH-PROTOCOL-001 reports the ID and compatibility risk for an unstable protocol', t => {
    const root = writeFixture(t, {
        'src/openProjects/protocol.ts': 'export const OPEN_PROJECT_PROTOCOL_VERSION = 2;\n',
    });
    assert.throws(
        () => validateArchitectureGuards(root, { ids: ['ARCH-PROTOCOL-001'] }),
        error => /ARCH-PROTOCOL-001/.test(error.message)
            && /risk:/i.test(error.message)
            && /compatib/i.test(error.message)
    );
});

test('ARCH-RELEASE-IDENTITY-001 reports the ID and release risk for malformed metadata', t => {
    const root = writeFixture(t, {
        'package.json': '{bad json',
        'extensions/attention-ui-bridge/package.json': '{}',
    });
    assert.throws(
        () => validateArchitectureGuards(root, { ids: ['ARCH-RELEASE-IDENTITY-001'] }),
        error => /ARCH-RELEASE-IDENTITY-001/.test(error.message)
            && /risk:/i.test(error.message)
            && /release identity/i.test(error.message)
    );
});

test('architecture guard runner rejects unknown guard IDs', () => {
    assert.throws(
        () => validateArchitectureGuards(repositoryRoot, { ids: ['ARCH-UNKNOWN-001'] }),
        /unknown architecture guard ARCH-UNKNOWN-001/
    );
});

for (const mutation of [
    {
        id: 'ARCH-AI-SESSION-SCAN-BOUNDARY-001',
        file: 'src/dashboard.ts',
        mutate: source => source.replace('AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000',
            'AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 0')
            + '\nconst OLD_AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000;\n',
    },
    {
        id: 'ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001',
        file: 'src/aiSessions/dashboardController.ts',
        mutate: source => source.replace("this.scheduleRefresh('watcher')", "this.options.refresh('watcher')")
            + "\n// this.scheduleRefresh('watcher')\n",
    },
    {
        id: 'ARCH-AI-SESSION-FALLBACK-REASON-001',
        file: 'src/dashboard.ts',
        mutate: source => source.replace("'sync-focused-runtime'", "'sync-runtime'")
            + "\n// 'sync-focused-runtime'\n",
    },
    {
        id: 'ARCH-PROVIDER-REGISTRY-COMPLETENESS-001',
        file: 'src/aiSessions/providers.ts',
        mutate: source => source.replace("['codex', 'kimi', 'claude']", "['codex', 'kimi']")
            + "\nconst OLD_AI_SESSION_PROVIDER_IDS = ['codex', 'kimi', 'claude'];\n",
    },
    {
        id: 'ARCH-PROTOCOL-001',
        file: 'src/openProjects/protocol.ts',
        mutate: source => source.replace('OPEN_PROJECT_PROTOCOL_VERSION = 1', 'OPEN_PROJECT_PROTOCOL_VERSION = 2')
            + '\nconst OLD_OPEN_PROJECT_PROTOCOL_VERSION = 1;\n',
    },
    {
        id: 'ARCH-RELEASE-IDENTITY-001',
        file: 'package.json',
        mutate: source => source.replace('"publisher": "hzcheng"', '"publisher": "changed"'),
    },
]) {
    test(`${mutation.id} controlled mutation is rejected with risk context`, t => {
        const root = copyGuardFixture(t, mutation.file, mutation.mutate);
        assert.throws(
            () => validateArchitectureGuards(root, { ids: [mutation.id] }),
            error => error.message.includes(mutation.id) && /risk:/i.test(error.message)
        );
    });
}
