'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const checkerPath = path.resolve(__dirname, '../../../scripts/check-coverage-baseline.js');
const {
    compareCoverageBaseline,
    readCoverageTotals,
} = require(checkerPath);

function coverageSummary(metrics) {
    return {
        total: Object.fromEntries(Object.entries(metrics).map(([metric, pct]) => [metric, { pct }])),
    };
}

const baseline = {
    lines: 80,
    branches: 70,
    functions: 60,
    statements: 90,
};

test('COVERAGE-BASELINE-001 reads and rounds total coverage metrics to two decimals', () => {
    assert.deepEqual(readCoverageTotals(coverageSummary({
        lines: 80.123,
        branches: 70.456,
        functions: 60.789,
        statements: 90.001,
    })), {
        lines: 80.12,
        branches: 70.46,
        functions: 60.79,
        statements: 90,
    });
});

test('COVERAGE-BASELINE-002 permits coverage that equals the baseline', () => {
    assert.deepEqual(compareCoverageBaseline(baseline, { ...baseline }), []);
});

test('COVERAGE-BASELINE-003 permits coverage that increases from the baseline', () => {
    assert.deepEqual(compareCoverageBaseline(baseline, {
        lines: 80.01,
        branches: 70.01,
        functions: 60.01,
        statements: 90.01,
    }), []);
});

for (const metric of Object.keys(baseline)) {
    test(`COVERAGE-BASELINE-004 rejects a 0.01 decrease in ${metric}`, () => {
        const current = { ...baseline, [metric]: baseline[metric] - 0.01 };

        assert.deepEqual(compareCoverageBaseline(baseline, current), [
            `${metric} coverage decreased from ${baseline[metric].toFixed(2)}% to ${current[metric].toFixed(2)}%`,
        ]);
    });
}

test('COVERAGE-BASELINE-005 rejects malformed coverage summaries', () => {
    assert.throws(() => readCoverageTotals(null), /coverage summary must be an object/);
    assert.throws(() => readCoverageTotals(coverageSummary({
        lines: 80,
        branches: '70',
        functions: 60,
        statements: 90,
    })), /branches coverage percentage must be a finite number/);
});

test('COVERAGE-BASELINE-006 rejects coverage summaries without total', () => {
    assert.throws(() => readCoverageTotals({}), /coverage summary must include a total entry/);
});

test('COVERAGE-BASELINE-007 prevents CI from writing a coverage baseline', () => {
    const result = childProcess.spawnSync(process.execPath, [checkerPath, '--write-baseline'], {
        cwd: path.resolve(__dirname, '../../..'),
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot write the coverage baseline in CI/);
});
