'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonFileAtomically } = require('./lib/jsonFile');

const COVERAGE_METRICS = ['lines', 'branches', 'functions', 'statements'];

function roundPercentage(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function readCoverageTotals(summary) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        throw new Error('coverage summary must be an object');
    }
    if (!summary.total || typeof summary.total !== 'object' || Array.isArray(summary.total)) {
        throw new Error('coverage summary must include a total entry');
    }

    const totals = {};
    for (const metric of COVERAGE_METRICS) {
        const percentage = summary.total[metric] && summary.total[metric].pct;
        if (typeof percentage !== 'number' || !Number.isFinite(percentage)) {
            throw new Error(`${metric} coverage percentage must be a finite number`);
        }
        totals[metric] = roundPercentage(percentage);
    }
    return totals;
}

function validateCoverageBaseline(baseline) {
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
        throw new Error('coverage baseline must be an object');
    }
    for (const metric of COVERAGE_METRICS) {
        if (typeof baseline[metric] !== 'number' || !Number.isFinite(baseline[metric])) {
            throw new Error(`${metric} baseline coverage percentage must be a finite number`);
        }
    }
    return baseline;
}

function compareCoverageBaseline(baseline, current) {
    const decreases = [];
    for (const metric of COVERAGE_METRICS) {
        if (current[metric] < baseline[metric]) {
            decreases.push(
                `${metric} coverage decreased from ${baseline[metric].toFixed(2)}% to ${current[metric].toFixed(2)}%`
            );
        }
    }
    return decreases;
}

function writeCoverageBaseline(baselinePath, current, fileSystem = fs) {
    writeJsonFileAtomically(baselinePath, current, fileSystem);
}

function main() {
    const root = path.resolve(__dirname, '..');
    const baselinePath = path.join(root, '.ci', 'coverage-baseline.json');
    const isWriteBaseline = process.argv.includes('--write-baseline');

    if (isWriteBaseline && process.env.CI) {
        throw new Error('cannot write the coverage baseline in CI');
    }

    const summaryPath = path.join(root, 'coverage', 'coverage-summary.json');
    const current = readCoverageTotals(JSON.parse(fs.readFileSync(summaryPath, 'utf8')));

    if (isWriteBaseline) {
        writeCoverageBaseline(baselinePath, current);
        return;
    }

    const baseline = validateCoverageBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
    const decreases = compareCoverageBaseline(baseline, current);
    if (decreases.length > 0) {
        for (const decrease of decreases) {
            console.error(decrease);
        }
        process.exitCode = 1;
        return;
    }
    console.log('Coverage baseline checks passed.');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = {
    compareCoverageBaseline,
    readCoverageTotals,
    validateCoverageBaseline,
    writeCoverageBaseline,
};
