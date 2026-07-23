# Tmux Codex Thread Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a managed tmux Active Session follow the current root Codex thread after an in-pane `/new` switch while preserving the previous thread in History.

**Architecture:** Carry the active pane PID in bounded tmux discovery rows, use a Linux `/proc` observer to identify exactly one open non-subagent Codex JSONL owned by that pane's process tree, then compare-and-swap the durable known binding to the observed session ID. Tmux metadata remains immutable container provenance; the exact-locator known binding becomes the authority for the current thread projected from that container.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, tmux format strings, `node:test`, existing Project Steward runtime contracts.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-refactor-and-ci`.
- Do not modify, merge, or push `main`.
- Write and run each failing test before its production change.
- Do not parse or retain terminal screen contents.
- Do not modify or delete Codex JSONL files.
- Reject subagent sessions and ambiguous root-session observations.
- Unsupported platforms and unavailable process evidence must preserve current behavior.
- Preserve Direct Terminal, readable tmux names, locator collision handling, attention, History, OTHER WINDOWS, and release packaging behavior.

---

### Task 1: Carry a bounded pane PID through tmux discovery

**Files:**
- Modify: `src/aiSessions/tmuxClient.ts`
- Modify: `tests/contract/aiSessions/tmuxClientBehavior.test.js`
- Modify: `tests/helpers/runtimeContract.js`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Produces: `TmuxWindowRecord.panePid: number`
- Produces: discovery fixture rows with `panePid`
- Consumes: tmux `#{pane_pid}` from the existing `list-windows` format

- [ ] **Step 1: Write the failing tmux client contract**

Update the fake `list-windows` output to include a fifth field and assert the
parsed PID:

```js
const row = [
    'project-session', 'base', '@1', '0', '4321',
].join('\u001f');
runner.enqueue({ exitCode: 0, stdout: `${row}\n`, stderr: '' });

assert.deepEqual((await client.listWindows())[0].panePid, 4321);
```

Add invalid-output cases for `0`, negative, non-numeric, decimal, and a value
larger than `2147483647`. Update the legacy safety harness expectations in
`scripts/run-ai-session-tmux-checks.js` in the same test-first change.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/tmuxClientBehavior.test.js
```

Expected: FAIL because `LIST_WINDOWS_FORMAT` still has four fields and
`panePid` is absent.

- [ ] **Step 3: Implement the minimal PID transport**

Change the record and parser contract:

```ts
const LIST_WINDOWS_FORMAT = [
    '#{session_name}', '#{window_name}', '#{window_id}', '#{window_active}',
    '#{pane_pid}',
].join(FIELD_SEPARATOR);

export interface TmuxWindowRecord {
    sessionName: string;
    windowName: string;
    windowId: string;
    active: boolean;
    panePid: number;
    sessionMetadata: Record<string, string>;
    windowMetadata: Record<string, string>;
    metadata: Record<string, string>;
}
```

In `parseWindowRows`, require exactly five fields and accept only:

```ts
const MAX_PID = 2147483647;
const panePid = Number(panePidValue);
if (!/^[1-9][0-9]{0,9}$/.test(panePidValue)
    || !Number.isSafeInteger(panePid)
    || panePid > MAX_PID) {
    throw new TmuxClientError(operation, 'invalid-output');
}
```

Return `panePid` with the other parsed fields. Add a deterministic default
`panePid: 1001` to `makeTmuxDiscoveryRow` and every shared fake window creator.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/tmuxClientBehavior.test.js
node scripts/run-ai-session-tmux-checks.js
```

Expected: all tmux client and legacy tmux safety cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/aiSessions/tmuxClient.ts tests/contract/aiSessions/tmuxClientBehavior.test.js tests/helpers/runtimeContract.js scripts/run-ai-session-tmux-checks.js
git commit -m "feat: expose managed tmux pane pids"
```

---

### Task 2: Identify the root Codex thread owned by a pane

**Files:**
- Create: `src/aiSessions/codexRootThreadObserver.ts`
- Create: `tests/contract/aiSessions/codexRootThreadObserver.test.js`

**Interfaces:**
- Produces:

```ts
export interface CodexRootThreadObservationRequest {
    panePid: number;
    currentSessionId: string;
    runStartedAtMs: number;
}

export interface CodexRootThreadObserver {
    observe(request: CodexRootThreadObservationRequest): Promise<string | null>;
}

export interface ProcCodexRootThreadObserverOptions {
    platform?: NodeJS.Platform;
    procRoot?: string;
    codexHome?: string;
    maxProcesses?: number;
    maxDescriptors?: number;
    maxFirstLineBytes?: number;
}

export class ProcCodexRootThreadObserver implements CodexRootThreadObserver {
    constructor(options?: ProcCodexRootThreadObserverOptions);
    observe(request: CodexRootThreadObservationRequest): Promise<string | null>;
}
```

- Consumes: `/proc/<pid>/task/<pid>/children`,
  `/proc/<pid>/fd/*`, and `<CODEX_HOME>/sessions/**/*.jsonl`

- [ ] **Step 1: Write observer RED contracts**

Build a temporary synthetic proc tree and Codex home. Create JSONL files whose
first records use the real metadata shape:

```js
{
    timestamp: '2026-07-23T05:17:29.604Z',
    type: 'session_meta',
    payload: {
        id: 'new-root',
        session_id: 'new-root',
        cwd: '/work',
        originator: 'codex-tui',
        source: 'cli',
    },
}
```

Symlink synthetic descriptor entries to those files. Add contracts proving:

- one new root file returns `new-root`;
- the current bound root plus one new root returns `new-root`, because the
  current ID is excluded from replacement candidates;
- `source.subagent` files are ignored;
- two different new root files return `null`;
- escaped paths, malformed first lines, mismatched `id`/`session_id`, old
  timestamps, invalid PIDs, traversal cycles, exceeded limits, missing
  directories, and `platform: 'darwin'` return `null`;
- filesystem errors do not reject the promise.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/codexRootThreadObserver.test.js
```

Expected: FAIL because `out/aiSessions/codexRootThreadObserver` does not exist.

- [ ] **Step 3: Implement bounded fail-closed observation**

Implement these constants:

```ts
const DEFAULT_MAX_PROCESSES = 128;
const DEFAULT_MAX_DESCRIPTORS = 1024;
const DEFAULT_MAX_FIRST_LINE_BYTES = 16 * 1024;
const MAX_PID = 2147483647;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
```

Resolve the configured Codex home from `options.codexHome`, then `CODEX_HOME`,
then `path.join(os.homedir(), '.codex')`. Canonicalize its `sessions`
subdirectory once per observation.

Traverse descendant PIDs breadth-first with a visited set and the process
limit. Enumerate descriptor links up to the descriptor limit. For every link:

1. resolve the real path;
2. require a `.jsonl` regular file beneath the canonical sessions root;
3. require file `mtimeMs >= runStartedAtMs`;
4. read only through the first newline within `maxFirstLineBytes`;
5. parse and validate the structured root-session metadata;
6. exclude `currentSessionId` and any `payload.source.subagent`.

Return the session ID only when the candidate set has size one. Wrap the
observation boundary in `try/catch` and return `null` on any unsupported or
unreliable observation.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/codexRootThreadObserver.test.js
```

Expected: every observer contract passes.

- [ ] **Step 5: Commit**

```bash
git add src/aiSessions/codexRootThreadObserver.ts tests/contract/aiSessions/codexRootThreadObserver.test.js
git commit -m "feat: observe codex root threads by pane"
```

---

### Task 3: Atomically replace a durable known binding

**Files:**
- Modify: `src/aiSessions/tmuxRuntimeBindingStore.ts`
- Modify: `tests/contract/aiSessions/tmuxStore.test.js`
- Modify: `tests/helpers/runtimeContract.js`

**Interfaces:**
- Produces:

```ts
export type TmuxKnownRebindResult = 'rebound' | 'stale' | 'missing';

interface TmuxKnownRebindIntent {
    version: 1;
    state: 'rebind-known';
    expected: TmuxKnownRuntimeBinding;
    replacement: TmuxKnownRuntimeBinding;
    recordedAtMs: number;
}

rebindKnown(
    expected: TmuxKnownRuntimeBinding,
    nextSessionId: string
): Promise<TmuxKnownRebindResult>;
```

- Consumes: the existing final-record lock, canonical record paths, validation,
  durable write, and durable removal helpers

- [ ] **Step 1: Write store RED contracts**

Add tests that:

```js
const oldBinding = makeTmuxKnownBinding('old-root', { lastSeenAtMs: NOW - 10 });
await store.setKnown(oldBinding);

assert.equal(await store.rebindKnown(oldBinding, 'new-root'), 'rebound');
assert.equal(await store.getKnown('codex', 'old-root'), null);
assert.deepEqual(await store.getKnown('codex', 'new-root'), {
    ...oldBinding,
    sessionId: 'new-root',
});
```

Also assert:

- a changed `lastSeenAtMs`, locator, scope, provider, or lifecycle field returns
  `stale` and does not create the new record;
- an absent old record returns `missing`;
- an invalid or already-existing target returns `stale`;
- two store instances racing under the shared final lock yield exactly one
  `rebound`;
- injected interruptions after intent persistence, replacement persistence,
  and old-record removal each recover on a restarted store to exactly the new
  binding;
- a restarted store lists exactly the new record at the original locator;
- no intent or `.tmp` file remains after successful recovery.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/tmuxStore.test.js
```

Expected: FAIL with `store.rebindKnown is not a function`.

- [ ] **Step 3: Implement compare-and-swap rebind**

Inside `serializeFinal`, validate `expected` as a known record and validate
`nextSessionId` with the existing bounded ID rule. Read the old canonical path
and return `missing` when absent. Return `stale` unless the entire current
record equals `expected`, including optional lifecycle evidence.

Reject a target canonical path that already contains an unrelated valid final
record.
Construct:

```ts
const replacement: TmuxKnownRuntimeBinding = {
    ...expected,
    sessionId: nextSessionId,
};
```

Before changing canonical records, durably write a validated
`TmuxKnownRebindIntent` under a locator-derived bounded filename. Then write the
replacement, remove the old canonical path durably, and remove the intent.

Extend the store's locked cleanup/enumeration path to recover intents
idempotently:

- when the expected old record still matches, ensure the replacement exists,
  remove the old record, then remove the intent;
- when only the exact replacement exists, remove the completed intent;
- when neither exact state is recoverable, quarantine/remove the invalid
  intent without overwriting unrelated records.

Return `rebound` only after the complete sequence finishes. An injected
operation error rejects; the next locked store operation must perform recovery
before returning records.

Add the same method and deterministic result recording to
`createSyntheticTmuxStore`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/tmuxStore.test.js
```

Expected: every store contract passes.

- [ ] **Step 5: Commit**

```bash
git add src/aiSessions/tmuxRuntimeBindingStore.ts tests/contract/aiSessions/tmuxStore.test.js tests/helpers/runtimeContract.js
git commit -m "feat: atomically rebind known tmux threads"
```

---

### Task 4: Project the observed root thread from the existing locator

**Files:**
- Modify: `src/aiSessions/tmuxRuntimeDiscovery.ts`
- Modify: `src/dashboard.ts`
- Modify: `tests/contract/aiSessions/tmuxDiscovery.test.js`
- Modify: `tests/contract/aiSessions/runtimeComposition.test.js`
- Modify: `tests/contract/aiSessions/archiveAndHydration.test.js`
- Modify: `tests/integration/dashboard/attentionRendering.test.js`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Consumes: `DiscoveryWindowRecord.panePid`
- Consumes: `CodexRootThreadObserver.observe(request)`
- Consumes: `TmuxDiscoveryBindingStore.rebindKnown(expected, nextSessionId)`
- Produces: an active runtime whose session ID is supplied by the exact-locator
  known binding after immutable tmux metadata validates the container

- [ ] **Step 1: Write discovery RED contracts**

Create a row whose immutable metadata contains `old-root`, a known binding at
the same locator, and an observer that returns `new-root`:

```js
const observed = [];
const discovery = new TmuxRuntimeDiscovery({
    client: { listWindows: async () => [row] },
    bindingStore: store,
    codexRootThreadObserver: {
        observe: async request => {
            observed.push(request);
            return 'new-root';
        },
    },
    markerIsCurrent: () => false,
    nowMs: () => NOW,
    cacheTtlMs: 0,
});
```

Assert:

- the observer receives the row's PID, current known ID, and run start;
- successful CAS projects only `new-root`;
- a fresh discovery instance still projects `new-root` although tmux metadata
  remains `old-root`;
- `stale`, `missing`, thrown observer errors, an absent known binding,
  non-Codex providers, and invalid/missing PIDs preserve the old projection;
- two known records matching one locator are treated as ambiguous and do not
  trigger a rebind;
- collision diagnostics still validate the locator using immutable tmux
  metadata rather than the replacement session ID.

In the same RED change, feed the discovered runtime into production hydration
with provider history containing:

```js
const sessions = [
    { id: 'new-root', name: 'New work', cwd: '/work', updatedAt: '2026-07-23T06:30:00Z' },
    { id: 'old-root', name: 'Old work', cwd: '/work', updatedAt: '2026-07-22T14:40:03Z' },
];
```

Supply an execution snapshot marking `codex:new-root` as `running`. Assert that
Active contains `new-root` named `New work`, History contains `old-root`, and
the rendered workspace HTML contains `session-running`, `data-session-fx`, and
`data-execution-state="running"`. This must fail through discovery projecting
`old-root`, not because of a synthetic fixture-only assertion.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/tmuxDiscovery.test.js tests/contract/aiSessions/runtimeComposition.test.js tests/contract/aiSessions/archiveAndHydration.test.js tests/integration/dashboard/attentionRendering.test.js
node scripts/run-dashboard-webview-checks.js
```

Expected: FAIL because discovery has no observer or rebind path and continues
to project `old-root`.

- [ ] **Step 3: Implement exact-locator authority and rebind**

Extend `DiscoveryWindowRecord` and `TmuxRuntimeDiscoveryOptions`:

```ts
interface DiscoveryWindowRecord {
    sessionName: string;
    windowName: string;
    windowId: string;
    active: boolean;
    panePid: number;
    metadata: Record<string, string>;
    sessionMetadata: Record<string, string>;
    windowMetadata: Record<string, string>;
}

export interface TmuxRuntimeDiscoveryOptions {
    client: TmuxDiscoveryClient;
    bindingStore: TmuxDiscoveryBindingStore;
    codexRootThreadObserver?: CodexRootThreadObserver;
    markerIsCurrent: (
        markerPath: string,
        runStartedAtMs: number
    ) => boolean | Promise<boolean>;
    nowMs?: () => number;
    cacheTtlMs?: number;
}
```

Add a helper that finds exactly one known record matching provider, all
workspace fields, cwd, layout, and exact locator, deliberately excluding the
session ID comparison.

For final rows:

1. validate metadata identity and locator with existing rules;
2. select the exact-locator known record, if unique;
3. use that known record's session ID and lifecycle evidence as the current
   projection;
4. for Codex with a valid PID and known record, call the observer;
5. if it returns a different ID, call `rebindKnown`;
6. only on `rebound`, replace the projected session ID immediately;
7. on every other result, preserve the pre-observation projection.

Instantiate `ProcCodexRootThreadObserver` in `src/dashboard.ts` and pass it to
the production discovery.

- [ ] **Step 4: Verify GREEN and legacy compatibility**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/tmuxDiscovery.test.js tests/contract/aiSessions/runtimeComposition.test.js tests/contract/aiSessions/archiveAndHydration.test.js tests/integration/dashboard/attentionRendering.test.js
node scripts/run-ai-session-tmux-checks.js
node scripts/run-dashboard-webview-checks.js
```

Expected: focused contracts, Active/History projection, running animation, and
the legacy safety harnesses pass.

- [ ] **Step 5: Commit**

```bash
git add src/aiSessions/tmuxRuntimeDiscovery.ts src/dashboard.ts tests/contract/aiSessions/tmuxDiscovery.test.js tests/contract/aiSessions/runtimeComposition.test.js tests/contract/aiSessions/archiveAndHydration.test.js tests/integration/dashboard/attentionRendering.test.js scripts/run-ai-session-tmux-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "fix: follow codex thread switches in tmux"
```

---

### Task 5: Run full gates, inspect the real incident, and reinstall

**Files:**
- Modify if required by actual results:
  `docs/superpowers/reports/2026-07-23-main-capability-regression-coverage.md`
- Generated artifacts:
  `artifacts/project-steward-2.1.4.vsix`
  `artifacts/project-steward-attention-ui-bridge-0.1.4.vsix`

**Interfaces:**
- Consumes: all prior commits
- Produces: verified CI evidence and an installed trial build

- [ ] **Step 1: Run focused and deterministic gates**

```bash
npm run test:contract
npm run test:tmux
npm run test:dashboard
npm run test:deterministic
```

Expected: all commands exit zero with no failed tests.

- [ ] **Step 2: Run platform and full Linux gates**

```bash
npm run test:ci:windows
npm run test:ci:linux
npm run test:tmux:smoke
```

Expected: all automatable gates pass. If Extension Host still cannot start
because `libnspr4.so` is unavailable, retain the existing explicit BLOCKED
classification rather than reporting a pass.

- [ ] **Step 3: Verify the real incident safely**

Without sending input to the target pane, refresh the extension and verify that
the locator `ps-reddb-dts-dual-active-7d65980f` projects the root session
currently held open by its pane process tree, not the stale
`019f89f5-13a2-7c40-b952-61b5413de697` binding. Confirm subagent JSONLs remain
excluded and the previous thread remains in History.

- [ ] **Step 4: Review the branch**

```bash
git diff --check
git status -sb
git diff origin/main...HEAD --stat
git diff --name-status origin/main...HEAD | awk '$1 == "D" && $2 ~ /test|spec/ { print }'
```

Expected: no whitespace errors, no uncommitted source changes, and no
unintended test/spec deletions.

- [ ] **Step 5: Package and install the workspace extension**

Use the active Dev Container VS Code IPC socket:

```bash
SKIP_NPM_CI=1 VSCODE_IPC_HOOK_CLI=/tmp/vscode-ipc-00ebfdef-f59f-4297-bb97-f1805399a463.sock npm run install-local
```

Treat the UI-only bridge rejection from the Dev Container CLI as an environment
limitation, not installation success. Verify the main installed bundle hash:

```bash
unzip -p artifacts/project-steward-2.1.4.vsix extension/dist/dashboard.js | sha256sum
sha256sum ~/.vscode-server/extensions/hzcheng.project-steward-2.1.4/dist/dashboard.js
```

Expected: the two hashes match.

- [ ] **Step 6: Commit verification-report changes if any**

```bash
git add docs/superpowers/reports/2026-07-23-main-capability-regression-coverage.md
git commit -m "docs: report tmux thread switch coverage"
```

Skip this commit when the report requires no change.
