'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadSiblingTests(directory) {
    const testFiles = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
        .map(entry => entry.name)
        .sort();

    testFiles.forEach(fileName => require(path.join(directory, fileName)));
    return testFiles;
}

module.exports = {
    loadSiblingTests,
};
