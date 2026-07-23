'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadBehaviorCatalog, validateBehaviorCatalog } = require('./lib/behaviorCatalog');
const {
    loadMainCapabilityCoverage,
    validateMainCapabilityCoverage,
} = require('./lib/mainCapabilityCoverage');

function collectAuditedCommits(repositoryRoot, audit) {
    const hashes = childProcess.execFileSync(
        'git',
        ['rev-list', '--reverse', `${audit.base}..${audit.head}`],
        { cwd: repositoryRoot, encoding: 'utf8' }
    ).trim().split(/\r?\n/u).filter(Boolean);
    return hashes.map(hash => ({
        hash,
        subject: childProcess.execFileSync(
            'git',
            ['show', '-s', '--format=%s', hash],
            { cwd: repositoryRoot, encoding: 'utf8' }
        ).trim(),
        files: childProcess.execFileSync(
            'git',
            ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', hash],
            { cwd: repositoryRoot, encoding: 'utf8' }
        ).trim().split(/\r?\n/u).filter(Boolean),
    }));
}

function loadWorkflowSources(repositoryRoot) {
    const workflowDirectory = path.join(repositoryRoot, '.github', 'workflows');
    return Object.fromEntries(
        fs.readdirSync(workflowDirectory)
            .filter(name => /\.ya?ml$/u.test(name))
            .map(name => [name, fs.readFileSync(path.join(workflowDirectory, name), 'utf8')])
    );
}

function main() {
    const repositoryRoot = path.resolve(__dirname, '..');
    const catalogPath = path.join(repositoryRoot, 'docs', 'testing', 'behavior-contracts.json');
    const capabilityPath = path.join(
        repositoryRoot,
        'docs',
        'testing',
        'main-capability-coverage.json'
    );
    let entries;
    let manifest;
    try {
        entries = loadBehaviorCatalog(catalogPath);
        manifest = loadMainCapabilityCoverage(capabilityPath);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
    }

    const behaviorErrors = validateBehaviorCatalog(entries, { repositoryRoot });
    let capabilityErrors;
    try {
        capabilityErrors = validateMainCapabilityCoverage(manifest, {
            repositoryRoot,
            behaviors: entries,
            scripts: require(path.join(repositoryRoot, 'package.json')).scripts,
            workflows: loadWorkflowSources(repositoryRoot),
            auditedCommits: collectAuditedCommits(repositoryRoot, manifest.audit),
        });
    } catch (error) {
        capabilityErrors = [`cannot collect main capability evidence: ${error.message}`];
    }
    const errors = [...behaviorErrors, ...capabilityErrors];
    if (errors.length > 0) {
        for (const error of errors) {
            console.error(error);
        }
        process.exitCode = 1;
        return;
    }

    console.log('Behavior contract catalog checks passed.');
    console.log('Main capability regression coverage checks passed.');
}

main();
