'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const spikeRoot = path.resolve(__dirname, '..');
const artifactsDirectory = path.join(spikeRoot, 'artifacts');
const packages = [
    {
        extensionDirectory: path.join(spikeRoot, 'ui-bridge'),
        artifactPath: 'artifacts/project-steward-attention-ui-bridge-probe-0.0.3.vsix',
    },
    {
        extensionDirectory: path.join(spikeRoot, 'workspace'),
        artifactPath: 'artifacts/project-steward-attention-workspace-probe-0.0.5.vsix',
    },
];

fs.rmSync(artifactsDirectory, { recursive: true, force: true });
fs.mkdirSync(artifactsDirectory, { recursive: true });

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const extensionPackage of packages) {
    const outputPath = path.join(spikeRoot, extensionPackage.artifactPath);
    const result = childProcess.spawnSync(
        npx,
        ['@vscode/vsce', 'package', '--out', outputPath],
        {
            cwd: extensionPackage.extensionDirectory,
            shell: false,
            stdio: 'inherit',
        }
    );

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        process.exit(result.status === null ? 1 : result.status);
    }
}

for (const extensionPackage of packages) {
    console.log(extensionPackage.artifactPath);
}
