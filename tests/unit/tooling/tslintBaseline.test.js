'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
    compareWarningBaseline,
    summarizeFailures,
} = require('../../../scripts/check-tslint-baseline');

test('TSLINT-BASELINE-001 ignores line movement when file and rule counts are unchanged', () => {
    const root = path.resolve('/repository');
    const baseline = { 'src/example.ts': { semicolon: 1 } };
    const current = summarizeFailures([{
        name: path.join(root, 'src', 'example.ts'),
        ruleName: 'semicolon',
        ruleSeverity: 'warning',
        startPosition: { line: 200 },
    }], root);

    assert.deepEqual(compareWarningBaseline(baseline, current), []);
});

test('TSLINT-BASELINE-002 reports a new rule or file pair', () => {
    const baseline = { 'src/example.ts': { semicolon: 1 } };
    const current = {
        'src/example.ts': { semicolon: 1, curly: 1 },
        'src/new-file.ts': { quotemark: 1 },
    };

    assert.deepEqual(compareWarningBaseline(baseline, current), [
        'src/example.ts curly 0=1',
        'src/new-file.ts quotemark 0=1',
    ]);
});

test('TSLINT-BASELINE-003 reports increased warning counts', () => {
    const baseline = { 'src/example.ts': { semicolon: 1 } };
    const current = { 'src/example.ts': { semicolon: 2 } };

    assert.deepEqual(compareWarningBaseline(baseline, current), [
        'src/example.ts semicolon 1=2',
    ]);
});

test('TSLINT-BASELINE-004 allows decreased warning counts', () => {
    const baseline = { 'src/example.ts': { semicolon: 2 } };
    const current = { 'src/example.ts': { semicolon: 1 } };

    assert.deepEqual(compareWarningBaseline(baseline, current), []);
});

test('TSLINT-BASELINE-005 summarizes absolute paths as repository-relative POSIX paths', () => {
    const root = path.resolve('/repository');
    const failures = [{
        name: path.join(root, 'src', 'feature', 'example.ts'),
        ruleName: 'semicolon',
        ruleSeverity: 'warning',
    }];

    assert.deepEqual(summarizeFailures(failures, root), {
        'src/feature/example.ts': { semicolon: 1 },
    });
});
