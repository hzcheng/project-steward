'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const extractorPath = path.join(__dirname, 'extract-release-notes.js');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'release-vsix.yml');

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
}

runExtractionChecks();
runWorkflowChecks();
console.log('Release notes checks passed.');
