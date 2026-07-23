# Logical Attention Card Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox items so progress and verification evidence stay explicit.

**Goal:** Count unread attention on every dashboard card by logical AI session, retain every run-scoped event ID for acknowledgement, and lock Close/Detach cleanup into CI.

**Architecture:** Keep attention payloads and aggregates run-scoped so lifecycle replay remains safe. Normalize run-scoped keys only when building UI-facing project/workspace summaries, through one shared helper in the AI-session attention domain. Keep the raw-key lookup index unchanged because controller recovery still needs exact aggregate records.

**Tech Stack:** TypeScript, Node.js `node:test`, repository behavior-contract catalog, deterministic/safety CI scripts.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count`.
- Keep the primary checkout and its existing `.vscode/settings.json` and `.codex/` changes untouched.
- Do not push the branch and do not create a PR.
- Preserve the intentional lifecycle split:
  - explicit UI Close/Detach acknowledges every unread run event for the logical session;
  - natural terminal closure does not acknowledge unread attention;
  - aggregate and persistence identities remain run-scoped.
- Use TDD: observe the new contract fail for duplicate count before changing production code.
- Use `apply_patch` for source and test edits.

---

## Task 1: Add a Failing Logical-Session Card Contract

**Files:**

- Modify: `tests/contract/aiSessions/attention.test.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

- [ ] **Step 1: Import acknowledgement filtering and workspace projection**

Update the aggregate import and add the workspace projection import:

```js
const {
    aggregateAttentionSnapshots,
    filterAcknowledgedAttentionAggregate,
} = require('../../../out/aiSessions/attentionAggregate');
const workspaceAttentionProjection = require('../../../out/workspaces/attentionProjection');
```

- [ ] **Step 2: Add the composition-level behavior contract**

Immediately after `ATTENTION-ATTENTION-PROJECT-001`, add:

```js
test('ATTENTION-LOGICAL-SESSION-CARD-COUNT-001 counts logical sessions and retains every run event', () => {
    const projectPath = 'file:///fixtures/project';
    const projectKey = attentionProject.getAttentionProjectKey('/fixtures/project');
    const sameLogicalSessionAggregate = {
        protocolVersion: 1,
        aggregateRevision: 'b'.repeat(64),
        generatedAtMs: 300,
        sessions: [{
            projectId: projectKey,
            sessionKey: 'codex:one:100:tmux',
            reasons: ['completed'],
            eventIds: ['event-old'],
            observedAtMs: 100,
        }, {
            projectId: projectKey,
            sessionKey: 'codex:one:200:vscode',
            reasons: ['input-required'],
            eventIds: ['event-new'],
            observedAtMs: 200,
        }],
    };

    assert.equal(
        attentionProject.getLogicalAttentionSessionKey('codex:one:200:vscode'),
        'codex:one'
    );
    assert.equal(
        attentionProject.getLogicalAttentionSessionKey('opaque-session-key'),
        'opaque-session-key'
    );

    const projectSummary = attentionProject.getAttentionProjectSummaries(
        sameLogicalSessionAggregate
    )[0];
    assert.deepEqual(projectSummary, {
        projectKey,
        attentionCount: 1,
        eventIds: ['event-new', 'event-old'],
        sessions: [{
            sessionKey: 'codex:one',
            eventId: 'event-new',
            eventIds: ['event-new', 'event-old'],
        }],
    });
    assert.deepEqual(
        attentionProject.withAttentionProject({ id: 'project', path: projectPath }, sameLogicalSessionAggregate),
        {
            id: 'project',
            path: projectPath,
            aiSessionAttentionCount: 1,
            aiSessionAttentionEventIds: ['event-new', 'event-old'],
        }
    );
    assert.deepEqual(
        workspaceAttentionProjection.getWorkspaceAttentionSummary({
            roots: [{ uri: projectPath }],
        }, sameLogicalSessionAggregate),
        {
            attentionCount: 1,
            eventIds: ['event-new', 'event-old'],
            sessions: [{
                sessionKey: 'codex:one',
                eventId: 'event-new',
                eventIds: ['event-new', 'event-old'],
            }],
        }
    );

    const acknowledged = filterAcknowledgedAttentionAggregate(
        sameLogicalSessionAggregate,
        new Set(['event-old', 'event-new'])
    );
    assert.equal(
        workspaceAttentionProjection.getWorkspaceAttentionSummary({
            roots: [{ uri: projectPath }],
        }, acknowledged).attentionCount,
        0
    );

    const twoLogicalSessions = {
        ...sameLogicalSessionAggregate,
        sessions: sameLogicalSessionAggregate.sessions.concat({
            projectId: projectKey,
            sessionKey: 'codex:two:300:tmux',
            reasons: ['failed'],
            eventIds: ['event-two'],
            observedAtMs: 300,
        }),
    };
    assert.equal(
        attentionProject.getAttentionProjectSummaries(twoLogicalSessions)[0].attentionCount,
        2
    );
});
```

This one contract covers saved-project cards (`withAttentionProject`), current/other workspace cards (`getWorkspaceAttentionSummary`), retained run events, acknowledgement-to-zero, distinct logical sessions, and opaque-key compatibility.

- [ ] **Step 3: Register the behavior as a CI-owned main capability**

Add this entry after `ATTENTION-ATTENTION-PROJECTION-001` in `docs/testing/behavior-contracts.json`:

```json
{
  "id": "ATTENTION-LOGICAL-SESSION-CARD-COUNT-001",
  "domain": "attention",
  "title": "Logical Session Card Attention Count behavior",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/contract/aiSessions/attention.test.js"
  ],
  "evidence": [
    "src/aiSessions/attentionProject.ts",
    "src/workspaces/attentionProjection.ts"
  ]
}
```

Add `"ATTENTION-LOGICAL-SESSION-CARD-COUNT-001"` to the `MAIN-WORKSPACE-ATTENTION.behaviors` array in `docs/testing/main-capability-coverage.json`.

- [ ] **Step 4: Compile and prove the old implementation is red**

Run:

```bash
npm run test-compile
node --test --test-name-pattern='ATTENTION-LOGICAL-SESSION-CARD-COUNT-001' tests/contract/aiSessions/attention.test.js
```

Expected: the test fails because the project summary reports `attentionCount: 2` and exposes two run-scoped sessions instead of one logical session.

- [ ] **Step 5: Confirm metadata itself is valid**

Run:

```bash
npm run test:behavior-contracts
```

Expected: pass. The behavior ID is owned by the new test and mapped to `MAIN-WORKSPACE-ATTENTION`.

- [ ] **Step 6: Commit the red contract and metadata**

```bash
git add tests/contract/aiSessions/attention.test.js docs/testing/behavior-contracts.json docs/testing/main-capability-coverage.json
git commit -m "test: cover logical attention card counting"
```

---

## Task 2: Normalize Logical Sessions in the Shared Projection Layer

**Files:**

- Modify: `src/aiSessions/attentionProject.ts`
- Modify: `src/aiSessions/attentionController.ts`
- Modify: `src/workspaces/sessionAttention.ts`

- [ ] **Step 1: Move the logical-key helper into the attention domain**

Add to `src/aiSessions/attentionProject.ts` after `AttentionSummary`:

```ts
export function getLogicalAttentionSessionKey(sessionKey: string): string {
    const match = /^(codex|kimi|claude):(.+):\d+:(?:vscode|tmux)$/.exec(sessionKey || '');
    return match ? `${match[1]}:${match[2]}` : sessionKey;
}
```

In `src/workspaces/sessionAttention.ts`, import `getLogicalAttentionSessionKey` from `../aiSessions/attentionProject` and remove the local exported implementation.

In `src/aiSessions/attentionController.ts`, import both `getAttentionProjectKeys` and `getLogicalAttentionSessionKey` from `./attentionProject`, then remove the dependency on `../workspaces/sessionAttention`.

- [ ] **Step 2: Add one summary builder that merges all run event IDs**

Add this private helper in `src/aiSessions/attentionProject.ts`:

```ts
function summarizeAttentionSessions(
    sourceSessions: readonly AggregatedAttentionSession[]
): AttentionSummary {
    const allEventIds = new Set<string>();
    const sessionEventIds = new Map<string, Set<string>>();
    for (const session of sourceSessions) {
        const sessionKey = getLogicalAttentionSessionKey(session.sessionKey);
        let events = sessionEventIds.get(sessionKey);
        if (!events) {
            events = new Set<string>();
            sessionEventIds.set(sessionKey, events);
        }
        for (const eventId of session.eventIds || []) {
            if (eventId) {
                events.add(eventId);
                allEventIds.add(eventId);
            }
        }
    }

    const sessions = Array.from(sessionEventIds.entries())
        .map(([sessionKey, events]) => {
            const eventIds = Array.from(events).sort();
            return {
                sessionKey,
                eventId: eventIds[0] || sessionKey,
                eventIds,
            };
        })
        .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));

    return {
        attentionCount: sessions.length,
        eventIds: Array.from(allEventIds).sort(),
        sessions,
    };
}
```

- [ ] **Step 3: Route workspace and project summaries through the same builder**

Replace `getAttentionSummaryForProjectKeys` with:

```ts
export function getAttentionSummaryForProjectKeys(
    projectKeys: readonly string[],
    aggregate: AttentionAggregate | null
): AttentionSummary {
    const selectedProjectKeys = new Set((projectKeys || []).filter(Boolean));
    return summarizeAttentionSessions(
        (aggregate?.sessions || []).filter(session => selectedProjectKeys.has(session.projectId))
    );
}
```

Replace `getAttentionProjectSummaries` with:

```ts
export function getAttentionProjectSummaries(aggregate: AttentionAggregate | null): AttentionProjectSummary[] {
    const sessionsByProject = new Map<string, AggregatedAttentionSession[]>();
    for (const session of aggregate?.sessions || []) {
        let projectSessions = sessionsByProject.get(session.projectId);
        if (!projectSessions) {
            projectSessions = [];
            sessionsByProject.set(session.projectId, projectSessions);
        }
        projectSessions.push(session);
    }

    return Array.from(sessionsByProject.entries())
        .map(([projectKey, sessions]) => ({
            projectKey,
            ...summarizeAttentionSessions(sessions),
        }))
        .sort((left, right) => left.projectKey.localeCompare(right.projectKey));
}
```

Do not change `buildAttentionSessionIndex`; it intentionally indexes exact run-scoped aggregate keys.

- [ ] **Step 4: Compile and make the new contract green**

Run:

```bash
npm run test-compile
node --test --test-name-pattern='ATTENTION-LOGICAL-SESSION-CARD-COUNT-001|ATTENTION-ATTENTION-PROJECT-001|ATTENTION-ATTENTION-PROJECTION-001' tests/contract/aiSessions/attention.test.js
```

Expected: all selected tests pass.

- [ ] **Step 5: Run all attention contracts**

Run:

```bash
node --test tests/contract/aiSessions/attention.test.js
```

Expected: pass with no regression to raw aggregate identity, lifecycle replay, acknowledgement, or natural-close persistence.

- [ ] **Step 6: Review the diff and commit the minimal fix**

Run:

```bash
git diff --check
git diff -- src/aiSessions/attentionProject.ts src/aiSessions/attentionController.ts src/workspaces/sessionAttention.ts
```

Then commit:

```bash
git add src/aiSessions/attentionProject.ts src/aiSessions/attentionController.ts src/workspaces/sessionAttention.ts
git commit -m "fix: count logical attention sessions on cards"
```

---

## Task 3: Lock Multi-Run Close/Detach Acknowledgement into Safety CI

**Files:**

- Modify: `scripts/run-ai-session-safety-checks.js`

- [ ] **Step 1: Feed multiple recovered events to the existing Close/Detach harness**

After `vm.runInNewContext(source, context);` in `runBatchAiSessionWebviewChecks`, initialize:

```js
context.window.__projectStewardAttentionSessionEvents = {
    'codex:active-session': ['attention-active-old', 'attention-active-new'],
    'kimi:tmux-session': ['attention-tmux-old', 'attention-tmux-new'],
};
```

Keep each row's `data-session-event-id` fallback attribute so the test also proves that recovered full ownership takes precedence over the single rendered fallback.

- [ ] **Step 2: Strengthen the explicit action expectations**

Replace the Close acknowledgement expectation with:

```js
{
    type: 'acknowledge-ai-session-attention',
    eventIds: ['attention-active-old', 'attention-active-new'],
}
```

Replace the Detach acknowledgement expectation with:

```js
{
    type: 'acknowledge-ai-session-attention',
    eventIds: ['attention-tmux-old', 'attention-tmux-new'],
}
```

Leave the natural terminal-close contracts unchanged; they must continue to preserve unread attention.

- [ ] **Step 3: Run the safety suite**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
```

Expected: pass, proving explicit Close/Detach sends all recovered logical-session events before the lifecycle command.

- [ ] **Step 4: Review and commit the regression protection**

Run:

```bash
git diff --check
git diff -- scripts/run-ai-session-safety-checks.js
```

Then commit:

```bash
git add scripts/run-ai-session-safety-checks.js
git commit -m "test: preserve multi-run close acknowledgement"
```

---

## Task 4: Verify the Local Branch Without Publishing

**Files:**

- Verify only; no expected source edits.

- [ ] **Step 1: Run targeted attention and metadata gates**

```bash
npm run test-compile
node --test tests/contract/aiSessions/attention.test.js
npm run test:behavior-contracts
npm run test:safety:run
```

Expected: all commands pass.

- [ ] **Step 2: Run the full Linux CI gate**

```bash
npm run test:ci:linux
```

Expected: exit code `0`, including deterministic, safety, dashboard, architecture, packaging, webpack, and coverage checks.

- [ ] **Step 3: Inspect final branch state**

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
git diff --check origin/main...HEAD
```

Expected:

- branch is `fix/logical-attention-card-count`;
- worktree is clean;
- commits contain the design, test contract, minimal fix, and Close/Detach regression protection;
- no remote push and no PR have been created.

- [ ] **Step 4: Hand off the local worktree**

Report:

- root cause and why CI previously missed composition;
- exact card-count and event-retention behavior now covered;
- targeted and full CI results;
- worktree path and local branch name;
- confirmation that the branch remains local with no PR.
