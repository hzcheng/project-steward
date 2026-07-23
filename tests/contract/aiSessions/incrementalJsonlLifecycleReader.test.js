'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const lifecycle = require('../../../out/aiSessions/lifecycle');
const IncrementalJsonlLifecycleReader = require('../../../out/aiSessions/incrementalJsonlLifecycleReader').default;

const RUN_STARTED_AT_MS = Date.parse('2026-07-15T00:00:00.000Z');

function createAccumulator(runStartedAtMs = RUN_STARTED_AT_MS) {
    return lifecycle.createCodexLifecycleAccumulator(runStartedAtMs);
}

function codexEvent(timestamp, type, turnId) {
    return JSON.stringify({ timestamp, type: 'event_msg', payload: { type, turn_id: turnId } });
}

test('PERSIST-INCREMENTAL-JSONL-LIFECYCLE-READER-001 cold-scans all chunks, appends incrementally, and skips unchanged files', t => {
    const root = makeTempDirectory(t, 'incremental-reader-append-');
    const reader = new IncrementalJsonlLifecycleReader(64);
    const filePath = path.join(root, 'codex.jsonl');
    const started = codexEvent('2026-07-15T00:00:01.000Z', 'task_started', 'long-turn');
    fs.writeFileSync(filePath, `${started}\n${Array.from({ length: 100 }, (_, index) => JSON.stringify({
        timestamp: `2026-07-15T00:00:02.${String(index).padStart(3, '0')}Z`,
        type: 'event_msg', payload: { type: 'token_count' },
    })).join('\n')}\n`, 'utf8');

    const originalReadSync = fs.readSync;
    let readCalls = 0;
    fs.readSync = function () {
        readCalls++;
        return originalReadSync.apply(this, arguments);
    };
    t.after(() => { fs.readSync = originalReadSync; });

    let signal = reader.read('codex:long', filePath, RUN_STARTED_AT_MS, createAccumulator);
    assert.equal(signal.executionState, 'running');
    fs.appendFileSync(filePath, `${codexEvent(
        '2026-07-15T00:00:03.000Z', 'task_complete', 'long-turn'
    )}\n`, 'utf8');
    signal = reader.read('codex:long', filePath, RUN_STARTED_AT_MS, createAccumulator);
    assert.equal(signal.executionState, 'stopped');

    const readsAfterAppend = readCalls;
    assert.equal(reader.read(
        'codex:long', filePath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'stopped');
    assert.equal(readCalls, readsAfterAppend, 'unchanged size must perform no additional reads');
});

test('PERSIST-INCREMENTAL-JSONL-LIFECYCLE-READER-001 joins split lines, resumes later input, and survives malformed JSON', t => {
    const root = makeTempDirectory(t, 'incremental-reader-split-');
    const reader = new IncrementalJsonlLifecycleReader(64);
    const inputPath = path.join(root, 'input.jsonl');
    fs.writeFileSync(inputPath, `${JSON.stringify({
        timestamp: '2026-07-15T00:00:04.000Z', type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'later-answer' },
    })}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:input', inputPath, RUN_STARTED_AT_MS, createAccumulator
    ).reason, 'input-required');
    fs.appendFileSync(inputPath, `${JSON.stringify({
        timestamp: '2026-07-15T00:00:05.000Z', type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'later-answer' },
    })}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:input', inputPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'running');

    const splitPath = path.join(root, 'split.jsonl');
    const splitLine = codexEvent('2026-07-15T00:00:06.000Z', 'task_started', 'split-line');
    const splitAt = Math.floor(splitLine.length / 2);
    fs.writeFileSync(splitPath, splitLine.slice(0, splitAt), 'utf8');
    assert.equal(reader.read('codex:split', splitPath, RUN_STARTED_AT_MS, createAccumulator), null);
    fs.appendFileSync(splitPath, `${splitLine.slice(splitAt)}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:split', splitPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'running');

    const malformedPath = path.join(root, 'malformed.jsonl');
    fs.writeFileSync(malformedPath, `{bad json\n${codexEvent(
        '2026-07-15T00:00:07.000Z', 'task_started', 'after-bad'
    )}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:malformed', malformedPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'running');
});

test('PERSIST-INCREMENTAL-JSONL-LIFECYCLE-READER-001 resets on truncation and isolates stat, open, path, and run failures', t => {
    const root = makeTempDirectory(t, 'incremental-reader-reset-');
    const reader = new IncrementalJsonlLifecycleReader(64);
    const truncatedPath = path.join(root, 'truncated.jsonl');
    fs.writeFileSync(truncatedPath,
        `${codexEvent('2026-07-15T00:00:08.000Z', 'task_started', 'truncate')}\n`
        + `${codexEvent('2026-07-15T00:00:09.000Z', 'task_complete', 'truncate')}\n`,
        'utf8');
    assert.equal(reader.read(
        'codex:truncated', truncatedPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'stopped');
    fs.writeFileSync(truncatedPath, `${codexEvent(
        '2026-07-15T00:00:10.000Z', 'task_started', 'new'
    )}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:truncated', truncatedPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'running');

    const nextRunStartedAtMs = Date.parse('2026-07-15T00:00:12.000Z');
    const runResetPath = path.join(root, 'run-reset.jsonl');
    fs.writeFileSync(runResetPath, `${codexEvent(
        '2026-07-15T00:00:11.000Z', 'task_complete', 'old-run'
    )}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:run-reset', runResetPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'stopped');
    const originalOpenSync = fs.openSync;
    fs.openSync = () => { throw new Error('forced open failure'); };
    assert.equal(reader.read(
        'codex:run-reset', runResetPath, nextRunStartedAtMs,
        () => createAccumulator(nextRunStartedAtMs)
    ), null, 'an open failure after a run reset must not leak the old signal');
    fs.openSync = originalOpenSync;

    const statFailurePath = path.join(root, 'stat-failure.jsonl');
    fs.writeFileSync(statFailurePath, `${codexEvent(
        '2026-07-15T00:00:11.000Z', 'task_complete', 'cached-old-run'
    )}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:stat-failure', statFailurePath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'stopped');
    const originalStatSync = fs.statSync;
    fs.statSync = () => { throw new Error('forced stat failure'); };
    assert.equal(reader.read(
        'codex:stat-failure', statFailurePath, nextRunStartedAtMs,
        () => createAccumulator(nextRunStartedAtMs)
    ), null, 'a stat failure must not leak a different run');
    assert.equal(reader.read(
        'codex:stat-failure', statFailurePath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'stopped', 'a stat failure may preserve the exact matching cursor');
    fs.statSync = originalStatSync;
    t.after(() => {
        fs.openSync = originalOpenSync;
        fs.statSync = originalStatSync;
    });

    const sourcePath = path.join(root, 'non-file-source.jsonl');
    const directoryPath = path.join(root, 'non-file-target');
    fs.writeFileSync(sourcePath, `${codexEvent(
        '2026-07-15T00:00:11.000Z', 'task_complete', 'cached-before-non-file'
    )}\n`, 'utf8');
    fs.mkdirSync(directoryPath);
    assert.equal(reader.read(
        'codex:non-file', sourcePath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'stopped');
    assert.equal(reader.read(
        'codex:non-file', directoryPath, nextRunStartedAtMs,
        () => createAccumulator(nextRunStartedAtMs)
    ), null, 'a non-file path must not leak a different path/run cursor');
});

test('PERSIST-INCREMENTAL-JSONL-LIFECYCLE-READER-001 retain and delete invalidate cursors before same-size rewrites', t => {
    const root = makeTempDirectory(t, 'incremental-reader-retain-delete-');
    const reader = new IncrementalJsonlLifecycleReader(64);

    const retainedPath = path.join(root, 'retained.jsonl');
    const retainedStarted = codexEvent('2026-07-15T00:00:13.000Z', 'task_started', 'retain-11');
    const retainedComplete = codexEvent('2026-07-15T00:00:13.000Z', 'task_complete', 'retain-1');
    assert.equal(retainedStarted.length, retainedComplete.length);
    fs.writeFileSync(retainedPath, `${retainedStarted}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:retain-drop', retainedPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'running');
    fs.writeFileSync(retainedPath, `${retainedComplete}\n`, 'utf8');
    reader.retain(new Set(['codex:other']));
    assert.equal(reader.read(
        'codex:retain-drop', retainedPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'stopped');

    const deletedPath = path.join(root, 'deleted.jsonl');
    const deletedStarted = codexEvent('2026-07-15T00:00:14.000Z', 'task_started', 'delete-11');
    const deletedComplete = codexEvent('2026-07-15T00:00:14.000Z', 'task_complete', 'delete-1');
    assert.equal(deletedStarted.length, deletedComplete.length);
    fs.writeFileSync(deletedPath, `${deletedStarted}\n`, 'utf8');
    assert.equal(reader.read(
        'codex:delete', deletedPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'running');
    fs.writeFileSync(deletedPath, `${deletedComplete}\n`, 'utf8');
    reader.delete('codex:delete');
    assert.equal(reader.read(
        'codex:delete', deletedPath, RUN_STARTED_AT_MS, createAccumulator
    ).executionState, 'stopped');
});
