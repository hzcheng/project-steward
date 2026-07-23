'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
for (const relativePath of ['out', 'extensions/attention-ui-bridge/out']) {
    fs.rmSync(path.join(repositoryRoot, relativePath), { recursive: true, force: true });
}
