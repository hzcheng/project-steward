'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fail(id, risk, detail) {
    throw new assert.AssertionError({ message: `${id} risk: ${risk}; ${detail}` });
}

function read(root, relativePath, id, risk) {
    try {
        return fs.readFileSync(path.join(root, relativePath), 'utf8');
    } catch (error) {
        fail(id, risk, `cannot inspect ${relativePath}: ${error.message}`);
    }
}

function requirePattern(source, pattern, id, risk, detail) {
    if (!pattern.test(source)) {
        fail(id, risk, detail);
    }
}

function readJson(root, relativePath, id, risk) {
    try {
        return JSON.parse(read(root, relativePath, id, risk));
    } catch (error) {
        if (error instanceof assert.AssertionError) {
            throw error;
        }
        fail(id, risk, `${relativePath} must contain valid JSON: ${error.message}`);
    }
}

const guards = {
    // ARCH-AI-SESSION-SCAN-BOUNDARY-001
    'ARCH-AI-SESSION-SCAN-BOUNDARY-001'(root) {
        const risk = 'unbounded provider scans can block the extension host';
        const dashboard = read(root, 'src/dashboard.ts', this.id, risk);
        const hydration = read(root, 'src/aiSessions/projectHydrationController.ts', this.id, risk);
        requirePattern(dashboard, /AI_SESSION_INCREMENTAL_SCAN_MAX_FILES\s*=\s*[1-9][0-9]*/, this.id, risk,
            'incremental scans must keep a positive finite file budget');
        requirePattern(hydration, /getAiSessionScanMaxFiles\(reason, this\.options\.incrementalScanMaxFiles\)/,
            this.id, risk, 'project hydration must apply the bounded scan policy');
        requirePattern(hydration, /readCoordinator\.getResults\(\{ candidatePaths, reason, maxFiles \}\)/,
            this.id, risk, 'the scan budget must reach every provider through the read coordinator');
    },

    // ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001
    'ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001'(root) {
        const risk = 'high-frequency watcher updates can trigger expensive full dashboard refreshes';
        const controller = read(root, 'src/aiSessions/dashboardController.ts', this.id, risk);
        requirePattern(controller, /scheduleRefresh\('watcher'\)/, this.id, risk,
            'provider watchers must use the coalesced incremental refresh path');
        const fallbackReasons = [...controller.matchAll(/this\.options\.refresh\('([^']+)'\)/g)].map(match => match[1]);
        const expected = [
            'ai-session-update-not-delivered',
            'ai-session-update-post-error',
            'ai-session-update-build-error',
        ];
        if (fallbackReasons.length !== expected.length || expected.some(reason => !fallbackReasons.includes(reason))) {
            fail(this.id, risk, `full refresh is allowed only for explicit delivery fallbacks: ${expected.join(', ')}`);
        }
    },

    // ARCH-AI-SESSION-FALLBACK-REASON-001
    'ARCH-AI-SESSION-FALLBACK-REASON-001'(root) {
        const risk = 'anonymous fallbacks hide the regression path and defeat diagnostics';
        const dashboard = read(root, 'src/dashboard.ts', this.id, risk);
        for (const reason of [
            'evaluate-attention-closed-terminal',
            'sync-focused-runtime',
            "`${fallback.operation}-fallback`",
        ]) {
            if (!dashboard.includes(reason)) {
                fail(this.id, risk, `missing explicit fallback reason ${reason}`);
            }
        }
    },

    // ARCH-PROVIDER-REGISTRY-COMPLETENESS-001
    'ARCH-PROVIDER-REGISTRY-COMPLETENESS-001'(root) {
        const risk = 'an incomplete provider registry silently drops a supported provider';
        const providers = read(root, 'src/aiSessions/providers.ts', this.id, risk);
        requirePattern(providers, /AI_SESSION_PROVIDER_IDS[^=]*=\s*\['codex', 'kimi', 'claude'\]/,
            this.id, risk, 'the supported provider ID list must remain complete and ordered');
        for (const provider of ['codex', 'kimi', 'claude']) {
            requirePattern(providers, new RegExp(`\\n\\s*${provider}:\\s*\\{[\\s\\S]*?id:\\s*'${provider}'`),
                this.id, risk, `provider definition ${provider} is missing or mismatched`);
        }
        requirePattern(providers, /AI_SESSION_PROVIDER_IDS\.map\(id => \(\{[\s\S]*?service: services\[id\]/,
            this.id, risk, 'registry construction must cover every declared provider and service');
    },

    // ARCH-PROTOCOL-001
    'ARCH-PROTOCOL-001'(root) {
        const risk = 'protocol drift breaks compatibility between workspace and UI extension hosts';
        const openProtocol = read(root, 'src/openProjects/protocol.ts', this.id, risk);
        const attentionProtocol = read(root, 'src/aiSessions/attentionPayload.ts', this.id, risk);
        const attentionClient = read(root, 'src/aiSessions/attentionBridgeClient.ts', this.id, risk);
        const bridgeCoordinator = read(root, 'extensions/attention-ui-bridge/src/openProjectCoordinator.ts', this.id, risk);
        const bridgeExtension = read(root, 'extensions/attention-ui-bridge/src/extension.ts', this.id, risk);
        requirePattern(openProtocol, /OPEN_PROJECT_PROTOCOL_VERSION\s*=\s*1\s*;/, this.id, risk,
            'open-project protocol version must remain 1 until an explicit migration exists');
        requirePattern(attentionProtocol, /ATTENTION_PAYLOAD_VERSION\s*=\s*1\s*;/, this.id, risk,
            'attention payload version must remain 1 until an explicit migration exists');
        requirePattern(attentionProtocol, /record\.protocolVersion !== 1/, this.id, risk,
            'attention handshake validation must remain on protocol version 1');
        requirePattern(attentionClient, /protocolVersion:\s*1/, this.id, risk,
            'the workspace attention client must emit protocol version 1');
        requirePattern(bridgeCoordinator, /OPEN_PROJECT_PROTOCOL_VERSION/, this.id, risk,
            'the UI Bridge must consume the shared open-project protocol version');
        requirePattern(bridgeExtension, /protocolVersion:\s*1/, this.id, risk,
            'the UI Bridge attention endpoint must emit protocol version 1');
    },

    // ARCH-RELEASE-IDENTITY-001
    'ARCH-RELEASE-IDENTITY-001'(root) {
        const risk = 'release identity drift produces uninstallable or disconnected VSIX artifacts';
        const main = readJson(root, 'package.json', this.id, risk);
        const bridge = readJson(root, 'extensions/attention-ui-bridge/package.json', this.id, risk);
        if (main.name !== 'project-steward' || main.publisher !== 'hzcheng') {
            fail(this.id, risk, 'main extension identity must remain hzcheng.project-steward');
        }
        if (bridge.name !== 'project-steward-attention-ui-bridge' || bridge.publisher !== 'hzcheng') {
            fail(this.id, risk, 'UI Bridge identity must remain hzcheng.project-steward-attention-ui-bridge');
        }
        if (!Array.isArray(main.extensionDependencies)
            || !main.extensionDependencies.includes('hzcheng.project-steward-attention-ui-bridge')) {
            fail(this.id, risk, 'main extension must retain its exact UI Bridge dependency identity');
        }
    },
};

function validateArchitectureGuards(root, options = {}) {
    const ids = options.ids || Object.keys(guards);
    for (const id of ids) {
        if (!guards[id]) {
            throw new Error(`unknown architecture guard ${id}`);
        }
        guards[id].call({ id }, root);
    }
}

if (require.main === module) {
    validateArchitectureGuards(path.resolve(__dirname, '..'));
    console.log('Architecture guards passed.');
}

module.exports = { validateArchitectureGuards };
