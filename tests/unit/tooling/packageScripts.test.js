'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const packageJson = require(path.resolve(__dirname, '../../../package.json'));

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
