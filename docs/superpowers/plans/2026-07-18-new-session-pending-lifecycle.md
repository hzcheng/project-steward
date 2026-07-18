# New Session Pending Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a newly created AI session in the ACTIVE tab while its Terminal remains open, then bind it when the provider session becomes discoverable.

**Architecture:** Remove elapsed-time ownership from `AiSessionCreationController`; the terminal service remains the sole owner of pending lifetimes, with resolver promotion and Terminal-close cleanup as the two live transitions. Keep the existing pending persistence, 24-hour restored-record TTL, matching rules, and `Starting` projection unchanged.

**Tech Stack:** TypeScript, VS Code extension API, Node.js safety-check harness using `assert`.

## Global Constraints

- A NEW session remains `Starting` in ACTIVE for as long as its Terminal is open.
- Elapsed time alone must never remove a live pending record or emit `Could not detect the new session`.
- Do not add a new UI status or change provider matching, completion, persistence, or the 24-hour restored-record TTL.
- Keep all changes on `fix/new-session-pending-lifecycle` in `.worktrees/fix-new-session-pending-lifecycle`; do not modify the main checkout.
- Add no dependencies.

---

### Task 1: Make pending lifetime follow Terminal ownership

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:559-621,1051-1188,1854-1981`
- Modify: `src/aiSessions/creationController.ts:31-219`
- Modify: `src/dashboard.ts:51-52,363-400,958-960,979`

**Interfaces:**
- Consumes: `trackPendingTerminal(pending)`, the existing pending resolver, and `AiSessionTerminalService.handleClosedTerminal(terminal)`.
- Produces: `AiSessionCreationController.createSession(projectId: string): Promise<void>` without a binding-timeout lifecycle; pending promotion and close cleanup retain their existing interfaces.

- [ ] **Step 1: Rewrite the creation-controller safety check to express the retained-pending behavior**

Keep the injected timer and removal spies temporarily so the test can prove they are not called. Delete the invalid-timestamp `controller.watchPending(...)` setup, replace both timeout expectations, and remove the timeout callback and `controller.dispose()` assertions. After the first successful Codex creation, use:

```js
    assert.deepStrictEqual(activeTabRequests, ['project-a']);
    assert.strictEqual(refreshes.length, 1);
    assert.strictEqual(timeoutQueue.length, 0, 'creating a session must not schedule pending removal');
    assert.strictEqual(pendingKeys.has(`codex:${tracked[0].createdAt}`), true);
```

After the Kimi creation, use:

```js
    assert.strictEqual(timeoutQueue.length, 0, 'elapsed time must not own the pending lifecycle');
    assert.strictEqual(pendingKeys.has(`kimi:${tracked[1].createdAt}`), true);
    assert.deepStrictEqual(removed, []);
    assert.deepStrictEqual(announcements, []);
    assert.deepStrictEqual(warnings, [['Open project not found.', []]]);
    assert.strictEqual(terminals[1].terminal.showCalls, 1);
    assert.strictEqual(terminals[1].terminal.disposeCalls, 0);
    assert.strictEqual(refreshes.length, 2);
```

This is the regression assertion: with the current implementation, `timeoutQueue.length` is `1` after the first creation.

- [ ] **Step 2: Make the delayed resolver and Terminal-close boundaries explicit in safety checks**

In `runPendingTerminalResolverChecks()`, make the matched session appear 56 seconds after the pending creation:

```js
                    { id: 'new', cwd: '/work/app', updatedAt: '2026-07-15T10:00:56Z' },
```

Keep the existing assertions that the resolver tracks `codex:new`, preserves the same pending Terminal and marker, applies the alias, and leaves only the unmatched pending record.

In `runAiSessionTerminalResolutionChecks()`, create a pending Terminal before the existing close assertions:

```js
        const pending = { name: 'Codex: Pending', creationOptions: {}, processId: Promise.resolve(42099) };
        service.trackPending({
            provider: 'codex',
            terminal: pending,
            markerPath: path.join(tempRoot, 'pending.done'),
            cwd: '/work/app',
            createdAt: new Date().toISOString(),
            excludedSessionIds: [],
        }, false);
        assert.strictEqual(service.getPendingTerminals().length, 1);
        assert.deepStrictEqual(service.handleClosedTerminal(pending), []);
        assert.strictEqual(service.getPendingTerminals().length, 0, 'closing a Terminal removes its unresolved pending row');
```

- [ ] **Step 3: Run the safety suite and verify the new creation assertion fails**

Run:

```bash
npm run test:safety
```

Expected: FAIL in `runAiSessionCreationControllerChecks()` with `creating a session must not schedule pending removal`, showing actual timeout count `1` instead of expected `0`. Compilation and the added delayed-resolver and close-boundary assertions must not error.

- [ ] **Step 4: Remove the creation controller's elapsed-time lifecycle**

In `src/aiSessions/creationController.ts`, delete:

- `AI_SESSION_CREATION_BIND_TIMEOUT_MS`;
- option fields `announceStatus`, `isPending`, `removePending`, `normalizeProjectPath`, `setTimeout`, `clearTimeout`, and `bindingTimeoutMs`;
- `pendingTimeouts`;
- methods `watchPending`, `dispose`, `handlePendingTimeout`, `findPendingProjectId`, and `getPendingKey`;
- the `this.watchPending(pending, project.id)` call.

Retain `nowMs`, because it supplies the pending record's creation timestamp. The final tail of `AiSessionCreationControllerOptions` must be:

```ts
    sendNewSessionCommand: (
        providerId: AiSessionProviderId,
        terminal: vscode.Terminal,
        cwd: string | null,
        title: string,
        markerPath: string
    ) => Thenable<unknown>;
    scheduleNewSessionRefresh: (providerId: AiSessionProviderId) => void;
    nowMs: () => number;
}
```

The final pending handoff in `createProviderSession` must be:

```ts
        this.options.trackPendingTerminal({
            provider: providerId,
            terminal,
            markerPath,
            cwd: pendingTerminalCwd,
            createdAt,
            excludedSessionIds: existingSessionIds,
            title: fields.title,
        });

        await this.options.showActiveTab(project.id);
        this.options.refresh();
        terminal.show();
        await this.options.sendNewSessionCommand(providerId, terminal, cwd, fields.title, markerPath);
        this.options.scheduleNewSessionRefresh(providerId);
```

- [ ] **Step 5: Remove obsolete dashboard wiring**

In `src/dashboard.ts`:

- keep only `import { AiSessionCreationController } from './aiSessions/creationController';` and remove the timeout-constant import;
- remove the `announceStatus` callback from the controller options;
- remove option fields `isPending`, `removePending`, `normalizeProjectPath`, `setTimeout`, `clearTimeout`, and `bindingTimeoutMs`;
- keep `nowMs: () => Date.now()`;
- remove the startup loop that calls `aiSessionCreationController.watchPending(pending)`;
- remove `context.subscriptions.push(aiSessionCreationController)` because the controller is no longer disposable.

Do not remove the Webview's generic `ai-session-status-announcement` receiver; this fix only removes the creation controller as a sender.

- [ ] **Step 6: Run focused verification and confirm GREEN**

Run:

```bash
npm run test:safety
```

Expected:

```text
AI session safety checks passed.
Open project safety checks passed.
```

- [ ] **Step 7: Run static checks and inspect the exact diff**

Run:

```bash
npm run lint
git diff --check
git diff --stat main...HEAD
git status -sb
```

Expected: lint and `git diff --check` exit `0`; only the design, plan, safety-check harness, creation controller, and dashboard are changed on the feature branch.

- [ ] **Step 8: Commit the behavior fix**

```bash
git add src/aiSessions/creationController.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: retain pending AI sessions until terminal close"
```

- [ ] **Step 9: Review the committed fix and rerun fresh verification**

Inspect:

```bash
git diff main...HEAD -- src/aiSessions/creationController.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js
```

Then rerun:

```bash
npm run test:safety
npm run lint
git status -sb
```

Expected: all checks exit `0`, the worktree is clean, and the branch contains the documentation commit plus the behavior-fix commit.
