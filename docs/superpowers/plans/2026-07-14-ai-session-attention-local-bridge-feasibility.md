# AI Session Attention Local Bridge Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task by task with review checkpoints.

**Goal:** Prove or reject the Local Bridge architecture before any production attention-monitor code is written.

**Architecture:** Two disposable probe extensions exercise the exact production host boundary. A Workspace Probe runs beside Project Steward in each local or remote Workspace Extension Host; a UI Bridge Probe runs in that window's local UI Extension Host. Phase 1 proves that duplicate private command registrations route only within the originating window. Only after Phase 1 passes, Phase 2 uses the UI Bridge's profile-local `globalStorageUri` as an atomic-file bus and measures cross-window propagation, leases, reload recovery, watcher fallback, and Profile isolation.

**Tech Stack:** VS Code Extension API `^1.51.0`, TypeScript 4.0, Node.js 14 APIs, webpack 5, `@vscode/vsce`, Node `assert`, JSONL evidence files.

## Global Constraints

- This plan implements only the feasibility spike. Do not add production attention state, UI badges, provider activity tokens, or a permanent companion extension.
- Do not stage, commit, push, publish, or create a merge request. Replace every normal commit boundary with a user review checkpoint.
- Preserve the user's modified `.vscode/settings.json`; never edit, stage, restore, or package it.
- Keep all disposable source under `spikes/attention-local-bridge/` and exclude `spikes/**` from the production VSIX.
- Phase 1 is a hard gate. If any command-routing criterion fails, stop, write a FAIL report, and do not implement or run Phase 2.
- An unavailable environment is recorded as `NOT RUN`, never `PASS`.
- Do not claim overall feasibility unless Local, Remote SSH, WSL, and Dev Container routing all pass. Partial execution may be reported, but the overall result remains `INCOMPLETE`.
- Retain the approved design, this plan, raw evidence, and final report until the user explicitly approves cleanup.
- Use fresh probe version numbers or uninstall both probes before reinstalling so stale bundles cannot contaminate results.

---

## Task 1: Add the pure protocol and routing-result checks

**Files:**

- Create: `spikes/attention-local-bridge/shared/protocol.ts`
- Create: `spikes/attention-local-bridge/shared/metrics.ts`
- Create: `scripts/run-attention-local-bridge-spike-checks.js`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `.vscodeignore`

### Step 1: Write the failing protocol checks

Create `scripts/run-attention-local-bridge-spike-checks.js` with checks for:

- protocol version rejection;
- lowercase 16-byte hexadecimal process IDs;
- bounded workspace identity and nonce strings;
- exact echo of nonce and Workspace process ID;
- one stable Bridge process ID per Workspace process;
- percentile calculation;
- production packaging exclusion of `spikes/**`.

The check runner must initially import the missing compiled modules so the red state is unambiguous:

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const protocol = require('../spikes/attention-local-bridge/out/shared/protocol');
const metrics = require('../spikes/attention-local-bridge/out/shared/metrics');

function throws(fn, pattern) {
    assert.throws(fn, pattern);
}

function runProtocolChecks() {
    const request = {
        protocolVersion: 1,
        workspaceProcessId: '0123456789abcdef0123456789abcdef',
        workspaceIdentity: 'file:///tmp/fixture-a',
        nonce: 'abcdef0123456789abcdef0123456789',
    };
    assert.deepStrictEqual(protocol.parseRoutingChallenge(request), request);
    throws(() => protocol.parseRoutingChallenge({ ...request, protocolVersion: 2 }), /protocolVersion/);
    throws(() => protocol.parseRoutingChallenge({ ...request, workspaceProcessId: 'wrong' }), /workspaceProcessId/);
    throws(() => protocol.parseRoutingChallenge({ ...request, nonce: '' }), /nonce/);
    throws(() => protocol.parseRoutingChallenge({ ...request, workspaceIdentity: 'x'.repeat(8193) }), /workspaceIdentity/);

    const response = {
        protocolVersion: 1,
        workspaceProcessId: request.workspaceProcessId,
        bridgeProcessId: 'fedcba9876543210fedcba9876543210',
        workspaceIdentity: request.workspaceIdentity,
        nonce: request.nonce,
    };
    assert.deepStrictEqual(protocol.parseRoutingResponse(response), response);
    protocol.assertMatchingRoutingResponse(request, response);
    throws(
        () => protocol.assertMatchingRoutingResponse(request, { ...response, nonce: '11111111111111111111111111111111' }),
        /nonce/
    );
    throws(
        () => protocol.assertStableBridgeProcessId(new Set([response.bridgeProcessId]), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        /unstable bridge process mapping/
    );
}

function runMetricChecks() {
    assert.strictEqual(metrics.percentile([], 95), null);
    assert.strictEqual(metrics.percentile([5, 1, 3, 2, 4], 95), 5);
    assert.strictEqual(metrics.percentile([1, 2, 3, 4, 5], 50), 3);
    assert.deepStrictEqual(metrics.summarizeLatencies([10, 20, 30]), {
        samples: 3,
        p95Ms: 30,
        maxMs: 30,
    });
}

function runPackagingChecks() {
    const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
    assert.match(ignore, /^spikes\/\*\*$/m);
}

runProtocolChecks();
runMetricChecks();
runPackagingChecks();
console.log('Attention Local Bridge spike checks passed.');
```

### Step 2: Run the checks and observe RED

Run:

```bash
node scripts/run-attention-local-bridge-spike-checks.js
```

Expected: failure because `spikes/attention-local-bridge/out/shared/protocol` does not exist.

### Step 3: Add the pure implementation

Create `spikes/attention-local-bridge/shared/protocol.ts`:

```ts
export const PROTOCOL_VERSION = 1;
export const PROCESS_ID_PATTERN = /^[a-f0-9]{32}$/;
export const MAX_WORKSPACE_IDENTITY_LENGTH = 8192;

export interface RoutingChallenge {
    protocolVersion: number;
    workspaceProcessId: string;
    workspaceIdentity: string;
    nonce: string;
}

export interface RoutingResponse extends RoutingChallenge {
    bridgeProcessId: string;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireProcessId(value: unknown, label: string): string {
    if (typeof value !== 'string' || !PROCESS_ID_PATTERN.test(value)) {
        throw new Error(`${label} must be 32 lowercase hexadecimal characters`);
    }
    return value;
}

function requireBoundedString(value: unknown, label: string, maximum: number): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
        throw new Error(`${label} must contain 1-${maximum} characters`);
    }
    return value;
}

export function parseRoutingChallenge(value: unknown): RoutingChallenge {
    const record = requireObject(value, 'routing challenge');
    if (record.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must equal ${PROTOCOL_VERSION}`);
    }
    return {
        protocolVersion: PROTOCOL_VERSION,
        workspaceProcessId: requireProcessId(record.workspaceProcessId, 'workspaceProcessId'),
        workspaceIdentity: requireBoundedString(record.workspaceIdentity, 'workspaceIdentity', MAX_WORKSPACE_IDENTITY_LENGTH),
        nonce: requireProcessId(record.nonce, 'nonce'),
    };
}

export function parseRoutingResponse(value: unknown): RoutingResponse {
    const challenge = parseRoutingChallenge(value);
    const record = requireObject(value, 'routing response');
    return {
        ...challenge,
        bridgeProcessId: requireProcessId(record.bridgeProcessId, 'bridgeProcessId'),
    };
}

export function assertMatchingRoutingResponse(request: RoutingChallenge, response: RoutingResponse): void {
    if (response.workspaceProcessId !== request.workspaceProcessId) {
        throw new Error('workspaceProcessId mismatch');
    }
    if (response.workspaceIdentity !== request.workspaceIdentity) {
        throw new Error('workspaceIdentity mismatch');
    }
    if (response.nonce !== request.nonce) {
        throw new Error('nonce mismatch');
    }
}

export function assertStableBridgeProcessId(seen: Set<string>, next: string): void {
    if (seen.size > 0 && !seen.has(next)) {
        throw new Error(`unstable bridge process mapping: ${Array.from(seen).join(',')} -> ${next}`);
    }
}
```

Create `spikes/attention-local-bridge/shared/metrics.ts`:

```ts
export interface LatencySummary {
    samples: number;
    p95Ms: number | null;
    maxMs: number | null;
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = values.slice().sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
    return sorted[index];
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
    return {
        samples: values.length,
        p95Ms: percentile(values, 95),
        maxMs: values.length === 0 ? null : Math.max(...values),
    };
}
```

Add `spikes/attention-local-bridge/tsconfig.json`:

```json
{
    "compilerOptions": {
        "module": "commonjs",
        "target": "es6",
        "outDir": "out",
        "rootDir": ".",
        "lib": ["es6"],
        "sourceMap": true,
        "strict": true,
        "esModuleInterop": true
    },
    "include": ["shared/**/*.ts", "workspace/src/**/*.ts", "ui-bridge/src/**/*.ts"]
}
```

Add these scripts to root `package.json`:

```json
"spike:attention:compile": "tsc -p spikes/attention-local-bridge/tsconfig.json",
"spike:attention:test": "npm run spike:attention:compile && node scripts/run-attention-local-bridge-spike-checks.js",
"spike:attention:bundle": "webpack --config spikes/attention-local-bridge/webpack.config.js --mode production",
"spike:attention:package": "npm run spike:attention:test && npm run spike:attention:bundle && node spikes/attention-local-bridge/scripts/package.js"
```

Add `"spikes"` to root `tsconfig.json`'s `exclude` array. Add this exact line to `.vscodeignore`:

```text
spikes/**
```

### Step 4: Run the checks and observe GREEN

Run:

```bash
npm run spike:attention:test
npm run test:safety
npm run webpack
```

Expected: all three commands exit 0. Confirm `git diff --check` is clean and `git diff --cached --name-only` is empty.

### Step 5: Review checkpoint

Show the user the Task 1 diff. Do not stage or commit it.

---

## Task 2: Build Phase 1's window-local command-routing challenge

**Files:**

- Create: `spikes/attention-local-bridge/workspace/src/extension.ts`
- Create: `spikes/attention-local-bridge/ui-bridge/src/extension.ts`
- Create: `spikes/attention-local-bridge/workspace/package.json`
- Create: `spikes/attention-local-bridge/ui-bridge/package.json`
- Create: `spikes/attention-local-bridge/workspace/README.md`
- Create: `spikes/attention-local-bridge/ui-bridge/README.md`
- Create: `spikes/attention-local-bridge/workspace/.vscodeignore`
- Create: `spikes/attention-local-bridge/ui-bridge/.vscodeignore`
- Create: `spikes/attention-local-bridge/webpack.config.js`
- Extend: `scripts/run-attention-local-bridge-spike-checks.js`

### Step 1: Add failing static contract checks

Extend the check runner so it reads both manifests and asserts:

```js
function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));
}

function runManifestChecks() {
    const workspace = readJson('spikes/attention-local-bridge/workspace/package.json');
    const bridge = readJson('spikes/attention-local-bridge/ui-bridge/package.json');
    assert.deepStrictEqual(workspace.extensionKind, ['workspace']);
    assert.deepStrictEqual(bridge.extensionKind, ['ui']);
    assert.strictEqual(bridge.api, 'none');
    assert.deepStrictEqual(workspace.extensionDependencies, ['hzcheng.project-steward-attention-ui-bridge-probe']);
    assert.ok(workspace.contributes.commands.some(command => command.command === 'projectStewardAttentionSpike.startRouting'));
    assert.ok(workspace.contributes.commands.some(command => command.command === 'projectStewardAttentionSpike.startSameWorkspaceRouting'));
    assert.ok(workspace.contributes.commands.some(command => command.command === 'projectStewardAttentionSpike.showStatus'));
}
```

Call `runManifestChecks()` before the final success message. Run `npm run spike:attention:test` and expect RED because the manifests do not exist.

### Step 2: Create the two probe manifests

Create `workspace/package.json`:

```json
{
    "name": "project-steward-attention-workspace-probe",
    "displayName": "Project Steward Attention Workspace Probe",
    "description": "Disposable feasibility probe for Project Steward Local Bridge.",
    "version": "0.0.2",
    "publisher": "hzcheng",
    "engines": { "vscode": "^1.51.0" },
    "extensionKind": ["workspace"],
    "activationEvents": ["*"],
    "main": "./dist/extension.js",
    "extensionDependencies": ["hzcheng.project-steward-attention-ui-bridge-probe"],
    "contributes": {
        "commands": [
            { "command": "projectStewardAttentionSpike.startRouting", "title": "Project Steward Attention Spike: Start Routing Challenge" },
            { "command": "projectStewardAttentionSpike.startSameWorkspaceRouting", "title": "Project Steward Attention Spike: Start Same-Workspace Routing Challenge" },
            { "command": "projectStewardAttentionSpike.showStatus", "title": "Project Steward Attention Spike: Show Status" }
        ]
    }
}
```

Create `ui-bridge/package.json`:

```json
{
    "name": "project-steward-attention-ui-bridge-probe",
    "displayName": "Project Steward Attention UI Bridge Probe",
    "description": "Disposable local UI bridge feasibility probe for Project Steward.",
    "version": "0.0.2",
    "publisher": "hzcheng",
    "engines": { "vscode": "^1.51.0" },
    "extensionKind": ["ui"],
    "api": "none",
    "activationEvents": ["*"],
    "main": "./dist/extension.js"
}
```

Both READMEs must say that the extension is disposable, records no conversation content, and must not be published. Both `.vscodeignore` files must contain:

```text
src/**
out/**
*.map
```

### Step 3: Implement the routing challenge

Use these private command IDs in both sources:

```ts
const BRIDGE_CHALLENGE = '_projectStewardAttentionSpike.bridge.challenge';
const WORKSPACE_CHALLENGE = '_projectStewardAttentionSpike.workspace.challenge';
```

The Workspace Probe must:

- generate one `workspaceProcessId` with `crypto.randomBytes(16).toString('hex')`;
- compute identity from sorted `workspaceFolders.map(folder => folder.uri.path).join('\n')`, falling back to the host-independent `<empty-workspace>` sentinel;
- register `WORKSPACE_CHALLENGE` and reject requests whose expected Workspace ID or identity differs;
- register `startRouting` with a fixed count of 1,000 and `startSameWorkspaceRouting` with a fixed count of 200;
- execute challenges in batches of 20, using unique nonces;
- apply a five-second timeout to every round trip;
- require exact nonce/identity/Workspace ID echoes;
- require one stable Bridge ID for the entire run;
- fail on the first mismatch and retain the error in status;
- emit a single JSON status object to a dedicated Output channel.

Only canonical URI `path` values participate in the comparable identity. Do
not include scheme, authority, `fsPath`, or remote name because Workspace and UI
Extension Hosts represent the same remote workspace with different schemes and
authorities. Treat this identity as a routing precheck; the random Workspace
process ID and successful reverse-command echo remain the authoritative proof
that the challenge returned to the originating Workspace process.

The UI Bridge Probe must:

- generate one `bridgeProcessId` per window instance;
- compute the same workspace identity independently;
- register `BRIDGE_CHALLENGE`;
- reject identity mismatches before calling the reverse command;
- call `WORKSPACE_CHALLENGE` with the expected Workspace ID, identity, nonce, and its Bridge ID;
- return only after the reverse response proves it reached the expected Workspace process.

Use the following challenge handlers as the behavioral core.

Workspace handler:

```ts
const reverseDisposable = vscode.commands.registerCommand(WORKSPACE_CHALLENGE, (raw: unknown) => {
    const value = raw as Record<string, unknown>;
    if (value.workspaceProcessId !== workspaceProcessId) {
        throw new Error(`reverse command reached wrong Workspace process: expected ${value.workspaceProcessId}, got ${workspaceProcessId}`);
    }
    if (value.workspaceIdentity !== workspaceIdentity) {
        throw new Error('reverse command workspace identity mismatch');
    }
    if (typeof value.bridgeProcessId !== 'string' || !PROCESS_ID_PATTERN.test(value.bridgeProcessId)) {
        throw new Error('reverse command bridgeProcessId is invalid');
    }
    if (typeof value.nonce !== 'string' || !PROCESS_ID_PATTERN.test(value.nonce)) {
        throw new Error('reverse command nonce is invalid');
    }
    return {
        workspaceProcessId,
        workspaceIdentity,
        bridgeProcessId: value.bridgeProcessId,
        nonce: value.nonce,
    };
});
```

Bridge handler:

```ts
const challengeDisposable = vscode.commands.registerCommand(BRIDGE_CHALLENGE, async (raw: unknown) => {
    const request = parseRoutingChallenge(raw);
    if (request.workspaceIdentity !== workspaceIdentity) {
        throw new Error(`bridge workspace identity mismatch: ${workspaceIdentity}`);
    }
    const reverse = await vscode.commands.executeCommand<Record<string, unknown>>(WORKSPACE_CHALLENGE, {
        ...request,
        bridgeProcessId,
    });
    if (!reverse || reverse.workspaceProcessId !== request.workspaceProcessId ||
        reverse.workspaceIdentity !== request.workspaceIdentity || reverse.nonce !== request.nonce ||
        reverse.bridgeProcessId !== bridgeProcessId) {
        throw new Error('reverse Workspace response mismatch');
    }
    return {
        ...request,
        bridgeProcessId,
    };
});
```

Use this exact batching pattern inside `runRoutingChallenge(total)` so “concurrent” is bounded and reproducible:

```ts
for (let offset = 0; offset < total; offset += 20) {
    const batchSize = Math.min(20, total - offset);
    const batch = Array.from({ length: batchSize }, async () => {
        const nonce = crypto.randomBytes(16).toString('hex');
        const request = { protocolVersion: PROTOCOL_VERSION, workspaceProcessId, workspaceIdentity, nonce };
        const raw = await withTimeout(
            vscode.commands.executeCommand(BRIDGE_CHALLENGE, request),
            5000,
            `routing challenge ${nonce}`
        );
        const response = parseRoutingResponse(raw);
        assertMatchingRoutingResponse(request, response);
        assertStableBridgeProcessId(seenBridgeProcessIds, response.bridgeProcessId);
        seenBridgeProcessIds.add(response.bridgeProcessId);
        completed += 1;
    });
    await Promise.all(batch);
}
```

Register the public commands without accepting arbitrary input:

```ts
context.subscriptions.push(
    vscode.commands.registerCommand('projectStewardAttentionSpike.startRouting', () => runRoutingChallenge(1000)),
    vscode.commands.registerCommand('projectStewardAttentionSpike.startSameWorkspaceRouting', () => runRoutingChallenge(200))
);
```

The final status schema is:

```ts
interface RoutingStatus {
    phase: 'routing';
    result: 'IDLE' | 'RUNNING' | 'PASS' | 'FAIL';
    workspaceProcessId: string;
    workspaceIdentity: string;
    remoteName: string;
    bridgeProcessIds: string[];
    attempted: number;
    completed: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
}
```

`projectStewardAttentionSpike.showStatus` must append exactly one line prefixed `ATTENTION_SPIKE_ROUTING_STATUS ` followed by JSON and reveal the Output channel.

### Step 4: Bundle both extensions

Create `spikes/attention-local-bridge/webpack.config.js` exporting two webpack configurations. Both use `target: 'node'`, externalize `vscode`, resolve `.ts` and `.js`, and point `ts-loader` at the spike `tsconfig.json`. Outputs are:

- `workspace/dist/extension.js`
- `ui-bridge/dist/extension.js`

Use `libraryTarget: 'commonjs2'`, production source maps off, and no other runtime dependencies.

### Step 5: Verify GREEN locally without installing

Run:

```bash
npm run spike:attention:test
npm run spike:attention:bundle
test -f spikes/attention-local-bridge/workspace/dist/extension.js
test -f spikes/attention-local-bridge/ui-bridge/dist/extension.js
npm run test:safety
git diff --check
git diff --cached --name-only
```

Expected: all checks exit 0; the final command prints nothing.

### Step 6: Review checkpoint

Show the user the Phase 1 source and manifests. Do not stage or commit them.

---

## Task 3: Package the probes and define a stale-build-safe installation flow

**Files:**

- Create: `spikes/attention-local-bridge/scripts/package.js`
- Create: `spikes/attention-local-bridge/MANUAL-MATRIX.md`
- Extend: `scripts/run-attention-local-bridge-spike-checks.js`

### Step 1: Add failing artifact checks

Add static checks that the package script names exactly these outputs:

```text
artifacts/project-steward-attention-ui-bridge-probe-0.0.2.vsix
artifacts/project-steward-attention-workspace-probe-0.0.2.vsix
```

Also assert that `MANUAL-MATRIX.md` contains the four labels `Local`, `Remote SSH`, `WSL`, and `Dev Container`, plus `same workspace`, `different Profile`, and the command `Developer: Show Running Extensions`.

Run `npm run spike:attention:test` and observe RED before creating these files.

### Step 2: Implement packaging

`package.js` must:

1. remove and recreate `spikes/attention-local-bridge/artifacts`;
2. invoke the repository's available `vsce` through `npx @vscode/vsce package` once in each extension directory;
3. pass an absolute `--out` path for the exact artifact names above;
4. inherit stdio and exit non-zero on any packaging failure;
5. print both artifact paths at the end.

Do not install automatically. The current environment may not expose the desktop `code` CLI, and the UI Bridge must be installed specifically in the local Extensions host.

### Step 3: Write the manual installation matrix

`MANUAL-MATRIX.md` must give this exact order for each fresh build:

1. Uninstall both prior probe extensions from every tested host, or bump both probe patch versions and artifact names.
2. In a local VS Code window, use **Extensions: Install from VSIX...** to install the UI Bridge artifact locally.
3. Open the target local/SSH/WSL/Dev Container fixture window.
4. Use **Extensions: Install from VSIX...** in that target window to install the Workspace Probe in the Workspace host.
5. Run **Developer: Show Running Extensions** and record that the UI Bridge is local while the Workspace Probe is local or remote as expected.
6. Reload the window only after both extensions are installed.
7. Run **Project Steward Attention Spike: Show Status** before starting a test and retain its JSON line.

It must also explain that unresolved `extensionDependencies` or activation on the wrong host is a spike failure, not something to work around by deleting the dependency.

### Step 4: Package and inspect

Run:

```bash
npm run spike:attention:package
unzip -l spikes/attention-local-bridge/artifacts/project-steward-attention-ui-bridge-probe-0.0.2.vsix
unzip -l spikes/attention-local-bridge/artifacts/project-steward-attention-workspace-probe-0.0.2.vsix
```

Verify each VSIX contains its own `extension/package.json` and `extension/dist/extension.js`, and contains no `.vscode/settings.json`, conversation data, or production `src/**` files.

### Step 5: Review checkpoint

Hand both VSIX paths and installation instructions to the user. Do not stage or commit.

---

## Task 4: Execute the Phase 1 routing hard gate

**Evidence files:**

- Create: `docs/superpowers/reports/evidence/2026-07-14-local-bridge-routing.jsonl`
- Create or update: `docs/superpowers/reports/2026-07-14-ai-session-attention-local-bridge-feasibility.md`

### Automation Harness Prerequisite

Before repeating the routing matrix, add a marker-gated harness to the
Workspace Probe only:

- create `spikes/attention-local-bridge/shared/autoRunControl.ts` with pure
  parsing, expiry, fixture matching, and deterministic result-name helpers;
- extend `scripts/run-attention-local-bridge-spike-checks.js` with RED/GREEN
  tests for missing/invalid/expired controls, nonmatching fixtures, valid
  controls, and traversal-safe result names;
- make the Workspace Probe read only
  `/tmp/project-steward-attention-routing-control.json` two seconds after
  activation;
- accept only protocol version `1`, a 32-lowercase-hex run ID, a future
  `expiresAtMs` no more than 30 minutes away, and one of two exact mode
  contracts: `routing` with total `1000` and fixture A+B, or
  `same-workspace-routing` with total `200` and fixture A only;
- run the existing single-flight routing operation only when the current
  canonical identity is listed;
- atomically write the final status beneath
  `/tmp/project-steward-attention-routing-results/<runId>/` using a sibling
  temporary file and rename; distinct-workspace filenames hash the identity,
  while same-workspace filenames hash identity plus Workspace process ID;
- skip an already existing result so Extension Host reconnects cannot replay a
  completed run;
- never read result files from either probe and never use them for routing or
  aggregation;
- bump the Workspace Probe and Workspace VSIX to `0.0.5`, and bump the UI
  Bridge to `0.0.3` because Phase 2 adds the snapshot protocol;
- install Workspace `0.0.5` through the remote `code-server --install-extension
  <absolute-vsix> --force`, restart only the two fixture Extension Hosts, and
  collect the two result files without user Command Palette interaction.

The automation harness must remain disposable and must be removed with the
rest of the spike after the retained feasibility report is accepted. It is not
Phase 2 storage and cannot satisfy any file-propagation gate.

### Step 1: Prepare distinct fixture windows

For each available environment, open two windows on distinct fixture workspaces and install the probes according to Task 3. Do not use this repository as both fixtures. Record:

- VS Code version and commit;
- OS and architecture;
- Profile name;
- `vscode.env.remoteName` from each routing status;
- Workspace and Bridge extension versions;
- **Developer: Show Running Extensions** host placement.

### Step 2: Run 1,000 challenges concurrently in both directions

In both windows, start **Project Steward Attention Spike: Start Routing Challenge** within ten seconds of each other. Wait for both commands to finish, then run **Show Status** in both windows.

Append each complete `ATTENTION_SPIKE_ROUTING_STATUS` JSON object to the evidence JSONL with these envelope fields:

```json
{"environment":"Local","fixture":"A","sameWorkspace":false,"capturedAt":"<ISO timestamp>","status":{}}
```

The actual `status` object must be copied intact from the probe; do not summarize it in the evidence file.

### Step 3: Run the same-workspace collision matrix

Open two additional windows on the same fixture workspace. In both windows run **Project Steward Attention Spike: Start Same-Workspace Routing Challenge**, which has a fixed count of 200. Require different Workspace and Bridge process IDs per window and one stable Bridge ID within each window.

### Step 4: Apply the hard gate independently to every environment

An environment passes only if every window reports:

- `result: "PASS"`;
- `attempted === completed`;
- exactly one Bridge process ID;
- no timeout, wrong Workspace process, identity mismatch, nonce mismatch, collision, or unstable Bridge mapping;
- distinct-workspace and same-workspace matrices both pass.

Run the matrix for:

- Local;
- Remote SSH;
- WSL;
- Dev Container.

Mark unavailable environments `NOT RUN` with a reason. Do not infer them from another remote type.

### Step 5: Stop or continue

If any executed environment fails, immediately:

1. write the report result as `FAIL`;
2. include the exact first error and evidence line;
3. state that Phase 2 was not implemented or run;
4. return to architecture design.

If any required environment is `NOT RUN`, write the current result as `INCOMPLETE`; Phase 2 may be developed only with explicit user approval, and overall feasibility cannot be `PASS`.

If all four environments pass, show the evidence and report section to the user. Proceed to Task 5 only after this review checkpoint. Do not stage or commit.

---

## Task 5: Add Phase 2's atomic profile-local snapshot bus

**Hard prerequisite:** Task 4 is PASS in all required environments, or the user explicitly authorizes partial Phase 2 work while the report remains INCOMPLETE.

**Files:**

- Create: `spikes/attention-local-bridge/shared/storeProtocol.ts`
- Create: `spikes/attention-local-bridge/ui-bridge/src/localStore.ts`
- Modify: `spikes/attention-local-bridge/ui-bridge/src/extension.ts`
- Modify: `spikes/attention-local-bridge/workspace/src/extension.ts`
- Modify: `spikes/attention-local-bridge/workspace/package.json`
- Extend: `scripts/run-attention-local-bridge-spike-checks.js`

### Step 1: Write failing store and aggregation checks

Add pure tests using a temporary directory. They must prove:

- snapshot schema rejects wrong protocol versions, invalid instance IDs, negative sequences, oversized files, and non-finite timestamps;
- `writeSnapshotAtomic` never leaves a partial final JSON file;
- three writers with distinct instance IDs cannot overwrite one another;
- scan returns the highest valid sequence per instance;
- a corrupt replacement does not erase the last valid in-memory snapshot before lease expiry;
- snapshots older than 90 seconds are inactive;
- sequences never decrease;
- latency summary uses one sample per newly observed peer sequence.

Run `npm run spike:attention:test`; expect RED because `storeProtocol` and `localStore` do not exist.

### Step 2: Define the snapshot schema

Use this complete on-disk shape:

```ts
export interface ProbeSnapshot {
    protocolVersion: 1;
    instanceId: string;
    workspaceProcessId: string;
    workspaceIdentity: string;
    sequence: number;
    sentAtMs: number;
    writtenAtMs: number;
    payload: string;
}
```

Validation limits are:

- IDs: 32 lowercase hex characters;
- workspace identity: 1-8192 characters;
- sequence: safe integer from 0 through `Number.MAX_SAFE_INTEGER`;
- timestamps: finite non-negative numbers;
- payload: 1-1024 characters;
- complete file: at most 256 KiB.

Store files at:

```text
<context.globalStorageUri.fsPath>/attention-local-bridge-spike/v1/instances/<instanceId>.json
```

Reject non-file `globalStorageUri` schemes and expose that as a FAIL status.

### Step 3: Implement one-writer atomic storage

`LocalStore.write(snapshot)` must:

1. create the `instances` directory recursively;
2. serialize and validate the complete snapshot;
3. write it to `<instanceId>.<bridgeProcessId>.<random>.tmp` with mode `0o600`;
4. close the file;
5. rename it over `<instanceId>.json`;
6. delete the temp file on failure without deleting the previous final file.

`LocalStore.scan(nowMs)` must:

- read only regular, non-symlink `^[a-f0-9]{32}\.json$` entries;
- skip files larger than 256 KiB;
- parse and validate each file independently;
- retain the previous valid cached value for a temporarily corrupt file until its 90-second lease expires;
- return active snapshots sorted by `instanceId`;
- report parse, size, symlink, read, rollback, and disappearance counters without throwing away other valid instances.

`LocalStore.removeOwnSnapshot()` deletes only the current instance's final file and ignores `ENOENT`.

### Step 4: Wire stress publication and aggregation commands

Add private commands:

```ts
const BRIDGE_PUBLISH = '_projectStewardAttentionSpike.bridge.publish';
const BRIDGE_STATUS = '_projectStewardAttentionSpike.bridge.status';
const BRIDGE_SET_WATCHER = '_projectStewardAttentionSpike.bridge.setWatcher';
const WORKSPACE_AGGREGATE = '_projectStewardAttentionSpike.workspace.aggregate';
```

Add Workspace Probe commands:

- `projectStewardAttentionSpike.startFileStress`
- `projectStewardAttentionSpike.stopFileStress`
- `projectStewardAttentionSpike.enableWatcher`
- `projectStewardAttentionSpike.disableWatcher`
- `projectStewardAttentionSpike.showFileStatus`
- `projectStewardAttentionSpike.clearLocalState`

Stress behavior:

- create one random `instanceId` on activation;
- publish immediately, then every two seconds;
- increment sequence once per publish;
- publish 300 state changes over ten minutes;
- keep a 30-second heartbeat after state changes finish without incrementing the semantic payload sequence;
- set payload to `${workspaceProcessId}:${sequence}`;
- stop and report the first command/write/schema error.

Bridge behavior:

- write only its window's `instanceId` file;
- scan every two seconds regardless of watcher activity;
- use `fs.watch` only as a latency accelerator;
- on a changed aggregate, invoke `WORKSPACE_AGGREGATE` in its own window;
- expose storage root, Bridge ID, scan counters, active instance count, and watcher enabled state through `BRIDGE_STATUS`;
- delete its own snapshot during normal `deactivate()`.

Workspace aggregate behavior:

- verify the reverse notification reached the expected Workspace process;
- track each peer's last sequence;
- record exactly one latency sample for each newly observed peer sequence;
- increment rollback if a peer sequence decreases;
- increment unexpected disappearance if a previously active peer vanishes while all three stress runs are expected active;
- retain only the most recent 2,000 latency samples in the status output while maintaining total sample count and P95/max over the full run.

### Step 5: Run unit and build verification

Run:

```bash
npm run spike:attention:test
npm run spike:attention:bundle
npm run test:safety
npm run webpack
git diff --check
git diff --cached --name-only
```

Expected: all checks exit 0 and the index remains empty.

### Step 6: Review checkpoint and repackage

Show the user the store tests and implementation. After approval, run `npm run spike:attention:package` and provide both fresh VSIX paths. Do not stage or commit.

---

## Task 6: Execute the Phase 2 file, lifecycle, Profile, and performance matrix

**Evidence files:**

- Create: `docs/superpowers/reports/evidence/2026-07-14-local-bridge-file-stress.jsonl`
- Update: `docs/superpowers/reports/2026-07-14-ai-session-attention-local-bridge-feasibility.md`

### Step 1: Prove shared storage and Profile isolation

In three windows using the same Profile, call **Show File Status** and require the exact same canonical storage root. In a fourth window using a different Profile, require a different canonical root. Record all four full statuses.

Failure conditions:

- same-Profile roots differ;
- different-Profile roots are equal;
- any root is remote rather than on the desktop UI host;
- a bridge reports a non-file storage URI.

### Step 2: Run the ten-minute, three-window stress test

Use three distinct windows in the chosen mixed-host matrix. Start file stress in all three within ten seconds. Run for at least ten minutes and at least 300 writes per window. Capture status at start, every minute, and finish.

PASS requires, in every window:

- all three active instance IDs are observed;
- at least 600 peer-sequence samples are observed across the other two writers;
- rollback, overwrite, disappearance, parse, schema, command, and write errors are all zero;
- P95 propagation latency is at most 3000 ms;
- maximum propagation latency is at most 5000 ms;
- each final instance file is no larger than 256 KiB.

### Step 3: Test watcher suppression

Disable the watcher in one receiving window while keeping its two-second scan active. Publish at least 30 additional peer sequences. Require convergence with P95 at most 3000 ms and max at most 5000 ms. Re-enable the watcher and record both status transitions.

### Step 4: Test normal and forced close

- **Normal close:** close one window normally and require its instance file to disappear promptly and the other windows to remove it on their next scan.
- **Forced close:** terminate another VS Code window/process without allowing extension deactivation. Require its file to remain initially but become inactive within 90 seconds plus one two-second scan interval. Record actual expiry latency.

Do not count these expected lifecycle removals as unexpected disappearance errors; arm the relevant lifecycle mode before closing.

### Step 5: Test reload and handshake recovery

Reload the remaining Bridge and Workspace Probe. Require:

- protocol version 1 handshake succeeds;
- a new process ID/instance ID publishes successfully;
- stale pre-reload state expires or is removed according to the normal-close path;
- other windows converge without manual file editing;
- no sequence rollback is reported across instance generations.

### Step 6: Record evidence without truncation

Append each status as one JSONL envelope containing environment, fixture, phase, captured timestamp, and the complete status. Keep aggregate latency arrays bounded in probe output but retain counters, P95, max, all error counters, roots, versions, and instance IDs.

### Step 7: Apply the gate

Any rollback, overwrite, state disappearance outside an armed lifecycle test, parse/write/command error, same-Profile root split, Profile isolation failure, P95 over 3 seconds, or max over 5 seconds makes Phase 2 FAIL. Stop further optimization and report the architecture failure as observed.

Show the complete Phase 2 evidence summary to the user. Do not stage or commit.

---

## Task 7: Write and independently verify the retained feasibility report

**Files:**

- Finalize: `docs/superpowers/reports/2026-07-14-ai-session-attention-local-bridge-feasibility.md`

### Step 1: Use a fixed report structure

The report must contain:

1. Decision: `PASS`, `FAIL`, or `INCOMPLETE`.
2. Exact source revision tested from `git rev-parse HEAD` plus a statement that the spike diff was uncommitted.
3. Probe versions and SHA-256 of both VSIX files.
4. VS Code version/commit, OS/architecture, Profile, and remote type for every window.
5. Phase 1 distinct-workspace and same-workspace results per environment.
6. Phase 2 shared-root and Profile-isolation results.
7. Ten-minute sample counts, writes per instance, P50/P95/max latency, error counters, and maximum file size.
8. Watcher-suppression, normal-close, forced-close, reload, and version-handshake results.
9. `NOT RUN` environments and reasons.
10. Exact first failure with evidence pointer if result is not PASS.
11. Recommendation: proceed to production plan only on PASS; otherwise return to architecture design.

### Step 2: Recompute evidence summaries

Add a read-only verification mode to `scripts/run-attention-local-bridge-spike-checks.js` that accepts both JSONL evidence paths, rejects malformed lines, recomputes sample/error totals, and exits non-zero if report gate claims disagree with raw evidence.

Run:

```bash
npm run spike:attention:test
node scripts/run-attention-local-bridge-spike-checks.js \
  docs/superpowers/reports/evidence/2026-07-14-local-bridge-routing.jsonl \
  docs/superpowers/reports/evidence/2026-07-14-local-bridge-file-stress.jsonl
sha256sum spikes/attention-local-bridge/artifacts/*.vsix
git diff --check
git status --short
git diff --cached --name-only
```

Expected: checks exit 0, the report numbers match evidence, and the index is empty.

### Step 3: User decision checkpoint

Present the report and raw evidence paths. Do not clean up, stage, commit, or begin production implementation until the user explicitly accepts the report.

---

## Task 8: Clean up the disposable probes only after report approval

**Files:**

- Delete: `spikes/attention-local-bridge/**`
- Delete spike-only logic from: `scripts/run-attention-local-bridge-spike-checks.js`
- Revert spike-only entries from: `package.json`
- Revert spike-only `"spikes"` exclusion from: `tsconfig.json`
- Revert spike-only `spikes/**` entry from: `.vscodeignore`
- Retain: `docs/superpowers/specs/2026-07-14-ai-session-attention-local-bridge-design.md`
- Retain: `docs/superpowers/plans/2026-07-14-ai-session-attention-local-bridge-feasibility.md`
- Retain: `docs/superpowers/reports/2026-07-14-ai-session-attention-local-bridge-feasibility.md`
- Retain evidence only if the user requests raw logs remain in the repository.

### Step 1: Obtain explicit approval

Ask the user whether to retain raw evidence JSONL in Git. Do not infer this choice and do not delete the probes before the report has been reviewed.

### Step 2: Remove only disposable spike artifacts

Use `apply_patch` for tracked text changes and remove generated `out`, `dist`, `artifacts`, and probe VSIX files. Do not touch the stable root `project-steward-1.1.8.vsix` or `.vscode/settings.json`.

### Step 3: Verify the stable production extension remains unchanged

Run:

```bash
npm run test:safety
npm run webpack
npm run test:release-notes
git diff --check
git status --short
git diff --cached --name-only
```

Expected: production tests and bundle pass, no spike source/build artifacts remain, the retained documents are present, the user's `.vscode/settings.json` remains untouched, and the index is empty.

### Step 4: Final review checkpoint

Give the user the final diff and verification output. Wait for explicit authorization before any commit or push.
