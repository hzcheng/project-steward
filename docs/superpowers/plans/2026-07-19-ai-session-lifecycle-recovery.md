# AI Session Lifecycle Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover accurate active-session execution state for Codex, Kimi, and Claude after reload without relying on a fixed JSONL tail window.

**Architecture:** Provider lifecycle parsers become stateful accumulators that preserve event-time ordering and provider-specific state across batches. A shared incremental JSONL reader owns bounded chunk I/O, partial lines, file identity, byte offsets, resets, and cursor pruning; provider services supply only file lookup and accumulator factories.

**Tech Stack:** TypeScript, Node.js `fs` and `string_decoder`, the existing compiled JavaScript safety-check harness, Git.

## Global Constraints

- Do not change user-visible execution states, labels, or card styling.
- Apply the same reader architecture to Codex, Kimi, and Claude.
- Keep steady-state reads proportional to appended bytes and memory bounded by chunk size plus the largest incomplete line.
- Preserve event-time ordering and Codex `request_user_input` matching semantics.
- Do not add dependencies or configuration.

---

### Task 1: Stateful Provider Lifecycle Accumulators

**Files:**
- Modify: `src/aiSessions/lifecycle.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `AiSessionLifecycleAccumulator` with `addLines(lines: readonly string[]): void` and `getSignal(): AiSessionLifecycleSignal | null`.
- Produces: `createCodexLifecycleAccumulator(runStartedAtMs)`, `createKimiLifecycleAccumulator(runStartedAtMs)`, and `createClaudeLifecycleAccumulator(runStartedAtMs)`.
- Preserves: existing `parseCodexLifecycleLines`, `parseKimiLifecycleLines`, and `parseClaudeLifecycleLines` signatures.

- [ ] **Step 1: Write failing cross-batch accumulator tests**

Add assertions to `runLifecycleParserChecks()` that exercise the wished-for stateful API:

```javascript
const codexAccumulator = lifecycle.createCodexLifecycleAccumulator(runStartedAtMs);
codexAccumulator.addLines([
    JSON.stringify({
        timestamp: '2026-07-15T00:00:10.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'cross-batch' },
    }),
]);
assert.strictEqual(codexAccumulator.getSignal().reason, 'input-required');
codexAccumulator.addLines([
    JSON.stringify({
        timestamp: '2026-07-15T00:00:11.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'cross-batch' },
    }),
]);
assert.strictEqual(codexAccumulator.getSignal().executionState, 'running');

const kimiAccumulator = lifecycle.createKimiLifecycleAccumulator(runStartedAtMs);
kimiAccumulator.addLines([
    JSON.stringify({ timestamp: 1784073612, message: { type: 'TurnEnd', payload: {} } }),
]);
kimiAccumulator.addLines([
    JSON.stringify({ timestamp: 1784073611, message: { type: 'TurnBegin', payload: {} } }),
]);
assert.strictEqual(kimiAccumulator.getSignal().executionState, 'stopped');

const claudeAccumulator = lifecycle.createClaudeLifecycleAccumulator(runStartedAtMs);
claudeAccumulator.addLines([
    JSON.stringify({ timestamp: '2026-07-15T00:00:12.000Z', type: 'user', message: { role: 'user' } }),
]);
assert.strictEqual(claudeAccumulator.getSignal().executionState, 'running');
```

- [ ] **Step 2: Compile and run the safety check to verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because `createCodexLifecycleAccumulator`, `createKimiLifecycleAccumulator`, and `createClaudeLifecycleAccumulator` do not exist.

- [ ] **Step 3: Implement the accumulator API and delegate batch parsers to it**

Refactor `lifecycle.ts` around this interface and helper shape:

```typescript
export interface AiSessionLifecycleAccumulator {
    addLines(lines: readonly string[]): void;
    getSignal(): AiSessionLifecycleSignal | null;
}

function createAccumulator(
    runStartedAtMs: number,
    parseEvent: (event: JsonRecord, occurredAtMs: number) => AiSessionLifecycleSignal | null
): AiSessionLifecycleAccumulator {
    let latest: AiSessionLifecycleSignal | null = null;
    return {
        addLines(lines) {
            for (const line of lines || []) {
                let event: JsonRecord;
                try {
                    event = JSON.parse(line);
                } catch (e) {
                    continue;
                }
                const occurredAtMs = getOccurredAtMs(event?.timestamp);
                if (!Number.isFinite(occurredAtMs) || occurredAtMs < runStartedAtMs) {
                    continue;
                }
                const signal = parseEvent(event, occurredAtMs);
                if (signal && (!latest || signal.occurredAtMs >= latest.occurredAtMs)) {
                    latest = signal;
                }
            }
        },
        getSignal: () => latest,
    };
}
```

Move each current provider callback into its exported factory. Keep `pendingInputCallIds` inside the Codex factory closure. Implement existing batch functions by creating an accumulator, adding the supplied lines once, and returning `getSignal()`.

- [ ] **Step 4: Run focused checks to verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 5: Commit the accumulator refactor**

```bash
git add src/aiSessions/lifecycle.ts scripts/run-ai-session-safety-checks.js
git commit -m "refactor: make AI lifecycle parsing incremental"
```

---

### Task 2: Shared Incremental JSONL Lifecycle Reader

**Files:**
- Create: `src/aiSessions/incrementalJsonlLifecycleReader.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `AiSessionLifecycleAccumulator` and `AiSessionLifecycleSignal` from Task 1.
- Produces: default class `IncrementalJsonlLifecycleReader`.
- Produces: `read(key: string, filePath: string, runStartedAtMs: number, createAccumulator: () => AiSessionLifecycleAccumulator): AiSessionLifecycleSignal | null`.
- Produces: `retain(keys: ReadonlySet<string>): void` and `delete(key: string): void` for bounded cache ownership.

- [ ] **Step 1: Import the new module and write failing reader tests**

Add the module import near the existing lifecycle imports:

```javascript
const IncrementalJsonlLifecycleReader = require('../out/aiSessions/incrementalJsonlLifecycleReader').default;
```

Add `runIncrementalJsonlLifecycleReaderChecks()` using a temporary directory and a small `64`-byte chunk size. Its core setup and assertions should be:

```javascript
const reader = new IncrementalJsonlLifecycleReader(64);
const filePath = path.join(tempRoot, 'codex.jsonl');
const started = JSON.stringify({
    timestamp: '2026-07-15T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'long-turn' },
});
fs.writeFileSync(filePath, `${started}\n${Array.from({ length: 100 }, (_, index) =>
    JSON.stringify({ timestamp: `2026-07-15T00:00:02.${String(index).padStart(3, '0')}Z`, type: 'event_msg', payload: { type: 'token_count' } })
).join('\n')}\n`);

let signal = reader.read(
    'codex:long',
    filePath,
    runStartedAtMs,
    () => lifecycle.createCodexLifecycleAccumulator(runStartedAtMs)
);
assert.strictEqual(signal.executionState, 'running', 'cold scan recovers starts beyond one chunk');

fs.appendFileSync(filePath, JSON.stringify({
    timestamp: '2026-07-15T00:00:03.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'long-turn' },
}) + '\n');
signal = reader.read('codex:long', filePath, runStartedAtMs, () => lifecycle.createCodexLifecycleAccumulator(runStartedAtMs));
assert.strictEqual(signal.executionState, 'stopped', 'appended completion updates cached state');
```

In the same function, add explicit cases for:

- no additional `fs.readSync` call when file size is unchanged;
- a Codex input request in one read and matching output in a later append;
- a JSON line split across calls and completed with a newline;
- malformed JSON followed by a valid event;
- truncation to a shorter file resetting the old completion state;
- a changed `runStartedAtMs` resetting the cursor;
- `retain(...)` and `delete(...)` removing cursors, proven by rewriting the file before the next cold read.

Call `runIncrementalJsonlLifecycleReaderChecks()` from `main()` immediately after `runLifecycleParserChecks()`.

- [ ] **Step 2: Compile to verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL with `Cannot find module '../out/aiSessions/incrementalJsonlLifecycleReader'` because the reader source does not exist.

- [ ] **Step 3: Implement bounded chunk reading and cursor reset logic**

Create the reader with cursor state equivalent to:

```typescript
interface Cursor {
    filePath: string;
    runStartedAtMs: number;
    dev: number;
    ino: number;
    birthtimeMs: number;
    offset: number;
    decoder: StringDecoder;
    partialLine: string;
    accumulator: AiSessionLifecycleAccumulator;
}
```

`read(...)` must:

1. `statSync` and reject non-files.
2. reset when path/run start/identity differs or `stat.size < cursor.offset`;
3. open the file and loop from `cursor.offset` to `stat.size` using `Buffer.alloc(Math.min(chunkBytes, remaining))`;
4. decode with `StringDecoder('utf8')`, prepend `partialLine`, split complete `\n`-terminated lines, and retain the unfinished suffix;
5. pass complete lines to `cursor.accumulator.addLines(...)`;
6. close the descriptor in `finally` and return `cursor.accumulator.getSignal()`;
7. catch stat/read failures and return the last cached signal when one exists, otherwise `null`.

Validate constructor chunk size and fall back to `512 * 1024` for invalid input. Do not call `decoder.end()` while the cursor can receive appended bytes.

- [ ] **Step 4: Run focused checks to verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 5: Commit the shared reader**

```bash
git add src/aiSessions/incrementalJsonlLifecycleReader.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: read AI lifecycle logs incrementally"
```

---

### Task 3: Integrate Codex, Kimi, and Claude Services

**Files:**
- Modify: `src/services/codexSessionService.ts`
- Modify: `src/services/kimiSessionService.ts`
- Modify: `src/services/claudeSessionService.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `IncrementalJsonlLifecycleReader` from Task 2.
- Consumes: the three accumulator factories from Task 1.
- Preserves: `getLifecycleSignals(requests)` service contract used by execution and attention controllers.

- [ ] **Step 1: Extend provider service tests with logs larger than the old tail window**

In `runProviderLifecycleServiceChecks()`, construct each provider log with a start event, more than `512 * 1024` bytes of ignored JSONL events, and no stop event. Assert a new service instance recovers `executionState === 'running'`.

Add this local helper at the start of `runProviderLifecycleServiceChecks()`:

```javascript
const writeLargeLifecycleLog = (filePath, firstEvent, fillerEvent) => {
    const fillerLine = JSON.stringify(fillerEvent);
    const fillerCount = Math.ceil((600 * 1024) / Buffer.byteLength(fillerLine + '\n'));
    fs.writeFileSync(filePath, [
        JSON.stringify(firstEvent),
        ...Array.from({ length: fillerCount }, () => fillerLine),
        '',
    ].join('\n'));
};
```

Use the helper in each existing provider fixture with these exact events:

```javascript
writeLargeLifecycleLog(sessionFile, {
    timestamp: '2026-07-15T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'long-codex' },
}, {
    timestamp: '2026-07-15T00:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'token_count' },
});
const codexService = new CodexSessionService();
assert.strictEqual(
    codexService.getLifecycleSignals([{ sessionId: codexId, runStartedAtMs }])[codexId].executionState,
    'running'
);
fs.appendFileSync(sessionFile, JSON.stringify({
    timestamp: '2026-07-15T00:00:03.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'long-codex' },
}) + '\n');
assert.strictEqual(
    codexService.getLifecycleSignals([{ sessionId: codexId, runStartedAtMs }])[codexId].executionState,
    'stopped'
);

writeLargeLifecycleLog(path.join(sessionDir, 'wire.jsonl'), {
    timestamp: runStartedAtMs / 1000 + 1,
    message: { type: 'TurnBegin', payload: {} },
}, {
    timestamp: runStartedAtMs / 1000 + 2,
    message: { type: 'StatusUpdate', payload: {} },
});
const kimiService = new KimiSessionService();
assert.strictEqual(
    kimiService.getLifecycleSignals([{ sessionId: kimiId, runStartedAtMs }])[kimiId].executionState,
    'running'
);
fs.appendFileSync(path.join(sessionDir, 'wire.jsonl'), JSON.stringify({
    timestamp: runStartedAtMs / 1000 + 3,
    message: { type: 'TurnEnd', payload: {} },
}) + '\n');
assert.strictEqual(
    kimiService.getLifecycleSignals([{ sessionId: kimiId, runStartedAtMs }])[kimiId].executionState,
    'stopped'
);

const claudeFile = path.join(sessionDir, `${claudeId}.jsonl`);
writeLargeLifecycleLog(claudeFile, {
    timestamp: '2026-07-15T00:00:01.000Z',
    type: 'user',
    message: { role: 'user' },
}, {
    timestamp: '2026-07-15T00:00:02.000Z',
    type: 'progress',
});
const claudeService = new ClaudeSessionService();
assert.strictEqual(
    claudeService.getLifecycleSignals([{ sessionId: claudeId, runStartedAtMs }])[claudeId].executionState,
    'running'
);
fs.appendFileSync(claudeFile, JSON.stringify({
    timestamp: '2026-07-15T00:00:03.000Z',
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
}) + '\n');
assert.strictEqual(
    claudeService.getLifecycleSignals([{ sessionId: claudeId, runStartedAtMs }])[claudeId].executionState,
    'stopped'
);
```

- [ ] **Step 2: Run the provider checks to verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because each service still reads only the final 512 KiB and cannot see the start event.

- [ ] **Step 3: Replace fixed-tail parsing in all provider services**

For each service:

1. replace `readJsonlTailLines` and batch parser imports with `IncrementalJsonlLifecycleReader` and the matching accumulator factory;
2. add `private readonly lifecycleReader = new IncrementalJsonlLifecycleReader();`;
3. call `lifecycleReader.read(...)` with `createCodexLifecycleAccumulator`, `createKimiLifecycleAccumulator`, or `createClaudeLifecycleAccumulator`, matching the service;
4. collect valid request IDs and call `lifecycleReader.retain(activeSessionIds)` before returning;
5. call `lifecycleReader.delete(sessionId)` when a cached file disappears or a session is archived.

The Codex call should have this shape:

```typescript
const signal = this.lifecycleReader.read(
    request.sessionId,
    sessionFile,
    request.runStartedAtMs,
    () => createCodexLifecycleAccumulator(request.runStartedAtMs)
);
```

Apply the equivalent Kimi and Claude factories without changing file discovery behavior.

- [ ] **Step 4: Run all safety checks and lint**

Run:

```bash
npm run test:safety
npm run lint
```

Expected: both safety suites pass and TSLint exits successfully.

- [ ] **Step 5: Commit provider integration**

```bash
git add src/services/codexSessionService.ts src/services/kimiSessionService.ts src/services/claudeSessionService.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: recover long-running AI session state"
```

---

### Task 4: Final Verification and Branch Review

**Files:**
- Verify: all files changed by Tasks 1-3
- Update only if behavior differs: `docs/superpowers/specs/2026-07-19-ai-session-lifecycle-recovery-design.md`

**Interfaces:**
- Verifies the public behavior and packaging boundaries; produces no new API.

- [ ] **Step 1: Run the full verification matrix**

Run:

```bash
npm run test:safety
npm run test:dashboard
npm run test:architecture-baseline
npm run test:release-packaging
npm run lint
git diff --check origin/main...HEAD
```

Expected: all commands exit `0`, both safety scripts report passed, and `git diff --check` prints nothing.

- [ ] **Step 2: Review the branch diff for scope and generated artifacts**

Run:

```bash
git status -sb
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- src/aiSessions src/services scripts/run-ai-session-safety-checks.js docs/superpowers
```

Confirm the diff contains only lifecycle recovery code, tests, the approved design, and this plan. Confirm `package-lock.json`, compiled `out/`, and packaging output are not tracked changes.

- [ ] **Step 3: Make and verify any review-only correction as its own commit**

If review finds a concrete defect, first add or tighten the failing safety assertion, run it to observe the expected failure, apply the smallest correction, rerun the focused and full checks, then commit explicit paths:

```bash
git add scripts/run-ai-session-safety-checks.js src/aiSessions/incrementalJsonlLifecycleReader.ts src/aiSessions/lifecycle.ts src/services/codexSessionService.ts src/services/kimiSessionService.ts src/services/claudeSessionService.ts
git commit -m "fix: address lifecycle recovery review"
```

If review finds no defect, do not create an empty commit.

- [ ] **Step 4: Report the ready branch**

Report the worktree path, branch name, commits, changed files, and exact verification commands/results. Do not push or open a PR without a separate user request.
