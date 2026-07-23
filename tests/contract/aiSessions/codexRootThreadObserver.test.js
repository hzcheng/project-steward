'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ProcCodexRootThreadObserver } = require('../../../out/aiSessions/codexRootThreadObserver');
const { makeTempDirectory } = require('../../helpers/tempDirectory');

const PANE_PID = 100;
const CHILD_PID = 101;
const STARTED_AT_MS = Date.parse('2026-07-23T04:00:00.000Z');

function createHarness(t, overrides = {}) {
    const root = makeTempDirectory(t, 'project-steward-codex-root-observer-');
    const procRoot = path.join(root, 'proc');
    const codexHome = path.join(root, 'codex');
    const sessionsRoot = path.join(codexHome, 'sessions', '2026', '07', '23');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    addProcess(procRoot, PANE_PID, [CHILD_PID]);
    addProcess(procRoot, CHILD_PID, []);
    const observer = new ProcCodexRootThreadObserver({
        platform: 'linux',
        procRoot,
        codexHome,
        ...overrides,
    });
    return {
        root,
        procRoot,
        codexHome,
        sessionsRoot,
        observer,
        observe: (request = {}) => observer.observe({
            panePid: PANE_PID,
            currentSessionId: 'old-root',
            runStartedAtMs: STARTED_AT_MS,
            ...request,
        }),
    };
}

function addProcess(procRoot, pid, children) {
    const processRoot = path.join(procRoot, String(pid));
    fs.mkdirSync(path.join(processRoot, 'task', String(pid)), { recursive: true });
    fs.mkdirSync(path.join(processRoot, 'fd'), { recursive: true });
    fs.writeFileSync(
        path.join(processRoot, 'task', String(pid), 'children'),
        children.join(' '),
        'utf8'
    );
}

function addSession(harness, pid, sessionId, options = {}) {
    const filePath = options.outside
        ? path.join(harness.root, `${sessionId}.jsonl`)
        : path.join(harness.sessionsRoot, `rollout-${sessionId}.jsonl`);
    const source = options.subagent
        ? { subagent: { thread_spawn: { parent_thread_id: 'new-root', depth: 1 } } }
        : 'cli';
    const record = options.malformed
        ? '{malformed'
        : JSON.stringify({
            timestamp: options.timestamp || '2026-07-23T05:17:29.604Z',
            type: options.type || 'session_meta',
            payload: {
                id: sessionId,
                session_id: options.sessionIdAlias || sessionId,
                cwd: '/work',
                originator: options.originator || 'codex-tui',
                source,
                ...(options.padding ? {
                    base_instructions: { text: 'x'.repeat(options.padding) },
                } : {}),
            },
        });
    fs.writeFileSync(filePath, `${record}\n`, 'utf8');
    const timestampMs = options.mtimeMs || Date.parse('2026-07-23T05:17:30.000Z');
    fs.utimesSync(filePath, timestampMs / 1000, timestampMs / 1000);
    const fdRoot = path.join(harness.procRoot, String(pid), 'fd');
    const descriptor = String(fs.readdirSync(fdRoot).length + 10);
    fs.symlinkSync(filePath, path.join(fdRoot, descriptor));
    return filePath;
}

test('RUNTIME-TMUX-THREAD-SWITCH-001 observes one replacement root owned by the pane process tree', async t => {
    const harness = createHarness(t);
    addSession(harness, CHILD_PID, 'new-root', { padding: 32 * 1024 });

    assert.equal(await harness.observe(), 'new-root');
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 excludes the current root and open subagent sessions', async t => {
    const harness = createHarness(t);
    addSession(harness, CHILD_PID, 'old-root');
    addSession(harness, CHILD_PID, 'new-root');
    addSession(harness, CHILD_PID, 'subagent-one', { subagent: true });
    addSession(harness, CHILD_PID, 'subagent-two', { subagent: true });

    assert.equal(await harness.observe(), 'new-root');
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 rejects ambiguous replacement roots and bounded traversal overflow', async t => {
    const ambiguous = createHarness(t);
    addSession(ambiguous, CHILD_PID, 'new-root-a');
    addSession(ambiguous, CHILD_PID, 'new-root-b');
    assert.equal(await ambiguous.observe(), null);

    const processOverflow = createHarness(t, { maxProcesses: 1 });
    addSession(processOverflow, CHILD_PID, 'new-root');
    assert.equal(await processOverflow.observe(), null);

    const descriptorOverflow = createHarness(t, { maxDescriptors: 1 });
    addSession(descriptorOverflow, CHILD_PID, 'new-root-a');
    addSession(descriptorOverflow, CHILD_PID, 'new-root-b');
    assert.equal(await descriptorOverflow.observe(), null);

    const metadataOverflow = createHarness(t, { maxFirstLineBytes: 64 });
    addSession(metadataOverflow, CHILD_PID, 'new-root', { padding: 128 });
    assert.equal(await metadataOverflow.observe(), null);
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 fails closed for invalid metadata, paths, timestamps, and platforms', async t => {
    const cases = [
        { options: { outside: true } },
        { options: { malformed: true } },
        { options: { sessionIdAlias: 'different' } },
        { options: { originator: 'codex-app-server' } },
        { options: { type: 'event_msg' } },
        { options: { mtimeMs: STARTED_AT_MS - 1 } },
    ];
    for (const [index, item] of cases.entries()) {
        const harness = createHarness(t);
        addSession(harness, CHILD_PID, `rejected-${index}`, item.options);
        assert.equal(await harness.observe(), null, JSON.stringify(item.options));
    }

    const unsupported = createHarness(t, { platform: 'darwin' });
    addSession(unsupported, CHILD_PID, 'new-root');
    assert.equal(await unsupported.observe(), null);
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 contains proc races, cycles, invalid requests, and missing roots', async t => {
    const cycle = createHarness(t);
    fs.writeFileSync(
        path.join(cycle.procRoot, String(CHILD_PID), 'task', String(CHILD_PID), 'children'),
        `${PANE_PID} 999999`,
        'utf8'
    );
    addSession(cycle, CHILD_PID, 'new-root');
    assert.equal(await cycle.observe(), 'new-root');

    for (const panePid of [0, -1, 1.5, 2147483648, Number.NaN]) {
        assert.equal(await cycle.observe({ panePid }), null);
    }

    const missing = createHarness(t);
    fs.rmSync(missing.procRoot, { recursive: true, force: true });
    await assert.doesNotReject(async () => {
        assert.equal(await missing.observe(), null);
    });

    const missingSessions = createHarness(t);
    fs.rmSync(path.join(missingSessions.codexHome, 'sessions'), { recursive: true, force: true });
    await assert.doesNotReject(async () => {
        assert.equal(await missingSessions.observe(), null);
    });
});
