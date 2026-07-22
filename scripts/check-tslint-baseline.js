'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function toRepositoryPath(fileName, root) {
    return path.relative(root, fileName).split(path.sep).join('/');
}

function sortedSummary(summary) {
    const sorted = {};
    for (const fileName of Object.keys(summary).sort()) {
        sorted[fileName] = {};
        for (const ruleName of Object.keys(summary[fileName]).sort()) {
            sorted[fileName][ruleName] = summary[fileName][ruleName];
        }
    }
    return sorted;
}

function summarizeFailures(failures, root) {
    const summary = {};
    for (const failure of failures) {
        if (failure.ruleSeverity !== 'warning') {
            continue;
        }

        const fileName = toRepositoryPath(failure.name, root);
        if (!summary[fileName]) {
            summary[fileName] = {};
        }
        summary[fileName][failure.ruleName] = (summary[fileName][failure.ruleName] || 0) + 1;
    }
    return sortedSummary(summary);
}

function compareWarningBaseline(baseline, current) {
    const increases = [];
    for (const fileName of Object.keys(current).sort()) {
        for (const ruleName of Object.keys(current[fileName]).sort()) {
            const baselineCount = (baseline[fileName] && baseline[fileName][ruleName]) || 0;
            const currentCount = current[fileName][ruleName];
            if (currentCount > baselineCount) {
                increases.push(`${fileName} ${ruleName} ${baselineCount}=${currentCount}`);
            }
        }
    }
    return increases;
}

function buildTslintInvocation() {
    return {
        command: process.execPath,
        args: [require.resolve('tslint/bin/tslint'), '-p', './', '-t', 'json'],
    };
}

function runTslint(root) {
    const invocation = buildTslintInvocation();
    const result = childProcess.spawnSync(invocation.command, invocation.args, {
        cwd: root,
        encoding: 'utf8',
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `TSLint exited with status ${result.status}.`);
    }
    return JSON.parse(result.stdout);
}

function writeBaselineAtomically(baselinePath, baseline, fileSystem = fs) {
    const contents = `${JSON.stringify(baseline, null, 2)}\n`;
    const directory = path.dirname(baselinePath);
    const temporaryPath = path.join(
        directory,
        `.${path.basename(baselinePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    fileSystem.mkdirSync(directory, { recursive: true });
    try {
        fileSystem.writeFileSync(temporaryPath, contents);
        fileSystem.renameSync(temporaryPath, baselinePath);
    } catch (error) {
        try {
            fileSystem.unlinkSync(temporaryPath);
        } catch (cleanupError) {
            // The temporary file may not have been created.
        }
        throw error;
    }
}

function main() {
    const root = path.resolve(__dirname, '..');
    const baselinePath = path.join(root, '.ci', 'tslint-warning-baseline.json');
    const current = summarizeFailures(runTslint(root), root);

    if (process.argv.includes('--write-baseline')) {
        writeBaselineAtomically(baselinePath, current);
        return;
    }

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const increases = compareWarningBaseline(baseline, current);
    if (increases.length > 0) {
        for (const increase of increases) {
            console.error(increase);
        }
        process.exitCode = 1;
        return;
    }
    console.log('TSLint warning baseline checks passed.');
}

if (require.main === module) {
    main();
}

module.exports = {
    buildTslintInvocation,
    compareWarningBaseline,
    summarizeFailures,
    writeBaselineAtomically,
};
