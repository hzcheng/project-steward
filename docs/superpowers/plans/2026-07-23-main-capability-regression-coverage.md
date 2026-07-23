# Main Capability Regression Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every capability introduced by merged `main` traceable to a focused automated behavior and an enforced PR or real-environment CI gate.

**Architecture:** Add a checked-in main-capability manifest and a pure validator beside the existing behavior catalog. Migrate remaining main-only guarantees out of large safety scripts into focused unit/contract/integration owners while retaining production-composition assertions as defense in depth. Reuse `verify.yml` for deterministic Linux, Windows, and real-tmux coverage, and keep the pinned Extension Host smoke in scheduled verification.

**Tech Stack:** Node.js 22, `node:test`, TypeScript, JSON manifests, GitHub Actions YAML, existing VS Code Extension Host harness, existing isolated tmux harness, `@vscode/vsce`.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-refactor-and-ci`.
- Do not modify, merge into, or push `main`.
- Do not delete, skip, weaken, or rename away an existing behavior solely to make a gate pass.
- All deterministic behavior runs in pull-request CI.
- Real VS Code Host and real tmux checks supplement deterministic PR tests; neither can replace them.
- Every production behavior change follows RED → GREEN → REFACTOR.
- Existing giant safety scripts remain evidence/defense-in-depth, not focused behavior owners.
- Package contents must remain exact allowlists: main VSIX 37 entries and bridge VSIX 6 entries unless a separately reviewed product requirement changes them.

---

### Task 1: Main Capability Manifest Validator

**Files:**
- Create: `scripts/lib/mainCapabilityCoverage.js`
- Create: `tests/unit/tooling/mainCapabilityCoverage.test.js`
- Create: `docs/testing/main-capability-coverage.json`
- Modify: `scripts/check-behavior-contracts.js`
- Modify: `package.json`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: `behavior-contracts.json`, `package.json#scripts`, workflow YAML text, repository root, and the audited Git range `2b34c653119bdf480f2af0330ee3809b51441807..e9145123b3ad1cdcbc625e52291ae053e8acbce5`.
- Produces:
  - `loadMainCapabilityCoverage(filePath): MainCapabilityManifest`
  - `validateMainCapabilityCoverage(manifest, options): string[]`
  - behavior ID `ARCH-MAIN-CAPABILITY-COVERAGE-001`
  - npm script `test:main-capabilities`

- [ ] **Step 1: Write validator fixture helpers and the first failing acceptance test**

Create `tests/unit/tooling/mainCapabilityCoverage.test.js` with a temporary repository fixture. The minimum valid fixture must contain one production commit, one automated behavior, one focused owner, one evidence file, one package gate, and one workflow job:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    validateMainCapabilityCoverage,
} = require('../../../scripts/lib/mainCapabilityCoverage');

function validFixture(t) {
    const repositoryRoot = makeTempDirectory(t, 'main-capability-');
    fs.mkdirSync(path.join(repositoryRoot, 'tests/unit'), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(repositoryRoot, 'tests/unit/owner.test.js'),
        \"test('MAIN-WORKSPACE-IDENTITY-001 preserves identity', () => {});\\n\"
    );
    fs.writeFileSync(path.join(repositoryRoot, 'src/identity.ts'), 'export const identity = 1;\\n');
    return {
        repositoryRoot,
        manifest: {
            version: 1,
            audit: {
                base: 'a'.repeat(40),
                head: 'b'.repeat(40),
                ignoredDocumentationCommits: [],
            },
            capabilities: [{
                id: 'MAIN-WORKSPACE-IDENTITY',
                title: 'Workspace identity',
                requirement: 'Workspace identities remain stable.',
                commits: ['c'.repeat(40)],
                behaviors: ['MAIN-WORKSPACE-IDENTITY-001'],
                prGates: ['test:deterministic:run'],
                scheduledJobs: [],
                realEnvironmentRequired: false,
            }],
        },
        behaviors: [{
            id: 'MAIN-WORKSPACE-IDENTITY-001',
            status: 'automated',
            owners: ['tests/unit/owner.test.js'],
            evidence: ['src/identity.ts'],
        }],
        scripts: {
            'test:deterministic:run': \"node --test 'tests/unit/**/*.test.js'\",
        },
        workflows: {},
        auditedCommits: [{
            hash: 'c'.repeat(40),
            subject: 'feat: model workspace identity',
            files: ['src/identity.ts'],
        }],
    };
}

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 accepts complete reachable main lineage', t => {
    const fixture = validFixture(t);
    assert.deepEqual(validateMainCapabilityCoverage(fixture.manifest, fixture), []);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tests/unit/tooling/mainCapabilityCoverage.test.js
```

Expected: FAIL with `Cannot find module '../../../scripts/lib/mainCapabilityCoverage'`.

- [ ] **Step 3: Implement the minimal validator API**

Create `scripts/lib/mainCapabilityCoverage.js` with:

```js
'use strict';

const fs = require('node:fs');

const CAPABILITY_ID = /^MAIN-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const COMMIT_ID = /^[a-f0-9]{40}$/;

function loadMainCapabilityCoverage(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateMainCapabilityCoverage(manifest, options) {
    const errors = [];
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.capabilities)) {
        return ['main capability manifest must use version 1 with a capabilities array'];
    }
    const ids = new Set();
    for (const [index, capability] of manifest.capabilities.entries()) {
        if (!CAPABILITY_ID.test(capability?.id || '')) {
            errors.push(`capability ${index + 1} has invalid id ${capability?.id || ''}`);
            continue;
        }
        if (ids.has(capability.id)) errors.push(`duplicate capability id ${capability.id}`);
        ids.add(capability.id);
        for (const commit of capability.commits || []) {
            if (!COMMIT_ID.test(commit)) errors.push(`${capability.id} has invalid commit ${commit}`);
        }
        for (const behaviorId of capability.behaviors || []) {
            const behavior = options.behaviors.find(item => item.id === behaviorId);
            if (!behavior) errors.push(`${capability.id} references missing behavior ${behaviorId}`);
            else if (behavior.status !== 'automated') {
                errors.push(`${capability.id} behavior ${behaviorId} must be automated`);
            }
        }
        for (const gate of capability.prGates || []) {
            if (typeof options.scripts[gate] !== 'string') {
                errors.push(`${capability.id} references missing PR gate ${gate}`);
            }
        }
    }
    return errors;
}

module.exports = {
    loadMainCapabilityCoverage,
    validateMainCapabilityCoverage,
};
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test tests/unit/tooling/mainCapabilityCoverage.test.js
```

Expected: PASS, 1 test.

- [ ] **Step 5: Add one mutation test per validator failure class**

Extend the test file with explicit mutations for:

```js
[
    ['duplicate capability', manifest => manifest.capabilities.push({ ...manifest.capabilities[0] })],
    ['missing commit assignment', (_manifest, fixture) => fixture.manifest.capabilities[0].commits = []],
    ['duplicate commit assignment', manifest => manifest.capabilities.push({
        ...manifest.capabilities[0],
        id: 'MAIN-WORKSPACE-SCOPE',
    })],
    ['missing behavior', manifest => manifest.capabilities[0].behaviors = ['MISSING-BEHAVIOR-001']],
    ['manual behavior', (_manifest, fixture) => fixture.behaviors[0].status = 'manual'],
    ['missing owner', (_manifest, fixture) => fixture.behaviors[0].owners = []],
    ['missing evidence', (_manifest, fixture) => fixture.behaviors[0].evidence = []],
    ['missing PR gate', manifest => manifest.capabilities[0].prGates = ['test:missing']],
    ['unreachable owner', (_manifest, fixture) => fixture.scripts['test:deterministic:run'] = 'node other.js'],
    ['missing scheduled job', manifest => {
        manifest.capabilities[0].realEnvironmentRequired = true;
        manifest.capabilities[0].scheduledJobs = ['missing-job'];
    }],
    ['real-only coverage', manifest => {
        manifest.capabilities[0].realEnvironmentRequired = true;
        manifest.capabilities[0].behaviors = [];
    }],
]
```

Each mutation must assert a stable error substring. Add fixture tests for invalid JSON through `loadMainCapabilityCoverage`.

- [ ] **Step 6: Run mutation tests and verify RED**

Run:

```bash
node --test tests/unit/tooling/mainCapabilityCoverage.test.js
```

Expected: FAIL on the first unsupported mutation, proving the initial validator is incomplete.

- [ ] **Step 7: Complete validation and gate reachability**

Implement:

- exact capability/commit uniqueness;
- automatic exclusion only when every changed path is under `docs/` or `.superpowers/`;
- explicit documentation exemptions in `audit.ignoredDocumentationCommits`;
- owner/evidence existence and regular-file checks using the same repository-boundary rules as `behaviorCatalog.js`;
- deterministic owner reachability for globbed unit/contract/integration gates and explicitly invoked script owners;
- scheduled job lookup by parsed workflow job ID;
- bounded repository-relative diagnostics.

Export a helper:

```js
function collectUnassignedAuditedCommits(manifest, auditedCommits) {
    const assigned = new Set(manifest.capabilities.flatMap(item => item.commits));
    const ignored = new Set(manifest.audit.ignoredDocumentationCommits || []);
    return auditedCommits.filter(commit =>
        !assigned.has(commit.hash)
        && !ignored.has(commit.hash)
        && commit.files.some(file => !file.startsWith('docs/') && !file.startsWith('.superpowers/'))
    );
}
```

- [ ] **Step 8: Populate the real manifest**

Create `docs/testing/main-capability-coverage.json` with the 16 capability IDs
from the approved design. Use full 40-character hashes and the fixed audit
range. Assign commits by observable behavior:

- identity/context/root normalization → `MAIN-WORKSPACE-IDENTITY`;
- provider scope/preflight/directory selection → `MAIN-WORKSPACE-SCOPE`;
- Direct/tmux identity and display-context persistence → `MAIN-RUNTIME-OWNERSHIP`;
- hydration/promotion/activation sequencing → `MAIN-WORKSPACE-HYDRATION`;
- protocol/store/coordinator/recovery → `MAIN-OPEN-WORKSPACE-PROTOCOL`;
- cross-window rendering/privacy/summary → `MAIN-OTHER-WINDOWS`;
- exact/fallback navigation → `MAIN-WORKSPACE-NAVIGATION`;
- saved/untitled workspace persistence → `MAIN-WORKSPACE-SAVE`;
- card markup/layout/click targets/animation → `MAIN-WORKSPACE-WEBVIEW`;
- catalog v2 targets and TODO preservation → `MAIN-WORKSPACE-SEARCH`;
- attention identity/persistence/acknowledgement → `MAIN-WORKSPACE-ATTENTION`;
- exact target and bounded-read performance → `MAIN-TMUX-FOCUS`;
- readable locator creation/promotion/recovery → `MAIN-TMUX-NAMING`;
- isolated fixture cleanup tests → `MAIN-TMUX-CLEANUP`;
- release metadata, stale builds, and VSIX allowlists → `MAIN-RELEASE-PACKAGING`;
- test-only, workflow, and reproducibility commits → `MAIN-CI-WIRING`.

The validator must report zero unassigned non-documentation commits. Do not
silence an unassigned implementation commit with a documentation exemption.

- [ ] **Step 9: Wire the validator into behavior contracts**

Update `scripts/check-behavior-contracts.js` to load both manifests and call
both validators. Add:

```json
"test:main-capabilities": "node --test tests/unit/tooling/mainCapabilityCoverage.test.js && node scripts/check-behavior-contracts.js"
```

Keep `test:behavior-contracts` as the public PR entry point and include the new
unit owner in it:

```json
"test:behavior-contracts": "node --test tests/unit/tooling/behaviorCatalog.test.js tests/unit/tooling/mainCapabilityCoverage.test.js && node scripts/check-behavior-contracts.js"
```

Add `ARCH-MAIN-CAPABILITY-COVERAGE-001` to the behavior catalog with the unit
test as owner and the validator, manifest, and `verify.yml` as evidence.

- [ ] **Step 10: Verify Task 1 and commit**

Run:

```bash
npm run test:behavior-contracts
git diff --check
```

Expected: all catalog and capability mutation tests pass; validator prints both
catalog and main-capability success messages.

Commit:

```bash
git add scripts/lib/mainCapabilityCoverage.js \
  tests/unit/tooling/mainCapabilityCoverage.test.js \
  docs/testing/main-capability-coverage.json \
  docs/testing/behavior-contracts.json \
  scripts/check-behavior-contracts.js package.json
git commit -m "test: trace main capabilities to regression gates"
```

---

### Task 2: Focused Workspace Scope, Save, and Navigation Contracts

**Files:**
- Create: `tests/unit/workspaces/sessionScope.test.js`
- Create: `tests/contract/workspaces/workspaceSave.test.js`
- Create: `tests/unit/openWorkspaces/navigationOutcome.test.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes:
  - `selectPrimaryWorkspaceRoot`, `buildAiSessionDirectoryScope`
  - `preflightAiSessionDirectoryScope`, provider-specific command builders
  - `SavedWorkspaceProjectAdapter`, `PendingWorkspaceSaveStore`
  - `WorkspaceNavigationController`
- Produces:
  - `SESSION-WORKSPACE-SCOPE-001`
  - `PERSIST-WORKSPACE-SAVE-001`
  - `OPEN-WORKSPACE-NAVIGATION-001`

- [ ] **Step 1: Write failing workspace-scope tests**

Move the observable primary-root, preflight, and provider command-builder cases from
`run-ai-session-safety-checks.js` into `tests/unit/workspaces/sessionScope.test.js`.
Cover this precedence exactly:

```js
explicit root
> deepest active-editor root
> persisted last-used root
> lowest ordinal valid root
```

Use nested `/work` and `/work/api` roots, trailing/leading whitespace paths,
invalid blank paths, removed stored roots, and all three providers. Assert
Codex/Kimi repeat `--add-dir`, Claude uses one `--add-dir` followed by all
additional directories, and unsupported capability returns a controlled
preflight rejection before terminal creation.

- [ ] **Step 2: Verify workspace-scope RED**

Temporarily omit the active-editor root from the fixture’s current workspace
and run:

```bash
npm run test-compile
node --test tests/unit/workspaces/sessionScope.test.js
```

Expected: FAIL at the deepest-root assertion. Restore the fixture and confirm
GREEN.

- [ ] **Step 3: Write failing workspace-save round-trip tests**

Create `tests/contract/workspaces/workspaceSave.test.js` using
`scripts/fixtures/workspace-first-saved-projects.json`. Assert:

- a live single-folder/saved-multi-root/untitled-multi-root workspace creates
  exactly one saved project;
- existing group and project fields remain byte-equivalent after normalized
  serialization;
- migration settles before the queued save;
- duplicate save requests serialize and do not create duplicate projects;
- failed migration retains the pending save for retry;
- missing/invalid workspace creates no write.

Verify RED by first asserting two concurrent saves produce one write against a
fixture that calls the adapter twice before releasing the migration gate.

- [ ] **Step 4: Write failing navigation outcome tests**

Create `tests/unit/openWorkspaces/navigationOutcome.test.js` around the
production `src/openWorkspaces/navigationController.ts`. Cover all five
environment values across single-folder, saved multi-root, and untitled
multi-root workspaces and assert:

- saved and single-folder workspaces pass the exact navigation URI to
  `vscode.openFolder`;
- command or URI parsing failure instructs the user to use native Switch Window;
- untitled workspaces return save-first;
- no path substitutes a member root URI;
- stale cards refresh instead of navigating.

Verify RED with a controlled expectation that the member-root URI is opened,
then correct it to the exact workspace navigation URI and record GREEN.

- [ ] **Step 5: Add behavior ownership and run focused GREEN**

Register the three behavior IDs with production evidence under
`src/workspaces/`, `src/openWorkspaces/navigationController.ts`, and the
classifier. Add them to the corresponding manifest capability rows.

Run:

```bash
npm run test-compile
node --test tests/unit/workspaces/sessionScope.test.js \
  tests/contract/workspaces/workspaceSave.test.js \
  tests/unit/openWorkspaces/navigationOutcome.test.js
npm run test:behavior-contracts
```

- [ ] **Step 6: Commit**

```bash
git add tests/unit/workspaces/sessionScope.test.js \
  tests/contract/workspaces/workspaceSave.test.js \
  tests/unit/openWorkspaces/navigationOutcome.test.js \
  docs/testing/behavior-contracts.json \
  docs/testing/main-capability-coverage.json
git commit -m "test: preserve workspace scope save and navigation"
```

---

### Task 3: OTHER WINDOWS, Search, and Attention Regression Contracts

**Files:**
- Modify: `tests/contract/openProjects/projection.test.js`
- Modify: `tests/integration/dashboard/openProjectFlow.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`
- Modify: `tests/integration/dashboard/attentionRendering.test.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: workspace projection, v3 aggregate, workspace card rendering,
  incremental replacement, catalog v2, and attention projection.
- Produces:
  - `OPEN-OTHER-WINDOWS-PRIVACY-001`
  - `OPEN-OTHER-WINDOWS-SUMMARY-001`
  - strengthened `TODO-TODO-SEARCH-RESULT-RENDERING-001`

- [ ] **Step 1: Add an OTHER WINDOWS privacy regression test**

Construct two registrations with the same navigation identity, different focus
times, session/provider-like hostile metadata, running counts, and attention.
Assert the projection:

- chooses the latest focused registration;
- excludes current scope and current navigation identity;
- exposes only workspace summary fields;
- carries running and attention counts;
- never includes provider IDs, session IDs, session titles, cwd, or marker
  paths.

- [ ] **Step 2: Verify RED by controlled mutation**

In the test only, add a fake `sessionName` expectation to the public navigation
card and confirm the test fails because the field is absent. Replace that
probe with a recursive forbidden-key assertion and confirm GREEN against
production.

- [ ] **Step 3: Strengthen incremental DOM rollback**

Extend `openProjectFlow.test.js` with:

- current + two OTHER WINDOWS cards;
- attention-only semantic update;
- running-count-only update;
- duplicate navigation identity;
- malformed replacement that loses a card.

Assert valid updates retain all groups and invalid replacement restores the
previous DOM and requests one full refresh.

- [ ] **Step 4: Lock catalog v2 and TODO preservation**

In `webviewState.test.js`, assert exact section order:

```text
AI SESSIONS
OPEN WORKSPACES
SAVED PROJECTS
TODO RESULTS
```

Assert `show-current-workspace`, `switch-open-workspace`,
`reveal-workspace-session`, `open-saved-project`, and `show-todo` actions.
Assert stale or malformed updates cannot erase TODO entries.

- [ ] **Step 5: Lock attention persistence and clearing**

Extend `attentionRendering.test.js` with current and navigation cards sharing
the same attention event. Assert collapse, refresh, and OTHER WINDOWS
navigation do not acknowledge it; explicit matching session acknowledgement
clears both projections; stale runtime evidence cannot recreate it.

- [ ] **Step 6: Register behavior IDs, verify, and commit**

Run:

```bash
npm run test-compile
node --test tests/contract/openProjects/projection.test.js \
  tests/integration/dashboard/openProjectFlow.test.js \
  tests/integration/dashboard/webviewState.test.js \
  tests/integration/dashboard/attentionRendering.test.js
npm run test:behavior-contracts
```

Commit:

```bash
git add tests/contract/openProjects/projection.test.js \
  tests/integration/dashboard/openProjectFlow.test.js \
  tests/integration/dashboard/webviewState.test.js \
  tests/integration/dashboard/attentionRendering.test.js \
  docs/testing/behavior-contracts.json \
  docs/testing/main-capability-coverage.json
git commit -m "test: lock other windows workspace behavior"
```

---

### Task 4: Focused Tmux Naming, Exact Focus, and Recovery Contracts

**Files:**
- Create: `tests/unit/aiSessions/tmuxNaming.test.js`
- Modify: `tests/contract/aiSessions/tmuxClientBehavior.test.js`
- Modify: `tests/contract/aiSessions/runtimeCoordinator.test.js`
- Modify: `tests/contract/aiSessions/tmuxStore.test.js`
- Modify: `tests/contract/aiSessions/tmuxDiscovery.test.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes:
  - `normalizeTmuxReadableComponent`
  - `buildReadableTmuxLocator`
  - `tmuxLocatorMatchesIdentity`
  - `projectTmuxSessionMatchesWorkspace`
  - `TmuxClient.getTargetWindow`
  - `AiSessionRuntimeCoordinator.focus`
- Produces:
  - `RUNTIME-TMUX-NAMING-001`
  - `RUNTIME-TMUX-FOCUS-TARGET-001`
  - `RUNTIME-TMUX-FOCUS-FAST-PATH-001`
  - expanded `RUNTIME-TMUX-STORE-001` and `RUNTIME-TMUX-DISCOVERY-001`

- [ ] **Step 1: Migrate readable naming cases into a focused unit test**

Create `tests/unit/aiSessions/tmuxNaming.test.js` from the observable cases in
`run-ai-session-tmux-checks.js`. Cover:

- Unicode normalization and control-character removal;
- fallback components;
- project and session layouts;
- duplicate readable names with distinct eight-hex suffixes;
- pending locators and stable readable identity suffixes;
- 95-character boundary and astral Unicode length;
- exact and renamed readable components with stable suffixes, plus mismatched
  provider/scope/ID rejection;
- legacy locator read compatibility without generating new legacy names.

- [ ] **Step 2: Verify naming RED/GREEN**

First assert a 96-character result for the boundary fixture and run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/tmuxNaming.test.js
```

Expected: FAIL because production bounds it to 95. Correct the expected
contract to 95 and verify GREEN.

- [ ] **Step 3: Add exact target snapshot contract**

Extend `tmuxClientBehavior.test.js` so `getTargetWindow`:

- sends the exact session/window target;
- reads one atomic `display-message` snapshot containing the fixed metadata
  option set;
- accepts only one well-formed snapshot;
- returns null when the target vanished;
- rejects malformed or duplicated output;
- redacts runner paths/errors.

Assert that the snapshot format contains every fixed metadata option and that
the client does not enumerate windows or issue per-option reads. Full
navigation/root/cwd ownership validation remains the runtime backend's
responsibility; locator matching intentionally permits readable component
renames when the stable identity suffix is unchanged.

- [ ] **Step 4: Add coordinator fast-path contract**

Extend `runtimeCoordinator.test.js` with a verified unique tmux runtime.
Assert focus performs:

```js
{
    targetSnapshots: 1,
    tmuxFocuses: 1,
    directRefreshes: 0,
    tmuxFullDiscoveries: 0,
}
```

Then simulate one `AiSessionRuntimeTargetChangedError`; assert one reconcile
and one retry. A second target change must fail closed.

- [ ] **Step 5: Add durable recovery contracts**

Extend store/discovery tests for:

- readable locator persistence;
- pending-to-final rename durability;
- frozen promotion replay;
- exact durable session recovery;
- legacy tombstone ignore;
- empty-server creation;
- reload terminal reuse;
- renamed readable project-container recovery by stable identity suffix and
  foreign-suffix rejection.

- [ ] **Step 6: Register behavior IDs, verify, and commit**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/tmuxNaming.test.js \
  tests/contract/aiSessions/tmuxClientBehavior.test.js \
  tests/contract/aiSessions/runtimeCoordinator.test.js \
  tests/contract/aiSessions/tmuxStore.test.js \
  tests/contract/aiSessions/tmuxDiscovery.test.js
npm run test:behavior-contracts
```

Commit:

```bash
git add tests/unit/aiSessions/tmuxNaming.test.js \
  tests/contract/aiSessions/tmuxClientBehavior.test.js \
  tests/contract/aiSessions/runtimeCoordinator.test.js \
  tests/contract/aiSessions/tmuxStore.test.js \
  tests/contract/aiSessions/tmuxDiscovery.test.js \
  docs/testing/behavior-contracts.json \
  docs/testing/main-capability-coverage.json
git commit -m "test: preserve tmux naming focus and recovery"
```

---

### Task 5: Reusable Scheduled and Release Gate Wiring

**Files:**
- Modify: `.github/workflows/scheduled-verification.yml`
- Modify: `scripts/lib/ciContracts.js`
- Modify: `tests/unit/tooling/ciContracts.test.js`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: reusable `.github/workflows/verify.yml`,
  `npm run test:extension-host`, `npm run test:tmux:smoke`.
- Produces: validator coverage for scheduled deterministic Linux, Windows,
  real tmux, and pinned Extension Host jobs.

- [ ] **Step 1: Write failing scheduled-workflow contract tests**

Add `validateScheduledWorkflow(source)` and tests that reject:

- missing reusable `verify.yml` job;
- a reusable verify job without `uses: ./.github/workflows/verify.yml`;
- missing pinned Extension Host job;
- missing `npm run test:extension-host`;
- `continue-on-error`;
- altered Node `22.12.0`;
- absent npm cache or `npm ci`.

Run:

```bash
node --test tests/unit/tooling/ciContracts.test.js
```

Expected: FAIL because `validateScheduledWorkflow` is not exported.

- [ ] **Step 2: Implement parser and switch scheduled workflow to reuse Verify**

Keep the macOS Extension Host job. Add:

```yaml
jobs:
  verify:
    uses: ./.github/workflows/verify.yml

  scheduled-macos:
    name: scheduled-macos
    needs: verify
    runs-on: macos-latest
```

Remove duplicated deterministic compile/test/lint/package steps from the macOS
job; they now run through the reusable Linux/Windows/tmux jobs. Retain `npm ci`
and `npm run test:extension-host`.

- [ ] **Step 3: Verify workflow mutations and manifest scheduled jobs**

Run:

```bash
node --test tests/unit/tooling/ciContracts.test.js
npm run test:behavior-contracts
```

Expected: mutation cases fail only inside `assert.throws`; repository workflows
validate successfully.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/scheduled-verification.yml \
  scripts/lib/ciContracts.js \
  tests/unit/tooling/ciContracts.test.js \
  docs/testing/main-capability-coverage.json
git commit -m "ci: reuse regression gates for scheduled verification"
```

---

### Task 6: Repeated Packaging Residue Gate

**Files:**
- Modify: `scripts/seed-release-packaging-stale-output.js`
- Modify: `scripts/run-release-packaging-checks.js`
- Modify: `tests/unit/tooling/packageScripts.test.js`
- Modify: `.vscodeignore`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: `package:release`, exact VSIX allowlists, `.vscodeignore`.
- Produces: deterministic second-run protection against test, CI, coverage, and
  stale build leakage.

- [ ] **Step 1: Write a failing seed/ignore contract**

Extend `packageScripts.test.js` to require stale seeds under:

```text
out/stale-release-output.js
dist/stale-release-output.js
extensions/attention-ui-bridge/out/stale-release-output.js
extensions/attention-ui-bridge/dist/stale-release-output.js
coverage/tmp/stale-coverage.json
```

Require `.vscodeignore` to exclude `.ci/**`, `tests/**`, and `coverage/**`.
Delete the coverage seed line in a controlled source mutation and confirm the
test fails.

- [ ] **Step 2: Seed every residue class and verify RED**

Add the coverage seed. Because the repository already excludes `coverage/**`,
make a controlled mutation that temporarily removes that exact line from
`.vscodeignore`, then run:

```bash
npm run test:release-packaging
```

Expected: FAIL because the main VSIX contains
`extension/coverage/tmp/stale-coverage.json`.

Restore the exact `coverage/**` line immediately after recording the failure.

- [ ] **Step 3: Restore exclusions and assert exact archives**

Ensure `.vscodeignore` contains:

```text
.ci/**
tests/**
coverage/**
```

Keep the exact main 37-entry and bridge 6-entry allowlists. Add an assertion
that no archive path begins with `extension/coverage/`,
`extension/tests/`, or `extension/.ci/`.

- [ ] **Step 4: Verify two consecutive packaging runs**

Run:

```bash
npm run test:release-packaging
npm run test:coverage:run
npm run test:release-packaging
```

Expected: both packaging checks pass; the second run observes real coverage
residue but still emits the exact allowlists.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-release-packaging-stale-output.js \
  scripts/run-release-packaging-checks.js \
  tests/unit/tooling/packageScripts.test.js \
  .vscodeignore docs/testing/main-capability-coverage.json
git commit -m "test: reject repeated release package residue"
```

---

### Task 7: Full Verification and Coverage Report

**Files:**
- Create: `docs/superpowers/reports/2026-07-23-main-capability-regression-coverage.md`
- Verify only: files changed in Tasks 1–6. Do not make ad hoc implementation
  changes in this task; route any failure back to its owning task, add a
  reproducing test there, and rerun that task's RED/GREEN sequence.

**Interfaces:**
- Consumes: all PR and real-environment gates.
- Produces: final capability-to-behavior table and reproducible evidence.

- [ ] **Step 1: Run deterministic and platform gates**

```bash
npm run test:behavior-contracts
npm run test:deterministic
npm run test:ci:windows
```

Record exact test/pass/fail counts.

- [ ] **Step 2: Run residue-producing coverage before Linux CI**

```bash
npm run test:coverage:run
npm run test:ci:linux
```

This order proves release packaging remains clean with existing coverage
residue.

- [ ] **Step 3: Run real tmux smoke**

```bash
npm run test:tmux:smoke
```

Before and after, record the user's default-server session list and verify the
isolated harness did not change it. Verify no harness-owned temporary root or
server remains.

- [ ] **Step 4: Run Extension Host smoke when the pinned host is available**

```bash
npm run test:extension-host
```

If the host cannot launch in the current environment, record the exact bounded
reason and rely on the enforced scheduled job; do not report it as a pass.

- [ ] **Step 5: Inspect artifacts and repository state**

```bash
unzip -t artifacts/project-steward-2.1.4.vsix
unzip -t artifacts/project-steward-attention-ui-bridge-0.1.4.vsix
unzip -Z1 artifacts/project-steward-2.1.4.vsix | wc -l
unzip -Z1 artifacts/project-steward-attention-ui-bridge-0.1.4.vsix | wc -l
sha256sum artifacts/*.vsix
git diff --check
git diff --name-only --diff-filter=D -- 'tests/**'
git status --short
git -C /home/hzcheng/projects/repos/vscode-dashboard status --short
```

Expected: archives are valid; counts are 37 and 6; deleted test list is empty;
feature worktree contains only intentional report changes; primary checkout
still contains only the user's pre-existing `.vscode/settings.json` and
`.codex/`.

- [ ] **Step 6: Write the report**

The report must contain:

- all 16 capability IDs;
- assigned main commits;
- required focused behavior IDs;
- PR and scheduled gate names;
- RED/GREEN evidence added in Tasks 1–6;
- deterministic, Linux, Windows, tmux, and Extension Host results;
- VSIX counts and hashes;
- remaining manual two-window/environment cells;
- explicit no-test-deletion and no-main-modification confirmations.

- [ ] **Step 7: Commit the verified report**

```bash
git add docs/superpowers/reports/2026-07-23-main-capability-regression-coverage.md
git commit -m "docs: verify main capability regression coverage"
```

Do not push, open a PR, or merge into `main` without a separate user request.
