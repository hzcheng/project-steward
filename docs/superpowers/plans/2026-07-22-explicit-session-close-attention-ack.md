# Explicit Session Close Attention Acknowledgement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear a final session's current attention events when the user explicitly closes or detaches that session from its Project Steward card.

**Architecture:** Reuse the existing webview-level `acknowledgeAiSessionRow` helper before posting the existing Close/Detach command. Keep extension-host terminal lifecycle handling unchanged so automatic exits and disconnects do not acknowledge attention.

**Tech Stack:** JavaScript webview event handling, Node.js assertion safety harness, Gulp-generated webview assets.

## Global Constraints

- A final session Close Terminal or Detach Terminal action acknowledges all attention event IDs represented by that row.
- Pending-session close/detach actions do not acknowledge attention.
- VS Code terminal lifecycle closure remains non-acknowledging.
- No protocol, persistence, markup, or styling changes.

---

### Task 1: Acknowledge Explicit Close and Detach Actions

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:6370-6470`
- Modify: `src/webview/webviewProjectScripts.js:664-686`
- Generate: `media/webviewProjectScripts.js`

**Interfaces:**
- Consumes: `acknowledgeAiSessionRow(sessionRow)`, which posts `acknowledge-ai-session-attention` for the row's current event IDs.
- Produces: Close/Detach click message ordering of acknowledgement first, terminal command second.

- [ ] **Step 1: Write the failing close/detach regression test**

Mark the final direct and tmux fixture rows as attention-bearing immediately before exercising their terminal controls:

```js
activeRow.setAttribute('data-ai-session-attention', '');
activeRow.setAttribute('data-session-event-id', 'attention-active-session');
tmuxRow.setAttribute('data-ai-session-attention', '');
tmuxRow.setAttribute('data-session-event-id', 'attention-tmux-session');
```

Update the expected message sequence so each final row acknowledges before its close/detach command, while the pending row still has no acknowledgement:

```js
{
    type: 'acknowledge-ai-session-attention', eventIds: ['attention-active-session'],
}, {
    type: 'close-ai-session-terminal', projectId: 'project-a', provider: 'codex',
    sessionId: 'active-session',
}, {
    type: 'close-ai-session-terminal', projectId: 'project-a', provider: 'claude',
    pendingCreatedAt: '2026-07-18T08:00:00Z',
}, {
    type: 'acknowledge-ai-session-attention', eventIds: ['attention-tmux-session'],
}, {
    type: 'detach-ai-session-terminal', projectId: 'project-a', provider: 'kimi',
    sessionId: 'tmux-session',
}
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because the actual message list lacks the two `acknowledge-ai-session-attention` messages.

- [ ] **Step 3: Implement the minimal webview behavior**

In the final-session branch of the terminal action handler, acknowledge the row before assigning the session ID and posting the close/detach command:

```js
if (terminalRow.hasAttribute('data-session-pending')) {
    terminalMessage.pendingCreatedAt = terminalRow.getAttribute('data-pending-created-at');
} else {
    acknowledgeAiSessionRow(terminalRow);
    terminalMessage.sessionId = terminalRow.getAttribute('data-session-id');
}
window.vscode.postMessage(terminalMessage);
```

- [ ] **Step 4: Regenerate the shipped webview asset**

Run:

```bash
npx gulp
```

Expected: `media/webviewProjectScripts.js` contains the same acknowledgement call as the source file.

- [ ] **Step 5: Verify focused and full regression suites**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
npm run test:safety
git diff --check
```

Expected: all commands exit zero; explicit Close/Detach acknowledges, pending close does not, and generic `onDidCloseTerminal` remains non-acknowledging.

- [ ] **Step 6: Review and commit the fix**

```bash
git add scripts/run-ai-session-safety-checks.js src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git commit -m "fix: acknowledge attention when leaving sessions"
```
