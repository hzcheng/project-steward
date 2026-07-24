# AI Session Terminal Workbench Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every successful AI-session card focus action finishes in the VS Code Terminal work area.

**Architecture:** Extend the terminal command controller with one injected workbench-focus callback and invoke it only after an exact runtime focus succeeds. Wire the callback to VS Code's built-in Terminal focus command and protect the transaction with the existing session-controller behavior contract.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `node:test`, repository behavior contracts.

## Global Constraints

- Work only in `.worktree/todo-ux` on `feat/todo-ux-overhaul`; do not modify or merge `main`.
- Preserve exact runtime ownership, tmux validation, conflict, detach, and incremental refresh semantics.
- Do not introduce an exact external-window focus claim or relay.
- Use RED-before-fix and keep the test reachable from `quality-linux`.

---

### Task 1: Protect the terminal workbench focus transaction

**Files:**
- Modify: `tests/contract/aiSessions/sessionControllers.test.js`
- Modify: `src/aiSessions/terminalCommandController.ts`
- Modify: `src/dashboard.ts`

**Interfaces:**
- Consumes: `AiSessionTerminalCommandRuntimeCoordinator.focus(identity): Promise<void>` and `focusSelected(runtime): Promise<boolean>`.
- Produces: optional controller capability `focusTerminalView?(): Thenable<unknown> | Promise<unknown>`, injected by production Dashboard composition.

- [ ] **Step 1: Write the failing controller contract**

Add a `focusTerminalView` fake to `SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001` and assert the successful active path produces:

```js
['show', 'refresh', 'focus-terminal-view', 'dispose', 'refresh']
```

Also assert a foreign project request adds no effects. Add focused cases proving pending and conflict-selected successes invoke `focus-terminal-view`, while a runtime focus rejection does not.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/aiSessions/sessionControllers.test.js
```

Expected: the focus contract fails because `focusTerminalView` is not invoked.

- [ ] **Step 3: Implement the minimal controller transaction**

Add this option:

```ts
focusTerminalView?(): Thenable<unknown> | Promise<unknown>;
```

After each successful `runtimeCoordinator.focus(...)` or successful `focusSelected(...)`, retain the existing `refresh()` call and then run:

```ts
await options.focusTerminalView?.();
```

Do not call it on missing, cancelled, changed, or failed paths. Keep it optional for isolated controller consumers while requiring Dashboard production composition to supply it.

- [ ] **Step 4: Wire Dashboard to the VS Code Terminal command**

Provide:

```ts
focusTerminalView: () =>
    vscode.commands.executeCommand('workbench.action.terminal.focus'),
```

- [ ] **Step 5: Run focused GREEN verification**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/aiSessions/sessionControllers.test.js
npm run test:behavior-contracts
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the behavior and implementation**

```bash
git add docs/superpowers/specs/2026-07-24-ai-session-terminal-workbench-focus-design.md \
  docs/superpowers/plans/2026-07-24-ai-session-terminal-workbench-focus.md \
  tests/contract/aiSessions/sessionControllers.test.js \
  src/aiSessions/terminalCommandController.ts src/dashboard.ts
git commit -m "fix: focus terminal after session selection"
```

### Task 2: Review, verify, package, and install

**Files:**
- Create: `docs/superpowers/reports/2026-07-24-ai-session-terminal-workbench-focus-verification.md`
- Verify: `artifacts/project-steward-2.1.5.vsix`

**Interfaces:**
- Consumes: the green controller transaction from Task 1.
- Produces: a review ledger, fresh CI evidence, a packaged VSIX, and local installation evidence.

- [ ] **Step 1: Review the focused diff**

Inspect:

```bash
git diff origin/main...HEAD -- src/aiSessions/terminalCommandController.ts src/dashboard.ts \
  tests/contract/aiSessions/sessionControllers.test.js
```

Confirm rejected and failed paths cannot invoke `focusTerminalView`, and no raw runtime details enter user-facing errors.

- [ ] **Step 2: Run branch verification**

Run:

```bash
npm run test:deterministic
PROJECT_STEWARD_TMUX_PATH=/usr/bin/tmux npm run test:tmux:smoke
npm run test:ci:linux
```

Expected: all commands exit 0.

- [ ] **Step 3: Package and install the extension**

Follow `.codex/skills/installing-vscode-extensions-locally/SKILL.md` to create a fresh `project-steward-2.1.5.vsix`, install it in the active SSH extension host, and verify the installed manifest and bundle contain the new Terminal focus command.

- [ ] **Step 4: Record evidence**

Create the verification report with the diagnosed runtime facts, RED and GREEN output, review findings, CI results, artifact byte size and SHA-256, installation target, and proof that protected `main` remains unchanged.

- [ ] **Step 5: Commit verification evidence**

```bash
git add docs/superpowers/reports/2026-07-24-ai-session-terminal-workbench-focus-verification.md
git commit -m "docs: verify session terminal focus"
```
