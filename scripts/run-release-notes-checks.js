'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const extractorPath = path.join(__dirname, 'extract-release-notes.js');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'release-vsix.yml');

function runWorkspaceFirstReleaseContentChecks() {
    const read = relativePath => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
    const readme = read('README.md');
    const changelog = read('CHANGELOG.md');
    const packageMetadata = JSON.parse(read('package.json'));
    const currentRelease = changelog.split('## [2.1.3]')[1].split(/\n## \[/)[0];
    const requiredReleaseFacts = [
        ['one card per non-empty VS Code workspace', /one card per non-empty VS Code workspace/i],
        ['all roots with provider-native --add-dir', /all (?:workspace )?roots[\s\S]{0,160}--add-dir/i],
        ['trust and capability preflight', /Restricted Mode[\s\S]{0,200}(?:capability|--add-dir)/i],
        ['safe other-window navigation fallback', /navigation[\s\S]{0,200}(?:Switch Window|save it first)/i],
        ['saved-project preservation', /saved projects[\s\S]{0,160}(?:preserv|unchanged)/i],
        ['v2 UI Bridge requirement', /(?:UI Bridge|bridge)[\s\S]{0,80}v2/i],
        ['intentional legacy runtime non-adoption', /legacy[\s\S]{0,160}(?:runtime|terminal|tmux)[\s\S]{0,160}(?:not adopted|not migrated|recreate|resume)/i],
    ];

    for (const [label, pattern] of requiredReleaseFacts) {
        assert.match(readme, pattern, `README must document ${label}`);
        assert.match(currentRelease, pattern, `current CHANGELOG release must document ${label}`);
    }

    assert.match(packageMetadata.description, /workspace/i,
        'package metadata must describe the workspace-first product boundary');
}

function runExtractor(version, changelogPath) {
    return spawnSync(process.execPath, [extractorPath, version, changelogPath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
    });
}

function runExtractionChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-release-notes-'));
    const changelogPath = path.join(tempRoot, 'CHANGELOG.md');

    try {
        fs.writeFileSync(changelogPath, [
            '# Changelog',
            '',
            '## [1.2.3] 2026-07-13',
            '',
            '### Added',
            '',
            '- Useful release note.',
            '',
            '## [1.2.2] 2026-07-12',
            '',
            '- Previous release.',
            '',
        ].join('\n'), 'utf8');

        const success = runExtractor('1.2.3', changelogPath);
        assert.strictEqual(success.status, 0, success.stderr);
        assert.strictEqual(success.stdout, '### Added\n\n- Useful release note.\n');
        assert.strictEqual(success.stdout.includes('Previous release'), false);

        const missing = runExtractor('9.9.9', changelogPath);
        assert.notStrictEqual(missing.status, 0);
        assert.strictEqual(
            missing.stderr.trim(),
            `No non-empty CHANGELOG.md section found for version 9.9.9.`
        );

        fs.writeFileSync(changelogPath, [
            '# Changelog',
            '',
            '## [2.0.0] 2026-07-13',
            '',
            '## [1.9.9] 2026-07-12',
            '',
            '- Previous release.',
            '',
        ].join('\n'), 'utf8');
        const empty = runExtractor('2.0.0', changelogPath);
        assert.notStrictEqual(empty.status, 0);
        assert.strictEqual(
            empty.stderr.trim(),
            `No non-empty CHANGELOG.md section found for version 2.0.0.`
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runWorkflowChecks() {
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    assert.match(
        workflow,
        /node scripts\/extract-release-notes\.js "\$VERSION" > release-notes\.md/
    );
    assert.match(workflow, /--notes-file release-notes\.md/);
    assert.strictEqual(workflow.includes('--notes "VSIX package for'), false);
    assert.match(workflow, /- name: Verify release notes\n\s+run: npm run test:release-notes/);
    assert.match(workflow, /- name: Package and verify release VSIX files\n\s+run: npm run test:release-packaging/);
    assert.strictEqual(workflow.includes('run: npm run package:release'), false);
    assert.match(workflow, /bridge_vsix_file=/);
    assert.match(workflow, /gh release create "\$TAG" "\$BRIDGE_VSIX_FILE" "\$MAIN_VSIX_FILE"/);
    assert.strictEqual(
        workflow.includes('npx --yes @vscode/vsce package --allow-star-activation --out "${{ steps.meta.outputs.vsix_file }}"'),
        false
    );
}

runExtractionChecks();
runWorkflowChecks();
runWorkspaceFirstReleaseContentChecks();
console.log('Release notes checks passed.');
