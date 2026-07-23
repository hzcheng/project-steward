# Regression CI and Test Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze Project Steward's confirmed behavior in a traceable contract catalog, migrate regression coverage into stable layered tests, and enforce Linux, Windows, and real-tmux pull-request gates that are reused by releases.

**Architecture:** A machine-readable behavior catalog maps stable behavior IDs to Node test files or documented environment scenarios. Deterministic unit, contract, and integration tests run against compiled modules with injected fakes; a small number of source guards and real tmux/Extension Host checks protect boundaries that cannot be proven at a lower layer. Reusable GitHub Actions jobs apply lint and coverage ratchets and prevent PR/release verification drift.

**Tech Stack:** TypeScript 4.0, Node.js 22.12+, built-in `node:test`, `assert`, c8 12.0.0, TSLint 6, Webpack 5, VS Code Extension API, GitHub Actions, tmux.

**Design:** `docs/superpowers/specs/2026-07-22-regression-ci-and-test-architecture-design.md`

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-refactor-and-ci` on `feat/refactor-and-ci`.
- Do not change command IDs, configuration keys, persisted data formats, protocol versions, extension IDs, or user-visible behavior.
- Node 22 is the test/CI runtime and does not change the VS Code runtime compatibility target.
- Do not modernize TypeScript, replace TSLint, upgrade the VS Code engine, or upgrade unrelated dependencies in this plan.
- Tests must never read real Codex, Kimi, or Claude session directories.
- Every test must isolate and clean timers, watchers, terminals, temporary directories, child processes, and tmux resources that it owns.
- Preserve existing safety checks until an equivalent behavior-ID test has passed alongside them and a controlled negative check proves that the replacement catches the same regression.
- Source checks may remain only for documented architectural prohibitions, not ordinary function names, file locations, or formatting.
- Use exact path staging and make one intentional commit per task.
- Before every completion claim, run the task's fresh verification commands and inspect their exit codes.

---

## Program Decomposition

The design spans four reviewable subsystems. Tasks 1-2 establish the shared foundation; Tasks 3-7 migrate behavior domains; Tasks 8-12 establish quality and environment gates; Tasks 13-14 remove obsolete checks and verify the complete program. Do not begin a later subsystem before its consumed interfaces exist.

## File Structure

### Shared behavior and test infrastructure

- `docs/testing/behavior-contracts.json`: authoritative behavior IDs, priorities, verification status, evidence, and test/manual owners.
- `docs/testing/README.md`: editing rules, ID naming, bug-regression workflow, and commands.
- `scripts/lib/behaviorCatalog.js`: catalog parsing and validation library.
- `scripts/check-behavior-contracts.js`: CLI that rejects duplicate, malformed, missing, or unreferenced behavior entries.
- `tests/helpers/fakeClock.js`: deterministic clock/timer ownership.
- `tests/helpers/tempDirectory.js`: repository-independent temporary fixtures and cleanup.
- `tests/helpers/fakeVscode.js`: minimal VS Code API fakes used by controllers.
- `tests/helpers/providerContract.js`: common Codex/Kimi/Claude contract suite.
- `tests/helpers/runtimeContract.js`: common Direct/tmux runtime contract suite.
- `tests/fixtures/`: minimal synthetic project, provider, lifecycle, protocol, and persistence fixtures.

### Behavior suites

- `tests/unit/projects/*.test.js`: path, ordering, favorites, workspace, and matching behavior.
- `tests/unit/todos/*.test.js`: normalization, ordering, search, and migration behavior.
- `tests/unit/aiSessions/*.test.js`: lifecycle, commands, attention, projection, and bounded I/O behavior.
- `tests/contract/projects/*.test.js`: project controller contracts.
- `tests/contract/openProjects/*.test.js`: protocol, bridge, projection, coordinator, and controller contracts.
- `tests/contract/aiSessions/*.test.js`: provider, controller, store, runtime, and attention contracts.
- `tests/integration/dashboard/*.test.js`: host routing, incremental refresh, startup/lifecycle, and Webview state flow.
- `tests/platform/windows/*.test.js`: drive paths, remote URIs, PowerShell/cmd quoting, and Windows-specific workspace behavior.

### Quality and CI

- `.ci/tslint-warning-baseline.json`: warning counts keyed by repository-relative file and TSLint rule.
- `.ci/coverage-baseline.json`: Linux Node 22 line, branch, function, and statement percentages.
- `scripts/check-tslint-baseline.js`: compares current JSON-formatted TSLint output with the warning baseline.
- `scripts/check-coverage-baseline.js`: compares c8's `coverage-summary.json` with the coverage baseline.
- `.github/workflows/verify.yml`: pull-request/protected-branch entry point and reusable Linux/Windows/tmux verification workflow, with concurrency cancellation on direct runs.
- `.github/workflows/scheduled-verification.yml`: macOS and stable Extension Host scheduled checks.
- `.github/workflows/release-vsix.yml`: existing release workflow updated to require reusable verification.

---

### Task 1: Create the Behavior Contract Catalog and Validator

**Files:**
- Create: `docs/testing/behavior-contracts.json`
- Create: `docs/testing/README.md`
- Create: `scripts/lib/behaviorCatalog.js`
- Create: `scripts/check-behavior-contracts.js`
- Create: `tests/unit/tooling/behaviorCatalog.test.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-ai-session-tmux-checks.js`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `loadBehaviorCatalog(filePath): BehaviorContract[]`
- Produces: `validateBehaviorCatalog(entries, options): string[]`, where `options.repositoryRoot` is absolute.
- Produces: `npm run test:behavior-contracts`.
- Consumes: repository-relative automated test/manual-document paths.

- [ ] **Step 1: Write validator tests that fail because the library does not exist**

Create `tests/unit/tooling/behaviorCatalog.test.js` using `node:test`. Cover a valid entry, duplicate IDs, invalid ID shape, an automated entry whose test file does not exist, an automated test that does not contain its ID, and a manual entry without `manualReason`.

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateBehaviorCatalog } = require('../../../scripts/lib/behaviorCatalog');

test('CATALOG-INTEGRITY-001 accepts a referenced automated behavior', t => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'behavior-catalog-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const testPath = path.join(root, 'tests', 'unit', 'sample.test.js');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "test('PROJECT-PATH-001 normalizes paths', () => {});\n");
    const errors = validateBehaviorCatalog([{
        id: 'PROJECT-PATH-001', domain: 'project', title: 'Normalize saved paths',
        priority: 'P0', status: 'automated', owners: ['tests/unit/sample.test.js'],
        evidence: ['src/projects/projectPathUtils.ts'],
    }], { repositoryRoot: root });
    assert.deepEqual(errors, []);
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `node --test tests/unit/tooling/behaviorCatalog.test.js`

Expected: FAIL with `Cannot find module '../../../scripts/lib/behaviorCatalog'`.

- [ ] **Step 3: Implement the validator and CLI**

`validateBehaviorCatalog` must enforce `^[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}$`, unique IDs, allowed domains (`project`, `todo`, `open-project`, `webview`, `session`, `runtime`, `attention`, `persistence`, `error`, `release`, `architecture`), `P0|P1|P2`, `automated|scheduled|manual`, at least one evidence path, existing owner paths, ID references in automated owner files, and non-empty manual reasons. The CLI loads `docs/testing/behavior-contracts.json`, prints one error per line, and exits 1 on any error.

Start the catalog with explicit entries covering every existing `run*Checks` group in the four legacy scripts. Use ID prefixes `PROJECT`, `TODO`, `OPEN`, `WEBVIEW`, `SESSION`, `RUNTIME`, `ATTENTION`, `PERSIST`, `ERROR`, `RELEASE`, and `ARCH`. Add the assigned ID as a comment immediately above each legacy `run*Checks` function so the automated owner-reference validation is real. Initially point `owners` at the legacy script that executes the behavior; later tasks replace those owners with focused tests.

- [ ] **Step 4: Add package scripts**

Add:

```json
"test:behavior-contracts": "node --test tests/unit/tooling/behaviorCatalog.test.js && node scripts/check-behavior-contracts.js"
```

- [ ] **Step 5: Verify GREEN and catalog completeness**

Run: `npm run test:behavior-contracts`

Expected: PASS and `Behavior contract catalog checks passed.`

Run: `node -e "const c=require('./docs/testing/behavior-contracts.json'); const d=new Set(c.map(x=>x.domain)); console.log(c.length,[...d].sort())"`

Expected: a non-zero entry count and all eleven required prefixes represented by their corresponding domains.

- [ ] **Step 6: Commit**

```bash
git add docs/testing scripts/lib/behaviorCatalog.js scripts/check-behavior-contracts.js tests/unit/tooling/behaviorCatalog.test.js scripts/run-ai-session-safety-checks.js scripts/run-ai-session-tmux-checks.js scripts/run-open-project-safety-checks.js scripts/run-dashboard-webview-checks.js package.json
git commit -m "test: add behavior contract catalog"
```

---

### Task 2: Add the Node Test Harness and Isolation Helpers

**Files:**
- Create: `tests/helpers/tempDirectory.js`
- Create: `tests/helpers/fakeClock.js`
- Create: `tests/helpers/fakeVscode.js`
- Create: `tests/unit/tooling/testHelpers.test.js`
- Create: `tests/unit/projects/projectPathUtils.test.js`
- Create: `tests/contract/openProjects/protocol.test.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `makeTempDirectory(testContext, prefix): string`.
- Produces: `createFakeClock(startMs)` with `nowMs`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `advanceBy`, and `pendingCount`.
- Produces: `createFakeVscode(overrides)` returning only explicitly requested API surfaces and call logs.
- Produces: `test:unit`, `test:contract`, `test:integration`, and `test:deterministic` scripts.

- [ ] **Step 1: Write RED helper ownership tests**

Create tests proving a temp root exists during the test and is removed by `t.after`, and proving fake-clock callbacks run in timestamp/insertion order while cleared handles never run.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/tooling/testHelpers.test.js`

Expected: FAIL because helper modules do not exist.

- [ ] **Step 3: Implement helpers**

Use `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`; register `fs.rmSync(root, { recursive: true, force: true })` through `t.after`. The fake clock must allocate monotonically increasing numeric handles and repeatedly execute due interval callbacks until the requested target time.

- [ ] **Step 4: Add first behavior-ID unit and contract tests**

In `projectPathUtils.test.js`, parameterize `normalizePosixPath`, `getPathMatchScore`, `normalizeRemoteAuthority`, and `encodeRemoteAuthority` with `PROJECT-PATH-001` through `PROJECT-PATH-004`. In `protocol.test.js`, cover valid publication round-trip, exact-key rejection, duplicate instance rejection, maximum record count, semantic revision stability, and reordered-registration stability using `OPEN-PROTOCOL-001` through `OPEN-PROTOCOL-006`.

- [ ] **Step 5: Add deterministic scripts**

Add:

```json
"test:unit": "npm run test-compile && node --test tests/unit",
"test:contract": "npm run test-compile && npm run attention:bridge:compile && node --test --test-concurrency=1 tests/contract",
"test:integration": "npm run test-compile && npm run attention:bridge:compile && node --test --test-concurrency=1 tests/integration",
"test:deterministic": "npm run test:unit && npm run test:contract && npm run test:integration"
```

- [ ] **Step 6: Replace catalog owners for migrated IDs and verify**

Run: `npm run test:deterministic && npm run test:behavior-contracts`

Expected: all focused tests pass; catalog validation confirms the new owner files contain their IDs.

- [ ] **Step 7: Commit**

```bash
git add tests package.json docs/testing/behavior-contracts.json
git commit -m "test: establish isolated node test harness"
```

---

### Task 3: Migrate Project, TODO, and Webview Behavior

**Files:**
- Create: `tests/unit/projects/orderAndFavorites.test.js`
- Create: `tests/unit/projects/workspaceAndOpenMatching.test.js`
- Create: `tests/unit/todos/types.test.js`
- Create: `tests/contract/projects/controllers.test.js`
- Create: `tests/contract/todos/service.test.js`
- Create: `tests/integration/dashboard/webviewState.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: `createFakeClock`, `createFakeVscode`, compiled `out/projects`, `out/todos`, and `out/webview` exports.
- Produces: focused owners for every Project/TODO/Webview legacy behavior ID.

- [ ] **Step 1: Add RED parameterized tests for Project behavior**

Cover favorite ordering, drag ordering, group mutation, add-from-folder, current workspace matching, local/workspace/SSH/WSL/Dev Container URI matching, new-window modifiers, duplicates, and cancellation. Each test name contains its catalog ID.

- [ ] **Step 2: Run Project tests and record RED causes**

Run: `npm run test-compile && node --test tests/unit/projects tests/contract/projects`

Expected: failures identify missing exports or hidden VS Code/filesystem dependencies, not changed expected behavior.

- [ ] **Step 3: Build focused harnesses from existing public seams**

Instantiate the existing exported controllers with their option interfaces, use `createFakeVscode` for VS Code calls, and evaluate existing Webview scripts in the same isolated VM style used by `run-dashboard-webview-checks.js`. Do not modify production modules in this task.

- [ ] **Step 4: Add RED TODO and Webview state tests**

Cover V1 normalization, migration, priority/insertion ordering, backend switching barrier, mutation serialization, search/reveal, edit reset, compose pending state, OPEN/PROJECTS/TODO tab preservation, stale sequence rejection, missing target fallback, and drag interaction state.

- [ ] **Step 5: Implement only required seams and verify GREEN**

Run: `npm run test:deterministic && npm run test:dashboard && npm run test:safety`

Expected: new suites and all legacy checks pass.

- [ ] **Step 6: Perform controlled negative checks**

Temporarily reverse favorite ordering and disable stale Webview sequence rejection, run the two focused tests, and confirm both fail. Restore production files and rerun the focused tests to PASS.

- [ ] **Step 7: Update catalog owners and commit**

```bash
git add tests docs/testing/behavior-contracts.json
git commit -m "test: freeze project todo and webview behavior"
```

---

### Task 4: Migrate Open Project and Cross-Window Behavior

**Files:**
- Create: `tests/contract/openProjects/projection.test.js`
- Create: `tests/contract/openProjects/bridgeClient.test.js`
- Create: `tests/contract/openProjects/workspaceController.test.js`
- Create: `tests/contract/openProjects/dashboardController.test.js`
- Create: `tests/contract/openProjects/coordinator.test.js`
- Create: `tests/integration/dashboard/openProjectFlow.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: fake clock, fake VS Code, synthetic bridge store, protocol fixtures.
- Produces: focused owners for all `run*Checks` groups in `run-open-project-safety-checks.js`.

- [ ] **Step 1: Write RED protocol-to-dashboard flow tests**

Cover publication sequence, focus ordering, lease expiry, duplicate windows, remote identity, current-card exclusion, semantic revision suppression, delivery failure fallback, and stale aggregate rejection.

- [ ] **Step 2: Run RED**

Run: `npm run test-compile && npm run attention:bridge:compile && node --test --test-concurrency=1 tests/contract/openProjects tests/integration/dashboard/openProjectFlow.test.js`

Expected: focused failures reveal any clock/store/bridge dependencies that are still implicit.

- [ ] **Step 3: Construct deterministic bridge/controller harnesses**

Use the existing `nowMs`, scheduler, command registration, and store dependencies already exercised by `run-open-project-safety-checks.js`. Move those fake implementations into focused helpers without changing production modules.

- [ ] **Step 4: Verify new and legacy suites together**

Run: `npm run test:contract && npm run test:integration && npm run test:open-projects`

Expected: PASS.

- [ ] **Step 5: Negative-check lease expiry and semantic revision**

Temporarily make expired registrations survive and include lease timestamps in semantic revision; each focused test must fail. Restore and rerun to PASS.

- [ ] **Step 6: Update owners and commit**

```bash
git add tests/contract/openProjects tests/integration/dashboard/openProjectFlow.test.js docs/testing/behavior-contracts.json
git commit -m "test: freeze open project cross-window behavior"
```

---

### Task 5: Add the Three-Provider Contract Matrix

**Files:**
- Create: `tests/helpers/providerContract.js`
- Create: `tests/fixtures/providers/codex/`
- Create: `tests/fixtures/providers/kimi/`
- Create: `tests/fixtures/providers/claude/`
- Create: `tests/contract/aiSessions/providers.test.js`
- Create: `tests/unit/aiSessions/lifecycle.test.js`
- Create: `tests/unit/aiSessions/commandBuilders.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces: `defineProviderContract({ id, serviceFactory, fixtures, definition })`.
- Consumes: `AiSessionProviderDefinition`, provider services, lifecycle parsers, and command builders.

- [ ] **Step 1: Write RED common provider contract tests**

For each provider assert stable ID/label, project session keys, bounded scanning, unavailable mapping, session ordering, project filtering, archive capability, resume/new launch specs, terminal markers, lifecycle Running/Waiting/Completed/Stopped signals, and malformed fixture isolation.

- [ ] **Step 2: Run RED for all providers**

Run: `npm run test-compile && node --test tests/contract/aiSessions/providers.test.js tests/unit/aiSessions/lifecycle.test.js tests/unit/aiSessions/commandBuilders.test.js`

Expected: contract output names the provider and behavior ID for every failure.

- [ ] **Step 3: Move synthetic fixtures out of the legacy script**

Copy only minimal, invented records needed by each assertion. Replace usernames, absolute home paths, prompts, and message contents with deterministic values under `/fixtures/project` or `C:\\fixtures\\project`.

- [ ] **Step 4: Add Windows command cases**

Cover quotes, spaces, ampersands, percent signs, empty values, marker paths, and PowerShell single quotes for all three providers under `tests/platform/windows/commandBuilders.test.js`.

- [ ] **Step 5: Verify new and legacy suites**

Run: `npm run test:unit && npm run test:contract && npm run test:safety`

Expected: PASS.

- [ ] **Step 6: Negative-check provider symmetry**

Temporarily remove Kimi's resume builder and change Claude completion parsing; the matching provider contract cases must fail while identifying `kimi` and `claude`. Restore and rerun to PASS.

- [ ] **Step 7: Update owners and commit**

```bash
git add tests/helpers/providerContract.js tests/fixtures/providers tests/contract/aiSessions tests/unit/aiSessions tests/platform/windows docs/testing/behavior-contracts.json
git commit -m "test: enforce ai provider behavior contracts"
```

---

### Task 6: Migrate Runtime, tmux, and Attention Contracts

**Files:**
- Create: `tests/helpers/runtimeContract.js`
- Create: `tests/contract/aiSessions/runtimeBackends.test.js`
- Create: `tests/contract/aiSessions/runtimeCoordinator.test.js`
- Create: `tests/contract/aiSessions/tmuxStore.test.js`
- Create: `tests/contract/aiSessions/tmuxDiscovery.test.js`
- Create: `tests/contract/aiSessions/attention.test.js`
- Create: `tests/integration/dashboard/sessionRuntimeFlow.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces: `defineRuntimeContract({ backendId, layout, createHarness })`.
- Consumes: fake clock, fake tmux client, fake terminal factory, synthetic stores, and provider contract fixtures.

- [ ] **Step 1: Write RED Direct/tmux parameter matrix**

Execute create, resume, reuse, attach, detach, complete, stop, stale, collision, conflict, unavailable, concurrent ensure, and pending-promotion behavior against Direct, tmux project layout, and tmux session layout as applicable.

- [ ] **Step 2: Add RED attention lifecycle matrix**

Cover Running, Waiting, Completed, Stopped, owner snapshots, aggregation, acknowledgement, retention, duplicate/old events, tombstone reactivation, bridge reconnect, privacy redaction, and runtime handoff for Codex/Kimi/Claude.

- [ ] **Step 3: Run RED**

Run: `npm run test-compile && node --test --test-concurrency=1 tests/contract/aiSessions/runtimeBackends.test.js tests/contract/aiSessions/runtimeCoordinator.test.js tests/contract/aiSessions/tmuxStore.test.js tests/contract/aiSessions/tmuxDiscovery.test.js tests/contract/aiSessions/attention.test.js tests/integration/dashboard/sessionRuntimeFlow.test.js`

Expected: failures expose any remaining real clock/process/terminal dependencies.

- [ ] **Step 4: Reuse existing injected runtime seams**

Extract the fake clock, scheduler, process lookup, filesystem, terminal factory, and tmux runner already embedded in the legacy scripts into `tests/helpers/runtimeContract.js`. Do not modify production runtime modules in this task.

- [ ] **Step 5: Verify new and legacy suites**

Run: `npm run test:contract && npm run test:integration && npm run test:tmux && npm run test:safety`

Expected: PASS.

- [ ] **Step 6: Perform controlled runtime negative checks**

Disable single-flight runtime creation, accept an old attention event, and acknowledge attention on terminal close. Each matching behavior-ID test must fail. Restore and rerun to PASS.

- [ ] **Step 7: Update owners and commit**

```bash
git add tests/helpers/runtimeContract.js tests/contract/aiSessions tests/integration/dashboard/sessionRuntimeFlow.test.js docs/testing/behavior-contracts.json
git commit -m "test: freeze runtime and attention behavior"
```

---

### Task 7: Cover Persistence, Corruption, and Error Boundaries

**Files:**
- Create: `tests/contract/persistence/stores.test.js`
- Create: `tests/contract/persistence/migrations.test.js`
- Create: `tests/contract/errors/failureMapping.test.js`
- Create: `tests/integration/dashboard/errorRecovery.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: temp directory, fake clock, fake VS Code, provider/runtime fakes.
- Produces: focused `PERSIST-*` and `ERROR-*` behavior owners.

- [ ] **Step 1: Write RED persistence cases**

Cover valid, legacy, missing-field, corrupt, oversized, duplicate, conflicting, partially written, and stale data for project, TODO, alias, pin, terminal binding, tmux binding, attention, and open-project stores.

- [ ] **Step 2: Write RED failure mapping cases**

Cover unreadable files, missing executables, permission failures, timeouts, malformed tmux output, bridge delivery failure, invalid Webview messages, disappearing runtime resources, and user cancellation. Assert safe state and redacted diagnostics.

- [ ] **Step 3: Run RED with isolated existing seams**

Run: `npm run test-compile && node --test --test-concurrency=1 tests/contract/persistence tests/contract/errors tests/integration/dashboard/errorRecovery.test.js`

Expected: RED because the new expected-behavior assertions are not yet represented in focused suites; the harness uses the same injected stores, clocks, and controller options as the legacy checks and does not modify production modules.

- [ ] **Step 4: Verify GREEN with the full deterministic and legacy suites**

Run: `npm run test:deterministic && npm run test:safety && npm run test:dashboard`

Expected: PASS.

- [ ] **Step 5: Update catalog and commit**

```bash
git add tests/contract/persistence tests/contract/errors tests/integration/dashboard/errorRecovery.test.js docs/testing/behavior-contracts.json
git commit -m "test: cover persistence and failure recovery"
```

---

### Task 8: Enforce the TSLint Warning Ratchet

**Files:**
- Create: `.ci/tslint-warning-baseline.json`
- Create: `scripts/check-tslint-baseline.js`
- Create: `tests/unit/tooling/tslintBaseline.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `summarizeFailures(failures, root): Record<string, Record<string, number>>`.
- Produces: `compareWarningBaseline(baseline, current): string[]`.
- Produces: `npm run lint:ci`.

- [ ] **Step 1: Write RED comparison tests**

Assert that moved line numbers do not fail, a new rule/file pair fails, increased counts fail, decreased counts pass, and absolute paths are converted to repository-relative POSIX paths.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/tooling/tslintBaseline.test.js`

Expected: FAIL because `check-tslint-baseline.js` does not exist.

- [ ] **Step 3: Implement JSON formatter parsing and comparison**

Invoke `node_modules/.bin/tslint -p ./ -t json`, parse the JSON array, count `ruleName` values by relative `name`, compare against `.ci/tslint-warning-baseline.json`, and print every increase as `file rule baseline=current`.

- [ ] **Step 4: Generate and verify the initial baseline**

Run: `node scripts/check-tslint-baseline.js --write-baseline`

Expected: creates sorted, two-space-indented `.ci/tslint-warning-baseline.json`.

Run: `node scripts/check-tslint-baseline.js`

Expected: `TSLint warning baseline checks passed.`

- [ ] **Step 5: Add package script and negative-check**

Add `"lint:ci": "node scripts/check-tslint-baseline.js"`. Temporarily decrement one committed baseline count, run `npm run lint:ci`, and confirm failure; restore and confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add .ci/tslint-warning-baseline.json scripts/check-tslint-baseline.js tests/unit/tooling/tslintBaseline.test.js package.json
git commit -m "ci: prevent new tslint warnings"
```

---

### Task 9: Establish the Coverage Ratchet

**Files:**
- Create: `.ci/coverage-baseline.json`
- Create: `scripts/check-coverage-baseline.js`
- Create: `tests/unit/tooling/coverageBaseline.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `readCoverageTotals(summary): { lines, branches, functions, statements }`.
- Produces: `compareCoverageBaseline(baseline, current): string[]`.
- Produces: `npm run test:coverage:run`, `npm run test:coverage`, and `npm run test:coverage:ci`.

- [ ] **Step 1: Install the pinned coverage tool**

Run: `npm install --save-dev --save-exact c8@12.0.0`

Expected: `package.json` and `package-lock.json` contain exactly `12.0.0`; no unrelated direct dependency changes.

- [ ] **Step 2: Write RED baseline comparison tests**

Cover equal values, increases, a 0.01 decrease in each metric, malformed summary input, and a missing `total` entry.

- [ ] **Step 3: Implement comparison and scripts**

Add:

```json
"test:coverage:run": "c8 --clean --reporter=text --reporter=json-summary node --test --test-concurrency=1 tests/unit tests/contract tests/integration",
"test:coverage": "npm run test-compile && npm run attention:bridge:compile && npm run test:coverage:run",
"test:coverage:ci": "npm run test:coverage && node scripts/check-coverage-baseline.js"
```

The checker reads `coverage/coverage-summary.json`, rounds all metrics to two decimals, and supports `--write-baseline` only when `CI` is not set.

- [ ] **Step 4: Generate fixed Linux baseline in a clean Node 22.12 environment**

Run the command below from a shell whose `node --version` is `v22.12.x`:

```bash
npm run test:coverage
node scripts/check-coverage-baseline.js --write-baseline
```

Expected: `.ci/coverage-baseline.json` contains four numeric percentages from `total`.

- [ ] **Step 5: Negative-check and verify**

Temporarily increase the stored line baseline by 0.01; `node scripts/check-coverage-baseline.js` must fail. Restore and run `npm run test:coverage:ci` to PASS.

- [ ] **Step 6: Commit**

```bash
git add .ci/coverage-baseline.json scripts/check-coverage-baseline.js tests/unit/tooling/coverageBaseline.test.js package.json package-lock.json
git commit -m "ci: enforce test coverage ratchet"
```

---

### Task 10: Add Reusable Linux and Windows CI Gates

**Files:**
- Create: `.github/workflows/verify.yml`
- Create: `tests/platform/windows/projectPaths.test.js`
- Modify: `package.json`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces stable jobs `quality-linux` and `platform-windows`.
- Produces scripts `test:ci:linux` and `test:ci:windows`.

- [ ] **Step 1: Add workflow contract checks before workflow files exist**

Extend `scripts/run-release-packaging-checks.js` to require `verify.yml`, stable job IDs, `contents: read`, Node `22.12.0`, `npm ci`, no `continue-on-error`, pull-request/push/workflow-call triggers, and PR concurrency cancellation.

- [ ] **Step 2: Run RED**

Run: `npm run test:release-packaging`

Expected: FAIL because reusable CI workflows do not exist.

- [ ] **Step 3: Add optimized package scripts**

Split existing scripts into compile wrappers and no-compile runners without changing their public behavior:

```json
"test:safety:run": "node scripts/run-ai-session-tmux-checks.js && node scripts/run-ai-session-safety-checks.js && node scripts/run-open-project-safety-checks.js",
"test:dashboard:run": "node scripts/run-dashboard-webview-checks.js",
"test:deterministic:run": "node --test tests/unit && node --test --test-concurrency=1 tests/contract && node --test --test-concurrency=1 tests/integration",
"test:ci:linux": "npm run test-compile && npm run attention:bridge:compile && npm run test:behavior-contracts && npm run lint:ci && npm run test:deterministic:run && npm run test:safety:run && npm run test:dashboard:run && npm run test:architecture-baseline && npm run test:release-notes && npm run test:release-packaging && npm run vscode:prepublish && npm run test:coverage:run && node scripts/check-coverage-baseline.js",
"test:ci:windows": "npm run test-compile && npm run attention:bridge:compile && node --test tests/unit/projects/projectPathUtils.test.js tests/unit/aiSessions/commandBuilders.test.js tests/platform/windows"
```

Keep `test:safety`, `test:dashboard`, and `test:deterministic` as compile-then-run developer wrappers. Linux CI compiles main and bridge once, then uses only the `:run` variants. Windows compiles and runs path/command tests without tmux.

- [ ] **Step 4: Create reusable workflow and PR entry point**

`verify.yml` supports `pull_request`, pushes to `main`, `workflow_dispatch`, and `workflow_call`. Use `ubuntu-latest` for `quality-linux`, `windows-latest` for `platform-windows`, `actions/checkout@v4`, `actions/setup-node@v4` with `22.12.0` and npm cache, `permissions: contents: read`, and `timeout-minutes: 10`. Use `concurrency.group: verify-${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`; direct PR runs therefore expose the exact stable job names `quality-linux` and `platform-windows`.

- [ ] **Step 5: Verify locally and validate YAML contracts**

Run: `npm run test:ci:linux`

Expected: PASS within five minutes.

Run: `npm run test:release-packaging`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/verify.yml tests/platform/windows package.json docs/testing/behavior-contracts.json scripts/run-release-packaging-checks.js
git commit -m "ci: add linux and windows pull request gates"
```

---

### Task 11: Add the Required Real-tmux Gate

**Files:**
- Modify: `.github/workflows/verify.yml`
- Modify: `scripts/run-ai-session-tmux-smoke-checks.js`
- Modify: `scripts/run-release-packaging-checks.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces stable job `tmux-smoke-linux`.
- Consumes existing `npm run test:tmux:smoke` and isolated tmux ownership rules.

- [ ] **Step 1: Add RED workflow source contracts**

Require `tmux-smoke-linux`, Ubuntu, `sudo apt-get install -y tmux`, `npm ci`, `npm run test:tmux:smoke`, and a ten-minute timeout.

- [ ] **Step 2: Strengthen smoke cleanup assertions**

Add a behavior-ID case proving the harness kills its unique server, verifies `list-sessions` no longer succeeds, and removes only the validated `TMUX_TMPDIR` it created. Ensure cleanup runs from `finally` and reports cleanup failures together with the primary failure.

- [ ] **Step 3: Run local tmux smoke twice**

Run: `npm run test:tmux:smoke && npm run test:tmux:smoke`

Expected: both PASS with distinct server names and no owned socket/temp roots remaining.

- [ ] **Step 4: Add the reusable workflow job and verify contracts**

Run: `npm run test:release-packaging`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/verify.yml scripts/run-ai-session-tmux-smoke-checks.js scripts/run-release-packaging-checks.js docs/testing/behavior-contracts.json
git commit -m "ci: require isolated tmux smoke checks"
```

---

### Task 12: Reuse Verification for Scheduled and Release Workflows

**Files:**
- Create: `.github/workflows/scheduled-verification.yml`
- Modify: `.github/workflows/release-vsix.yml`
- Modify: `scripts/run-release-packaging-checks.js`
- Modify: `docs/manual-tests/ai-session-tmux-runtime.md`
- Create: `docs/manual-tests/cross-platform-remote-matrix.md`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces scheduled macOS deterministic verification.
- Makes release job depend on reusable core verification.
- Produces versioned manual ownership for SSH, WSL, Dev Container, multi-window, and visual-only behavior IDs.

- [ ] **Step 1: Write RED release/schedule contracts**

Require `scheduled-verification.yml` with `schedule` and `workflow_dispatch`, `macos-latest`, Node `22.12.0`, deterministic tests, and artifact-free `contents: read`. Require release verification to complete before the existing write-permission release job.

- [ ] **Step 2: Run RED**

Run: `npm run test:release-packaging`

Expected: FAIL because the schedule and release dependency are absent.

- [ ] **Step 3: Create the scheduled workflow**

Run macOS compile, behavior catalog, deterministic tests, lint ratchet, and release packaging checks weekly and on manual dispatch. Set `timeout-minutes: 15` and do not use secrets or write permissions.

- [ ] **Step 4: Update release workflow**

Add a verification job that calls `./.github/workflows/verify.yml`; make the existing release job use `needs: verify`. Keep `contents: write` scoped to the release job and preserve current tag/version/VSIX behavior.

- [ ] **Step 5: Document manual scenarios**

For every manual behavior entry, record exact prerequisites, steps, expected results, environment fields, execution date, and evidence location. Cover two local windows, same-workspace windows, SSH, WSL, Dev Container, UI attention visuals, terminal focus, and sleep/disconnect recovery.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:release-packaging && npm run test:behavior-contracts`

Expected: PASS.

```bash
git add .github/workflows/scheduled-verification.yml .github/workflows/release-vsix.yml scripts/run-release-packaging-checks.js docs/manual-tests docs/testing/behavior-contracts.json
git commit -m "ci: reuse verification for schedules and releases"
```

---

### Task 13: Retire Replaced Source Checks and Split Remaining Guards

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-ai-session-tmux-checks.js`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Create: `scripts/run-architecture-guards.js`
- Modify: `package.json`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces: `npm run test:architecture-guards` containing only documented prohibitions.
- Removes behavior assertions only after their behavior-ID replacements pass.

- [ ] **Step 1: Build a migration ledger from catalog owners**

Run a script/query that lists behavior IDs still owned by each legacy script. Do not remove a legacy `run*Checks` group while any catalog entry points only to that group.

- [ ] **Step 2: For each eligible group, run replacement tests and a negative check**

Expected: replacement is GREEN normally and RED under the controlled behavior mutation documented in Tasks 3-7.

- [ ] **Step 3: Remove the eligible group and rerun both suites**

Expected: focused behavior tests remain GREEN; remaining legacy script stays GREEN.

- [ ] **Step 4: Move justified architecture prohibitions**

Keep guards for bounded scans, high-frequency paths avoiding full refresh, explicit fallback reasons, provider registry completeness, stable protocol versions, and release identity. Each assertion message must name its `ARCH-*` behavior ID and risk.

- [ ] **Step 5: Add package script and verify catalog ownership**

Add `"test:architecture-guards": "node scripts/run-architecture-guards.js"` and include it in Linux CI.

Run: `npm run test:behavior-contracts && npm run test:architecture-guards && npm run test:safety && npm run test:dashboard && npm run test:tmux`

Expected: PASS; no automated catalog entry points only to a removed function/group.

- [ ] **Step 6: Commit**

```bash
git add scripts package.json docs/testing/behavior-contracts.json
git commit -m "test: retire implementation-coupled safety checks"
```

---

### Task 14: Final Program Verification and Branch-Protection Handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/testing/README.md`
- Create: `docs/superpowers/reports/2026-07-22-regression-ci-verification.md`

**Interfaces:**
- Consumes all prior scripts/workflows.
- Produces final evidence, CI command documentation, and the exact required-check names for repository settings.

- [ ] **Step 1: Run a clean-install Linux-equivalent verification**

Run:

```bash
npm ci
npm run test:ci:linux
npm run test:tmux:smoke
npm run test:release-packaging
npm run test:architecture-baseline
git diff --check
```

Expected: every command exits 0; record wall-clock duration for `test:ci:linux` and confirm it is at most five minutes.

- [ ] **Step 2: Verify isolation**

Run tests with temporary empty values for provider home/session roots supported by the new helpers. Confirm no test output contains the real home directory, repository parent path outside the checkout, provider prompt text, or session content.

- [ ] **Step 3: Audit behavior ownership**

Run: `npm run test:behavior-contracts`

Expected: every entry has exactly one status, valid owners, and a manual reason where required. The report records counts by domain, priority, and status.

- [ ] **Step 4: Document developer workflow**

README and `docs/testing/README.md` must show quick focused tests, full deterministic tests, real tmux smoke, Linux CI-equivalent verification, behavior-ID rules, and the required RED-before-fix regression workflow.

- [ ] **Step 5: Write the verification report**

Record commit, Node/npm/tmux versions, command results, durations, behavior counts, lint baseline totals, coverage baseline, manual scenarios, known environment-only limitations, and required checks: `quality-linux`, `platform-windows`, `tmux-smoke-linux`.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/testing/README.md docs/superpowers/reports/2026-07-22-regression-ci-verification.md
git commit -m "docs: record regression ci verification"
```

- [ ] **Step 7: Prepare repository-settings handoff**

Do not mutate GitHub branch protection without explicit user authorization. Report that the repository administrator must mark `quality-linux`, `platform-windows`, and `tmux-smoke-linux` as required checks after the workflow has completed successfully at least once.

---

## Final Acceptance Checklist

- [ ] Every behavior contract has a valid ID, evidence, priority, status, and owner.
- [ ] Every known historical regression is owned by an automated focused test.
- [ ] New unit/contract/integration tests run without real user session data.
- [ ] Linux CI rejects behavior failures, new lint warnings, coverage decreases, build failures, and release-package regressions.
- [ ] Windows CI protects drive, URI, workspace, and command-quoting behavior.
- [ ] Real tmux smoke is isolated, required, repeatable, and self-cleaning.
- [ ] macOS and stable Extension Host cases run on schedule; unhostable remote/visual cases have versioned manual instructions.
- [ ] Release creation depends on the same core verification used by pull requests.
- [ ] Remaining source checks are documented architecture guards rather than implementation-shape assertions.
- [ ] Linux main gate completes within five minutes.
- [ ] Worktree is clean and all task commits are intentional and independently reviewable.
