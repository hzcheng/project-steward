'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const packageJson = require(path.resolve(__dirname, '../../../package.json'));

test('TEST-PACKAGE-SCRIPTS-001 test-compile builds root and attention bridge TypeScript outputs', () => {
    assert.equal(
        packageJson.scripts['test-compile'],
        'tsc -p ./ && npm run attention:bridge:compile'
    );
    assert.equal(
        packageJson.scripts['attention:bridge:compile'],
        'tsc -p extensions/attention-ui-bridge/tsconfig.json'
    );
});
