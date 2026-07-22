'use strict';

const path = require('node:path');
const { loadBehaviorCatalog, validateBehaviorCatalog } = require('./lib/behaviorCatalog');

function main() {
    const repositoryRoot = path.resolve(__dirname, '..');
    const catalogPath = path.join(repositoryRoot, 'docs', 'testing', 'behavior-contracts.json');
    let entries;
    try {
        entries = loadBehaviorCatalog(catalogPath);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
    }

    const errors = validateBehaviorCatalog(entries, { repositoryRoot });
    if (errors.length > 0) {
        for (const error of errors) {
            console.error(error);
        }
        process.exitCode = 1;
        return;
    }

    console.log('Behavior contract catalog checks passed.');
}

main();
