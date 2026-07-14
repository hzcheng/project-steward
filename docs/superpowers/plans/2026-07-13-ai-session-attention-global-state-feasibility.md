# AI Session Attention Global-State Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove or reject that one Project Steward extension can use `ExtensionContext.globalState` as an eventually consistent, low-pressure state bus across local, Remote SSH, WSL, and Dev Container windows without corrupting unrelated extension state.

**Architecture:** Add a temporary diagnostic probe that gives every participating Extension Host instance a unique node ID, publishes revisioned node snapshots, acknowledges revisions from other windows, and measures clock-independent round-trip propagation. Require P95 full round-trip latency of at most one second, which is stricter than the design's one-way target and avoids assuming synchronized or symmetric remote clocks. Stress a separate sentinel key concurrently to detect stale whole-state overwrites, record the results, then remove all diagnostic code before any production implementation begins.

**Tech Stack:** TypeScript 4, VS Code Extension API `^1.51.0`, `ExtensionContext.globalState`, Node.js `assert` safety checks, webpack 5, VSIX local/remote installation

## Global Constraints

- This plan is a mandatory architecture gate, not production feature implementation.
- Keep Project Steward as one extension; do not introduce a companion extension in this spike.
- Use the existing `extensionKind: ["workspace", "ui"]` unchanged.
- Test only windows using the same local VS Code profile; different profiles and `--user-data-dir` values are out of scope.
- Do not call `globalState.setKeysForSync()`; no spike state may be uploaded through Settings Sync.
- Do not store prompts, terminal output, filesystem paths, remote authority names, or credentials.
- Production acceptance requires P95 state propagation of at most one second. This spike enforces the stricter clock-independent condition `P95 full round trip <= 1000 ms`, plus no missing live snapshot for more than two 30-second heartbeat periods, forced-termination expiry within 90 seconds, and registry size below 64 KiB.
- The spike deliberately writes once per second to expose races; this temporary stress rate is exempt from the production limit of one heartbeat per window per 30 seconds.
- A separate monotonically increasing sentinel key must never roll back while probe nodes write concurrently.
- If cross-host propagation fails or the sentinel rolls back, stop and return to architecture design. Do not continue to the production plan.
- Remove all debug commands and probe code after the report is captured; retain only the report, specification, and implementation plans.
- Preserve the user's `.vscode/settings.json` change and all unrelated working-tree changes.
- Do not commit without explicit user approval. Every task ends at a review checkpoint.

## File Structure

- Create temporarily `src/aiSessions/attentionGlobalStateSpike.ts`: diagnostic node protocol, revision/ack tracking, clock-independent latency measurement, missing-node tracking, sentinel rollback detection, and status snapshots.
- Modify temporarily `src/dashboard.ts`: register start/status/stop/clear diagnostic commands and write diagnostics to the existing Project Steward output channel.
- Modify temporarily `package.json`: contribute four command-palette commands used in each test window.
- Modify temporarily `scripts/run-ai-session-safety-checks.js`: executable tests for merge preservation, acknowledgements, latency sampling, sentinel rollback detection, and timer disposal.
- Create and retain `docs/superpowers/reports/2026-07-13-ai-session-attention-global-state-feasibility.md`: measured environment matrix and gate decision.
- Remove the temporary TypeScript module, command wiring, command contributions, and safety checks after measurements are complete.

---

### Task 1: Temporary Probe Protocol

**Files:**

- Create temporarily: `src/aiSessions/attentionGlobalStateSpike.ts`
- Modify temporarily: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**

- Consumes: an injected `AttentionSpikeMemento` compatible with `ExtensionContext.globalState`, injected timer functions, a local `now()` clock, and a diagnostic logger.
- Produces: `ATTENTION_SPIKE_REGISTRY_KEY`, `ATTENTION_SPIKE_SENTINEL_KEY`, `AttentionGlobalStateSpike`, `AttentionSpikeStatus`, `start(sentinelOwner)`, `writeProbe()`, `poll()`, `getStatus()`, `stop(clean)`, and `clear()`.

- [ ] **Step 1: Add the failing safety checks**

Add the compiled-module import near the existing pure AI-session imports:

```js
const AttentionGlobalStateSpike = require('../out/aiSessions/attentionGlobalStateSpike').default;
```

Add this executable check before `main()`:

```js
async function runAttentionGlobalStateSpikeChecks() {
    const values = new Map();
    const memento = {
        get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
        update: async (key, value) => {
            if (value === undefined) values.delete(key);
            else values.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
    let now = 1000;
    let timers = [];
    const dependencies = id => ({
        globalState: memento,
        now: () => now,
        createId: () => id,
        log: () => undefined,
        setInterval: callback => {
            const handle = { callback, active: true };
            timers.push(handle);
            return handle;
        },
        clearInterval: handle => { handle.active = false; },
    });
    const nodeA = new AttentionGlobalStateSpike(dependencies('node-a'));
    const nodeB = new AttentionGlobalStateSpike(dependencies('node-b'));

    await nodeA.writeProbe();
    now += 100;
    nodeB.poll();
    await nodeB.writeProbe();
    now += 100;
    nodeA.poll();

    assert.deepStrictEqual(nodeA.getStatus().seenNodeIds, ['node-b']);
    assert.deepStrictEqual(nodeB.getStatus().seenNodeIds, ['node-a']);
    assert.strictEqual(nodeA.getStatus().roundTripSamplesMs[0], 200);
    assert.strictEqual(nodeA.getStatus().p95RoundTripMs, 200);

    nodeA.start(true);
    nodeB.start(false);
    assert.strictEqual(timers.filter(timer => timer.active).length, 4);
    await nodeA.writeProbe();
    assert.strictEqual(nodeA.getStatus().sentinelRevision > 0, true);

    values.set('projectSteward.debug.aiSessionAttentionSpike.sentinel', 0);
    nodeA.poll();
    assert.strictEqual(nodeA.getStatus().sentinelRollbacks, 1);

    await nodeA.stop(true);
    await nodeB.stop(true);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);
    const registry = values.get('projectSteward.debug.aiSessionAttentionSpike.registry');
    assert.strictEqual(registry.nodes['node-a'].closed, true);
    assert.strictEqual(registry.nodes['node-b'].closed, true);

    await nodeA.clear();
    assert.strictEqual(values.has('projectSteward.debug.aiSessionAttentionSpike.registry'), false);
    assert.strictEqual(values.has('projectSteward.debug.aiSessionAttentionSpike.sentinel'), false);
}
```

Call it from `main()`:

```js
await runAttentionGlobalStateSpikeChecks();
```

- [ ] **Step 2: Run the safety suite and verify RED**

Run:

```bash
npm run test:safety
```

Expected: compilation or Node loading fails because `src/aiSessions/attentionGlobalStateSpike.ts` does not exist.

- [ ] **Step 3: Implement the temporary probe**

Create `src/aiSessions/attentionGlobalStateSpike.ts` with the following implementation:

```ts
'use strict';

export const ATTENTION_SPIKE_REGISTRY_KEY = 'projectSteward.debug.aiSessionAttentionSpike.registry';
export const ATTENTION_SPIKE_SENTINEL_KEY = 'projectSteward.debug.aiSessionAttentionSpike.sentinel';
export const ATTENTION_SPIKE_WRITE_INTERVAL_MS = 1000;
export const ATTENTION_SPIKE_POLL_INTERVAL_MS = 200;

interface AttentionSpikeMemento {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

interface AttentionSpikeNode {
    revision: number;
    closed: boolean;
    acknowledgements: Record<string, number>;
}

interface AttentionSpikeRegistry {
    version: 1;
    nodes: Record<string, AttentionSpikeNode>;
}

interface AttentionSpikeObservation {
    revision: number;
    observedAt: number;
    missingSince: number | null;
    maxMissingMs: number;
}

export interface AttentionSpikeStatus {
    nodeId: string;
    ownRevision: number;
    seenNodeIds: string[];
    peerRevisions: Record<string, number>;
    peerStalledMs: Record<string, number>;
    closedNodeIds: string[];
    registryBytes: number;
    roundTripSamplesMs: number[];
    p95RoundTripMs: number | null;
    longestMissingMs: number;
    sentinelRevision: number;
    sentinelRollbacks: number;
    writeErrors: number;
}

export interface AttentionGlobalStateSpikeDependencies {
    globalState: AttentionSpikeMemento;
    now: () => number;
    createId: () => string;
    log: (message: string) => void;
    setInterval: (callback: () => void, intervalMs: number) => unknown;
    clearInterval: (handle: unknown) => void;
}

export default class AttentionGlobalStateSpike {
    private readonly nodeId: string;
    private revision = 0;
    private sentinelOwner = false;
    private sentinelRevision = 0;
    private sentinelRollbacks = 0;
    private writeErrors = 0;
    private writeTimer: unknown = null;
    private pollTimer: unknown = null;
    private writeQueue: Promise<void> = Promise.resolve();
    private observations = new Map<string, AttentionSpikeObservation>();
    private sentAt = new Map<number, number>();
    private lastAckByNode = new Map<string, number>();
    private roundTripSamplesMs: number[] = [];

    constructor(private readonly dependencies: AttentionGlobalStateSpikeDependencies) {
        this.nodeId = dependencies.createId();
    }

    start(sentinelOwner: boolean) {
        if (this.writeTimer !== null || this.pollTimer !== null) return;
        this.sentinelOwner = sentinelOwner;
        this.writeTimer = this.dependencies.setInterval(
            () => { this.writeProbe().then(undefined, error => this.recordWriteError(error)); },
            ATTENTION_SPIKE_WRITE_INTERVAL_MS
        );
        this.pollTimer = this.dependencies.setInterval(
            () => this.poll(),
            ATTENTION_SPIKE_POLL_INTERVAL_MS
        );
        this.writeProbe().then(undefined, error => this.recordWriteError(error));
    }

    writeProbe(closed: boolean = false): Promise<void> {
        const operation = this.writeQueue.then(() => this.performWrite(closed));
        this.writeQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async performWrite(closed: boolean) {
        const registry = this.readRegistry();
        const acknowledgements: Record<string, number> = {};
        for (const [nodeId, observation] of this.observations) {
            acknowledgements[nodeId] = observation.revision;
        }
        this.revision += 1;
        this.sentAt.set(this.revision, this.dependencies.now());
        registry.nodes[this.nodeId] = {
            revision: this.revision,
            closed,
            acknowledgements,
        };
        await this.dependencies.globalState.update(ATTENTION_SPIKE_REGISTRY_KEY, registry);
        if (this.sentinelOwner && !closed) {
            const current = this.dependencies.globalState.get<number>(ATTENTION_SPIKE_SENTINEL_KEY, 0);
            this.sentinelRevision = Math.max(this.sentinelRevision, current) + 1;
            await this.dependencies.globalState.update(ATTENTION_SPIKE_SENTINEL_KEY, this.sentinelRevision);
        }
    }

    poll() {
        const now = this.dependencies.now();
        const registry = this.readRegistry();
        const liveIds = new Set(Object.keys(registry.nodes).filter(id => id !== this.nodeId));
        for (const nodeId of liveIds) {
            const node = registry.nodes[nodeId];
            const previous = this.observations.get(nodeId);
            if (!previous || node.revision > previous.revision) {
                this.observations.set(nodeId, {
                    revision: node.revision,
                    observedAt: now,
                    missingSince: null,
                    maxMissingMs: previous ? previous.maxMissingMs : 0,
                });
            } else if (previous.missingSince !== null) {
                previous.maxMissingMs = Math.max(previous.maxMissingMs, now - previous.missingSince);
                previous.missingSince = null;
            }
            const acknowledged = node.acknowledgements[this.nodeId] || 0;
            const lastAcknowledged = this.lastAckByNode.get(nodeId) || 0;
            const sentAt = this.sentAt.get(acknowledged);
            if (acknowledged > lastAcknowledged && sentAt !== undefined) {
                this.roundTripSamplesMs.push(Math.max(0, now - sentAt));
                this.lastAckByNode.set(nodeId, acknowledged);
            }
        }
        for (const [nodeId, observation] of this.observations) {
            if (!liveIds.has(nodeId) && observation.missingSince === null) {
                observation.missingSince = now;
            }
        }
        const sentinel = this.dependencies.globalState.get<number>(ATTENTION_SPIKE_SENTINEL_KEY, 0);
        if (sentinel < this.sentinelRevision) this.sentinelRollbacks += 1;
        this.sentinelRevision = Math.max(this.sentinelRevision, sentinel);
    }

    getStatus(): AttentionSpikeStatus {
        const now = this.dependencies.now();
        const registry = this.readRegistry();
        const samples = [...this.roundTripSamplesMs].sort((a, b) => a - b);
        const p95Index = samples.length ? Math.ceil(samples.length * 0.95) - 1 : -1;
        const missingDurations = Array.from(this.observations.values()).map(item =>
            Math.max(item.maxMissingMs, item.missingSince === null ? 0 : now - item.missingSince)
        );
        return {
            nodeId: this.nodeId,
            ownRevision: this.revision,
            seenNodeIds: Array.from(this.observations.keys()).sort(),
            peerRevisions: Array.from(this.observations.entries()).reduce((result, [nodeId, item]) => {
                result[nodeId] = item.revision;
                return result;
            }, {} as Record<string, number>),
            peerStalledMs: Array.from(this.observations.entries()).reduce((result, [nodeId, item]) => {
                result[nodeId] = Math.max(0, now - item.observedAt);
                return result;
            }, {} as Record<string, number>),
            closedNodeIds: Object.keys(registry.nodes).filter(nodeId => registry.nodes[nodeId].closed).sort(),
            registryBytes: Buffer.byteLength(JSON.stringify(registry), 'utf8'),
            roundTripSamplesMs: [...this.roundTripSamplesMs],
            p95RoundTripMs: p95Index < 0 ? null : samples[p95Index],
            longestMissingMs: missingDurations.length ? Math.max(...missingDurations) : 0,
            sentinelRevision: this.sentinelRevision,
            sentinelRollbacks: this.sentinelRollbacks,
            writeErrors: this.writeErrors,
        };
    }

    async stop(clean: boolean) {
        this.stopTimers();
        if (clean) await this.writeProbe(true);
    }

    async clear() {
        this.stopTimers();
        await this.dependencies.globalState.update(ATTENTION_SPIKE_REGISTRY_KEY, undefined);
        await this.dependencies.globalState.update(ATTENTION_SPIKE_SENTINEL_KEY, undefined);
    }

    dispose() {
        this.stopTimers();
    }

    private readRegistry(): AttentionSpikeRegistry {
        const value = this.dependencies.globalState.get<AttentionSpikeRegistry>(
            ATTENTION_SPIKE_REGISTRY_KEY,
            { version: 1, nodes: {} }
        );
        return value && value.version === 1 && value.nodes
            ? { version: 1, nodes: { ...value.nodes } }
            : { version: 1, nodes: {} };
    }

    private stopTimers() {
        if (this.writeTimer !== null) this.dependencies.clearInterval(this.writeTimer);
        if (this.pollTimer !== null) this.dependencies.clearInterval(this.pollTimer);
        this.writeTimer = null;
        this.pollTimer = null;
    }

    private recordWriteError(error: unknown) {
        this.writeErrors += 1;
        this.dependencies.log(`Attention spike write failed: ${String(error)}`);
    }
}
```

- [ ] **Step 4: Run the safety suite and verify GREEN**

Run:

```bash
npm run test:safety
```

Expected: `runAttentionGlobalStateSpikeChecks()` passes and the suite prints `AI session safety checks passed.`

- [ ] **Step 5: Review checkpoint**

Run:

```bash
git diff --check
git diff -- src/aiSessions/attentionGlobalStateSpike.ts scripts/run-ai-session-safety-checks.js
```

Present the temporary probe and tests for user review. Do not commit.

---

### Task 2: Temporary VS Code Command Wiring

**Files:**

- Modify temporarily: `src/dashboard.ts`
- Modify temporarily: `package.json`

**Interfaces:**

- Consumes: `AttentionGlobalStateSpike` from Task 1 and the existing Project Steward output channel.
- Produces: command-palette commands `projectSteward.debugAttentionSpikeStart`, `projectSteward.debugAttentionSpikeStatus`, `projectSteward.debugAttentionSpikeStop`, and `projectSteward.debugAttentionSpikeClear`.

- [ ] **Step 1: Add command contributions**

Append these entries to `contributes.commands` in `package.json`:

```json
{
  "command": "projectSteward.debugAttentionSpikeStart",
  "title": "Project Steward Debug: Start Attention globalState Spike"
},
{
  "command": "projectSteward.debugAttentionSpikeStatus",
  "title": "Project Steward Debug: Show Attention globalState Spike Status"
},
{
  "command": "projectSteward.debugAttentionSpikeStop",
  "title": "Project Steward Debug: Stop Attention globalState Spike Cleanly"
},
{
  "command": "projectSteward.debugAttentionSpikeClear",
  "title": "Project Steward Debug: Clear Attention globalState Spike Data"
}
```

- [ ] **Step 2: Wire the probe into `activate()`**

Add imports:

```ts
import * as crypto from 'crypto';
import AttentionGlobalStateSpike from './aiSessions/attentionGlobalStateSpike';
```

After constructing `outputChannel`, construct the probe:

```ts
const attentionGlobalStateSpike = new AttentionGlobalStateSpike({
    globalState: context.globalState,
    now: () => Date.now(),
    createId: () => crypto.randomBytes(8).toString('hex'),
    log: message => outputChannel.appendLine(message),
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
});
```

Register and subscribe the commands inside `activate()`:

```ts
context.subscriptions.push(
    vscode.commands.registerCommand('projectSteward.debugAttentionSpikeStart', async () => {
        const mode = await vscode.window.showQuickPick(
            ['Probe node', 'Probe node + sentinel owner'],
            { placeHolder: 'Choose one sentinel owner per test matrix' }
        );
        if (!mode) return;
        attentionGlobalStateSpike.start(mode === 'Probe node + sentinel owner');
        outputChannel.show(true);
        outputChannel.appendLine(`Attention spike started: ${JSON.stringify(attentionGlobalStateSpike.getStatus())}`);
    }),
    vscode.commands.registerCommand('projectSteward.debugAttentionSpikeStatus', () => {
        const status = attentionGlobalStateSpike.getStatus();
        outputChannel.show(true);
        outputChannel.appendLine(`Attention spike status: ${JSON.stringify(status)}`);
        vscode.window.showInformationMessage(
            `Attention spike: ${status.seenNodeIds.length} peers, P95 RTT ${status.p95RoundTripMs ?? 'n/a'} ms, rollbacks ${status.sentinelRollbacks}`
        );
    }),
    vscode.commands.registerCommand('projectSteward.debugAttentionSpikeStop', async () => {
        await attentionGlobalStateSpike.stop(true);
        outputChannel.appendLine(`Attention spike stopped: ${JSON.stringify(attentionGlobalStateSpike.getStatus())}`);
    }),
    vscode.commands.registerCommand('projectSteward.debugAttentionSpikeClear', async () => {
        await attentionGlobalStateSpike.clear();
        outputChannel.appendLine('Attention spike state cleared.');
    }),
    { dispose: () => attentionGlobalStateSpike.dispose() }
);
```

- [ ] **Step 3: Compile, bundle, and verify command registration**

Run:

```bash
npm run test:safety
npm run webpack
```

Expected: both commands exit 0; safety output ends with `AI session safety checks passed.` and webpack reports a successful build.

Run:

```bash
rg -n "debugAttentionSpike(Start|Status|Stop|Clear)" package.json src/dashboard.ts
```

Expected: all four command IDs appear in both files.

- [ ] **Step 4: Build and install the diagnostic VSIX**

Run:

```bash
SKIP_NPM_CI=1 npm run install-local
```

Expected: `project-steward-1.1.8.vsix` is built and installed in the selected local VS Code client.

For every Remote SSH, WSL, or Dev Container test window, use that window's Extensions view and run **Install from VSIX...** with the same generated file so the workspace extension is installed in that remote Extension Host. Reload each test window after installation.

- [ ] **Step 5: Review checkpoint**

Run:

```bash
git diff --check
git diff -- package.json src/dashboard.ts src/aiSessions/attentionGlobalStateSpike.ts scripts/run-ai-session-safety-checks.js
```

Present the temporary command wiring and successful build evidence. Do not commit.

---

### Task 3: Execute the Cross-Window Matrix and Record Evidence

**Files:**

- Create and retain: `docs/superpowers/reports/2026-07-13-ai-session-attention-global-state-feasibility.md`

**Interfaces:**

- Consumes: the four temporary commands and JSON status lines from Task 2.
- Produces: a measured PASS/FAIL report that decides whether a production `globalState` registry is allowed.

- [ ] **Step 1: Run the two-local-window baseline**

Open two local VS Code windows using the same profile. In the first, run **Start Attention globalState Spike** as `Probe node + sentinel owner`. In the second, start as `Probe node`.

Leave both running for at least five minutes. Once per minute, run **Show Attention globalState Spike Status** in both windows and save the complete JSON status lines from the Project Steward output channel.

Expected in both windows:

- exactly one peer node is visible;
- at least 100 round-trip samples exist by the end;
- `p95RoundTripMs <= 1000`;
- `longestMissingMs <= 60000`;
- `sentinelRollbacks === 0`;
- `writeErrors === 0`;
- `registryBytes < 65536`.

- [ ] **Step 2: Run each available remote pairing**

Repeat the five-minute procedure for:

1. one local window plus one Remote SSH window;
2. two Remote SSH windows connected to different hosts;
3. one local window plus one WSL window;
4. one local window plus one Dev Container window.

Only one participating window is the sentinel owner in each run. Before moving
to the next matrix, run **Stop Attention globalState Spike Cleanly** in every
participating window, then run **Clear Attention globalState Spike Data** in
every participating window so both shared keys and every instance's local
statistics reset. Mark an unavailable environment as
`NOT RUN — environment unavailable`, never as PASS.

Expected for every required/available matrix: the same thresholds as Step 1.

- [ ] **Step 3: Exercise clean and forced shutdown**

For each matrix:

1. Run **Stop Attention globalState Spike Cleanly** in one non-sentinel window.
2. Verify the other window includes that node ID in `closedNodeIds` on the next
   status read.
3. Restart that node, then close/kill its VS Code window without running Stop.
4. Continue checking the surviving window for 90 seconds and verify the dead
   node's value in `peerRevisions` stops advancing while its `peerStalledMs`
   reaches at least 90,000.

Expected: clean stop is visible within one second. Forced shutdown stops the lease immediately at the source and provides sufficient evidence for the production reader's planned 90-second local expiry. The spike does not implement production TTL cleanup; the report must distinguish "revision stopped" from "entry removed".

- [ ] **Step 4: Stress unrelated state**

While three probe windows run concurrently, change an unrelated Project Steward value in the sentinel-owner window at least ten times—for example collapse/expand the Open Projects group—and verify the final UI value remains stable after probe writes continue for another minute.

Also confirm every probe status retains `sentinelRollbacks === 0`.

Expected: neither the dedicated sentinel nor the unrelated UI value rolls back.

- [ ] **Step 5: Write the evidence report with actual measurements**

Create `docs/superpowers/reports/2026-07-13-ai-session-attention-global-state-feasibility.md` only after measurements exist. Include:

- tested VS Code version, extension version, OS, profile name, and remote types;
- one row per environment matrix with duration, node count, sample count, P95 full round-trip latency, longest missing duration, sentinel rollback count, write error count, and maximum registry bytes;
- clean-stop `closedNodeIds` observation latency and forced-stop
  `peerRevisions`/`peerStalledMs` behavior;
- unrelated Project Steward state stress result;
- unavailable matrices explicitly marked as not run;
- one final decision: `PASS — production registry allowed` or `FAIL — return to architecture design`;
- raw JSON status samples in a collapsible Markdown section.

Do not write PASS unless every required environment and every numeric threshold passes.

- [ ] **Step 6: Gate review checkpoint**

Present the report to the user before cleanup or production planning.

If the report says FAIL, stop here. Do not execute Task 4 as an implied approval to proceed; first return to brainstorming and choose same-host-only monitoring or a broker/companion architecture.

---

### Task 4: Remove the Spike and Close the Gate

**Files:**

- Delete: `src/aiSessions/attentionGlobalStateSpike.ts`
- Modify: `src/dashboard.ts`
- Modify: `package.json`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Retain: `docs/superpowers/reports/2026-07-13-ai-session-attention-global-state-feasibility.md`

**Interfaces:**

- Consumes: an explicitly approved PASS report from Task 3.
- Produces: a clean branch with no diagnostic runtime code and an evidence-backed authorization to write the production implementation plan.

- [ ] **Step 1: Clear shared diagnostic state**

Run **Stop Attention globalState Spike Cleanly** in every participating window.
Then run **Clear Attention globalState Spike Data** in every participating
window. Run Status in each window and confirm `seenNodeIds`, `peerRevisions`,
`peerStalledMs`, and `closedNodeIds` are empty, revisions/counters are reset, and
no shared sentinel value remains.

- [ ] **Step 2: Remove all temporary runtime wiring**

Delete `src/aiSessions/attentionGlobalStateSpike.ts`.

Remove from `src/dashboard.ts`:

- the `crypto` import added solely for the spike;
- the `AttentionGlobalStateSpike` import;
- the `attentionGlobalStateSpike` construction;
- all four command registrations;
- the spike disposable.

Remove the four `projectSteward.debugAttentionSpike*` command contributions from `package.json`.

Remove from `scripts/run-ai-session-safety-checks.js`:

- the temporary compiled-module require;
- `runAttentionGlobalStateSpikeChecks()`;
- its call from `main()`.

- [ ] **Step 3: Prove diagnostic code is gone**

Run:

```bash
rg -n "attentionGlobalStateSpike|debugAttentionSpike|aiSessionAttentionSpike" src package.json scripts
```

Expected: no output and exit status 1.

- [ ] **Step 4: Run repository verification**

Run:

```bash
npm run test:safety
npm run lint
npm run webpack
git diff --check
```

Expected:

- safety checks print `AI session safety checks passed.`;
- lint exits 0 with no new errors;
- webpack completes successfully;
- `git diff --check` exits 0.

- [ ] **Step 5: Final review checkpoint**

Run:

```bash
git status --short
git diff -- docs/superpowers/specs/2026-07-13-ai-session-attention-monitor-design.md docs/superpowers/plans/2026-07-13-ai-session-attention-global-state-feasibility.md docs/superpowers/reports/2026-07-13-ai-session-attention-global-state-feasibility.md
```

Expected: no temporary spike source, command, or test changes remain. The user's `.vscode/settings.json` remains untouched. Present the spec, plan, measured report, and verification output for review. Do not commit without explicit user approval.

After an approved PASS, create a separate production implementation plan covering source-ID persistence, the 10-second attention state machine, registry lease/retry behavior, aggregation, dashboard integration, Webview indicators, configuration, and regression verification.
