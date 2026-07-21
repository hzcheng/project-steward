'use strict';

const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const generatedDirectories = [
    path.join(repositoryRoot, 'out'),
    path.join(repositoryRoot, 'dist'),
    path.join(repositoryRoot, 'extensions', 'attention-ui-bridge', 'out'),
    path.join(repositoryRoot, 'extensions', 'attention-ui-bridge', 'dist'),
];

for (const directory of generatedDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
}

console.log('Cleaned release build outputs.');
