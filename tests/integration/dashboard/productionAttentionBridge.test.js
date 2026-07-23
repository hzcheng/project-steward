'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');

test('ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 activates the production bridge/client handshake, schema, storage, and cleanup', async t => {
    const root = makeTempDirectory(t, 'production-attention-bridge-');
    const registered = new Map();
    const executed = [];
    const vscode = {
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        },
        workspace: { workspaceFolders: [{
            name: 'sensitive',
            uri: {
                scheme: 'vscode-remote',
                authority: 'ssh-remote+sensitive-host',
                path: '/home/sensitive-user/private-project',
                toString: () => 'vscode-remote://ssh-remote%2Bsensitive-host/home/sensitive-user/private-project',
            },
        }] },
        commands: {
            registerCommand: (command, callback) => {
                registered.set(command, callback);
                return { dispose: () => registered.delete(command) };
            },
            executeCommand: async (command, argument) => {
                executed.push({ command, argument });
                const callback = registered.get(command);
                return callback ? callback(argument) : undefined;
            },
        },
    };
    const previousLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return previousLoad.call(this, request, parent, isMain);
    };
    const bridgeRoot = path.resolve(__dirname, '../../../extensions/attention-ui-bridge');
    const extensionPath = require.resolve(
        '../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/extension'
    );
    const clientPath = require.resolve('../../../out/aiSessions/attentionBridgeClient');
    delete require.cache[extensionPath];
    delete require.cache[clientPath];
    const bridgePackage = JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'package.json'), 'utf8'));
    const context = {
        extensionPath: bridgeRoot,
        globalStoragePath: root,
        globalStorageUri: { scheme: 'file' },
        subscriptions: [],
    };
    let client;
    try {
        const extension = require(extensionPath);
        await extension.activate(context);
        const requiredCommands = [
            '_projectStewardAttention.bridge.handshake',
            '_projectStewardAttention.bridge.publish',
            '_projectStewardAttention.bridge.unregister',
            '_projectStewardAttention.bridge.acknowledge',
        ];
        for (const command of requiredCommands) assert.equal(typeof registered.get(command), 'function');

        const aggregates = [];
        const errors = [];
        const AttentionBridgeClient = require(clientPath).default;
        client = new AttentionBridgeClient(
            aggregate => aggregates.push(aggregate),
            error => errors.push(error),
            { mainExtensionVersion: '2.1.3' }
        );
        assert.equal(await client.publish([{
            projectId: 'a'.repeat(64), sessionKey: 'codex:integration',
            state: 'needsAttention', eventId: 'integration-event',
            reason: 'completed', observedAtMs: 1,
        }]), true);
        assert.deepEqual(errors, []);
        assert.ok(aggregates.length > 0);
        assert.deepEqual(aggregates.at(-1).sessions[0].eventIds, ['integration-event']);

        const handshake = registered.get('_projectStewardAttention.bridge.handshake');
        const publish = registered.get('_projectStewardAttention.bridge.publish');
        const unregister = registered.get('_projectStewardAttention.bridge.unregister');
        const validSnapshot = executed.find(entry =>
            entry.command === '_projectStewardAttention.bridge.publish').argument;
        const handshakeResponse = await handshake({
            protocolVersion: 1, mainExtensionVersion: '2.1.3', instanceId: 'b'.repeat(32),
        });
        assert.equal(handshakeResponse.bridgeExtensionVersion, bridgePackage.version);
        assert.deepEqual(handshakeResponse.capabilities, {
            snapshots: true, acknowledgements: true, atomicReplace: true,
        });
        await assert.rejects(
            unregister({ protocolVersion: 1, instanceId: validSnapshot.instanceId, unexpected: true }),
            /unexpected fields/
        );
        await assert.rejects(handshake({
            protocolVersion: 2, mainExtensionVersion: '2.1.3', instanceId: 'b'.repeat(32),
        }), /protocol/);
        await assert.rejects(publish({ ...validSnapshot, unexpected: true }), /unexpected fields/);
        await assert.rejects(publish({ ...validSnapshot, version: 2 }), /header|version|protocol/);
        await assert.rejects(publish({
            ...validSnapshot,
            items: [{ ...validSnapshot.items[0], eventId: 'x'.repeat(1025) }],
        }), /eventId/);

        const productionRoot = path.join(
            root, 'attention-local-bridge-spike', 'v1', 'production-attention', 'v1', 'instances'
        );
        const storedText = fs.readdirSync(productionRoot)
            .filter(name => name.endsWith('.json'))
            .map(name => fs.readFileSync(path.join(productionRoot, name), 'utf8'))
            .join('\n');
        assert.doesNotMatch(storedText, /\/home\/|ssh-remote|workspaceIdentity/);
        assert.doesNotMatch(storedText, /sensitive-user|sensitive-host|private-project/);
        assert.match(storedText, new RegExp(`"bridgeVersion":"${bridgePackage.version.replace('.', '\\.')}"`));

        const unregisterCount = () => executed.filter(entry =>
            entry.command === '_projectStewardAttention.bridge.unregister'
            && entry.argument?.instanceId === validSnapshot.instanceId).length;
        assert.equal(fs.existsSync(path.join(productionRoot, `${validSnapshot.instanceId}.json`)), true);
        client.dispose();
        for (let attempt = 0; attempt < 50
            && (unregisterCount() === 0
                || fs.existsSync(path.join(productionRoot, `${validSnapshot.instanceId}.json`))); attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(unregisterCount(), 1, 'disposing the real client unregisters its production snapshot');
        assert.equal(fs.existsSync(path.join(productionRoot, `${validSnapshot.instanceId}.json`)), false);
    } finally {
        client?.dispose();
        await new Promise(resolve => setImmediate(resolve));
        for (const disposable of context.subscriptions.slice().reverse()) disposable.dispose?.();
        Module._load = previousLoad;
        delete require.cache[extensionPath];
        delete require.cache[clientPath];
    }
    assert.equal(registered.size, 0, 'disposing production activation unregisters every command');
});
