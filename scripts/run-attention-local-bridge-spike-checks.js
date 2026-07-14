'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const protocol = require('../spikes/attention-local-bridge/out/shared/protocol');
const metrics = require('../spikes/attention-local-bridge/out/shared/metrics');
const singleFlight = require('../spikes/attention-local-bridge/out/shared/singleFlight');
const batchDrain = require('../spikes/attention-local-bridge/out/shared/drainBatch');
const workspaceIdentity = require('../spikes/attention-local-bridge/out/shared/workspaceIdentity');
const autoRunControl = require('../spikes/attention-local-bridge/out/shared/autoRunControl');
const storeProtocol = require('../spikes/attention-local-bridge/out/shared/storeProtocol');
const localStore = require('../spikes/attention-local-bridge/out/ui-bridge/src/localStore');

const AUTO_RUN_FIXTURE_A = '/tmp/project-steward-attention-fixture-a';
const AUTO_RUN_FIXTURE_B = '/tmp/project-steward-attention-fixture-b';

function throws(fn, pattern) {
    assert.throws(fn, pattern);
}

function runProtocolChecks() {
    const request = {
        protocolVersion: 1,
        workspaceProcessId: '0123456789abcdef0123456789abcdef',
        workspaceIdentity: 'file:///tmp/fixture-a',
        nonce: 'abcdef0123456789abcdef0123456789',
    };
    assert.deepStrictEqual(protocol.parseRoutingChallenge(request), request);
    throws(() => protocol.parseRoutingChallenge({ ...request, protocolVersion: 2 }), /protocolVersion/);
    throws(() => protocol.parseRoutingChallenge({ ...request, workspaceProcessId: 'wrong' }), /workspaceProcessId/);
    throws(() => protocol.parseRoutingChallenge({ ...request, nonce: '' }), /nonce/);
    throws(() => protocol.parseRoutingChallenge({ ...request, workspaceIdentity: 'x'.repeat(8193) }), /workspaceIdentity/);

    const response = {
        protocolVersion: 1,
        workspaceProcessId: request.workspaceProcessId,
        bridgeProcessId: 'fedcba9876543210fedcba9876543210',
        workspaceIdentity: request.workspaceIdentity,
        nonce: request.nonce,
    };
    assert.deepStrictEqual(protocol.parseRoutingResponse(response), response);
    protocol.assertMatchingRoutingResponse(request, response);
    throws(
        () => protocol.assertMatchingRoutingResponse(request, { ...response, nonce: '11111111111111111111111111111111' }),
        /nonce/
    );
    throws(
        () => protocol.assertStableBridgeProcessId(new Set([response.bridgeProcessId]), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        /unstable bridge process mapping/
    );
}

function runMetricChecks() {
    assert.strictEqual(metrics.percentile([], 95), null);
    assert.strictEqual(metrics.percentile([5, 1, 3, 2, 4], 95), 5);
    assert.strictEqual(metrics.percentile([1, 2, 3, 4, 5], 50), 3);
    assert.deepStrictEqual(metrics.summarizeLatencies([10, 20, 30]), {
        samples: 3,
        p95Ms: 30,
        maxMs: 30,
    });
}

async function runSingleFlightChecks() {
    const deferred = [];
    let calls = 0;
    const run = singleFlight.createSingleFlight(() => {
        calls += 1;
        return new Promise((resolve, reject) => deferred.push({ resolve, reject }));
    });

    const first = run();
    const overlapping = run();
    assert.strictEqual(overlapping, first);
    await Promise.resolve();
    assert.strictEqual(calls, 1);

    deferred[0].resolve('success');
    assert.strictEqual(await first, 'success');

    const afterSuccess = run();
    assert.notStrictEqual(afterSuccess, first);
    await Promise.resolve();
    assert.strictEqual(calls, 2);
    deferred[1].reject(new Error('expected rejection'));
    await assert.rejects(afterSuccess, /expected rejection/);

    const afterRejection = run();
    assert.notStrictEqual(afterRejection, afterSuccess);
    await Promise.resolve();
    assert.strictEqual(calls, 3);
    deferred[2].resolve('recovered');
    assert.strictEqual(await afterRejection, 'recovered');
}

async function runBatchDrainChecks() {
    const firstError = new Error('first observed error');
    const laterError = new Error('later sibling error');
    let rejectSibling;
    const deferredSibling = new Promise((_resolve, reject) => {
        rejectSibling = reject;
    });
    const aggregate = batchDrain.drainBatch([Promise.reject(firstError), deferredSibling]);
    let settled = false;
    aggregate.then(
        () => { settled = true; },
        () => { settled = true; }
    );

    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(settled, false);
    rejectSibling(laterError);
    await assert.rejects(aggregate, error => error === firstError);

    await batchDrain.drainBatch([Promise.resolve('first'), Promise.resolve('second')]);
}

function runWorkspaceIdentityChecks() {
    const workspaceHostA = new URL('file:///tmp/project-steward-attention-fixture-a');
    const bridgeHostA = new URL('vscode-remote://dev-container+fixture-a/tmp/project-steward-attention-fixture-a');
    const workspaceHostB = new URL('file:///tmp/project-steward-attention-fixture-b');
    const bridgeHostB = new URL('vscode-remote://dev-container+fixture-b/tmp/project-steward-attention-fixture-b');

    const fixtureA = workspaceIdentity.createWorkspaceIdentity([workspaceHostA.pathname]);
    const bridgeFixtureA = workspaceIdentity.createWorkspaceIdentity([bridgeHostA.pathname]);
    const fixtureB = workspaceIdentity.createWorkspaceIdentity([workspaceHostB.pathname]);
    const bridgeFixtureB = workspaceIdentity.createWorkspaceIdentity([bridgeHostB.pathname]);
    assert.strictEqual(fixtureA, bridgeFixtureA);
    assert.strictEqual(fixtureB, bridgeFixtureB);
    assert.notStrictEqual(fixtureA, fixtureB);

    assert.strictEqual(
        workspaceIdentity.createWorkspaceIdentity(['/workspace/zeta', '/workspace/alpha']),
        '/workspace/alpha\n/workspace/zeta'
    );
    assert.strictEqual(
        workspaceIdentity.createWorkspaceIdentity([]),
        workspaceIdentity.EMPTY_WORKSPACE_IDENTITY
    );
    assert.strictEqual(
        workspaceIdentity.createWorkspaceIdentity([]),
        workspaceIdentity.createWorkspaceIdentity([])
    );
}

function runAutoRunControlChecks() {
    const nowMs = 1_000_000;
    const validRoutingControl = {
        protocolVersion: 1,
        runId: '0123456789abcdef0123456789abcdef',
        mode: 'routing',
        total: 1000,
        expiresAtMs: nowMs + 60_000,
        fixtureIdentities: [AUTO_RUN_FIXTURE_A, AUTO_RUN_FIXTURE_B],
    };
    const validSameWorkspaceControl = {
        protocolVersion: 1,
        runId: 'fedcba9876543210fedcba9876543210',
        mode: 'same-workspace-routing',
        total: 200,
        expiresAtMs: nowMs + 60_000,
        fixtureIdentities: [AUTO_RUN_FIXTURE_A],
    };

    assert.strictEqual(autoRunControl.parseAutoRunControl(undefined, nowMs), null);
    assert.strictEqual(autoRunControl.parseAutoRunControl(null, nowMs), null);
    assert.strictEqual(autoRunControl.parseAutoRunControl('invalid', nowMs), null);

    const missingRunId = { ...validRoutingControl };
    delete missingRunId.runId;

    for (const invalidControl of [
        missingRunId,
        { ...validRoutingControl, protocolVersion: 2 },
        { ...validRoutingControl, runId: 'ABCDEF0123456789ABCDEF0123456789' },
        { ...validRoutingControl, runId: '../../escape' },
        { ...validRoutingControl, mode: 'same-workspace-routing' },
        { ...validRoutingControl, total: 999 },
        { ...validRoutingControl, expiresAtMs: nowMs },
        { ...validRoutingControl, expiresAtMs: nowMs + (30 * 60 * 1000) + 1 },
        { ...validRoutingControl, fixtureIdentities: [AUTO_RUN_FIXTURE_A] },
        { ...validRoutingControl, fixtureIdentities: [AUTO_RUN_FIXTURE_A, AUTO_RUN_FIXTURE_A] },
        { ...validRoutingControl, fixtureIdentities: [AUTO_RUN_FIXTURE_A, '/tmp/not-an-approved-fixture'] },
        { ...validRoutingControl, unexpected: true },
        { ...validSameWorkspaceControl, mode: 'routing' },
        { ...validSameWorkspaceControl, total: 1000 },
        { ...validSameWorkspaceControl, fixtureIdentities: [AUTO_RUN_FIXTURE_A, AUTO_RUN_FIXTURE_B] },
        { ...validSameWorkspaceControl, fixtureIdentities: [AUTO_RUN_FIXTURE_B] },
    ]) {
        assert.strictEqual(autoRunControl.parseAutoRunControl(invalidControl, nowMs), null);
    }

    const parsed = autoRunControl.parseAutoRunControl(validRoutingControl, nowMs);
    const parsedSameWorkspace = autoRunControl.parseAutoRunControl(validSameWorkspaceControl, nowMs);
    assert.deepStrictEqual(parsed, validRoutingControl);
    assert.deepStrictEqual(parsedSameWorkspace, validSameWorkspaceControl);
    assert.notStrictEqual(autoRunControl.parseAutoRunControl({ ...validRoutingControl, expiresAtMs: nowMs + 1 }, nowMs), null);
    assert.notStrictEqual(
        autoRunControl.parseAutoRunControl({ ...validRoutingControl, expiresAtMs: nowMs + (30 * 60 * 1000) }, nowMs),
        null
    );
    assert.notStrictEqual(
        autoRunControl.parseAutoRunControl({
            ...validRoutingControl,
            fixtureIdentities: [AUTO_RUN_FIXTURE_B, AUTO_RUN_FIXTURE_A],
        }, nowMs),
        null
    );
    assert.strictEqual(autoRunControl.matchesAutoRunFixture(parsed, AUTO_RUN_FIXTURE_A), true);
    assert.strictEqual(autoRunControl.matchesAutoRunFixture(parsed, AUTO_RUN_FIXTURE_B), true);
    assert.strictEqual(autoRunControl.matchesAutoRunFixture(parsed, '/tmp/not-an-approved-fixture'), false);
    assert.strictEqual(autoRunControl.shouldStartAutoRun(parsed, AUTO_RUN_FIXTURE_A, false), true);
    assert.strictEqual(autoRunControl.shouldStartAutoRun(parsed, AUTO_RUN_FIXTURE_A, true), false);
    assert.strictEqual(autoRunControl.shouldStartAutoRun(parsed, '/tmp/not-an-approved-fixture', false), false);
    assert.strictEqual(autoRunControl.matchesAutoRunFixture(parsedSameWorkspace, AUTO_RUN_FIXTURE_A), true);
    assert.strictEqual(autoRunControl.matchesAutoRunFixture(parsedSameWorkspace, AUTO_RUN_FIXTURE_B), false);

    assert.strictEqual(
        autoRunControl.createAutoRunResultFileName(AUTO_RUN_FIXTURE_A),
        'b5025e2d9fd6e3665d801deae8d8ee9aaf5fc9007b229939c88e5d5aeca3d3ef.json'
    );
    assert.strictEqual(
        autoRunControl.createAutoRunResultFileName('../../escape/fixture'),
        'b76cbd636c6aec91c3ab9467f0d3e093fd195b4878d83f17969cfd5aa5f8ebe7.json'
    );
    assert.match(autoRunControl.createAutoRunResultFileName('../../escape/fixture'), /^[a-f0-9]{64}\.json$/);

    const workspaceProcessA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const workspaceProcessB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const sameWorkspaceResultA = autoRunControl.createAutoRunResultFileName(AUTO_RUN_FIXTURE_A, workspaceProcessA);
    const sameWorkspaceResultB = autoRunControl.createAutoRunResultFileName(AUTO_RUN_FIXTURE_A, workspaceProcessB);
    assert.match(sameWorkspaceResultA, /^[a-f0-9]{64}\.json$/);
    assert.match(sameWorkspaceResultB, /^[a-f0-9]{64}\.json$/);
    assert.notStrictEqual(sameWorkspaceResultA, sameWorkspaceResultB);
}

async function runLocalStoreChecks() {
    const validSnapshot = {
        protocolVersion: 1,
        instanceId: '0123456789abcdef0123456789abcdef',
        workspaceProcessId: 'abcdef0123456789abcdef0123456789',
        workspaceIdentity: '/tmp/project-steward-attention-fixture-a',
        sequence: 1,
        sentAtMs: 1_000_000,
        writtenAtMs: 1_000_001,
        payload: 'workspace:1',
    };

    assert.doesNotThrow(() => storeProtocol.validateSnapshot(validSnapshot));
    for (const invalidSnapshot of [
        { ...validSnapshot, protocolVersion: 2 },
        { ...validSnapshot, instanceId: 'bad' },
        { ...validSnapshot, sequence: -1 },
        { ...validSnapshot, sequence: Number.MAX_SAFE_INTEGER + 1 },
        { ...validSnapshot, sentAtMs: Infinity },
        { ...validSnapshot, writtenAtMs: -1 },
        { ...validSnapshot, payload: '' },
        { ...validSnapshot, payload: 'x'.repeat(storeProtocol.MAX_PAYLOAD_LENGTH + 1) },
    ]) {
        assert.throws(() => storeProtocol.validateSnapshot(invalidSnapshot));
    }
    assert.throws(() => storeProtocol.parseSnapshotText('x'.repeat(storeProtocol.MAX_FILE_BYTES + 1)));
    assert.match(storeProtocol.createSnapshotFileName(validSnapshot.instanceId), /^[a-f0-9]{32}\.json$/);

    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'attention-local-store-'));
    const first = new localStore.LocalStore(root, validSnapshot.instanceId, 'fedcba9876543210fedcba9876543210');
    await first.write(validSnapshot);
    const instanceB = { ...validSnapshot, instanceId: 'fedcba9876543210fedcba9876543210', sequence: 0 };
    const instanceC = { ...validSnapshot, instanceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sequence: 0 };
    await new localStore.LocalStore(root, instanceB.instanceId, validSnapshot.workspaceProcessId).write(instanceB);
    await new localStore.LocalStore(root, instanceC.instanceId, validSnapshot.workspaceProcessId).write(instanceC);
    assert.rejects(first.write({ ...validSnapshot, sequence: 0 }));

    const scanned = await first.scan(1_000_010);
    assert.deepStrictEqual(scanned.snapshots.map(snapshot => snapshot.instanceId), [
        '0123456789abcdef0123456789abcdef',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'fedcba9876543210fedcba9876543210',
    ]);
    assert.strictEqual(scanned.snapshots[0].sequence, 1);
    assert.strictEqual(scanned.counters.activeInstances, 3);

    const staleId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await new localStore.LocalStore(root, staleId, validSnapshot.workspaceProcessId).write({
        ...validSnapshot,
        instanceId: staleId,
        sentAtMs: 0,
        writtenAtMs: 0,
        sequence: 0,
    });
    const staleScan = await first.scan(storeProtocol.LEASE_MS + 1);
    assert.strictEqual(staleScan.snapshots.some(snapshot => snapshot.instanceId === staleId), false);

    const ownPath = path.join(root, 'instances', storeProtocol.createSnapshotFileName(validSnapshot.instanceId));
    fs.writeFileSync(ownPath, '{not-json}', 'utf8');
    const retained = await first.scan(1_000_020);
    assert.strictEqual(retained.snapshots.some(snapshot => snapshot.instanceId === validSnapshot.instanceId), true);
    const expired = await first.scan(1_000_000 + storeProtocol.LEASE_MS + 1);
    assert.strictEqual(expired.snapshots.some(snapshot => snapshot.instanceId === validSnapshot.instanceId), false);

    fs.writeFileSync(ownPath, JSON.stringify(validSnapshot), 'utf8');
    fs.writeFileSync(`${ownPath}.tmp`, JSON.stringify(validSnapshot), { encoding: 'utf8', mode: 0o600 });
    const oversizedPath = path.join(root, 'instances', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json');
    fs.writeFileSync(oversizedPath, 'x'.repeat(storeProtocol.MAX_FILE_BYTES + 1), 'utf8');
    const symlinkPath = path.join(root, 'instances', 'cccccccccccccccccccccccccccccccc.json');
    fs.symlinkSync(ownPath, symlinkPath);
    const finalScan = await first.scan(1_000_030);
    assert.strictEqual(finalScan.counters.oversizedFiles, 1);
    assert.strictEqual(finalScan.counters.symlinkFiles, 1);
    await first.removeOwnSnapshot();
    assert.strictEqual(fs.existsSync(ownPath), false);
    fs.rmSync(root, { recursive: true, force: true });
}

function runPackagingChecks() {
    const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
    assert.match(ignore, /^spikes\/\*\*$/m);
}

function readText(relativePath) {
    const absolutePath = path.join(__dirname, '..', relativePath);
    assert.ok(fs.existsSync(absolutePath), `${relativePath} must exist`);
    return fs.readFileSync(absolutePath, 'utf8');
}

function runArtifactContractChecks() {
    const packageScript = readText('spikes/attention-local-bridge/scripts/package.js');
    const expectedArtifactPaths = [
        'artifacts/project-steward-attention-ui-bridge-0.1.0.vsix',
        'artifacts/project-steward-attention-workspace-probe-0.0.5.vsix',
    ];
    const namedArtifactPaths = packageScript.match(/artifacts\/[^'"`\s]+\.vsix/g) || [];
    assert.deepStrictEqual(namedArtifactPaths.sort(), expectedArtifactPaths.sort());

    const manualMatrix = readText('spikes/attention-local-bridge/MANUAL-MATRIX.md');
    for (const requiredText of [
        'Local',
        'Remote SSH',
        'WSL',
        'Dev Container',
        'same workspace',
        'different Profile',
        'Developer: Show Running Extensions',
        'project-steward-attention-ui-bridge-probe-0.0.3.vsix',
        'project-steward-attention-workspace-probe-0.0.5.vsix',
    ]) {
        assert.ok(manualMatrix.includes(requiredText), `MANUAL-MATRIX.md must contain ${requiredText}`);
    }
}

function runAutomationIntegrationContractChecks() {
    const workspaceSource = readText('spikes/attention-local-bridge/workspace/src/extension.ts');
    for (const requiredText of [
        "const AUTO_RUN_CONTROL_PATH = '/tmp/project-steward-attention-routing-control.json'",
        "const AUTO_RUN_RESULT_ROOT = '/tmp/project-steward-attention-routing-results'",
        'const AUTO_RUN_DELAY_MS = 2000',
        'runRoutingChallengeSingleFlight(control.total)',
        "control.mode === 'same-workspace-routing'",
        'createAutoRunResultFileName(workspaceIdentity, workspaceProcessId)',
        'probeVersion: WORKSPACE_PROBE_VERSION',
        'runId: control.runId',
        'mode: control.mode',
        'ATTENTION_SPIKE_AUTOMATION_CHECK',
        'matches: control !== null && matchesAutoRunFixture(control, workspaceIdentity)',
        'status,',
        'const temporaryPath = `${resultPath}.',
        'fs.promises.writeFile(temporaryPath',
        'fs.promises.rename(temporaryPath, resultPath)',
        'clearTimeout(autoRunTimer)',
        'void maybeRunRoutingFromControl().catch(logAutomationError)',
    ]) {
        assert.ok(workspaceSource.includes(requiredText), `Workspace automation must contain ${requiredText}`);
    }
    const metadataAccessIndex = workspaceSource.indexOf('await fs.promises.access(filePath');
    const resultExistenceCheckIndex = workspaceSource.indexOf('const resultAlreadyExists = await fileExists(resultPath)');
    const routingIndex = workspaceSource.indexOf('runRoutingChallengeSingleFlight(control.total)');
    assert.notStrictEqual(metadataAccessIndex, -1, 'Workspace automation must implement a metadata-only existence check');
    assert.notStrictEqual(resultExistenceCheckIndex, -1, 'Workspace automation must check result metadata for replay suppression');
    assert.notStrictEqual(routingIndex, -1, 'Workspace automation must invoke the existing routing single flight');
    assert.ok(
        resultExistenceCheckIndex < routingIndex,
        'Workspace automation must check for an existing result before starting routing'
    );
    assert.ok(!workspaceSource.includes('readFile(resultPath'), 'Workspace automation must not read result contents');
    assert.ok(!workspaceSource.includes('readFile(AUTO_RUN_RESULT_ROOT'), 'Workspace automation must not read result contents');
}

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));
}

function runManifestChecks() {
    const workspace = readJson('spikes/attention-local-bridge/workspace/package.json');
    const bridge = readJson('spikes/attention-local-bridge/ui-bridge/package.json');
    assert.strictEqual(workspace.version, '0.0.5');
    assert.strictEqual(bridge.version, '0.1.0');
    assert.deepStrictEqual(workspace.extensionKind, ['workspace']);
    assert.deepStrictEqual(bridge.extensionKind, ['ui']);
    assert.strictEqual(bridge.api, 'none');
    assert.deepStrictEqual(workspace.extensionDependencies, ['hzcheng.project-steward-attention-ui-bridge']);
    assert.ok(workspace.contributes.commands.some(command => command.command === 'projectStewardAttentionSpike.startRouting'));
    assert.ok(workspace.contributes.commands.some(command => command.command === 'projectStewardAttentionSpike.startSameWorkspaceRouting'));
    assert.ok(workspace.contributes.commands.some(command => command.command === 'projectStewardAttentionSpike.showStatus'));
}

async function main() {
    runProtocolChecks();
    runMetricChecks();
    await runSingleFlightChecks();
    await runBatchDrainChecks();
    runWorkspaceIdentityChecks();
    runAutoRunControlChecks();
    await runLocalStoreChecks();
    runPackagingChecks();
    runArtifactContractChecks();
    runAutomationIntegrationContractChecks();
    runManifestChecks();
    console.log('Attention Local Bridge spike checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
