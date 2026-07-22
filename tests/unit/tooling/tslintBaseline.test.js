'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    buildTslintInvocation,
    compareWarningBaseline,
    summarizeFailures,
    writeBaselineAtomically,
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

test('TSLINT-BASELINE-006 invokes the resolved TSLint JavaScript CLI with the current Node executable', () => {
    const invocation = buildTslintInvocation();

    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0], require.resolve('tslint/bin/tslint'));
    assert.deepEqual(invocation.args.slice(1), ['-p', './', '-t', 'json']);
});

test('TSLINT-BASELINE-007 atomically replaces the baseline without leaving a temporary file', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tslint-baseline-'));
    const ciDirectory = path.join(root, '.ci');
    const baselinePath = path.join(ciDirectory, 'tslint-warning-baseline.json');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(ciDirectory);
    fs.writeFileSync(baselinePath, '{"old":true}\n');

    writeBaselineAtomically(baselinePath, { 'src/example.ts': { semicolon: 1 } });

    assert.deepEqual(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), {
        'src/example.ts': { semicolon: 1 },
    });
    assert.deepEqual(fs.readdirSync(ciDirectory), ['tslint-warning-baseline.json']);
});

test('TSLINT-BASELINE-008 removes the temporary baseline when replacement fails', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tslint-baseline-'));
    const ciDirectory = path.join(root, '.ci');
    const baselinePath = path.join(ciDirectory, 'tslint-warning-baseline.json');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(ciDirectory);

    assert.throws(() => writeBaselineAtomically(baselinePath, {}, {
        mkdirSync: fs.mkdirSync,
        renameSync: () => { throw new Error('replace failed'); },
        unlinkSync: fs.unlinkSync,
        writeFileSync: fs.writeFileSync,
    }), /replace failed/);
    assert.deepEqual(fs.readdirSync(ciDirectory), []);
});
