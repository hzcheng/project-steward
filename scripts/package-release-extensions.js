'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const artifactsDirectory = path.join(repositoryRoot, 'artifacts');
const mainPackage = require(path.join(repositoryRoot, 'package.json'));
const bridgeDirectory = path.join(repositoryRoot, 'extensions', 'attention-ui-bridge');
const bridgePackage = require(path.join(bridgeDirectory, 'package.json'));

const packages = [
    {
        label: `${bridgePackage.publisher}.${bridgePackage.name}`,
        extensionDirectory: bridgeDirectory,
        artifactPath: path.join(artifactsDirectory, `${bridgePackage.name}-${bridgePackage.version}.vsix`),
    },
    {
        label: `${mainPackage.publisher}.${mainPackage.name}`,
        extensionDirectory: repositoryRoot,
        artifactPath: path.join(artifactsDirectory, `${mainPackage.name}-${mainPackage.version}.vsix`),
    },
];

function runVsce(extensionPackage) {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = childProcess.spawnSync(
        npx,
        ['--yes', '@vscode/vsce', 'package', '--allow-star-activation', '--out', extensionPackage.artifactPath],
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

fs.rmSync(artifactsDirectory, { recursive: true, force: true });
fs.mkdirSync(artifactsDirectory, { recursive: true });

for (const extensionPackage of packages) {
    console.log(`Packaging ${extensionPackage.label} -> ${path.relative(repositoryRoot, extensionPackage.artifactPath)}`);
    runVsce(extensionPackage);
}

console.log('Release VSIX files:');
for (const extensionPackage of packages) {
    console.log(path.relative(repositoryRoot, extensionPackage.artifactPath));
}
