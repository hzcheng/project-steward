'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

function readZipArchive(archivePath) {
    const bytes = fs.readFileSync(archivePath);
    const minimumEndOffset = Math.max(0, bytes.length - 65_557);
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
        if (bytes.readUInt32LE(offset) === 0x06054b50) {
            endOffset = offset;
            break;
        }
    }
    assert.notStrictEqual(endOffset, -1, `${archivePath} must contain a ZIP end record`);
    const entryCount = bytes.readUInt16LE(endOffset + 10);
    let centralOffset = bytes.readUInt32LE(endOffset + 16);
    const entries = new Map();

    for (let index = 0; index < entryCount; index += 1) {
        assert.strictEqual(bytes.readUInt32LE(centralOffset), 0x02014b50,
            `${archivePath} central directory entry ${index} must be valid`);
        const compressionMethod = bytes.readUInt16LE(centralOffset + 10);
        const compressedSize = bytes.readUInt32LE(centralOffset + 20);
        const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
        const fileNameLength = bytes.readUInt16LE(centralOffset + 28);
        const extraLength = bytes.readUInt16LE(centralOffset + 30);
        const commentLength = bytes.readUInt16LE(centralOffset + 32);
        const localOffset = bytes.readUInt32LE(centralOffset + 42);
        const fileName = bytes.subarray(
            centralOffset + 46,
            centralOffset + 46 + fileNameLength,
        ).toString('utf8');
        assert.strictEqual(bytes.readUInt32LE(localOffset), 0x04034b50,
            `${archivePath} local entry for ${fileName} must be valid`);
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
        const content = compressionMethod === 0
            ? Buffer.from(compressed)
            : compressionMethod === 8
                ? zlib.inflateRawSync(compressed)
                : assert.fail(`${archivePath} uses unsupported compression method ${compressionMethod}`);
        assert.strictEqual(content.length, uncompressedSize,
            `${archivePath} entry ${fileName} must have the declared length`);
        assert.strictEqual(entries.has(fileName), false,
            `${archivePath} must not contain duplicate entry ${fileName}`);
        entries.set(fileName, content);
        centralOffset += 46 + fileNameLength + extraLength + commentLength;
    }
    return entries;
}

function sourceOutputEntries(sourceDirectory, archiveDirectory) {
    return fs.readdirSync(path.join(repositoryRoot, sourceDirectory))
        .filter(fileName => fileName.endsWith('.ts'))
        .map(fileName => `${archiveDirectory}/${fileName.replace(/\.ts$/, '.js')}`)
        .sort();
}

function assertExactEntries(entries, expectedEntries, label) {
    assert.deepStrictEqual(
        Array.from(entries.keys()).sort(),
        expectedEntries.slice().sort(),
        `${label} must contain exactly the reviewed release files`,
    );
}

function readVsixIdentity(entries, label) {
    const manifest = entries.get('extension.vsixmanifest').toString('utf8');
    const identity = manifest.match(/<Identity\s+[^>]*Id="([^"]+)"[^>]*Version="([^"]+)"[^>]*Publisher="([^"]+)"[^>]*\/>/);
    assert.ok(identity, `${label} VSIX manifest must contain an Identity with id, version, and publisher`);
    return {
        name: identity[1],
        version: identity[2],
        publisher: identity[3],
    };
}

function runRealVsixArchiveChecks(mainPackage, bridgePackage) {
    const mainArtifact = path.join(
        repositoryRoot,
        'artifacts',
        `${mainPackage.name}-${mainPackage.version}.vsix`,
    );
    const bridgeArtifact = path.join(
        repositoryRoot,
        'artifacts',
        `${bridgePackage.name}-${bridgePackage.version}.vsix`,
    );
    const mainEntries = readZipArchive(mainArtifact);
    const bridgeEntries = readZipArchive(bridgeArtifact);
    const workspaceOutputs = sourceOutputEntries('src/workspaces', 'extension/out/workspaces');
    const openWorkspaceOutputs = sourceOutputEntries('src/openWorkspaces', 'extension/out/openWorkspaces');
    const expectedMainEntries = [
        '[Content_Types].xml',
        'extension.vsixmanifest',
        'extension/LICENSE.md',
        'extension/changelog.md',
        'extension/package.json',
        'extension/readme.md',
        'extension/dist/dashboard.js',
        'extension/media/dom-autoscroller.min.js',
        'extension/media/dragula.min.js',
        'extension/media/extension_icon.png',
        'extension/media/fitty.min.js',
        'extension/media/icon.svg',
        'extension/media/styles.css',
        'extension/media/webviewDashboardScripts.js',
        'extension/media/webviewDnDScripts.js',
        'extension/media/webviewFilterScripts.js',
        'extension/media/webviewProjectScripts.js',
        ...workspaceOutputs,
        ...openWorkspaceOutputs,
    ];
    const expectedBridgeEntries = [
        '[Content_Types].xml',
        'extension.vsixmanifest',
        'extension/LICENSE.md',
        'extension/package.json',
        'extension/readme.md',
        'extension/dist/extension.js',
    ];
    assertExactEntries(mainEntries, expectedMainEntries, 'main VSIX');
    assertExactEntries(bridgeEntries, expectedBridgeEntries, 'UI Bridge VSIX');

    const embeddedMainPackage = JSON.parse(mainEntries.get('extension/package.json').toString('utf8'));
    const embeddedBridgePackage = JSON.parse(bridgeEntries.get('extension/package.json').toString('utf8'));
    const mainVsixIdentity = readVsixIdentity(mainEntries, 'main');
    const bridgeVsixIdentity = readVsixIdentity(bridgeEntries, 'UI Bridge');
    for (const [embedded, identity, source, label] of [
        [embeddedMainPackage, mainVsixIdentity, mainPackage, 'main VSIX'],
        [embeddedBridgePackage, bridgeVsixIdentity, bridgePackage, 'UI Bridge VSIX'],
    ]) {
        assert.strictEqual(embedded.publisher, source.publisher, `${label} publisher must match source manifest`);
        assert.strictEqual(embedded.name, source.name, `${label} name must match source manifest`);
        assert.strictEqual(embedded.version, source.version, `${label} version must match source manifest`);
        assert.deepStrictEqual(identity, {
            name: source.name,
            version: source.version,
            publisher: source.publisher,
        }, `${label} VSIX identity must match its source manifest`);
    }
    assert.deepStrictEqual(embeddedMainPackage.extensionDependencies,
        [`${bridgePackage.publisher}.${bridgePackage.name}`]);

    const mainBundle = mainEntries.get('extension/dist/dashboard.js').toString('utf8');
    const bridgeBundle = bridgeEntries.get('extension/dist/extension.js').toString('utf8');
    assertIncludes(mainBundle, '_projectStewardOpenWorkspaces', 'packaged main bundle');
    assertNotIncludes(mainBundle, '_projectStewardOpenProjects', 'packaged main bundle');
    assertIncludes(bridgeBundle, '_projectStewardOpenWorkspaces', 'packaged UI Bridge bundle');
    assert.match(bridgeBundle, /["']open-workspaces["'],["']v3["'],["']instances["']/,
        'packaged UI Bridge bundle must retain the v2 registry path');
    assertNotIncludes(bridgeBundle, '_projectStewardOpenProjects', 'packaged UI Bridge bundle');
    for (const entries of [mainEntries, bridgeEntries]) {
        for (const [fileName, content] of entries) {
            assert.doesNotMatch(fileName,
                /(?:\.map$|(?:^|\/)(?:docs|src|scripts|test|tests|spikes|\.github|\.superpowers)(?:\/|$)|workspace-navigation-probe)/i,
                `release archive must exclude non-production entry ${fileName}`);
            assert.strictEqual(content.includes('STALE_RELEASE_PACKAGING_PROBE'), false,
                `release archive must not retain seeded stale output in ${fileName}`);
        }
    }
    for (const [archiveEntry, localPath] of [
        ['extension/media/styles.css', 'media/styles.css'],
        ['extension/media/webviewProjectScripts.js', 'media/webviewProjectScripts.js'],
    ]) {
        assert.deepStrictEqual(mainEntries.get(archiveEntry), fs.readFileSync(path.join(repositoryRoot, localPath)),
            `${archiveEntry} must match the production-generated local asset`);
    }
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

function parseAcceptanceRow(row) {
    const values = [];
    let cell = '';
    for (let index = 1; index < row.length - 1; index += 1) {
        if (row[index] === '\\' && row[index + 1] === '|') {
            cell += '|';
            index += 1;
        } else if (row[index] === '|') {
            values.push(cell.trim());
            cell = '';
        } else {
            cell += row[index];
        }
    }
    values.push(cell.trim());
    assert.strictEqual(values.length, 9, `acceptance row must have exactly nine columns: ${row}`);
    return {
        environment: values[0],
        workspaceKind: values[1],
        provider: values[2],
        runtimeLayout: values[3],
        status: values[8],
    };
}

function expectedCartesianKeys(dimensions) {
    return dimensions.reduce(
        (keys, values) => keys.flatMap(key => values.map(value => key ? `${key}|${value}` : value)),
        [''],
    );
}

function assertExactKeySet(actualKeys, expectedKeys, label) {
    assert.deepStrictEqual(
        Array.from(new Set(actualKeys)).sort(),
        expectedKeys.slice().sort(),
        `${label} must contain the exact supported-domain Cartesian product`,
    );
    assert.strictEqual(actualKeys.length, expectedKeys.length,
        `${label} must not contain duplicate or extra rows`);
}

function validateAcceptanceMatrixDomains(report, navigationRowLines, launchRowLines, supplementalRowLines) {
    const environments = ['Local', 'SSH', 'WSL', 'Dev Container'];
    const workspaceKinds = ['single-folder', 'saved multi-root', 'untitled multi-root'];
    const providers = ['Codex', 'Kimi', 'Claude'];
    const runtimeLayouts = ['Direct Terminal', 'project-layout tmux', 'session-layout tmux'];
    const allowedStatuses = new Set(['PASS', 'FAIL', 'BLOCKED']);
    const navigationRows = navigationRowLines.map(parseAcceptanceRow);
    const launchRows = launchRowLines.map(parseAcceptanceRow);
    const supplementalRows = supplementalRowLines.map(parseAcceptanceRow);

    assertExactKeySet(
        navigationRows.map(row => [
            row.environment,
            row.workspaceKind,
            row.provider,
            row.runtimeLayout,
        ].join('|')),
        expectedCartesianKeys([environments, workspaceKinds, ['N/A'], ['OTHER WINDOWS']]),
        'navigation matrix',
    );
    assertExactKeySet(
        launchRows.map(row => [
            row.environment,
            row.workspaceKind,
            row.provider,
            row.runtimeLayout,
        ].join('|')),
        expectedCartesianKeys([environments, workspaceKinds, providers, runtimeLayouts]),
        'launch matrix',
    );
    assertExactKeySet(
        supplementalRows.map(row => [
            row.environment,
            row.workspaceKind,
            row.provider,
            row.runtimeLayout,
        ].join('|')),
        expectedCartesianKeys([
            environments,
            workspaceKinds,
            ['Codex / Kimi / Claude'],
            ['Direct / project tmux / session tmux'],
        ]),
        'supplemental matrix',
    );

    const statuses = [...navigationRows, ...launchRows, ...supplementalRows]
        .map(row => row.status);
    for (const status of statuses) {
        assert.ok(allowedStatuses.has(status), `manual acceptance status must be PASS, FAIL, or BLOCKED: ${status}`);
    }
    const expectedOverall = statuses.some(status => status === 'FAIL' || status === 'BLOCKED')
        ? 'BLOCKED'
        : 'PASS';
    const overall = report.match(/\*\*Overall status: (PASS|BLOCKED)\*\*/);
    assert.ok(overall, 'acceptance report must declare PASS or BLOCKED overall status');
    assert.strictEqual(overall[1], expectedOverall,
        'overall acceptance must be BLOCKED for any FAIL/BLOCKED cell and PASS only when every cell passes');
}

function runAcceptanceReportChecks() {
    assert.strictEqual(parseAcceptanceRow(
        '| Local | single-folder | N/A | OTHER WINDOWS | Action | Expected | Observed | Evidence \\| detail | PASS |'
    ).status, 'PASS', 'matrix parser must preserve escaped pipe characters inside evidence cells');
    const report = readText('docs/superpowers/reports/2026-07-20-workspace-first-acceptance.md');
    const navigationRows = extractMarkedRows(report, 'workspace-navigation-matrix');
    const launchRows = extractMarkedRows(report, 'workspace-launch-matrix');
    const supplementalRows = extractMarkedRows(report, 'workspace-supplemental-matrix');
    validateAcceptanceMatrixDomains(report, navigationRows, launchRows, supplementalRows);
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
    assert.strictEqual(
        mainPackage.scripts['test:release-packaging'],
        'node scripts/seed-release-packaging-stale-output.js && npm run package:release && node scripts/run-release-packaging-checks.js',
        'release packaging verification must seed stale output, rebuild clean, then inspect the real archives'
    );
    assertIncludes(mainPackage.scripts['package:release'], 'clean-release-build.js',
        'release package script');
    assertIncludes(mainPackage.scripts['package:release'], 'test-compile',
        'release package script');
    assertIncludes(mainPackage.scripts['package:release'], 'attention:bridge:compile',
        'release package script');
    assertIncludes(mainPackage.scripts['package:release'], 'vscode:prepublish',
        'release package script');
    assertNotIncludes(mainPackage.scripts['package:release'], 'test:release-packaging',
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
    assertNotIncludes(workflow, 'npm run package:release', 'GitHub release workflow');
    assertIncludes(workflow, '${{ steps.meta.outputs.bridge_vsix_file }}', 'GitHub release workflow');
    assertIncludes(workflow, 'sha256sum', 'GitHub release workflow');
    assertNotIncludes(workflow, 'npx --yes @vscode/vsce package --allow-star-activation --out "${{ steps.meta.outputs.vsix_file }}"', 'GitHub release workflow');
    assert.ok(
        workflow.indexOf('npm run lint') < workflow.indexOf('npm run test:release-packaging'),
        'GitHub release workflow must build/package/verify only after compile and lint'
    );

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
    assert.match(bridgeBundle, /["']open-workspaces["'],["']v3["'],["']instances["']/,
        'UI Bridge bundle must retain the open-workspaces/v3/instances registry path');
    assertNotIncludes(bridgeBundle, '_projectStewardOpenProjects', 'UI Bridge bundle');

    runRealVsixArchiveChecks(mainPackage, bridgePackage);

    runAcceptanceReportChecks();
}

run();
console.log('Release packaging checks passed.');
