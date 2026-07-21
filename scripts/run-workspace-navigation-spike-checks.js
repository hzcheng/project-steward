'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const probeSourcePath = path.join(repositoryRoot, 'spikes', 'workspace-navigation', 'extension.ts');
const probePackagePath = path.join(repositoryRoot, 'spikes', 'workspace-navigation', 'package.json');
const probeTsconfigPath = path.join(repositoryRoot, 'spikes', 'workspace-navigation', 'tsconfig.json');
const reportPath = path.join(
    repositoryRoot,
    'docs',
    'superpowers',
    'reports',
    '2026-07-20-workspace-navigation-feasibility.md'
);
const capabilityPath = path.join(repositoryRoot, 'src', 'openWorkspaces', 'navigationCapabilities.ts');
const controllerPath = path.join(repositoryRoot, 'src', 'openWorkspaces', 'navigationController.ts');

const ENVIRONMENTS = ['local', 'ssh', 'wsl', 'devContainer'];
const KINDS = ['singleFolder', 'savedMultiRoot', 'untitledMultiRoot'];
const OUTCOMES = new Set([
    'focused-existing',
    'opened-duplicate',
    'replaced-source',
    'unsupported',
    'not-runnable',
]);

function readRequired(filePath) {
    assert.ok(fs.existsSync(filePath), `missing required file: ${path.relative(repositoryRoot, filePath)}`);
    return fs.readFileSync(filePath, 'utf8');
}

function parseMatrix(report) {
    const match = report.match(
        /<!-- workspace-navigation-matrix:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- workspace-navigation-matrix:end -->/
    );
    assert.ok(match, 'feasibility report must contain the machine-readable navigation matrix');
    return JSON.parse(match[1]);
}

function assertDirectObservation(cell, observation, key) {
    assert.strictEqual(observation.outcome, 'focused-existing', `direct cell ${key} has mixed outcomes`);
    assert.strictEqual(observation.environment, cell.environment, `direct observation environment mismatch in ${key}`);
    assert.strictEqual(observation.kind, cell.kind, `direct observation kind mismatch in ${key}`);
    assert.match(observation.sourceInstanceId, /^[a-f0-9]{32}$/);
    assert.match(observation.targetInstanceId, /^[a-f0-9]{32}$/);
    assert.notStrictEqual(observation.sourceInstanceId, observation.targetInstanceId,
        `direct observation source and target must differ in ${key}`);
    assert.ok(Number.isSafeInteger(observation.registrationCountBefore)
        && observation.registrationCountBefore >= 0, `invalid registrationCountBefore in ${key}`);
    assert.ok(Number.isSafeInteger(observation.registrationCountAfter)
        && observation.registrationCountAfter >= 0, `invalid registrationCountAfter in ${key}`);
    assert.ok(Number.isSafeInteger(observation.authoritativeWindowCountBefore)
        && observation.authoritativeWindowCountBefore >= 0,
    `direct cell ${key} needs a non-null authoritativeWindowCountBefore`);
    assert.ok(Number.isSafeInteger(observation.authoritativeWindowCountAfter)
        && observation.authoritativeWindowCountAfter >= 0,
    `direct cell ${key} needs a non-null authoritativeWindowCountAfter`);
    assert.strictEqual(
        observation.authoritativeWindowCountBefore,
        observation.authoritativeWindowCountAfter,
        `direct cell ${key} changed authoritative window count`
    );
    assert.match(
        observation.authoritativeWindowCountSource,
        /^(vscode-ui-automation|os-window-enumerator):\S+/,
        `direct cell ${key} needs an auditable authoritative window-count source`
    );
    assert.ok(Number.isSafeInteger(observation.targetFocusSequenceBefore));
    assert.ok(Number.isSafeInteger(observation.targetFocusSequenceAfter));
    assert.ok(observation.targetFocusSequenceAfter > observation.targetFocusSequenceBefore,
        `direct cell ${key} needs a new target focus event`);
    assert.ok(Number.isSafeInteger(observation.startedAtMs));
    assert.ok(Number.isSafeInteger(observation.sourceHeartbeatBeforeMs));
    assert.ok(Number.isSafeInteger(observation.sourceHeartbeatAfterMs));
    assert.ok(observation.sourceHeartbeatAfterMs > observation.sourceHeartbeatBeforeMs,
        `direct cell ${key} needs a new source heartbeat`);
    assert.ok(observation.sourceHeartbeatAfterMs > observation.startedAtMs,
        `direct cell ${key} source heartbeat must occur after the action starts`);
}

function assertMatrix(matrix) {
    assert.ok(Array.isArray(matrix), 'navigation matrix must be an array');
    assert.strictEqual(matrix.length, ENVIRONMENTS.length * KINDS.length, 'navigation matrix must contain 12 cells');
    const byCell = new Map();
    for (const cell of matrix) {
        assert.ok(cell && typeof cell === 'object' && !Array.isArray(cell), 'each matrix cell must be an object');
        const key = `${cell.environment}/${cell.kind}`;
        assert.strictEqual(byCell.has(key), false, `duplicate navigation matrix cell: ${key}`);
        assert.ok(ENVIRONMENTS.includes(cell.environment), `invalid environment in ${key}`);
        assert.ok(KINDS.includes(cell.kind), `invalid workspace kind in ${key}`);
        assert.ok(OUTCOMES.has(cell.outcome), `invalid outcome in ${key}`);
        assert.ok(Array.isArray(cell.observations), `observations must be an array in ${key}`);
        if (cell.outcome === 'focused-existing') {
            assert.ok(cell.observations.length >= 2, `direct cell ${key} needs repeated observations`);
            for (const observation of cell.observations) {
                assertDirectObservation(cell, observation, key);
            }
        } else {
            assert.strictEqual(typeof cell.reason, 'string', `fallback cell ${key} must explain why direct is disabled`);
            assert.ok(cell.reason.trim().length > 0, `fallback cell ${key} reason must not be empty`);
        }
        byCell.set(key, cell);
    }
    for (const environment of ENVIRONMENTS) {
        for (const kind of KINDS) {
            assert.ok(byCell.has(`${environment}/${kind}`), `missing navigation matrix cell: ${environment}/${kind}`);
        }
    }
    return byCell;
}

function runCheckerSelfTests() {
    const cell = { environment: 'devContainer', kind: 'singleFolder' };
    const valid = {
        outcome: 'focused-existing',
        environment: 'devContainer',
        kind: 'singleFolder',
        sourceInstanceId: '1'.repeat(32),
        targetInstanceId: '2'.repeat(32),
        registrationCountBefore: 2,
        registrationCountAfter: 2,
        authoritativeWindowCountBefore: 2,
        authoritativeWindowCountAfter: 2,
        authoritativeWindowCountSource: 'vscode-ui-automation:desktop-window-list',
        targetFocusSequenceBefore: 4,
        targetFocusSequenceAfter: 5,
        startedAtMs: 100,
        sourceHeartbeatBeforeMs: 90,
        sourceHeartbeatAfterMs: 110,
    };
    assert.doesNotThrow(() => assertDirectObservation(cell, valid, 'self-test'));
    for (const invalid of [
        { ...valid, authoritativeWindowCountBefore: null },
        { ...valid, authoritativeWindowCountSource: 'probe-registration-count' },
        { ...valid, targetInstanceId: valid.sourceInstanceId },
        { ...valid, environment: 'local' },
        { ...valid, targetFocusSequenceAfter: valid.targetFocusSequenceBefore },
        { ...valid, sourceHeartbeatAfterMs: valid.sourceHeartbeatBeforeMs },
        { ...valid, sourceHeartbeatAfterMs: valid.startedAtMs },
    ]) {
        assert.throws(() => assertDirectObservation(cell, invalid, 'self-test'));
    }
}

function assertProbeSource(source, packageSource, tsconfigSource) {
    const packageJson = JSON.parse(packageSource);
    const tsconfig = JSON.parse(tsconfigSource);
    assert.strictEqual(packageJson.name, 'project-steward-workspace-navigation-probe');
    assert.strictEqual(packageJson.extensionKind.includes('workspace'), true);
    assert.strictEqual(packageJson.main, './dist/extension.js');
    assert.strictEqual(packageJson.activationEvents.includes('*'), false,
        'probe must not activate continuously');
    assert.ok(packageJson.activationEvents.includes('onCommand:projectStewardWorkspaceNavigationProbe.start'));
    assert.ok(packageJson.activationEvents.includes('onCommand:projectStewardWorkspaceNavigationProbe.stop'));
    assert.strictEqual(tsconfig.compilerOptions.outDir, 'dist');
    for (const required of [
        "'vscode.openFolder'",
        'vscode.Uri.parse(target.navigationUri)',
        '{ forceNewWindow: true }',
        'sourceInstanceId',
        'targetInstanceId',
        'registrationCountBefore',
        'registrationCountAfter',
        'authoritativeWindowCountBefore',
        'authoritativeWindowCountAfter',
        'authoritativeWindowCountSource',
        'sourceHeartbeatBeforeMs',
        'sourceHeartbeatAfterMs',
        'heartbeatAtMs',
        'focused-existing',
        'opened-duplicate',
        'replaced-source',
        'unsupported',
        'not-runnable',
        "outcome: 'not-runnable'",
    ]) {
        assert.ok(source.includes(required), `probe source is missing contract: ${required}`);
    }
    assert.strictEqual(/\bwindowCountBefore\s*:/.test(source), false,
        'probe registration count must not be named windowCountBefore');
    assert.strictEqual(/\bwindowCountAfter\s*:/.test(source), false,
        'probe registration count must not be named windowCountAfter');
    assert.strictEqual(/\.roots\s*\[/.test(source), false, 'probe navigation must not use a workspace root URI');
}

function assertProductionPolicy(matrixByCell, capabilitySource, controllerSource) {
    assert.strictEqual(/record\.roots\b/.test(controllerSource), false,
        'production navigation must never read record.roots');
    assert.ok(controllerSource.includes('record.navigationUri'),
        'production navigation must consume the latest record.navigationUri');
    assert.ok(controllerSource.includes("'workbench.action.switchWindow'"),
        'saved fallback must invoke native Switch Window');
    assert.ok(controllerSource.includes('Save this workspace before switching to it'),
        'untitled fallback must ask the user to save');
    for (const [key, cell] of matrixByCell) {
        const [environment, kind] = key.split('/');
        const directLiteral = `'${environment}/${kind}': true`;
        assert.strictEqual(
            capabilitySource.includes(directLiteral),
            cell.outcome === 'focused-existing',
            `capability policy does not match evidence for ${key}`
        );
    }
}

function main() {
    runCheckerSelfTests();
    const probeSource = readRequired(probeSourcePath);
    const packageSource = readRequired(probePackagePath);
    const tsconfigSource = readRequired(probeTsconfigPath);
    const report = readRequired(reportPath);
    assertProbeSource(probeSource, packageSource, tsconfigSource);
    const matrixByCell = assertMatrix(parseMatrix(report));

    if (fs.existsSync(capabilityPath) || fs.existsSync(controllerPath)) {
        const capabilitySource = readRequired(capabilityPath);
        const controllerSource = readRequired(controllerPath);
        assertProductionPolicy(matrixByCell, capabilitySource, controllerSource);
    }
    console.log('Workspace navigation spike checks passed.');
}

main();
