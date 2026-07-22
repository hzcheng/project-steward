'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeTempDirectory(testContext, prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

module.exports = {
    makeTempDirectory,
};
