# Regression CI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add required-CI protection for real TODO layout, AI-session full-card activation, and capability-audit freshness.

**Architecture:** A Playwright Chromium component test exercises production markup, CSS, and Webview JavaScript. A focused Node integration test owns session-card message routing. The behavior-catalog validator rejects implementation commits that appear after its recorded audit head.

**Tech Stack:** Node.js 22.12, `node:test`, Playwright Chromium, TypeScript build output, Git commit inspection.

## Global Constraints

- Work only in `.worktree/todo-ux`; do not modify or merge `main`.
- Every new automated behavior must have a stable behavior ID and a required-PR-check path.
- Browser layout assertions must use computed browser geometry rather than source-text matching.
- Real multi-window, remote lifecycle, and terminal focus remain manual unless their actual environment is exercised.

---

### Task 1: Browser TODO Layout Contract

**Files:**
- Create: `tests/browser/todoLayout.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/verify.yml`
- Modify: `docs/testing/README.md`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: `getTodoPanelContent(viewModel, options)`, `buildTodoViewModel(data, options)`, `initTodos(options)`.
- Produces: `test:browser:run` and `TODO-BROWSER-EXPANDED-LAYOUT-001`.

- [ ] **Step 1: Add the Chromium test and behavior entry**

Render one group with long title and notes at 280px width and `maxVisibleTodosPerGroup: 1`. Click the title and assert the expanded card has `clientHeight >= scrollHeight`, the list grows, no following card overlaps it, and collapsing restores the base viewport.

- [ ] **Step 2: Prove the test detects the old clipping behavior**

Run `npm run test:browser:run` after temporarily removing the production expanded-card height assignment. Expected: `TODO-BROWSER-EXPANDED-LAYOUT-001` fails because the expanded card clips or overlaps content.

- [ ] **Step 3: Restore production behavior and verify green**

Run `npm run test:browser:run`. Expected: one browser layout test passes without skips.

- [ ] **Step 4: Wire the browser into required Linux CI**

Add `test:browser:run` to `test:ci:linux`. The `quality-linux` job reaches it through `npm run test:ci:linux`.

- [ ] **Step 5: Commit**

```bash
git add tests/browser/todoLayout.test.js package.json package-lock.json .github/workflows/verify.yml docs/testing/README.md docs/testing/behavior-contracts.json
git commit -m "test: guard todo layout in chromium"
```

### Task 2: Focused AI Session Card Activation Contract

**Files:**
- Create: `tests/integration/dashboard/sessionCardInteraction.test.js`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/webviewProjectScripts.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: a click target, project ID, and session-row attributes.
- Produces: `getAiSessionCardActivationMessage(target, projectId)` returning the exact host message or `null`.

- [ ] **Step 1: Add the focused behavior test**

Cover an active card body, inactive card body, pending card body, primary action, and pin/archive nested controls under `WEBVIEW-AI-SESSION-CARD-ACTIVATION-001`.

- [ ] **Step 2: Verify RED**

Run `node --test tests/integration/dashboard/sessionCardInteraction.test.js`. Expected: failure because `getAiSessionCardActivationMessage` is not exported.

- [ ] **Step 3: Extract the minimal production decision**

Add the pure message decision to `src/webview/webviewProjectScripts.js`, use it from `onTriggerAiSessionAction`, and export it only through CommonJS when available. Regenerate the media copy with `npx gulp copyWebviewAssets --production`.

- [ ] **Step 4: Verify GREEN**

Run `node --test tests/integration/dashboard/sessionCardInteraction.test.js` and `npm run test:safety:run`. Expected: focused behavior and legacy compatibility checks pass.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/dashboard/sessionCardInteraction.test.js src/webview/webviewProjectScripts.js media/webviewProjectScripts.js docs/testing/behavior-contracts.json
git commit -m "test: own ai session card activation"
```

### Task 3: Capability Audit Freshness

**Files:**
- Modify: `tests/unit/tooling/mainCapabilityCoverage.test.js`
- Modify: `scripts/lib/mainCapabilityCoverage.js`
- Modify: `scripts/check-behavior-contracts.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: commits in `audit.head..HEAD`.
- Produces: `ARCH-MAIN-CAPABILITY-CURRENCY-001`, rejecting tail commits with non-documentation changes.

- [ ] **Step 1: Add validator tests**

Add one passing case for a documentation-only tail and one failing case for a source-changing tail.

- [ ] **Step 2: Verify RED**

Run `node --test tests/unit/tooling/mainCapabilityCoverage.test.js`. Expected: the source-changing tail is not rejected.

- [ ] **Step 3: Add tail validation and repository collection**

Pass `unauditedCommits` into `validateMainCapabilityCoverage` and reject each tail commit containing a non-documentation path.

- [ ] **Step 4: Extend the manifest through the latest implementation commit**

Assign every non-documentation commit in the extended audit range to a capability, list documentation-only commits in `ignoredDocumentationCommits`, and set `audit.head` to the latest implementation commit before the manifest-only commit.

- [ ] **Step 5: Verify GREEN**

Run `npm run test:behavior-contracts`. Expected: catalog and capability checks pass, while a controlled source-changing tail mutation fails.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/tooling/mainCapabilityCoverage.test.js scripts/lib/mainCapabilityCoverage.js scripts/check-behavior-contracts.js docs/testing/behavior-contracts.json docs/testing/main-capability-coverage.json
git commit -m "test: require current capability audit"
```

### Task 4: Full Review and Verification

**Files:**
- Review all task files.

**Interfaces:**
- Consumes: all three new behavior owners.
- Produces: a clean feature branch ready for user validation, without merging.

- [ ] **Step 1: Run focused and catalog checks**

```bash
npm run test:browser:run
node --test tests/integration/dashboard/sessionCardInteraction.test.js
npm run test:behavior-contracts
```

- [ ] **Step 2: Run the required Linux equivalent**

```bash
npm run test:ci:linux
```

- [ ] **Step 3: Review and commit any necessary fixes**

Run `git diff --check`, inspect `git diff origin/main..HEAD`, stage explicit files, and keep `main` untouched.
