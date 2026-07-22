'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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

function parseTypescript(root, relativePath, id, risk) {
    const source = read(root, relativePath, id, risk);
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (sourceFile.parseDiagnostics.length) {
        fail(id, risk, `${relativePath} must parse as TypeScript`);
    }
    return sourceFile;
}

function walk(node, visit) {
    visit(node);
    ts.forEachChild(node, child => walk(child, visit));
}

function findVariable(sourceFile, name, id, risk) {
    const matches = [];
    walk(sourceFile, node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
            matches.push(node);
        }
    });
    if (matches.length !== 1) {
        fail(id, risk, `${name} must have exactly one real declaration`);
    }
    return matches[0];
}

function numericInitializer(sourceFile, name, id, risk) {
    const declaration = findVariable(sourceFile, name, id, risk);
    if (!declaration.initializer || !ts.isNumericLiteral(declaration.initializer)) {
        fail(id, risk, `${name} must use a numeric literal initializer`);
    }
    return Number(declaration.initializer.text);
}

function stringArrayInitializer(sourceFile, name, id, risk) {
    const declaration = findVariable(sourceFile, name, id, risk);
    if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)
        || declaration.initializer.elements.some(element => !ts.isStringLiteral(element))) {
        fail(id, risk, `${name} must use a string-literal array initializer`);
    }
    return declaration.initializer.elements.map(element => element.text);
}

function callArguments(sourceFile, calleeText) {
    const calls = [];
    walk(sourceFile, node => {
        if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === calleeText) {
            calls.push(node.arguments);
        }
    });
    return calls;
}

function stringArgument(argument) {
    return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ? argument.text
        : undefined;
}

const guards = {
    // ARCH-AI-SESSION-SCAN-BOUNDARY-001
    'ARCH-AI-SESSION-SCAN-BOUNDARY-001'(root) {
        const risk = 'unbounded provider scans can block the extension host';
        const dashboard = parseTypescript(root, 'src/dashboard.ts', this.id, risk);
        const hydration = parseTypescript(root, 'src/aiSessions/projectHydrationController.ts', this.id, risk);
        if (numericInitializer(dashboard, 'AI_SESSION_INCREMENTAL_SCAN_MAX_FILES', this.id, risk) <= 0) {
            fail(this.id, risk, 'incremental scans must keep a positive finite file budget');
        }
        const policyCalls = callArguments(hydration, 'getAiSessionScanMaxFiles');
        if (policyCalls.length !== 1 || policyCalls[0].map(argument => argument.getText(hydration)).join(',')
            !== 'reason,this.options.incrementalScanMaxFiles') {
            fail(this.id, risk, 'project hydration must apply the bounded scan policy exactly once');
        }
        const readCalls = callArguments(hydration, 'this.options.readCoordinator.getResults');
        if (readCalls.length !== 1 || readCalls[0].length !== 1
            || !ts.isObjectLiteralExpression(readCalls[0][0])
            || readCalls[0][0].properties.map(property => property.getText(hydration)).join(',')
                !== 'candidatePaths,reason,maxFiles') {
            fail(this.id, risk, 'the scan budget must reach every provider through the read coordinator');
        }
    },

    // ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001
    'ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001'(root) {
        const risk = 'high-frequency watcher updates can trigger expensive full dashboard refreshes';
        const controller = parseTypescript(root, 'src/aiSessions/dashboardController.ts', this.id, risk);
        const watcherCalls = callArguments(controller, 'this.scheduleRefresh')
            .filter(args => stringArgument(args[0]) === 'watcher');
        if (watcherCalls.length !== 1) {
            fail(this.id, risk, 'provider watchers must use the coalesced incremental refresh path exactly once');
        }
        const fallbackReasons = callArguments(controller, 'this.options.refresh')
            .map(args => stringArgument(args[0]));
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
        const dashboard = parseTypescript(root, 'src/dashboard.ts', this.id, risk);
        const lifecycleReasons = callArguments(dashboard, 'runSafeAiSessionRuntimeLifecycleTask')
            .map(args => stringArgument(args[0]));
        if (!lifecycleReasons.includes('evaluate-attention-closed-terminal')) {
            fail(this.id, risk, 'terminal-close attention fallback must have an explicit diagnostic reason');
        }
        const runtimeFailureArguments = callArguments(dashboard, 'logAiSessionRuntimeFailure');
        if (!runtimeFailureArguments.some(args => stringArgument(args[0]) === 'sync-focused-runtime')) {
            fail(this.id, risk, 'focused-runtime fallback must have an explicit diagnostic reason');
        }
        if (!runtimeFailureArguments.some(args => ts.isTemplateExpression(args[0])
            && args[0].getText(dashboard) === '`${fallback.operation}-fallback`')) {
            fail(this.id, risk, 'tmux choice fallback must derive its reason from the failing operation');
        }
    },

    // ARCH-PROVIDER-REGISTRY-COMPLETENESS-001
    'ARCH-PROVIDER-REGISTRY-COMPLETENESS-001'(root) {
        const risk = 'an incomplete provider registry silently drops a supported provider';
        const providers = parseTypescript(root, 'src/aiSessions/providers.ts', this.id, risk);
        const expected = ['codex', 'kimi', 'claude'];
        if (stringArrayInitializer(providers, 'AI_SESSION_PROVIDER_IDS', this.id, risk).join(',') !== expected.join(',')) {
            fail(this.id, risk, 'the supported provider ID list must remain complete and ordered');
        }
        const definitions = findVariable(providers, 'AI_SESSION_PROVIDER_DEFINITIONS', this.id, risk).initializer;
        if (!definitions || !ts.isObjectLiteralExpression(definitions)) {
            fail(this.id, risk, 'provider definitions must be an object literal');
        }
        const actualDefinitions = definitions.properties.map(property => {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)
                || !ts.isObjectLiteralExpression(property.initializer)) return null;
            const idProperty = property.initializer.properties.find(candidate =>
                ts.isPropertyAssignment(candidate) && candidate.name.getText(providers) === 'id');
            return idProperty && ts.isPropertyAssignment(idProperty) && ts.isStringLiteral(idProperty.initializer)
                ? `${property.name.text}:${idProperty.initializer.text}` : null;
        });
        if (actualDefinitions.join(',') !== expected.map(id => `${id}:${id}`).join(',')) {
            fail(this.id, risk, 'provider definitions must match every supported provider exactly');
        }
        const registryMaps = callArguments(providers, 'AI_SESSION_PROVIDER_IDS.map');
        if (registryMaps.length !== 1 || !registryMaps[0][0]
            || !registryMaps[0][0].getText(providers).includes('service: services[id]')) {
            fail(this.id, risk, 'registry construction must cover every declared provider and service');
        }
    },

    // ARCH-PROTOCOL-001
    'ARCH-PROTOCOL-001'(root) {
        const risk = 'protocol drift breaks compatibility between workspace and UI extension hosts';
        const openProtocol = parseTypescript(root, 'src/openProjects/protocol.ts', this.id, risk);
        const attentionProtocol = parseTypescript(root, 'src/aiSessions/attentionPayload.ts', this.id, risk);
        if (numericInitializer(openProtocol, 'OPEN_PROJECT_PROTOCOL_VERSION', this.id, risk) !== 1) {
            fail(this.id, risk, 'open-project protocol version must remain 1 until an explicit migration exists');
        }
        if (numericInitializer(attentionProtocol, 'ATTENTION_PAYLOAD_VERSION', this.id, risk) !== 1) {
            fail(this.id, risk, 'attention payload version must remain 1 until an explicit migration exists');
        }
        for (const relativePath of [
            'src/aiSessions/attentionBridgeClient.ts',
            'extensions/attention-ui-bridge/src/extension.ts',
        ]) {
            const sourceFile = parseTypescript(root, relativePath, this.id, risk);
            let protocolOne = false;
            walk(sourceFile, node => {
                if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'protocolVersion'
                    && ts.isNumericLiteral(node.initializer) && node.initializer.text === '1') protocolOne = true;
            });
            if (!protocolOne) fail(this.id, risk, `${relativePath} must emit protocol version 1`);
        }
        const bridgeCoordinator = parseTypescript(root,
            'extensions/attention-ui-bridge/src/openProjectCoordinator.ts', this.id, risk);
        let sharedVersionReferences = 0;
        walk(bridgeCoordinator, node => {
            if (ts.isIdentifier(node) && node.text === 'OPEN_PROJECT_PROTOCOL_VERSION') sharedVersionReferences += 1;
        });
        if (sharedVersionReferences < 2) {
            fail(this.id, risk, 'the UI Bridge must import and consume the shared open-project protocol version');
        }
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
