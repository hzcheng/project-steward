# Active Session Status Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant visible `Needs attention` label and guarantee that execution state is the first item on every Active Session card's second line.

**Architecture:** Keep attention and execution data unchanged and adjust only `getActiveAiSessionRow`'s presentation-level metadata composition. Extend the existing rendered-HTML safety checks to verify status priority, attention-dot accessibility, absence of duplicate visible text, and preservation of runtime diagnostics.

**Tech Stack:** TypeScript, server-rendered Webview HTML, Node.js `assert`, existing AI session safety and Dashboard test scripts.

## Global Constraints

- Keep the red attention dot as the sole visible attention indicator.
- Keep the dot's tooltip and accessible label `AI session needs attention`.
- Never render the visible text `Needs attention` on an Active Session card.
- Always place `Running`, `Stopped`, or `Starting` first on the second line.
- Preserve `stale` and `Runtime conflict` diagnostics after the execution state.
- Do not change attention acknowledgement, runtime state, focus, tmux, or VS Code terminal behavior.

---

### Task 1: Prioritize Active Session execution metadata

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:4660`
- Modify: `src/webview/webviewContent.ts:770`
- Verify: `docs/superpowers/specs/2026-07-20-active-session-status-priority-design.md`

**Interfaces:**
- Consumes: `ActiveAiSessionViewModel.executionState`, `.needsAttention`, `.status`, `.conflict`, and `.stale`.
- Produces: Active Session HTML whose `.codex-session-meta` begins with `.ai-session-execution-status`; attention remains represented by `.ai-session-attention-indicator`.

- [x] **Step 1: Write the failing rendered-HTML regression checks**

Add a stale conflict fixture without changing the existing attention fixture:

```js
{
    key: 'claude:c3', provider: 'claude', sessionId: 'c3', name: 'Claude running',
    executionState: 'running', focused: false, needsAttention: false, pending: false,
    backend: 'vscode', attached: true, status: 'conflict', conflict: true, stale: true,
},
```

After extracting `activeMetadata`, assert the intended visible and accessible behavior:

```js
assert.ok(activeMetadata.every(metadata => metadata.startsWith(
    '<span class="ai-session-execution-status"'
)), 'every Active Session metadata line must begin with execution state');
assert.ok(activeMetadata.every(metadata => !metadata.includes('Needs attention')),
    'the attention dot must not be duplicated by visible metadata text');
assert.ok(sessionTabsHtml.includes(
    '<span class="ai-session-attention-indicator" title="AI session needs attention" aria-label="AI session needs attention"></span>'
), 'the attention dot must retain its tooltip and accessible label');
assert.ok(activeMetadata.some(metadata =>
    metadata.includes('Running</span> · <span class="ai-session-stale-status"')
    && metadata.includes('</span> · Runtime conflict · ')
), 'stale and conflict diagnostics must follow execution state');
```

- [x] **Step 2: Run the safety suite and verify the regression fails for the intended reasons**

Run:

```bash
npm run test:safety
```

Expected: FAIL because current attention metadata contains `Needs attention` and current metadata begins with stale/runtime status rather than execution state.

- [x] **Step 3: Make the minimal renderer change**

Replace the attention-aware runtime label with a conflict-only diagnostic and reorder metadata:

```ts
var runtimeStatusLabel = model.status === 'conflict' || model.conflict ? 'Runtime conflict' : '';
// Keep runtimeBadge, staleStatus, and attentionIndicator construction unchanged.
var metadata = [executionStatus, staleStatus, runtimeStatusLabel, createdAt, shortSessionId]
    .filter(Boolean)
    .join(' · ');
```

- [x] **Step 4: Run the focused suites and verify green**

Run:

```bash
npm run test:safety
npm run test:dashboard
```

Expected: AI session safety, tmux, open-project, and Dashboard Webview checks all pass.

- [x] **Step 5: Run final repository verification**

Run:

```bash
npm run test-compile
npm run lint
npm run test:architecture-baseline
npm run test:release-notes
npm run test:release-packaging
git diff --check
```

Expected: all commands exit zero; existing lint warnings may remain, but the modified files add no lint errors.

- [x] **Step 6: Commit the implementation intentionally**

Run:

```bash
git add docs/superpowers/plans/2026-07-20-active-session-status-priority.md \
    scripts/run-ai-session-safety-checks.js \
    src/webview/webviewContent.ts
git commit -m "fix: prioritize active session execution status"
```

Expected: one implementation commit following the already committed design document.
