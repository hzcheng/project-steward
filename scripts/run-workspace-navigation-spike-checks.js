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
                assert.strictEqual(observation.outcome, 'focused-existing', `direct cell ${key} has mixed outcomes`);
                assert.strictEqual(
                    observation.windowCountBefore,
                    observation.windowCountAfter,
                    `direct cell ${key} changed window count`
                );
                assert.match(observation.sourceInstanceId, /^[a-f0-9]{32}$/);
                assert.match(observation.targetInstanceId, /^[a-f0-9]{32}$/);
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

function assertProbeSource(source, packageSource, tsconfigSource) {
    const packageJson = JSON.parse(packageSource);
    const tsconfig = JSON.parse(tsconfigSource);
    assert.strictEqual(packageJson.name, 'project-steward-workspace-navigation-probe');
    assert.strictEqual(packageJson.extensionKind.includes('workspace'), true);
    assert.strictEqual(packageJson.main, './dist/extension.js');
    assert.strictEqual(tsconfig.compilerOptions.outDir, 'dist');
    for (const required of [
        "'vscode.openFolder'",
        'vscode.Uri.parse(target.navigationUri)',
        '{ forceNewWindow: true }',
        'sourceInstanceId',
        'targetInstanceId',
        'windowCountBefore',
        'windowCountAfter',
        'focused-existing',
        'opened-duplicate',
        'replaced-source',
        'unsupported',
        'not-runnable',
        "outcome: 'not-runnable'",
    ]) {
        assert.ok(source.includes(required), `probe source is missing contract: ${required}`);
    }
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
