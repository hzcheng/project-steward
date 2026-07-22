'use strict';

const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const staleFiles = [
    path.join(repositoryRoot, 'out', 'workspaces', '__staleReleasePackagingProbe.js'),
    path.join(repositoryRoot, 'dist', '__staleReleasePackagingProbe.js'),
    path.join(repositoryRoot, 'extensions', 'attention-ui-bridge', 'out', '__staleReleasePackagingProbe.js'),
    path.join(repositoryRoot, 'extensions', 'attention-ui-bridge', 'dist', '__staleReleasePackagingProbe.js'),
];

for (const filePath of staleFiles) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'STALE_RELEASE_PACKAGING_PROBE', 'utf8');
}

console.log('Seeded stale release packaging outputs.');
