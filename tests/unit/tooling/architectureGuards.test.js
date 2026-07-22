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

function copyGuardFixture(t, mutationPath, mutate = source => source) {
    const relativePaths = [
        'src/dashboard.ts',
        'src/aiSessions/projectHydrationController.ts',
        'src/aiSessions/dashboardController.ts',
        'src/aiSessions/providers.ts',
        'src/aiSessions/attentionAggregate.ts',
        'src/openProjects/protocol.ts',
        'src/openProjects/bridgeClient.ts',
        'src/aiSessions/attentionPayload.ts',
        'src/aiSessions/attentionBridgeClient.ts',
        'extensions/attention-ui-bridge/src/openProjectCoordinator.ts',
        'extensions/attention-ui-bridge/src/extension.ts',
        'package.json',
        'extensions/attention-ui-bridge/package.json',
    ];
    const files = Object.fromEntries(relativePaths.map(relativePath => {
        const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
        if (relativePath !== mutationPath) return [relativePath, source];
        const mutated = mutate(source);
        assert.notEqual(mutated, source, `controlled mutation must change ${mutationPath}`);
        return [relativePath, mutated];
    }));
    return writeFixture(t, files);
}

function replaceFixtureSource(source, search, replacement, suffix = '') {
    assert.ok(source.includes(search), `controlled mutation must find ${search}`);
    const replaced = source.replace(search, replacement);
    assert.notEqual(replaced, source, `controlled mutation must replace ${search}`);
    return replaced + suffix;
}

test('complete production fixture satisfies every architecture guard without mutation', t => {
    validateArchitectureGuards(copyGuardFixture(t));
});

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
        expectedDetail: 'incremental scans must keep a positive finite file budget',
        mutate: source => replaceFixtureSource(source,
            'AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000',
            'AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 0',
            '\nconst OLD_AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000;\n'),
    },
    {
        id: 'ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001',
        file: 'src/aiSessions/dashboardController.ts',
        expectedDetail: 'provider watchers must use the coalesced incremental refresh path exactly once',
        mutate: source => replaceFixtureSource(source,
            "this.scheduleRefresh('watcher')", "this.options.refresh('watcher')",
            "\n// this.scheduleRefresh('watcher')\n"),
    },
    {
        id: 'ARCH-AI-SESSION-FALLBACK-REASON-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'focused-runtime fallback must have an explicit diagnostic reason',
        mutate: source => replaceFixtureSource(source,
            "onError: error => logAiSessionRuntimeFailure('sync-focused-runtime', error)",
            "onError: error => logAiSessionRuntimeFailure('sync-runtime', error)",
            "\nfunction deadFallbackDecoy(error: unknown) {"
                + " logAiSessionRuntimeFailure('sync-focused-runtime', error); }\n"),
    },
    {
        id: 'ARCH-PROVIDER-REGISTRY-COMPLETENESS-001',
        file: 'src/aiSessions/providers.ts',
        expectedDetail: 'the supported provider ID list must remain complete and ordered',
        mutate: source => replaceFixtureSource(source,
            "['codex', 'kimi', 'claude']", "['codex', 'kimi']",
            "\nconst OLD_AI_SESSION_PROVIDER_IDS = ['codex', 'kimi', 'claude'];\n"),
    },
    {
        id: 'ARCH-PROTOCOL-001',
        file: 'src/openProjects/protocol.ts',
        expectedDetail: 'open-project protocol version must remain 1 until an explicit migration exists',
        mutate: source => replaceFixtureSource(source,
            'OPEN_PROJECT_PROTOCOL_VERSION = 1', 'OPEN_PROJECT_PROTOCOL_VERSION = 2',
            '\nconst OLD_OPEN_PROJECT_PROTOCOL_VERSION = 1;\n'),
    },
    {
        id: 'ARCH-PROTOCOL-001',
        file: 'src/aiSessions/attentionBridgeClient.ts',
        expectedDetail: 'attention client unregister writer must contain exactly one protocolVersion: 1',
        mutate: source => replaceFixtureSource(source,
            '{ protocolVersion: 1, instanceId: this.instanceId }',
            '{ protocolVersion: 2, instanceId: this.instanceId }'),
    },
    {
        id: 'ARCH-PROTOCOL-001',
        file: 'src/aiSessions/attentionPayload.ts',
        expectedDetail: 'validateAttentionUnregisterRequest validator and normalized return must contain exactly one record.protocolVersion !== 1',
        mutate: source => replaceFixtureSource(source,
            "if (record.protocolVersion !== 1) throw new Error('attention unregister protocol is incompatible');",
            "if (record.protocolVersion !== 2) throw new Error('attention unregister protocol is incompatible');"),
    },
    {
        id: 'ARCH-RELEASE-IDENTITY-001',
        file: 'package.json',
        expectedDetail: 'main extension identity must remain hzcheng.project-steward',
        mutate: source => replaceFixtureSource(source,
            '"publisher": "hzcheng"', '"publisher": "changed"'),
    },
]) {
    test(`${mutation.id} controlled mutation is rejected at its exact expectation site`, t => {
        const root = copyGuardFixture(t, mutation.file, mutation.mutate);
        assert.throws(
            () => validateArchitectureGuards(root, { ids: [mutation.id] }),
            error => error.message.includes(mutation.id)
                && /risk:/i.test(error.message)
                && error.message.includes(mutation.expectedDetail)
        );
    });
}
