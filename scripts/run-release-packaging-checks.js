'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');

function readText(relativePath) {
    return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
    return JSON.parse(readText(relativePath));
}

function assertIncludes(source, needle, label) {
    assert.ok(source.includes(needle), `${label} must include ${needle}`);
}

function assertNotIncludes(source, needle, label) {
    assert.ok(!source.includes(needle), `${label} must not include ${needle}`);
}

function extractMarkedRows(source, marker) {
    const block = source.match(new RegExp(
        `<!-- ${marker}:start -->\\n([\\s\\S]*?)\\n<!-- ${marker}:end -->`
    ));
    assert.ok(block, `acceptance report must include ${marker} markers`);
    const lines = block[1].split('\n').filter(line => line.startsWith('| '));
    assert.ok(lines.length >= 2, `${marker} must include a Markdown table header`);
    assert.strictEqual(
        lines[0],
        '| Environment | Workspace kind | Provider | Runtime layout | Action | Expected result | Observed result | Evidence | Status |',
        `${marker} must use the required acceptance columns`
    );
    return lines.slice(2);
}

function runAcceptanceReportChecks() {
    const report = readText('docs/superpowers/reports/2026-07-20-workspace-first-acceptance.md');
    assertIncludes(report, '**Overall status: BLOCKED**', 'workspace-first acceptance report');
    const navigationRows = extractMarkedRows(report, 'workspace-navigation-matrix');
    const launchRows = extractMarkedRows(report, 'workspace-launch-matrix');
    const supplementalRows = extractMarkedRows(report, 'workspace-supplemental-matrix');
    assert.strictEqual(navigationRows.length, 12, 'navigation matrix must list all 12 cells');
    assert.strictEqual(launchRows.length, 108, 'launch matrix must list all 108 cells');
    assert.strictEqual(supplementalRows.length, 12,
        'supplemental matrix must list every environment/workspace-kind cell');
    const cellKey = (row, dimensions) => row.split('|')
        .slice(1, dimensions + 1)
        .map(value => value.trim())
        .join('|');
    assert.strictEqual(new Set(navigationRows.map(row => cellKey(row, 2))).size, 12,
        'navigation matrix must not duplicate an environment/workspace-kind cell');
    assert.strictEqual(new Set(launchRows.map(row => cellKey(row, 4))).size, 108,
        'launch matrix must not duplicate an environment/workspace-kind/provider/runtime cell');
    assert.strictEqual(new Set(supplementalRows.map(row => cellKey(row, 2))).size, 12,
        'supplemental matrix must not duplicate an environment/workspace-kind cell');
    for (const [label, rows] of [
        ['navigation', navigationRows],
        ['launch', launchRows],
        ['supplemental', supplementalRows],
    ]) {
        assert.ok(rows.every(row => row.endsWith('| BLOCKED |')),
            `${label} manual cells must remain explicitly BLOCKED until genuinely run`);
    }
    assertIncludes(report, '0 violations observed across 0 runnable manual navigation trials',
        'workspace-first acceptance report');
    assertIncludes(report, 'workspace-first-saved-projects.json',
        'workspace-first acceptance report');
}

function run() {
    const mainPackage = readJson('package.json');
    const bridgePackage = readJson('extensions/attention-ui-bridge/package.json');
    const bridgeId = `${bridgePackage.publisher}.${bridgePackage.name}`;

    assert.deepStrictEqual(
        mainPackage.extensionDependencies,
        [bridgeId],
        'main extension dependency must exactly match the UI Bridge extension id'
    );
    assert.deepStrictEqual(bridgePackage.extensionKind, ['ui'], 'UI Bridge must run in the UI extension host');
    assert.strictEqual(bridgePackage.api, 'none', 'UI Bridge must not expose a public API');

    assert.ok(mainPackage.scripts['package:release'], 'package.json must define package:release');
    assert.ok(mainPackage.scripts['test:release-packaging'], 'package.json must define test:release-packaging');
    assertIncludes(mainPackage.scripts['package:release'], 'vscode:prepublish',
        'release package script');

    const releasePackager = readText('scripts/package-release-extensions.js');
    assertIncludes(releasePackager, 'extensions\', \'attention-ui-bridge', 'release packager');
    assertIncludes(releasePackager, 'artifacts', 'release packager');
    assertIncludes(releasePackager, 'bridgePackage.name', 'release packager');
    assertIncludes(releasePackager, 'mainPackage.name', 'release packager');
    assertNotIncludes(releasePackager, 'attention-workspace-probe', 'release packager');
    assertNotIncludes(releasePackager, 'spikes/attention-local-bridge/workspace', 'release packager');

    const installScript = readText('scripts/build-test-package-install.sh');
    assertIncludes(installScript, 'npm run package:release', 'local install script');
    assertIncludes(installScript, 'BRIDGE_VERSION', 'local install script');
    assertIncludes(installScript, '--install-extension "$BRIDGE_VSIX" --force', 'local install script');
    assertIncludes(installScript, '--install-extension "$MAIN_VSIX" --force', 'local install script');
    assertNotIncludes(installScript, 'project-steward-attention-ui-bridge-0.1.3.vsix', 'local install script');

    const publishScript = readText('scripts/publish-marketplace.sh');
    assertIncludes(publishScript, 'BRIDGE_NAME', 'Marketplace publish script');
    assertIncludes(publishScript, 'BRIDGE_VERSION', 'Marketplace publish script');
    assertIncludes(publishScript, 'BRIDGE_VSIX_FILE', 'Marketplace publish script');
    assertIncludes(publishScript, 'BRIDGE_PUBLISH_ARGS=(publish --packagePath "$BRIDGE_VSIX_FILE"', 'Marketplace publish script');
    assertIncludes(publishScript, 'PUBLISH_ARGS=(publish --packagePath "$VSIX_FILE"', 'Marketplace publish script');
    assertIncludes(publishScript, 'run_vsce "${BRIDGE_PUBLISH_ARGS[@]}"', 'Marketplace publish script');
    assertIncludes(publishScript, 'run_vsce "${PUBLISH_ARGS[@]}"', 'Marketplace publish script');
    assert.ok(
        publishScript.indexOf('run_vsce "${BRIDGE_PUBLISH_ARGS[@]}"') <
            publishScript.indexOf('run_vsce "${PUBLISH_ARGS[@]}"'),
        'Marketplace publish script must publish UI Bridge before the main extension'
    );

    const workflow = readText('.github/workflows/release-vsix.yml');
    assertIncludes(workflow, 'bridge_name=', 'GitHub release workflow');
    assertIncludes(workflow, 'bridge_version=', 'GitHub release workflow');
    assertIncludes(workflow, 'bridge_vsix_file=', 'GitHub release workflow');
    assertIncludes(workflow, 'npm run test:release-packaging', 'GitHub release workflow');
    assertIncludes(workflow, 'npm run package:release', 'GitHub release workflow');
    assertIncludes(workflow, '${{ steps.meta.outputs.bridge_vsix_file }}', 'GitHub release workflow');
    assertIncludes(workflow, 'sha256sum', 'GitHub release workflow');
    assertNotIncludes(workflow, 'npx --yes @vscode/vsce package --allow-star-activation --out "${{ steps.meta.outputs.vsix_file }}"', 'GitHub release workflow');

    const mainIgnore = readText('.vscodeignore');
    const bridgeIgnore = readText('extensions/attention-ui-bridge/.vscodeignore');
    assertIncludes(mainIgnore, 'spikes/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '.superpowers/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '.github/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, 'docs/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, 'docs/superpowers/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!out/workspaces/*.js', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!out/openWorkspaces/*.js', 'main VSIX ignore rules');
    assertNotIncludes(mainIgnore, '!out/workspaces/**', 'main VSIX ignore rules');
    assertNotIncludes(mainIgnore, '!out/openWorkspaces/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, 'out/**/*.map', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!media/webviewProjectScripts.js', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!media/styles.css', 'main VSIX ignore rules');
    assertIncludes(bridgeIgnore, 'src/**', 'UI Bridge VSIX ignore rules');
    assertIncludes(bridgeIgnore, 'out/**', 'UI Bridge VSIX ignore rules');

    for (const requiredArtifact of [
        'out/workspaces/types.js',
        'out/workspaces/contextResolver.js',
        'out/workspaces/savedWorkspaceProjectAdapter.js',
        'out/openWorkspaces/protocol.js',
        'out/openWorkspaces/bridgeClient.js',
        'out/openWorkspaces/navigationController.js',
        'dist/dashboard.js',
        'media/webviewProjectScripts.js',
        'media/styles.css',
        'extensions/attention-ui-bridge/dist/extension.js',
    ]) {
        assert.ok(fs.statSync(path.join(repositoryRoot, requiredArtifact)).isFile(),
            `production build must generate ${requiredArtifact}`);
    }

    const bridgeBundle = readText('extensions/attention-ui-bridge/dist/extension.js');
    assertIncludes(bridgeBundle, '_projectStewardOpenWorkspaces', 'UI Bridge bundle');
    assert.match(bridgeBundle, /["']open-workspaces["'],["']v2["'],["']instances["']/,
        'UI Bridge bundle must retain the open-workspaces/v2/instances registry path');
    assertNotIncludes(bridgeBundle, '_projectStewardOpenProjects', 'UI Bridge bundle');

    runAcceptanceReportChecks();
}

run();
console.log('Release packaging checks passed.');
