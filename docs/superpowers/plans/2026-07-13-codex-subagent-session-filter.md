# Codex Subagent Session Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exclude explicitly marked Codex subagent sessions from all Project Steward AI-session results without deleting provider data or changing normal Kimi/Claude session behavior.

**Architecture:** Classify Codex JSONL files from their first `session_meta.payload.source` object and filter explicit `source.subagent` entries at `CodexSessionService`, before any downstream project assignment, terminal resolution, rendering, or management logic. Keep Kimi and Claude production readers unchanged, and protect their existing nested-subagent scan boundaries with real-layout regression fixtures.

**Tech Stack:** TypeScript 4, Node.js `fs`/`path`/`crypto`, provider JSONL fixtures, Node.js `assert` safety checks, VS Code Extension API `^1.51.0`, webpack 5

## Global Constraints

- Filter only Codex metadata with an explicit `session_meta.payload.source.subagent` property.
- Do not infer subagent status from `parent_thread_id` alone.
- Do not delete, move, archive, pin, unpin, or alter provider session files or Project Steward alias/pin state.
- Keep Kimi and Claude production readers unchanged; their nested subagents are already outside their scan boundaries.
- Preserve existing provider cache, watcher, project assignment, resume, archive, batch management, and active-terminal highlighting behavior for visible sessions.
- Add no runtime dependency and keep compatibility with VS Code `^1.51.0` and the repository's TypeScript 4 baseline.
- Preserve the user's `.vscode/settings.json` change.
- Do not stage or commit without explicit user approval.

## File Structure

- Modify `src/services/codexSessionService.ts`: retain explicit subagent classification in internal metadata and skip those sessions in both indexed and file-only discovery paths.
- Modify `scripts/run-ai-session-safety-checks.js`: add realistic Codex, Kimi, and Claude provider-home fixtures plus downstream assignment/terminal-candidate assertions.
- Preserve `src/services/kimiSessionService.ts` and `src/services/claudeSessionService.ts`: no production changes are needed.

---

### Task 1: Provider-Boundary Subagent Filtering and Regression Coverage

**Files:**

- Modify: `src/services/codexSessionService.ts:11-20,55-82,267-322`
- Modify: `scripts/run-ai-session-safety-checks.js:1-35,1456-1490,1550-1565`
- Preserve: `src/services/kimiSessionService.ts`
- Preserve: `src/services/claudeSessionService.ts`

**Interfaces:**

- Produces: internal `CodexSessionMeta.isSubagent?: boolean` and `CodexSessionService.isExplicitSubagentSource(source: unknown): boolean`.
- Consumes: the existing first-line `session_meta` reader, `session_index.jsonl`, `addSessionsFromFiles()`, and unchanged provider service APIs.
- Downstream contract: `getSessions()` returns only visible top-level sessions; no new public type or setting is introduced.

- [ ] **Step 1: Load Codex and Kimi services in the safety harness**

Add the imports beside the existing Claude service import:

```js
const crypto = require('crypto');
const CodexSessionService = require('../out/services/codexSessionService').default;
const KimiSessionService = require('../out/services/kimiSessionService').default;
const ClaudeSessionService = require('../out/services/claudeSessionService').default;
```

Do not move these providers into the temporary `vscode` module shim; the services use filesystem APIs and do not import `vscode`.

- [ ] **Step 2: Add the failing Codex integration fixture**

Add a helper and an executable check before `runClaudeSessionChecks()`:

```js
function writeCodexSessionMetaFile(sessionsDir, sessionId, payload) {
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, JSON.stringify({
        timestamp: payload.timestamp,
        type: 'session_meta',
        payload,
    }) + '\n', 'utf8');
    return sessionFile;
}

function runCodexSubagentSessionFilterChecks() {
    const previousCodexHome = process.env.CODEX_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-codex-subagents-'));
    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '07', '13');
    const indexedNormalId = '11111111-1111-4111-8111-111111111111';
    const indexedSubagentId = '22222222-2222-4222-8222-222222222222';
    const fileNormalId = '33333333-3333-4333-8333-333333333333';
    const fileSubagentId = '44444444-4444-4444-8444-444444444444';
    const parentOnlyId = '55555555-5555-4555-8555-555555555555';
    const malformedIndexedId = '66666666-6666-4666-8666-666666666666';
    try {
        process.env.CODEX_HOME = tempRoot;
        fs.mkdirSync(sessionsDir, { recursive: true });
        const writeMeta = (sessionId, timestamp, extra = {}) => writeCodexSessionMetaFile(
            sessionsDir,
            sessionId,
            { id: sessionId, session_id: sessionId, cwd: '/work/app', timestamp, ...extra }
        );

        writeMeta(indexedNormalId, '2026-07-13T01:00:00.000Z', { source: 'vscode' });
        const indexedSubagentFile = writeMeta(indexedSubagentId, '2026-07-13T02:00:00.000Z', {
            source: { subagent: { thread_spawn: { parent_thread_id: indexedNormalId, depth: 1 } } },
            parent_thread_id: indexedNormalId,
        });
        writeMeta(fileNormalId, '2026-07-13T03:00:00.000Z', { source: 'vscode' });
        const fileSubagentFile = writeMeta(fileSubagentId, '2026-07-13T04:00:00.000Z', {
            source: { subagent: { thread_spawn: { parent_thread_id: indexedNormalId, depth: 1 } } },
            parent_thread_id: indexedNormalId,
        });
        writeMeta(parentOnlyId, '2026-07-13T05:00:00.000Z', {
            source: 'vscode',
            parent_thread_id: indexedNormalId,
        });
        fs.writeFileSync(path.join(sessionsDir, `${malformedIndexedId}.jsonl`), 'not-json\n', 'utf8');
        fs.writeFileSync(path.join(tempRoot, 'session_index.jsonl'), [
            { id: indexedNormalId, thread_name: 'Parent', updated_at: '2026-07-13T01:00:00.000Z' },
            { id: indexedSubagentId, thread_name: 'Worker', updated_at: '2026-07-13T02:00:00.000Z' },
            { id: malformedIndexedId, thread_name: 'Index fallback', updated_at: '2026-07-13T06:00:00.000Z' },
        ].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

        const result = new CodexSessionService().getSessions();
        assert.strictEqual(result.available, true);
        assert.deepStrictEqual(new Set(result.sessions.map(session => session.id)), new Set([
            indexedNormalId,
            fileNormalId,
            parentOnlyId,
            malformedIndexedId,
        ]));
        assert.strictEqual(fs.existsSync(indexedSubagentFile), true);
        assert.strictEqual(fs.existsSync(fileSubagentFile), true);

        const assignments = helpers.assignAiSessionsToProjects(
            [{ project: { id: 'app' }, path: '/work/app' }],
            result.sessions,
            session => session.cwd
        );
        assert.deepStrictEqual(
            new Set((assignments.get('app') || []).map(session => session.id)),
            new Set([indexedNormalId, fileNormalId, parentOnlyId])
        );

        const terminalService = new AiSessionTerminalService(
            path.join(tempRoot, 'storage'),
            providerId => providers.getAiSessionProviderDefinition(providerId),
            0
        );
        const subagentTerminal = {
            name: 'Codex restored',
            creationOptions: { env: { PROJECT_STEWARD_CODEX_SESSION_ID: indexedSubagentId } },
        };
        assert.strictEqual(
            terminalService.resolveTerminalSession(subagentTerminal, () => result.sessions),
            null
        );
    } finally {
        if (previousCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = previousCodexHome;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}
```

The assignment expectation intentionally excludes `malformedIndexedId`: it lacks a readable `cwd`, although the existing index fallback keeps it in the provider result.

- [ ] **Step 3: Add real-layout Kimi and Claude boundary guards**

Add this Kimi check beside the Codex check:

```js
function runKimiNestedSubagentBoundaryChecks() {
    const previousKimiHome = process.env.KIMI_SHARE_DIR;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-kimi-subagents-'));
    const workDir = '/work/app';
    const sessionId = '77777777-7777-4777-8777-777777777777';
    try {
        process.env.KIMI_SHARE_DIR = tempRoot;
        fs.writeFileSync(path.join(tempRoot, 'kimi.json'), JSON.stringify({
            work_dirs: [{ path: workDir }],
        }), 'utf8');
        const workDirHash = crypto.createHash('md5').update(workDir, 'utf8').digest('hex');
        const sessionDir = path.join(tempRoot, 'sessions', workDirHash, sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'wire.jsonl'), '{}\n', 'utf8');
        fs.writeFileSync(path.join(sessionDir, 'state.json'), '{}', 'utf8');

        const nestedSubagentDir = path.join(sessionDir, 'subagents', 'a12345678');
        fs.mkdirSync(nestedSubagentDir, { recursive: true });
        fs.writeFileSync(path.join(nestedSubagentDir, 'wire.jsonl'), '{}\n', 'utf8');

        const result = new KimiSessionService().getSessions({ candidatePaths: [workDir] });
        assert.strictEqual(result.available, true);
        assert.deepStrictEqual(result.sessions.map(session => session.id), [sessionId]);
    } finally {
        if (previousKimiHome === undefined) {
            delete process.env.KIMI_SHARE_DIR;
        } else {
            process.env.KIMI_SHARE_DIR = previousKimiHome;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}
```

Extend `runClaudeSessionChecks()` after creating the top-level session file:

```js
const nestedSubagentDir = path.join(sessionDir, sessionId, 'subagents');
fs.mkdirSync(nestedSubagentDir, { recursive: true });
fs.writeFileSync(
    path.join(nestedSubagentDir, 'agent-a1234567890abcdef.jsonl'),
    cwdLine,
    'utf8'
);
```

The existing Claude assertion must still return exactly `[sessionId]`.

Call the new checks from `main()` immediately before `runClaudeSessionChecks()`:

```js
runCodexSubagentSessionFilterChecks();
runKimiNestedSubagentBoundaryChecks();
runClaudeSessionChecks();
```

- [ ] **Step 4: Run the safety suite and verify RED**

Run:

```bash
npm run test:safety
```

Expected: TypeScript compilation succeeds, then `runCodexSubagentSessionFilterChecks()` fails because `indexedSubagentId` and `fileSubagentId` are present in the actual result. Kimi and Claude characterization assertions are expected to pass once execution reaches them.

- [ ] **Step 5: Retain explicit Codex subagent classification**

Extend the internal metadata type in `src/services/codexSessionService.ts`:

```ts
interface CodexSessionMeta {
    id?: string;
    session_id?: string;
    cwd?: string;
    timestamp?: string;
    isSubagent?: boolean;
}
```

Add this private classifier near `readSessionMeta()`:

```ts
private isExplicitSubagentSource(source: unknown): boolean {
    return Boolean(
        source
        && typeof source === 'object'
        && Object.prototype.hasOwnProperty.call(source, 'subagent')
    );
}
```

Return the classification from `readSessionMeta()` without exposing it through `CodexSession`:

```ts
return {
    id: payload.id,
    session_id: payload.session_id,
    cwd: payload.cwd,
    timestamp: payload.timestamp || event.timestamp,
    isSubagent: this.isExplicitSubagentSource(payload.source),
};
```

- [ ] **Step 6: Filter both Codex discovery paths**

In the `session_index.jsonl` loop, skip only explicit subagents after reading metadata:

```ts
let meta = this.readSessionMeta(entry.id, sessionFiles);
if (meta?.isSubagent) {
    continue;
}
```

In `addSessionsFromFiles()`, preserve the existing missing-metadata skip and add the same explicit filter:

```ts
let meta = this.readSessionMeta(sessionId, sessionFiles);
if (!meta || meta.isSubagent) {
    continue;
}
```

Do not filter on `parent_thread_id`, file name, title, agent nickname, or directory date. Do not mutate the `sessionFiles` map, so archive lookup and watcher fingerprint behavior remain unchanged.

- [ ] **Step 7: Run focused verification and verify GREEN**

Run:

```bash
npm run test:safety
git diff --check
```

Expected:

- compilation succeeds;
- `AI session safety checks passed.` is printed;
- indexed and file-only Codex subagents are absent;
- parent-only and malformed-index fallback behavior is preserved;
- Kimi and Claude nested decoys remain excluded;
- the two subagent JSONL files still exist;
- diff check exits 0.

- [ ] **Step 8: Review checkpoint**

Inspect:

```bash
git diff -- src/services/codexSessionService.ts scripts/run-ai-session-safety-checks.js
git status --short
git diff --cached --quiet
```

Expected: only the approved provider/test changes plus the uncommitted design/plan documents are in feature scope, `.vscode/settings.json` remains separate, and the index is empty. Present the diff for review; do not stage or commit.

---

### Task 2: Full Verification and Manual Dashboard Check

**Files:**

- Verify: `src/services/codexSessionService.ts`
- Verify: `scripts/run-ai-session-safety-checks.js`
- Verify: `docs/superpowers/specs/2026-07-13-codex-subagent-session-filter-design.md`
- Verify: `docs/superpowers/plans/2026-07-13-codex-subagent-session-filter.md`
- Preserve: `.vscode/settings.json`

**Interfaces:**

- Consumes: the filtered `CodexSessionService.getSessions()` result from Task 1.
- Produces: evidence that subagents are hidden without provider data deletion or cross-provider regressions.

- [ ] **Step 1: Run the complete automated verification set**

Run:

```bash
npm run test:safety
npm run lint
npm run webpack
cmp -s src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git diff --check
```

Expected:

- safety checks print `AI session safety checks passed.`;
- lint exits 0, allowing only the repository's existing legacy warnings;
- webpack compiles successfully, allowing only the two existing webpack deprecation warnings;
- generated Webview JavaScript remains byte-identical even though this feature does not modify it;
- diff check exits 0.

- [ ] **Step 2: Audit exact scope and data safety**

Run:

```bash
git status --short
git diff --stat
git diff -- src/services/codexSessionService.ts scripts/run-ai-session-safety-checks.js
git diff --cached --quiet
```

Expected:

- feature scope contains only the Codex service, safety checks, design, and plan;
- Kimi and Claude production services are unchanged;
- `.vscode/settings.json` remains an unrelated unstaged user modification;
- no provider session directory under `~/.codex`, `~/.kimi`, or `~/.claude` was modified by tests, because fixtures use temporary homes;
- no staged changes or commit exists.

- [ ] **Step 3: Run the manual Dashboard smoke check**

In a real Extension Development Host:

1. Open the project containing a normal Codex parent session and one or more spawned subagents.
2. Refresh or reopen the Sidebar and select Codex.
3. Confirm the normal parent session remains visible and every explicitly marked subagent row is absent.
4. Confirm pinned normal sessions, aliases, resume, archive, batch management, and active-terminal highlighting still work.
5. Switch to Kimi and Claude and confirm their normal top-level sessions remain unchanged.
6. Confirm the underlying Codex subagent JSONL files still exist after the check.

- [ ] **Step 4: Present results for user review**

Report command exit codes, warning categories, exact changed paths, and manual observations. Do not stage or commit until the user explicitly approves.
