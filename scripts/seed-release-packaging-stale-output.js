'use strict';

const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const staleRelativePaths = [
    'out/stale-release-output.js',
    'dist/stale-release-output.js',
    'extensions/attention-ui-bridge/out/stale-release-output.js',
    'extensions/attention-ui-bridge/dist/stale-release-output.js',
    'coverage/tmp/stale-coverage.json',
];

function seedStaleReleasePackagingOutputs() {
    for (const relativePath of staleRelativePaths) {
        const filePath = path.join(repositoryRoot, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'STALE_RELEASE_PACKAGING_PROBE', 'utf8');
    }

    console.log('Seeded stale release packaging outputs.');
}

if (require.main === module) {
    seedStaleReleasePackagingOutputs();
}

module.exports = {
    seedStaleReleasePackagingOutputs,
    staleRelativePaths,
};
