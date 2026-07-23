'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const yaml = require('js-yaml');
const {
    validateScheduledWorkflow: validateScheduledWorkflowSource,
    validateVerifyWorkflow,
} = require('./lib/ciContracts');

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

function isMapping(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsKey(value, key) {
    if (Array.isArray(value)) return value.some(item => containsKey(item, key));
    if (!isMapping(value)) return false;
    return Object.prototype.hasOwnProperty.call(value, key)
        || Object.values(value).some(item => containsKey(item, key));
}

function containsSecretContext(value) {
    if (typeof value === 'string') return /\$\{\{[\s\S]*?\bsecrets\s*\./i.test(value);
    if (Array.isArray(value)) return value.some(containsSecretContext);
    return isMapping(value) && (
        Object.keys(value).some(containsSecretContext)
        || Object.values(value).some(containsSecretContext)
    );
}

function assertExactKeys(value, expectedKeys, label) {
    assert.deepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort(),
        `${label} must define exactly ${expectedKeys.join(', ')}`);
}

function parseWorkflow(source, label) {
    let workflow;
    try {
        workflow = yaml.safeLoad(source, { schema: yaml.JSON_SCHEMA });
    } catch (error) {
        assert.fail(`${label} must be valid YAML: ${error.message}`);
    }
    assert.ok(isMapping(workflow), `${label} must be a YAML mapping`);
    return workflow;
}

function validateScheduledWorkflow(workflow) {
    validateScheduledWorkflowSource(yaml.safeDump(workflow));
    assert.strictEqual(containsSecretContext(workflow), false,
        'scheduled verification must not reference the GitHub secrets context');
    assertExactKeys(workflow, ['name', 'on', 'permissions', 'jobs'],
        'scheduled verification workflow');
    assert.ok(isMapping(workflow.on), 'scheduled verification on must be a mapping');
    assertExactKeys(workflow.on, ['schedule', 'workflow_dispatch'],
        'scheduled verification triggers');
    assert.ok(Array.isArray(workflow.on.schedule), 'scheduled verification must define schedule');
    assert.strictEqual(workflow.on.schedule.length, 1,
        'scheduled verification must define exactly one reviewed schedule');
    for (const entry of workflow.on.schedule) {
        assert.ok(isMapping(entry), 'scheduled verification schedule entries must be mappings');
        assertExactKeys(entry, ['cron'], 'scheduled verification schedule entry');
        assert.strictEqual(entry.cron, '17 3 * * 1',
            'scheduled verification cron must remain the reviewed weekly schedule');
    }
    assert.ok(Object.prototype.hasOwnProperty.call(workflow.on, 'workflow_dispatch'),
        'scheduled verification must define workflow_dispatch');
    assert.ok(workflow.on.workflow_dispatch === null || isMapping(workflow.on.workflow_dispatch),
        'scheduled verification workflow_dispatch must be empty or a mapping');
    if (isMapping(workflow.on.workflow_dispatch)) {
        assertExactKeys(workflow.on.workflow_dispatch, [],
            'scheduled verification workflow_dispatch');
    }
    assert.deepStrictEqual(workflow.permissions, { contents: 'read' },
        'scheduled verification permissions must be exactly contents: read');
    assert.ok(isMapping(workflow.jobs), 'scheduled verification jobs must be a mapping');
    assert.deepStrictEqual(Object.keys(workflow.jobs), ['verify', 'scheduled-macos'],
        'scheduled verification must contain only verify and scheduled-macos jobs');
    assertExactKeys(workflow.jobs.verify, ['uses'], 'scheduled verify job');
    const job = workflow.jobs['scheduled-macos'];
    assert.ok(isMapping(job), 'scheduled verification must define scheduled-macos');
    assertExactKeys(job, ['name', 'needs', 'runs-on', 'timeout-minutes', 'steps'],
        'scheduled-macos job');
    assert.strictEqual(job.name, 'scheduled-macos',
        'scheduled-macos must keep its stable job name');
    assert.strictEqual(job['runs-on'], 'macos-latest', 'scheduled-macos must use macos-latest');
    assert.strictEqual(job['timeout-minutes'], 15, 'scheduled-macos timeout must be 15 minutes');
    assert.strictEqual(containsKey(workflow, 'continue-on-error'), false,
        'scheduled verification must not define continue-on-error');
    assert.ok(Array.isArray(job.steps), 'scheduled-macos steps must be an array');
    assert.strictEqual(job.steps.length, 4, 'scheduled-macos must define exactly four allowed steps');
    const checkout = job.steps[0];
    assertExactKeys(checkout, ['name', 'uses'], 'scheduled-macos checkout step');
    assert.strictEqual(checkout.uses, 'actions/checkout@v4',
        'scheduled-macos must use actions/checkout@v4');
    const setupNode = job.steps[1];
    assertExactKeys(setupNode, ['name', 'uses', 'with'], 'scheduled-macos setup-node step');
    assert.strictEqual(setupNode.uses, 'actions/setup-node@v4',
        'scheduled-macos must use actions/setup-node@v4');
    assertExactKeys(setupNode.with, ['node-version', 'cache'], 'scheduled-macos setup-node inputs');
    assert.strictEqual(setupNode.with['node-version'], '22.12.0',
        'scheduled-macos must use Node 22.12.0');
    assert.strictEqual(setupNode.with.cache, 'npm', 'scheduled-macos must cache npm');
    const commands = [
        'npm ci',
        'npm run test:extension-host',
    ];
    for (const [index, command] of commands.entries()) {
        const step = job.steps[index + 2];
        assertExactKeys(step, ['name', 'run'], `scheduled-macos ${command} step`);
        assert.strictEqual(step.run, command, `scheduled-macos must run ${command}`);
    }
    assert.strictEqual(containsKey(workflow, 'secrets'), false,
        'scheduled verification must not use secrets');
}

function validateReleaseWorkflow(workflow) {
    assert.ok(isMapping(workflow.on), 'release workflow on must be a mapping');
    assert.ok(isMapping(workflow.jobs), 'release workflow jobs must be a mapping');
    assert.deepStrictEqual(workflow.permissions, { contents: 'read' },
        'release workflow top-level permissions must be exactly contents: read');
    assert.strictEqual(containsKey(workflow, 'continue-on-error'), false,
        'release workflow must not define continue-on-error');
    assert.deepStrictEqual(Object.keys(workflow.jobs).sort(), ['release', 'verify'],
        'release workflow must contain only verify and release jobs');
    const verify = workflow.jobs.verify;
    assert.strictEqual(verify.uses, './.github/workflows/verify.yml',
        'release verify job must call the reusable verification workflow');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(verify, 'permissions'), false,
        'release verify job must not receive elevated permissions');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(verify, 'secrets'), false,
        'release verify job must not receive secrets');
    const release = workflow.jobs.release;
    assert.strictEqual(release.needs, 'verify', 'release job must need verify');
    assert.deepStrictEqual(release.permissions, { contents: 'write' },
        'release job permissions must be exactly contents: write');
}

function assertWorkflowMutationRejected(validate, workflow, mutate, message) {
    const mutation = JSON.parse(JSON.stringify(workflow));
    mutate(mutation);
    assert.throws(() => validate(mutation), assert.AssertionError, message);
}

function assertWorkflowMutationsRejected(validate, workflow, mutations) {
    const accepted = [];
    for (const [message, mutate] of mutations) {
        const mutation = JSON.parse(JSON.stringify(workflow));
        mutate(mutation);
        try {
            validate(mutation);
            accepted.push(message);
        } catch (error) {
            assert.ok(error instanceof assert.AssertionError, `${message} must fail with an assertion`);
        }
    }
    assert.deepStrictEqual(accepted, [], `workflow contract accepted unsafe mutations: ${accepted.join(', ')}`);
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
    for (const [entries, label] of [
        [mainEntries, 'main VSIX'],
        [bridgeEntries, 'UI Bridge VSIX'],
    ]) {
        for (const forbiddenPrefix of [
            'extension/coverage/',
            'extension/tests/',
            'extension/.ci/',
        ]) {
            assert.ok(
                [...entries.keys()].every(fileName => !fileName.startsWith(forbiddenPrefix)),
                `${label} must exclude ${forbiddenPrefix}`
            );
        }
    }
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
    assert.strictEqual(mainPackage.scripts['test:extension-host'],
        'npm run vscode:prepublish && npm run attention:bridge:bundle && node scripts/run-extension-host-tests.js',
        'package.json must define the reviewed Extension Host runner');
    assert.strictEqual(mainPackage.devDependencies['@vscode/test-electron'], '3.0.0',
        '@vscode/test-electron must remain an exact direct development dependency');
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

    const verifyWorkflow = readText('.github/workflows/verify.yml');
    validateVerifyWorkflow(verifyWorkflow);
    const verifyMutation = parseWorkflow(verifyWorkflow, 'verification workflow mutation fixture');
    verifyMutation.jobs['quality-linux'].steps[0]['continue-on-error'] = true;
    assert.throws(() => validateVerifyWorkflow(yaml.safeDump(verifyMutation)), assert.AssertionError,
        'reusable verification must recursively reject continue-on-error');

    const scheduled = parseWorkflow(readText('.github/workflows/scheduled-verification.yml'),
        'scheduled verification workflow');
    validateScheduledWorkflow(scheduled);
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => { delete value.on.schedule; }, 'schedule removal must be rejected');
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => { value.jobs['scheduled-macos'].steps[1].with['node-version'] = '22'; },
        'Node version drift must be rejected');
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => { value.jobs['scheduled-macos'].steps.push({ uses: 'actions/upload-artifact@v4' }); },
        'artifact upload must be rejected');
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => { value.jobs['scheduled-macos'].steps.pop(); },
        'Extension Host step removal must be rejected');
    assertWorkflowMutationsRejected(validateScheduledWorkflow, scheduled, [
        ['invalid cron expression', value => { value.on.schedule[0].cron = 'not a cron'; }],
        ['secrets context reference', value => {
            value.jobs['scheduled-macos'].steps[0].env = { TOKEN: '${{ secrets.RELEASE_TOKEN }}' };
        }],
        ['case-insensitive spaced secrets context reference', value => {
            value.name = 'Scheduled ${{  SeCrEtS . RELEASE_TOKEN }}';
        }],
        ['continue-on-error', value => { value.jobs['scheduled-macos']['continue-on-error'] = true; }],
        ['additional artifact action', value => {
            value.jobs['scheduled-macos'].steps.push({ uses: 'actions/upload-pages-artifact@v3' });
        }],
        ['job if condition', value => { value.jobs['scheduled-macos'].if = false; }],
        ['secrets context mapping key', value => {
            value.metadata = { '${{ secrets.TOKEN }}': 'redacted' };
        }],
        ['out-of-range cron fields', value => { value.on.schedule[0].cron = '99 99 99 99 99'; }],
        ['unreviewed every-minute schedule', value => { value.on.schedule[0].cron = '* * * * *'; }],
    ]);

    const release = parseWorkflow(workflow, 'release workflow');
    validateReleaseWorkflow(release);
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { delete value.jobs.release.needs; }, 'release dependency removal must be rejected');
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { value.permissions = { contents: 'write' }; },
        'top-level write permission must be rejected');
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { value.jobs.verify.secrets = 'inherit'; },
        'verification secrets inheritance must be rejected');
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { value.jobs.release.steps[0]['continue-on-error'] = true; },
        'release continue-on-error must be rejected recursively');

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
