'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = require(path.resolve(__dirname, '../../../package.json'));
const { staleRelativePaths } = require('../../../scripts/seed-release-packaging-stale-output');

const expectedStaleRelativePaths = [
    'out/stale-release-output.js',
    'dist/stale-release-output.js',
    'extensions/attention-ui-bridge/out/stale-release-output.js',
    'extensions/attention-ui-bridge/dist/stale-release-output.js',
    'coverage/tmp/stale-coverage.json',
];

function assertReleaseResidueContract(paths, vscodeIgnore) {
    assert.deepEqual(paths, expectedStaleRelativePaths);
    for (const exclusion of ['.ci/**', 'tests/**', 'coverage/**']) {
        assert.ok(vscodeIgnore.split(/\r?\n/).includes(exclusion),
            `.vscodeignore must exclude ${exclusion}`);
    }
}

test('TEST-PACKAGE-SCRIPTS-001 test-compile removes stale outputs before building root and attention bridge TypeScript', () => {
    assert.equal(
        packageJson.scripts['test-compile'],
        'node scripts/clean-test-build.js && tsc -p ./ && npm run attention:bridge:compile'
    );
    assert.equal(require('node:fs').existsSync(
        path.resolve(__dirname, '../../../scripts/clean-test-build.js')
    ), true);
    assert.equal(
        packageJson.scripts['attention:bridge:compile'],
        'tsc -p extensions/attention-ui-bridge/tsconfig.json'
    );
});

test('RELEASE-VSIX-PACKAGING-001 seeds every repeated-build residue class and excludes non-production roots', () => {
    const vscodeIgnore = fs.readFileSync(
        path.resolve(__dirname, '../../../.vscodeignore'),
        'utf8'
    );
    assertReleaseResidueContract(staleRelativePaths, vscodeIgnore);
    assert.throws(
        () => assertReleaseResidueContract(
            staleRelativePaths.filter(fileName => fileName !== 'coverage/tmp/stale-coverage.json'),
            vscodeIgnore
        ),
        assert.AssertionError
    );
});
