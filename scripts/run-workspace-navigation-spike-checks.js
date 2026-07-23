'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const probeSourcePath = path.join(repositoryRoot, 'spikes', 'workspace-navigation', 'extension.ts');
const probePackagePath = path.join(repositoryRoot, 'spikes', 'workspace-navigation', 'package.json');
const probeTsconfigPath = path.join(repositoryRoot, 'spikes', 'workspace-navigation', 'tsconfig.json');
const probeClassifierPath = path.join(
    repositoryRoot,
    'spikes',
    'workspace-navigation',
    'outcomeClassifier.js'
);
const reportPath = path.join(
    repositoryRoot,
    'docs',
    'superpowers',
    'reports',
    '2026-07-20-workspace-navigation-feasibility.md'
);
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
// Direct navigation remains disabled until a reviewed evidence importer is added here.
// Evidence source names are never trusted by pattern or prefix.
const TRUSTED_EVIDENCE_ADAPTERS = Object.freeze([]);

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

function assertDirectObservationSchema(cell, observation, key) {
    assert.ok(observation && typeof observation === 'object' && !Array.isArray(observation),
        `direct observation must be an object in ${key}`);
    assert.match(observation.trialId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
        `invalid trialId in ${key}`);
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
    assert.strictEqual(typeof observation.authoritativeWindowCountSource, 'string',
        `direct cell ${key} needs an authoritative window-count source description`);
    assert.ok(observation.authoritativeWindowCountSource.trim().length > 0,
        `direct cell ${key} needs an authoritative window-count source description`);
    assert.match(observation.evidenceSourceId, /^[a-z0-9][a-z0-9.-]{0,127}$/,
        `invalid evidenceSourceId in ${key}`);
    assert.strictEqual(typeof observation.evidenceArtifactRef, 'string',
        `invalid evidenceArtifactRef in ${key}`);
    assert.ok(observation.evidenceArtifactRef.trim().length > 0
        && !/[\r\n]/.test(observation.evidenceArtifactRef), `invalid evidenceArtifactRef in ${key}`);
    assert.match(observation.evidenceSha256, /^[a-f0-9]{64}$/,
        `invalid evidenceSha256 in ${key}`);
    assert.ok(Number.isSafeInteger(observation.targetFocusSequenceBefore));
    assert.ok(Number.isSafeInteger(observation.targetFocusSequenceAfter));
    assert.ok(observation.targetFocusSequenceAfter > observation.targetFocusSequenceBefore,
        `direct cell ${key} needs a new target focus event`);
    assert.ok(Number.isSafeInteger(observation.startedAtMs));
    assert.ok(Number.isSafeInteger(observation.targetFocusedAtMs),
        `invalid targetFocusedAtMs in ${key}`);
    assert.ok(observation.targetFocusedAtMs > observation.startedAtMs,
        `direct cell ${key} targetFocusedAtMs must be after startedAtMs`);
    assert.ok(Number.isSafeInteger(observation.sourceHeartbeatBeforeMs));
    assert.ok(Number.isSafeInteger(observation.sourceHeartbeatAfterMs));
    assert.ok(observation.sourceHeartbeatAfterMs > observation.sourceHeartbeatBeforeMs,
        `direct cell ${key} needs a new source heartbeat`);
    assert.ok(observation.sourceHeartbeatAfterMs > observation.startedAtMs,
        `direct cell ${key} source heartbeat must occur after the action starts`);
}

function assertTrustedEvidenceAdapter(observation, key) {
    const adapter = TRUSTED_EVIDENCE_ADAPTERS.find(candidate => (
        candidate.evidenceSourceId === observation.evidenceSourceId
    ));
    assert.ok(adapter,
        `no trusted adapter configured for evidenceSourceId "${observation.evidenceSourceId}" in direct cell ${key}`);
    adapter.assertObservation(observation, key);
}

function assertDirectObservation(cell, observation, key) {
    assertDirectObservationSchema(cell, observation, key);
    assertTrustedEvidenceAdapter(observation, key);
}

function canonicalJson(value) {
    if (Array.isArray(value)) { return value.map(canonicalJson); }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
    }
    return value;
}

function observationFingerprint(observation) {
    const { trialId: _trialId, ...content } = observation;
    return JSON.stringify(canonicalJson(content));
}

function assertMatrix(matrix) {
    assert.ok(Array.isArray(matrix), 'navigation matrix must be an array');
    assert.strictEqual(matrix.length, ENVIRONMENTS.length * KINDS.length, 'navigation matrix must contain 12 cells');
    const byCell = new Map();
    const directObservations = [];
    const seenTrialIds = new Set();
    const seenObservationFingerprints = new Set();
    for (const cell of matrix) {
        assert.ok(cell && typeof cell === 'object' && !Array.isArray(cell), 'each matrix cell must be an object');
        const key = `${cell.environment}/${cell.kind}`;
        assert.strictEqual(byCell.has(key), false, `duplicate navigation matrix cell: ${key}`);
        assert.ok(ENVIRONMENTS.includes(cell.environment), `invalid environment in ${key}`);
        assert.ok(KINDS.includes(cell.kind), `invalid workspace kind in ${key}`);
        assert.ok(OUTCOMES.has(cell.outcome), `invalid outcome in ${key}`);
        assert.ok(Array.isArray(cell.observations), `observations must be an array in ${key}`);
        for (const observation of cell.observations) {
            assert.ok(observation && typeof observation === 'object' && !Array.isArray(observation),
                `observation must be an object in ${key}`);
            assert.match(observation.trialId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
                `invalid trialId in ${key}`);
            const fingerprint = observationFingerprint(observation);
            assert.strictEqual(seenObservationFingerprints.has(fingerprint), false,
                `duplicate observation in ${key}`);
            seenObservationFingerprints.add(fingerprint);
            assert.strictEqual(seenTrialIds.has(observation.trialId), false,
                `duplicate trialId "${observation.trialId}" in ${key}`);
            seenTrialIds.add(observation.trialId);
        }
        if (cell.outcome === 'focused-existing') {
            assert.ok(cell.observations.length >= 2, `direct cell ${key} needs repeated observations`);
            for (const observation of cell.observations) {
                assertDirectObservationSchema(cell, observation, key);
                directObservations.push({ observation, key });
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
    for (const { observation, key } of directObservations) {
        assertTrustedEvidenceAdapter(observation, key);
    }
    return byCell;
}

function runCheckerSelfTests() {
    assert.strictEqual(TRUSTED_EVIDENCE_ADAPTERS.length, 0,
        'trusted evidence adapter registry must remain empty until an importer is reviewed');
    const cell = { environment: 'devContainer', kind: 'singleFolder' };
    const valid = {
        trialId: 'trial-devcontainer-single-folder-001',
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
        evidenceSourceId: 'vscode-ui-automation',
        evidenceArtifactRef: 'artifact://workspace-navigation/trial-001.json',
        evidenceSha256: 'a'.repeat(64),
        targetFocusSequenceBefore: 4,
        targetFocusSequenceAfter: 5,
        startedAtMs: 100,
        targetFocusedAtMs: 105,
        sourceHeartbeatBeforeMs: 90,
        sourceHeartbeatAfterMs: 110,
    };
    assert.doesNotThrow(() => assertDirectObservationSchema(cell, valid, 'self-test'));
    assert.throws(
        () => assertDirectObservation(cell, valid, 'self-test'),
        /no trusted adapter configured/
    );
    for (const invalid of [
        { ...valid, authoritativeWindowCountBefore: null },
        { ...valid, authoritativeWindowCountSource: '' },
        { ...valid, targetInstanceId: valid.sourceInstanceId },
        { ...valid, environment: 'local' },
        { ...valid, targetFocusSequenceAfter: valid.targetFocusSequenceBefore },
        { ...valid, sourceHeartbeatAfterMs: valid.sourceHeartbeatBeforeMs },
        { ...valid, sourceHeartbeatAfterMs: valid.startedAtMs },
        { ...valid, targetFocusedAtMs: valid.startedAtMs },
        { ...valid, trialId: 'bad trial id' },
        { ...valid, evidenceSourceId: 'vscode-ui-automation:desktop-window-list' },
        { ...valid, evidenceArtifactRef: '' },
        { ...valid, evidenceSha256: 'not-a-sha256' },
    ]) {
        assert.throws(() => assertDirectObservationSchema(cell, invalid, 'self-test'));
    }

    const fallbackMatrix = ENVIRONMENTS.flatMap(environment => KINDS.map(kind => ({
        environment,
        kind,
        outcome: 'not-runnable',
        reason: 'fixture fallback',
        observations: [],
    })));
    const directCellIndex = fallbackMatrix.findIndex(cellEntry => (
        cellEntry.environment === cell.environment && cellEntry.kind === cell.kind
    ));
    const withDirectCell = observations => fallbackMatrix.map((cellEntry, index) => (
        index === directCellIndex
            ? { ...cellEntry, outcome: 'focused-existing', reason: undefined, observations }
            : cellEntry
    ));
    assert.throws(
        () => assertMatrix(withDirectCell([
            valid,
            { ...valid, trialId: 'trial-devcontainer-single-folder-002', evidenceSha256: 'b'.repeat(64) },
        ])),
        /no trusted adapter configured/
    );
    assert.throws(
        () => assertMatrix(withDirectCell([
            valid,
            { ...valid, trialId: 'trial-devcontainer-single-folder-002' },
        ])),
        /duplicate observation/
    );
    assert.throws(
        () => assertMatrix(withDirectCell([
            valid,
            { ...valid, targetFocusSequenceAfter: 6 },
        ])),
        /duplicate trialId/
    );
}

function runProbeOutcomeClassifierTests() {
    const { classifyProbeOutcome } = require(probeClassifierPath);
    const base = {
        commandError: null,
        registrationCountBefore: 2,
        registrationCountAfter: 2,
        startedAtMs: 100,
        sourceHeartbeatBeforeMs: 90,
        sourceHeartbeatAfterMs: 110,
    };
    const fixtures = [
        [{ ...base, commandError: 'command failed', registrationCountAfter: 3 }, 'unsupported'],
        [{ ...base, registrationCountAfter: 3, sourceHeartbeatAfterMs: null }, 'opened-duplicate'],
        [{ ...base, sourceHeartbeatAfterMs: null }, 'replaced-source'],
        [{ ...base, sourceHeartbeatAfterMs: base.sourceHeartbeatBeforeMs }, 'replaced-source'],
        [base, 'not-runnable'],
    ];
    for (const [input, expected] of fixtures) {
        assert.strictEqual(classifyProbeOutcome(input).outcome, expected);
    }
    assert.strictEqual(fixtures.some(([input]) => classifyProbeOutcome(input).outcome === 'focused-existing'), false,
        'the probe classifier must never self-classify focused-existing');
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
        'trialId',
        'evidenceSourceId',
        'evidenceArtifactRef',
        'evidenceSha256',
        'targetFocusedAtMs',
        'sourceHeartbeatBeforeMs',
        'sourceHeartbeatAfterMs',
        'heartbeatAtMs',
        "from './outcomeClassifier'",
        'classifyProbeOutcome({',
        "outcome: 'not-runnable'",
    ]) {
        assert.ok(source.includes(required), `probe source is missing contract: ${required}`);
    }
    assert.strictEqual(/\bwindowCountBefore\s*:/.test(source), false,
        'probe registration count must not be named windowCountBefore');
    assert.strictEqual(/\bwindowCountAfter\s*:/.test(source), false,
        'probe registration count must not be named windowCountAfter');
    assert.strictEqual(/\.roots\s*\[/.test(source), false, 'probe navigation must not use a workspace root URI');
    assert.strictEqual(source.includes('focused-existing'), false,
        'probe source must not be able to self-classify focused-existing');
}

function assertProductionPolicy(controllerSource) {
    assert.strictEqual(/record\.roots\b/.test(controllerSource), false,
        'production navigation must never read record.roots');
    assert.ok(controllerSource.includes('record.navigationUri'),
        'production navigation must consume the latest record.navigationUri');
    assert.ok(controllerSource.includes("'vscode.openFolder'"),
        'saved workspace navigation must invoke vscode.openFolder');
    assert.strictEqual(controllerSource.includes('workbench.action.switchWindow'), false,
        'production navigation must never invoke native Switch Window automatically');
    assert.ok(controllerSource.includes('Save this workspace before switching to it'),
        'untitled fallback must ask the user to save');
}

function main() {
    runCheckerSelfTests();
    runProbeOutcomeClassifierTests();
    const probeSource = readRequired(probeSourcePath);
    const packageSource = readRequired(probePackagePath);
    const tsconfigSource = readRequired(probeTsconfigPath);
    const report = readRequired(reportPath);
    assertProbeSource(probeSource, packageSource, tsconfigSource);
    assertMatrix(parseMatrix(report));

    if (fs.existsSync(controllerPath)) {
        const controllerSource = readRequired(controllerPath);
        assertProductionPolicy(controllerSource);
    }
    console.log('Workspace navigation spike checks passed.');
}

main();
