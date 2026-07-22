'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { validateVerifyWorkflow } = require('./lib/ciContracts');

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
    if (Array.isArray(value)) {
        return value.some(item => containsKey(item, key));
    }
    if (!isMapping(value)) {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(value, key)
        || Object.values(value).some(item => containsKey(item, key));
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

function findStep(job, predicate, label) {
    assert.ok(Array.isArray(job.steps), `${label} steps must be an array`);
    return job.steps.find(predicate);
}

function validateScheduledWorkflow(workflow) {
    assert.ok(isMapping(workflow.on), 'scheduled verification on must be a mapping');
    assert.ok(Array.isArray(workflow.on.schedule), 'scheduled verification must define schedule');
    assert.ok(workflow.on.schedule.length > 0, 'scheduled verification schedule must not be empty');
    for (const entry of workflow.on.schedule) {
        assert.ok(isMapping(entry) && typeof entry.cron === 'string' && entry.cron.trim(),
            'scheduled verification schedule entries must define cron');
    }
    assert.ok(Object.prototype.hasOwnProperty.call(workflow.on, 'workflow_dispatch'),
        'scheduled verification must define workflow_dispatch');
    assert.ok(workflow.on.workflow_dispatch === null || isMapping(workflow.on.workflow_dispatch),
        'scheduled verification workflow_dispatch must be empty or a mapping');
    assert.deepStrictEqual(workflow.permissions, { contents: 'read' },
        'scheduled verification permissions must be exactly contents: read');
    assert.ok(isMapping(workflow.jobs), 'scheduled verification jobs must be a mapping');
    assert.deepStrictEqual(Object.keys(workflow.jobs), ['scheduled-macos'],
        'scheduled verification must contain only the scheduled-macos job');
    const job = workflow.jobs['scheduled-macos'];
    assert.ok(isMapping(job), 'scheduled verification must define scheduled-macos');
    assert.strictEqual(job['runs-on'], 'macos-latest', 'scheduled-macos must use macos-latest');
    assert.strictEqual(job['timeout-minutes'], 15, 'scheduled-macos timeout must be 15 minutes');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(job, 'permissions'), false,
        'scheduled-macos must not override read-only permissions');
    assert.ok(findStep(job, step => isMapping(step) && step.uses === 'actions/checkout@v4', 'scheduled-macos'),
        'scheduled-macos must use actions/checkout@v4');
    const setupNode = findStep(job,
        step => isMapping(step) && step.uses === 'actions/setup-node@v4', 'scheduled-macos');
    assert.ok(setupNode && isMapping(setupNode.with), 'scheduled-macos must configure setup-node');
    assert.strictEqual(setupNode.with['node-version'], '22.12.0',
        'scheduled-macos must use Node 22.12.0');
    assert.strictEqual(setupNode.with.cache, 'npm', 'scheduled-macos must cache npm');
    const commands = job.steps.filter(step => isMapping(step) && typeof step.run === 'string')
        .map(step => step.run);
    for (const command of [
        'npm ci',
        'npm run test-compile',
        'npm run test:behavior-contracts',
        'npm run test:deterministic:run',
        'npm run lint:ci',
        'npm run test:release-packaging',
    ]) {
        assert.ok(commands.includes(command), `scheduled-macos must run ${command}`);
    }
    assert.strictEqual(job.steps.some(step => isMapping(step)
        && typeof step.uses === 'string'
        && step.uses.startsWith('actions/upload-artifact@')), false,
        'scheduled verification must not upload artifacts');
    assert.strictEqual(containsKey(workflow, 'secrets'), false,
        'scheduled verification must not use secrets');
}

function validateReleaseWorkflow(workflow) {
    assert.ok(isMapping(workflow.on), 'release workflow on must be a mapping');
    assert.ok(isMapping(workflow.jobs), 'release workflow jobs must be a mapping');
    assert.deepStrictEqual(workflow.permissions, { contents: 'read' },
        'release workflow top-level permissions must be exactly contents: read');
    assert.deepStrictEqual(Object.keys(workflow.jobs).sort(), ['release', 'verify'],
        'release workflow must contain only verify and release jobs');
    const verify = workflow.jobs.verify;
    assert.ok(isMapping(verify), 'release workflow must define verify');
    assert.strictEqual(verify.uses, './.github/workflows/verify.yml',
        'release verify job must call the reusable verification workflow');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(verify, 'permissions'), false,
        'release verify job must not receive elevated permissions');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(verify, 'secrets'), false,
        'release verify job must not receive secrets');
    const release = workflow.jobs.release;
    assert.ok(isMapping(release), 'release workflow must define release');
    assert.strictEqual(release.needs, 'verify', 'release job must need verify');
    assert.deepStrictEqual(release.permissions, { contents: 'write' },
        'release job permissions must be exactly contents: write');
}

function assertWorkflowMutationRejected(validate, workflow, mutate, message) {
    const mutation = JSON.parse(JSON.stringify(workflow));
    mutate(mutation);
    assert.throws(() => validate(mutation), assert.AssertionError, message);
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

    const verifyWorkflow = readText('.github/workflows/verify.yml');
    validateVerifyWorkflow(verifyWorkflow);

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
        value => { value.jobs['scheduled-macos'].permissions = { contents: 'write' }; },
        'scheduled job write permission must be rejected');

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
}

run();
console.log('Release packaging checks passed.');
