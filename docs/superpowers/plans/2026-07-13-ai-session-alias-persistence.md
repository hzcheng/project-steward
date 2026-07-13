# AI Session Alias Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent window-scoped or transient AI session discovery results from deleting user-defined session aliases.

**Architecture:** Keep aliases as independently owned persistent user metadata. The Open Project rendering path reads and applies the complete alias map without reconciling it against scoped provider results; explicit Rename reset and successful Project Steward archive remain the only deletion paths.

**Tech Stack:** TypeScript 4, VS Code Extension API, Node.js assertion-based safety checks

## Global Constraints

- Preserve the existing `ai-session-aliases.json` format and storage location.
- Do not change provider discovery, Webview message contracts, or project data.
- Do not delete aliases because a session is absent from discovery results.
- Keep explicit alias deletion for Rename reset and successful Project Steward archive.
- Preserve the user's `.vscode/settings.json` changes.

---

### Task 1: Remove Discovery-Owned Alias Pruning

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:287-421`
- Modify: `src/dashboard.ts:17,1939-1953,2135-2251`

**Interfaces:**
- Consumes: `getAiSessionAliases(): Record<string, string>` and `prepareAiSessionsForDisplay(...)`.
- Produces: an Open Project refresh path in which aliases are read but never pruned from scoped `AiSessionReadResult` values.

- [x] **Step 1: Write the failing regression check**

Add the following assertions inside `runWebviewContentChecks()` after the existing `dashboard` source load:

```js
const withAiSessionsFunction = extractFunctionBody(dashboard, 'withAiSessions');
assert.ok(withAiSessionsFunction.includes('let aliases = getAiSessionAliases();'));
assert.ok(!withAiSessionsFunction.includes('pruneAiSessionAliases('));
assert.ok(!dashboard.includes('function pruneAiSessionAliases('));
```

These assertions encode the ownership rule at the actual wiring boundary: rendering may read aliases, but scoped discovery may not reconcile or delete them.

- [x] **Step 2: Run the safety checks and verify RED**

Run:

```bash
npm run test:safety
```

Expected: FAIL in `runWebviewContentChecks` because `withAiSessions` currently calls `pruneAiSessionAliases(...)` and the pruning function still exists.

- [x] **Step 3: Implement the minimal production fix**

In `withAiSessions`, replace:

```ts
let aliases = pruneAiSessionAliases(getAiSessionAliases(), sessionResults);
```

with:

```ts
let aliases = getAiSessionAliases();
```

Delete the now-unused functions:

```ts
function addAvailableAiSessionKeys(
    sessionKeys: Set<string>,
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>
) { /* existing body */ }

function pruneAiSessionAliases(
    aliases: Record<string, string>,
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>
): Record<string, string> { /* existing body */ }

function getProviderIdFromAiSessionPinKey(
    sessionKey: string
): AiSessionProviderId { /* existing body */ }
```

Remove `getAiSessionProviderIdFromKey` from the `sessionHelpers` import because its only caller is removed. Keep `deleteAiSessionAlias` unchanged so Rename reset and successful archive still remove aliases explicitly.

- [x] **Step 4: Run the focused checks and verify GREEN**

Run:

```bash
npm run test:safety
```

Expected: TypeScript compilation succeeds and output ends with `AI session safety checks passed.`

- [x] **Step 5: Run full repository verification**

Run each command independently:

```bash
npm run lint
npm run webpack
git diff --check
git status --short
```

Expected:

- lint exits 0 with only the repository's existing legacy warnings;
- webpack compiles successfully, with only the existing webpack deprecation warnings;
- `git diff --check` prints no errors;
- status contains the intended plan, test, and production changes plus the pre-existing `.vscode/settings.json` modification.

- [x] **Step 6: Commit the fix without the user's settings change**

```bash
git add src/dashboard.ts scripts/run-ai-session-safety-checks.js docs/superpowers/plans/2026-07-13-ai-session-alias-persistence.md
git commit -m "fix: preserve AI session aliases across refreshes"
```

Expected: the commit includes only the alias persistence plan, regression check, and production fix; `.vscode/settings.json` remains unstaged.
