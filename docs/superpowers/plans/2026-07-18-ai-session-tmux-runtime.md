# AI Session Tmux Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent tmux backend for Codex, Kimi, and Claude sessions, with configurable executable path and project/session layouts, while preserving the existing Direct Terminal behavior.

**Architecture:** Introduce a backend-neutral runtime coordinator in front of the current terminal service. Keep Direct Terminal as an adapter over the existing PID/marker implementation; add a tmux backend composed from pure layout/identity functions, a shell-free tmux process client, durable runtime records, discovery, and an attach-terminal registry. Controllers and projections consume runtime snapshots instead of assuming that every active AI session owns a live VS Code `Terminal`.

**Tech Stack:** TypeScript 4.0, Node.js 14 APIs, VS Code Extension API ^1.51, tmux CLI, plain Webview JavaScript, SCSS/CSS, Node `assert` safety scripts, Webpack, Gulp.

## Global Constraints

- `projectSteward.aiSessionTerminalMode` is machine-scoped, defaults to `vscode`, and accepts only `vscode` or `tmux`.
- `projectSteward.aiSessionTmuxLayout` is machine-scoped, defaults to `project`, and accepts only `project` or `session`.
- `projectSteward.aiSessionTmuxPath` is machine-scoped, defaults to `tmux`, and represents one executable name or path with no additional arguments.
- Existing live runtimes win over current settings; mode and layout changes never migrate a running provider process.
- Project layout uses one managed tmux session per project and one managed tmux window per AI session.
- Session layout uses one managed tmux session per AI session.
- Closing a tmux attach terminal detaches only; it never kills the provider process.
- V1 does not add kill, migration, pane layout, grouped viewer sessions, custom socket arguments, automatic installation, or native Windows support.
- Multiple clients attached to one project tmux session share its current window.
- Direct Terminal behavior, provider discovery, aliases, pins, archive guards, Active/History tabs, and attention must remain compatible.
- Never modify a tmux target unless compatible `@project-steward-*` metadata proves ownership.
- Tmux control commands use argument arrays with `shell: false`; prompts, credentials, full environment dumps, and complete provider commands never enter logs.
- Tmux runtime records live under extension-host global storage; attach-client PID records remain workspace-scoped.
- Support VS Code 1.51: do not depend on `Memento.keys()` or APIs added after 1.51.
- Keep production code provider-neutral; Codex, Kimi, and Claude differences stay in provider definitions and launch specifications.

## File Structure

### New production files

- `src/aiSessions/runtimeTypes.ts`: backend-neutral runtime identities, snapshots, requests, results, and backend interfaces.
- `src/aiSessions/runtimeConfiguration.ts`: validated machine setting resolution.
- `src/aiSessions/launchSpec.ts`: provider launch specifications plus Direct Terminal and POSIX tmux serializers.
- `src/aiSessions/tmuxLayout.ts`: stable names, hashes, locators, metadata schemas, and layout strategies.
- `src/aiSessions/tmuxRuntimeBindingStore.ts`: atomic per-record global-storage persistence and bounded pruning.
- `src/aiSessions/tmuxAttachBindingStore.ts`: workspace PID bindings for surviving attach terminals.
- `src/aiSessions/tmuxCreationLock.ts`: bounded cross-extension-instance creation lock.
- `src/aiSessions/tmuxClient.ts`: typed tmux CLI boundary with an injectable runner.
- `src/aiSessions/tmuxRuntimeDiscovery.ts`: managed metadata enumeration, lifecycle classification, caching, and hint reconciliation.
- `src/aiSessions/tmuxRuntimeBackend.ts`: project/session ensure, pending/final rename, focus, attach, and detach operations.
- `src/aiSessions/directTerminalRuntimeBackend.ts`: adapter around `AiSessionTerminalService`.
- `src/aiSessions/runtimeCoordinator.ts`: lookup precedence, conflicts, fallback, single-flight, and unified runtime snapshots.

### New verification files

- `scripts/run-ai-session-tmux-checks.js`: deterministic unit/controller checks using fake tmux and VS Code boundaries.
- `scripts/run-ai-session-tmux-smoke-checks.js`: real tmux checks on an isolated random server.

### Existing files modified by integration

- `package.json`: settings and tmux test scripts.
- `src/aiSessions/types.ts`: provider launch builder and Active view-model fields.
- `src/aiSessions/commandBuilders.ts`: build commands through structured launch specifications.
- `src/aiSessions/providers.ts`: expose provider launch-spec builders.
- `src/aiSessions/terminalService.ts`: consume Direct Terminal serialized launch specifications without changing terminal ownership semantics.
- `src/aiSessions/creationController.ts`: request a pending runtime instead of directly creating a terminal.
- `src/aiSessions/resumeController.ts`: request or focus a runtime instead of directly sending a resume command.
- `src/aiSessions/terminalCommandController.ts`: focus a runtime and close/direct or detach/tmux clients through the coordinator.
- `src/aiSessions/pendingTerminals.ts`: match backend-neutral pending runtime records.
- `src/aiSessions/pendingTerminalResolver.ts`: promote pending runtimes without requiring a terminal object.
- `src/aiSessions/projectHydrationController.ts`: consume coordinator active/pending snapshots.
- `src/aiSessions/activeSessionProjection.ts`: project Direct and tmux runtimes, backend badges, attachment state, and conflicts.
- `src/aiSessions/attentionController.ts`: inspect runtime completion rather than terminal-only completion.
- `src/aiSessions/archiveController.ts`: block archive for any active runtime backend.
- `src/dashboard.ts`: construct services, restore attach clients, refresh discovery, handle configuration changes, and wire controllers.
- `src/dashboard/runtimeController.ts`: publish backend-neutral focused runtime identity.
- `src/webview/webviewContent.ts`: render tmux/conflict metadata and Close versus Detach actions.
- `src/webview/webviewProjectScripts.js`: emit the correct close/detach intent and preserve runtime attributes during incremental updates.
- `media/styles.scss`: quiet tmux badge and conflict state styling.
- `media/webviewProjectScripts.js`, `media/styles.css`: generated Webview assets.
- `README.md`, `CHANGELOG.md`: user-facing configuration, host-lifetime limitation, and V1 behavior.
- `scripts/run-ai-session-safety-checks.js`: regression assertions that runtime integration remains connected.

---

### Task 1: Runtime Settings and Domain Types

**Files:**
- Create: `src/aiSessions/runtimeTypes.ts`
- Create: `src/aiSessions/runtimeConfiguration.ts`
- Create: `scripts/run-ai-session-tmux-checks.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `AiSessionRuntimeConfiguration`, `AiSessionRuntimeIdentity`, `AiSessionRuntimeSnapshot`, `AiSessionPendingRuntimeSnapshot`, `AiSessionRuntimeBackend`, and `readAiSessionRuntimeConfiguration()`.
- Consumes: `AiSessionProviderId` from `src/models.ts` and a minimal `{ get<T>(key, fallback): T }` configuration reader.

- [ ] **Step 1: Write the failing configuration and type-contract checks**

Create `scripts/run-ai-session-tmux-checks.js` with a configuration reader fixture and manifest assertions:

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtimeConfiguration = require('../out/aiSessions/runtimeConfiguration');

function config(values) {
    return { get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback };
}

function runRuntimeConfigurationChecks() {
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({})), {
        mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux',
    });
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({
        aiSessionTerminalMode: 'tmux', aiSessionTmuxLayout: 'session', aiSessionTmuxPath: '/opt/bin/tmux',
    })), { mode: 'tmux', tmuxLayout: 'session', tmuxPath: '/opt/bin/tmux' });
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({
        aiSessionTerminalMode: 'bad', aiSessionTmuxLayout: 'bad', aiSessionTmuxPath: '   ',
    })), { mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' });

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    assert.deepStrictEqual(properties['projectSteward.aiSessionTerminalMode'].enum, ['vscode', 'tmux']);
    assert.strictEqual(properties['projectSteward.aiSessionTerminalMode'].scope, 'machine');
    assert.strictEqual(properties['projectSteward.aiSessionTmuxLayout'].default, 'project');
    assert.strictEqual(properties['projectSteward.aiSessionTmuxPath'].scope, 'machine');
}

runRuntimeConfigurationChecks();
console.log('AI session tmux checks passed.');
```

- [ ] **Step 2: Run the focused check to verify it fails**

Run: `npm run test-compile && node scripts/run-ai-session-tmux-checks.js`

Expected: FAIL because `out/aiSessions/runtimeConfiguration` does not exist and the three settings are absent.

- [ ] **Step 3: Add exact runtime types and validated setting resolution**

Define these contracts in `runtimeTypes.ts`:

```ts
export type AiSessionRuntimeBackendId = 'vscode' | 'tmux';
export type AiSessionTmuxLayout = 'project' | 'session';
export type AiSessionRuntimeState = 'pending' | 'active' | 'completed' | 'stopped' | 'conflict';

export interface AiSessionRuntimeIdentity {
    provider: AiSessionProviderId;
    projectKey: string;
    cwd: string;
    sessionId?: string;
    pendingId?: string;
}

export interface AiSessionTmuxLocator {
    layout: AiSessionTmuxLayout;
    sessionName: string;
    windowName?: string;
}

export interface AiSessionRuntimeSnapshot<TTerminal = unknown> {
    identity: AiSessionRuntimeIdentity;
    backend: AiSessionRuntimeBackendId;
    state: AiSessionRuntimeState;
    markerPath: string;
    runStartedAtMs: number;
    attached: boolean;
    terminal?: TTerminal;
    tmux?: AiSessionTmuxLocator;
}

export interface AiSessionPendingRuntimeSnapshot<TTerminal = unknown> extends AiSessionRuntimeSnapshot<TTerminal> {
    state: 'pending';
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
}

export interface AiSessionRuntimeConfiguration {
    mode: AiSessionRuntimeBackendId;
    tmuxLayout: AiSessionTmuxLayout;
    tmuxPath: string;
}
```

Add request/result/backend interfaces with these exact method names:

```ts
export interface AiSessionRuntimeBackend<TTerminal = unknown> {
    refresh(force?: boolean): Promise<void>;
    getActive(): AiSessionRuntimeSnapshot<TTerminal>[];
    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[];
    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[];
    focus(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void>;
    detach(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void>;
}
```

Implement `readAiSessionRuntimeConfiguration()` with strict enum checks and `trim()` on the executable. Add the three `scope: "machine"` manifest settings with descriptions from the design. Add scripts:

```json
"test:tmux": "npm run test-compile && node scripts/run-ai-session-tmux-checks.js",
"test:tmux:smoke": "npm run test-compile && node scripts/run-ai-session-tmux-smoke-checks.js"
```

- [ ] **Step 4: Run the focused check to verify it passes**

Run: `npm run test:tmux`

Expected: PASS with `AI session tmux checks passed.`

- [ ] **Step 5: Commit the settings and domain contracts**

```bash
git add package.json scripts/run-ai-session-tmux-checks.js src/aiSessions/runtimeTypes.ts src/aiSessions/runtimeConfiguration.ts
git commit -m "feat: define AI session runtime settings"
```

### Task 2: Structured Provider Launch Specifications

**Files:**
- Create: `src/aiSessions/launchSpec.ts`
- Modify: `src/aiSessions/commandBuilders.ts`
- Modify: `src/aiSessions/types.ts`
- Modify: `src/aiSessions/providers.ts`
- Modify: `src/aiSessions/terminalService.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `AiSessionLaunchSpec`, `serializeDirectLaunchCommand()`, `serializeTmuxLaunchCommand()`, and provider `buildResumeLaunchSpec` / `buildNewSessionLaunchSpec` functions.
- Consumes: runtime platform types and the existing command-builder quoting rules.

- [ ] **Step 1: Add failing launch-spec and quoting checks**

Add assertions covering Codex, Kimi, Claude, POSIX, PowerShell, marker creation, and metacharacters:

```js
const launchSpec = require('../out/aiSessions/launchSpec');
const commandBuilders = require('../out/aiSessions/commandBuilders');

function runLaunchSpecChecks() {
    const spec = commandBuilders.buildCodexResumeLaunchSpec(
        `session'; touch /tmp/nope; '`,
        `/work/it's app`,
        `/tmp/done marker`
    );
    assert.deepStrictEqual(spec.executable, 'codex');
    assert.deepStrictEqual(spec.args, ['resume', '--cd', `/work/it's app`, `session'; touch /tmp/nope; '`]);
    const tmuxCommand = launchSpec.serializeTmuxLaunchCommand(spec);
    assert.ok(tmuxCommand.startsWith("exec /bin/sh -lc "));
    assert.ok(tmuxCommand.includes("'\\''"));
    assert.strictEqual(commandBuilders.buildClaudeNewSessionLaunchSpec('/work/app', 'Title', '/tmp/m').cwd, '/work/app');
    assert.ok(launchSpec.serializeDirectLaunchCommand(spec, 'win32').includes('powershell'));
}
```

- [ ] **Step 2: Run the focused check to verify it fails**

Run: `npm run test:tmux`

Expected: FAIL because launch-spec builders and serializers are not exported.

- [ ] **Step 3: Implement launch specifications and keep legacy builders compatible**

Define:

```ts
export interface AiSessionLaunchSpec {
    executable: string;
    args: string[];
    cwd?: string;
    markerPath?: string;
}

export function serializeDirectLaunchCommand(
    spec: AiSessionLaunchSpec,
    platform: NodeJS.Platform = process.platform
): string;

export function serializeTmuxLaunchCommand(spec: AiSessionLaunchSpec): string;
```

Use one shared POSIX argument quote function. The tmux serializer must return a single command argument shaped as `exec /bin/sh -lc <quoted lifecycle body>`; the lifecycle body removes the old marker, runs the quoted executable and args from the quoted cwd, captures `$?`, creates the marker, and exits with the captured code. The Windows Direct serializer must preserve the current PowerShell marker behavior.

Add these builder exports in `commandBuilders.ts`:

```ts
buildCodexResumeLaunchSpec
buildCodexNewSessionLaunchSpec
buildKimiResumeLaunchSpec
buildKimiNewSessionLaunchSpec
buildClaudeResumeLaunchSpec
buildClaudeNewSessionLaunchSpec
```

Keep existing `build*Command` exports as thin `serializeDirectLaunchCommand(build*LaunchSpec(...))` adapters so existing callers and tests remain green during the refactor. Extend `AiSessionProviderDefinition` with `buildResumeLaunchSpec` and `buildNewSessionLaunchSpec`; migrate `terminalService.sendNewSessionCommand()` and `.sendResumeCommand()` to serialize the provider spec for Direct Terminal.

- [ ] **Step 4: Run focused and legacy command checks**

Run: `npm run test:tmux && npm run test:safety`

Expected: both PASS; the safety command ends with `AI session safety checks passed.`

- [ ] **Step 5: Commit the provider-neutral launch model**

```bash
git add src/aiSessions/launchSpec.ts src/aiSessions/commandBuilders.ts src/aiSessions/types.ts src/aiSessions/providers.ts src/aiSessions/terminalService.ts scripts/run-ai-session-tmux-checks.js scripts/run-ai-session-safety-checks.js
git commit -m "refactor: model AI provider launch commands"
```

### Task 3: Tmux Identity, Metadata, and Layout Strategies

**Files:**
- Create: `src/aiSessions/tmuxLayout.ts`
- Modify: `src/aiSessions/runtimeTypes.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Produces: `ProjectTmuxLayout`, `SessionTmuxLayout`, `getTmuxRuntimeKey()`, `parseManagedTmuxMetadata()`, `TMUX_METADATA_OPTIONS`.
- Consumes: `AiSessionRuntimeIdentity`, `AiSessionTmuxLocator`, `AiSessionTmuxLayout`.

- [ ] **Step 1: Add failing deterministic layout and metadata checks**

```js
const tmuxLayout = require('../out/aiSessions/tmuxLayout');

function runTmuxLayoutChecks() {
    const identity = { provider: 'codex', projectKey: 'project-key', cwd: '/work/app', sessionId: 'session-1' };
    const project = new tmuxLayout.ProjectTmuxLayout().getLocator(identity);
    const session = new tmuxLayout.SessionTmuxLayout().getLocator(identity);
    assert.match(project.sessionName, /^project-steward-p-[0-9a-f]{16}$/);
    assert.match(project.windowName, /^ai-codex-[0-9a-f]{16}$/);
    assert.match(session.sessionName, /^project-steward-s-codex-[0-9a-f]{16}$/);
    assert.strictEqual(new tmuxLayout.ProjectTmuxLayout().getLocator(identity).sessionName, project.sessionName);
    assert.notStrictEqual(new tmuxLayout.ProjectTmuxLayout().getPendingLocator({ ...identity, sessionId: undefined, pendingId: 'p1' }).windowName, project.windowName);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'project', projectKey: 'project-key', provider: 'codex', sessionId: 'session-1'
    }).provider, 'codex');
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({ managed: '1', version: '99' }), null);
}
```

- [ ] **Step 2: Run the focused check to verify it fails**

Run: `npm run test:tmux`

Expected: FAIL because `tmuxLayout` does not exist.

- [ ] **Step 3: Implement stable, bounded strategies and strict metadata parsing**

Use SHA-256 and the first 16 lowercase hexadecimal characters. Export exact option names:

```ts
export const TMUX_METADATA_OPTIONS = {
    managed: '@project-steward-managed',
    version: '@project-steward-version',
    layout: '@project-steward-layout',
    projectKey: '@project-steward-project-key',
    provider: '@project-steward-provider',
    sessionId: '@project-steward-session-id',
    pendingId: '@project-steward-pending-id',
    createdAt: '@project-steward-created-at',
    marker: '@project-steward-marker',
} as const;
```

`ProjectTmuxLayout.getLocator()` must require project key plus final session ID; `getPendingLocator()` must require a pending ID. `SessionTmuxLayout` follows the same contract. Reject unknown providers, layouts, versions, empty IDs, control characters, and bounded strings over the limits copied from the design.

- [ ] **Step 4: Run the focused check to verify it passes**

Run: `npm run test:tmux`

Expected: PASS.

- [ ] **Step 5: Commit the pure tmux layout model**

```bash
git add src/aiSessions/tmuxLayout.ts src/aiSessions/runtimeTypes.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: define managed tmux layouts"
```

### Task 4: Durable Runtime, Attach, and Lock Stores

**Files:**
- Create: `src/aiSessions/tmuxRuntimeBindingStore.ts`
- Create: `src/aiSessions/tmuxAttachBindingStore.ts`
- Create: `src/aiSessions/tmuxCreationLock.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Produces: `TmuxRuntimeBindingStore`, `TmuxAttachBindingStore`, `withTmuxCreationLock()`.
- Consumes: tmux locators, provider IDs, global-storage directory, workspace `Memento`-compatible get/update interface.

- [ ] **Step 1: Add failing persistence, corruption, symlink, TTL, ordering, and lock checks**

Use a real temporary directory and a fake Memento:

```js
const os = require('os');
const runtimeStoreModule = require('../out/aiSessions/tmuxRuntimeBindingStore');
const attachStoreModule = require('../out/aiSessions/tmuxAttachBindingStore');
const creationLock = require('../out/aiSessions/tmuxCreationLock');

async function runTmuxStoreChecks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-tmux-store-'));
    try {
        const store = new runtimeStoreModule.TmuxRuntimeBindingStore(root, () => Date.parse('2026-07-18T10:00:00Z'));
        await store.setPending({ version: 1, state: 'pending', pendingId: 'p1', provider: 'codex', projectKey: 'pk', cwd: '/work', createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [], layout: 'project', locator: { layout: 'project', sessionName: 'project-steward-p-a', windowName: 'pending-codex-p1' } });
        assert.strictEqual((await store.listPending()).length, 1);
        fs.writeFileSync(path.join(root, 'bad.json'), '{bad');
        fs.symlinkSync('/etc/passwd', path.join(root, 'ignored.json'));
        assert.strictEqual((await store.listPending()).length, 1);
        await store.setKnown({ version: 1, state: 'known', provider: 'codex', sessionId: 's1', projectKey: 'pk', layout: 'project', locator: { layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-a' }, lastSeenAtMs: Date.parse('2026-07-18T09:59:00Z') });
        assert.ok(await store.getKnown('codex', 's1'));

        const state = new Map();
        const attach = new attachStoreModule.TmuxAttachBindingStore({ get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value) });
        attach.set(Promise.resolve(41), { version: 1, layout: 'project', projectKey: 'pk', sessionName: 'project-steward-p-a', terminalNamePrefix: 'Project Steward:' });
        attach.remove(Promise.resolve(41));
        await attach.flush();
        assert.strictEqual(state.size, 0);

        let inside = 0;
        await Promise.all([1, 2].map(() => creationLock.withTmuxCreationLock(root, 'same-key', async () => { assert.strictEqual(inside++, 0); inside--; })));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
```

- [ ] **Step 2: Run the focused check to verify it fails**

Run: `npm run test:tmux`

Expected: FAIL because the three store modules do not exist.

- [ ] **Step 3: Implement bounded atomic records and locks**

`TmuxRuntimeBindingStore` must write a temporary file in the target directory, `fsync`/close it, and rename it over the final hashed filename. Enumerate regular `.json` files only with `lstat`; ignore symlinks and invalid records. Enforce 24-hour pending expiry, 30-day unconfirmed known expiry, 512 known-record cap, 1000 excluded-ID cap, schema version 1, and the string limits used by `terminalBindingStore.ts`.

Expose these exact async methods:

```ts
listPending(): Promise<TmuxPendingRuntimeBinding[]>;
listKnown(): Promise<TmuxKnownRuntimeBinding[]>;
getKnown(provider: AiSessionProviderId, sessionId: string): Promise<TmuxKnownRuntimeBinding | null>;
setPending(record: TmuxPendingRuntimeBinding): Promise<void>;
removePending(pendingId: string): Promise<void>;
setKnown(record: TmuxKnownRuntimeBinding): Promise<void>;
removeKnown(provider: AiSessionProviderId, sessionId: string): Promise<void>;
reconcileKnown(live: readonly AiSessionRuntimeSnapshot[]): Promise<void>;
```

`TmuxAttachBindingStore` mirrors the existing process-Promise queue semantics under a new key prefix `aiSessionTmuxAttachProcessBinding.v1.` and validates PID, layout, project key, target, optional provider/session ID, and title prefix.

`withTmuxCreationLock(root, key, operation)` uses `open(..., 'wx')`, a 5-second bounded wait, 50ms retry polling, and recovery only for a lock whose mtime is more than 30 seconds old. The `finally` block removes only the exact hashed lock file created inside `<globalStorage>/ai-session-tmux-locks`.

- [ ] **Step 4: Run focused checks twice to catch stale state**

Run: `npm run test:tmux && npm run test:tmux`

Expected: both PASS with no leftover temporary or lock records.

- [ ] **Step 5: Commit persistence and locking**

```bash
git add src/aiSessions/tmuxRuntimeBindingStore.ts src/aiSessions/tmuxAttachBindingStore.ts src/aiSessions/tmuxCreationLock.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: persist managed tmux runtime state"
```

### Task 5: Typed Tmux Process Client

**Files:**
- Create: `src/aiSessions/tmuxClient.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Produces: `TmuxClient`, `TmuxCommandRunner`, `TmuxCommandResult`, `TmuxAvailability`, `TmuxWindowRecord`.
- Consumes: configured executable path and metadata option names.

- [ ] **Step 1: Add failing argument-array, availability, no-server, and error-redaction checks**

```js
const tmuxClientModule = require('../out/aiSessions/tmuxClient');

async function runTmuxClientChecks() {
    const calls = [];
    const runner = { run: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.2a\n', stderr: '' };
        if (args[0] === 'list-commands') return { exitCode: 0, stdout: 'new-session\nnew-window\nlist-windows\nset-option\nshow-options\nselect-window\nattach-session\n', stderr: '' };
        if (args[0] === 'list-windows') return { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/tmux' };
        return { exitCode: 0, stdout: '', stderr: '' };
    }};
    const client = new tmuxClientModule.TmuxClient('/opt/bin/tmux', runner);
    assert.deepStrictEqual(await client.checkAvailability(), { available: true, version: '3.2a' });
    assert.deepStrictEqual(await client.listWindows(), []);
    await client.selectWindow({ layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-b' });
    assert.deepStrictEqual(calls[calls.length - 1], { file: '/opt/bin/tmux', args: ['select-window', '-t', 'project-steward-p-a:ai-codex-b'] });
    assert.ok(calls.every(call => Array.isArray(call.args)));
}
```

- [ ] **Step 2: Run the focused check to verify it fails**

Run: `npm run test:tmux`

Expected: FAIL because `TmuxClient` is missing.

- [ ] **Step 3: Implement the only child-process boundary**

The default runner wraps `child_process.execFile` with `shell: false`, UTF-8 output, a 5-second timeout, and a 1 MiB output limit. It returns exit code/stdout/stderr without logging the full command.

`checkAvailability()` must call `-V`, parse a non-empty version, call `list-commands`, and require `new-session`, `new-window`, `list-windows`, `set-option`, `show-options`, `select-window`, and `attach-session`. Add typed methods for list, create session/window, rename session/window, select, read/write session/window user options, and `has-session`. `setExecutablePath()` trims and validates the new executable and clears the cached availability result before any later operation. Treat only the recognized no-server message as an empty list; every other nonzero result raises a redacted `TmuxClientError` containing operation and exit category.

Use these exact public method signatures so Tasks 6 and 7 can inject one fake consistently:

```ts
checkAvailability(): Promise<TmuxAvailability>;
getExecutablePath(): string;
setExecutablePath(executablePath: string): void;
listWindows(): Promise<TmuxWindowRecord[]>;
hasSession(sessionName: string): Promise<boolean>;
createSession(sessionName: string, windowName: string, cwd: string, command: string): Promise<void>;
createWindow(sessionName: string, windowName: string, cwd: string, command: string): Promise<void>;
renameSession(sessionName: string, newName: string): Promise<void>;
renameWindow(sessionName: string, windowName: string, newName: string): Promise<void>;
selectWindow(locator: AiSessionTmuxLocator): Promise<void>;
setSessionOptions(sessionName: string, values: Record<string, string>): Promise<void>;
setWindowOptions(sessionName: string, windowName: string, values: Record<string, string>): Promise<void>;
```

- [ ] **Step 4: Run the focused check to verify it passes**

Run: `npm run test:tmux`

Expected: PASS and captured calls contain the configured executable plus argument arrays only.

- [ ] **Step 5: Commit the process boundary**

```bash
git add src/aiSessions/tmuxClient.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: add typed tmux process client"
```

### Task 6: Managed Runtime Discovery and Lifecycle Classification

**Files:**
- Create: `src/aiSessions/tmuxRuntimeDiscovery.ts`
- Modify: `src/aiSessions/runtimeTypes.ts`
- Modify: `src/aiSessions/tmuxClient.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Produces: `TmuxRuntimeDiscovery.refresh(force)`, `.getActive()`, `.getPending()`, `.find(identity)`, `.invalidate()`.
- Consumes: `TmuxClient.listWindows()`, strict metadata parser, completion-marker predicate, runtime binding store.

- [ ] **Step 1: Add failing discovery, cache, completion, stopped, and collision checks**

```js
const discoveryModule = require('../out/aiSessions/tmuxRuntimeDiscovery');

async function runTmuxDiscoveryChecks() {
    let lists = 0;
    const client = { listWindows: async () => { lists++; return [{
        sessionName: 'project-steward-p-a', windowName: 'ai-codex-b', windowId: '@1',
        metadata: { managed: '1', version: '1', layout: 'project', projectKey: 'pk', provider: 'codex', sessionId: 's1', marker: '/tmp/m', createdAt: '2026-07-18T10:00:00Z' }
    }]; }};
    const discovery = new discoveryModule.TmuxRuntimeDiscovery({
        client, bindingStore: { listPending: async () => [], listKnown: async () => [], reconcileKnown: async () => undefined },
        markerIsCurrent: () => false, nowMs: () => 1000, cacheTtlMs: 500,
    });
    await discovery.refresh();
    await discovery.refresh();
    assert.strictEqual(lists, 1);
    assert.deepStrictEqual(discovery.getActive().map(item => item.identity.sessionId), ['s1']);
    await discovery.refresh(true);
    assert.strictEqual(lists, 2);
    assert.strictEqual(discovery.find({ provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1' }).length, 1);
}
```

- [ ] **Step 2: Run the focused check to verify it fails**

Run: `npm run test:tmux`

Expected: FAIL because discovery is missing.

- [ ] **Step 3: Implement bounded authoritative discovery**

Build runtime snapshots only from compatible managed metadata. Project layout metadata comes from the managed window plus its session project key; session layout metadata comes from its managed session/window. Ignore unmanaged rows. Project a metadata/name mismatch as a collision diagnostic, not a runtime. Merge persisted pending records by locator, preserve pending records during one ambiguous discovery failure, and reconcile known hints after successful enumeration.

Cache only successful snapshots for 500ms. Share an in-flight Promise. A force refresh bypasses the TTL but still joins the in-flight call. Do not classify a missing runtime as completed or stopped on a failed list call. On a successful list call, a vanished known target is `completed` only when its current marker exists; otherwise it is `stopped` and its known hint is cleared.

- [ ] **Step 4: Run focused checks**

Run: `npm run test:tmux`

Expected: PASS with one list call for two cached refreshes and two after the forced refresh.

- [ ] **Step 5: Commit discovery**

```bash
git add src/aiSessions/tmuxRuntimeDiscovery.ts src/aiSessions/runtimeTypes.ts src/aiSessions/tmuxClient.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: discover managed tmux runtimes"
```

### Task 7: Tmux Backend, Layout Operations, and Attach Clients

**Files:**
- Create: `src/aiSessions/tmuxRuntimeBackend.ts`
- Modify: `src/aiSessions/runtimeTypes.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Produces: `TmuxRuntimeBackend.ensureResume()`, `.ensurePending()`, `.promotePending()`, `.focus()`, `.detach()`, `.restoreAttachTerminals()`, `.handleClosedTerminal()`.
- Consumes: `TmuxClient`, both layout strategies, discovery, stores, creation lock, `serializeTmuxLaunchCommand()`, and an injected VS Code terminal factory.

- [ ] **Step 1: Add failing project/session layout, reuse, attach, detach, and promotion checks**

```js
const backendModule = require('../out/aiSessions/tmuxRuntimeBackend');
const tmuxDiscoveryModule = require('../out/aiSessions/tmuxRuntimeDiscovery');

function metadataFromOptions(values) {
    return Object.keys(values).reduce((result, key) => {
        result[key.replace(/^@project-steward-/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = values[key];
        return result;
    }, {});
}

function createTmuxBackendHarness({ client, terminals, windows }) {
    const pending = new Map();
    const known = new Map();
    const runtimeStore = {
        listPending: async () => Array.from(pending.values()),
        listKnown: async () => Array.from(known.values()),
        setPending: async record => pending.set(record.pendingId, record),
        removePending: async pendingId => pending.delete(pendingId),
        setKnown: async record => known.set(`${record.provider}:${record.sessionId}`, record),
        getKnown: async (provider, sessionId) => known.get(`${provider}:${sessionId}`) || null,
        removeKnown: async (provider, sessionId) => known.delete(`${provider}:${sessionId}`),
        reconcileKnown: async () => undefined,
    };
    const discovery = new tmuxDiscoveryModule.TmuxRuntimeDiscovery({
        client, bindingStore: runtimeStore, markerIsCurrent: () => false,
        nowMs: () => Date.parse('2026-07-18T10:00:00Z'), cacheTtlMs: 0,
    });
    return {
        platform: 'linux', client, discovery, runtimeStore,
        attachStore: { set: () => undefined, remove: () => undefined, flush: async () => undefined },
        withCreationLock: async (_key, operation) => operation(),
        createTerminal: creationOptions => {
            const terminal = {
                creationOptions, shown: false, disposed: false,
                processId: Promise.resolve(100 + terminals.length),
                show() { this.shown = true; },
                dispose() { this.disposed = true; },
            };
            terminals.push(terminal);
            return terminal;
        },
        nowMs: () => Date.parse('2026-07-18T10:00:00Z'),
    };
}

function createFakeTmuxBackendDependencies({ operations, terminals }) {
    const windows = [];
    const client = {
        checkAvailability: async () => ({ available: true, version: '3.2a' }),
        getExecutablePath: () => 'tmux',
        setExecutablePath: () => undefined,
        listWindows: async () => windows.slice(),
        hasSession: async name => windows.some(item => item.sessionName === name),
        createSession: async (sessionName, windowName, cwd, command) => { operations.push({ type: 'new-session', sessionName, windowName, cwd, command }); windows.push({ sessionName, windowName, metadata: {} }); },
        createWindow: async (sessionName, windowName, cwd, command) => { operations.push({ type: 'new-window', sessionName, windowName, cwd, command }); windows.push({ sessionName, windowName, metadata: {} }); },
        renameSession: async () => undefined,
        renameWindow: async () => undefined,
        selectWindow: async locator => operations.push({ type: 'select-window', locator }),
        setSessionOptions: async (sessionName, values) => windows.filter(item => item.sessionName === sessionName).forEach(item => { item.metadata = { ...item.metadata, ...metadataFromOptions(values) }; }),
        setWindowOptions: async (sessionName, windowName, values) => { const item = windows.find(candidate => candidate.sessionName === sessionName && candidate.windowName === windowName); if (item) item.metadata = { ...item.metadata, ...metadataFromOptions(values) }; },
    };
    return createTmuxBackendHarness({ client, operations, terminals, windows });
}

async function runTmuxBackendChecks() {
    const operations = [];
    const terminals = [];
    const dependencies = createFakeTmuxBackendDependencies({ operations, terminals });
    const backend = new backendModule.TmuxRuntimeBackend(dependencies);
    await backend.ensureResume({ identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1' }, projectName: 'App', layout: 'project', launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/m' } });
    await backend.ensureResume({ identity: { provider: 'claude', projectKey: 'pk', cwd: '/work', sessionId: 's2' }, projectName: 'App', layout: 'project', launch: { executable: 'claude', args: ['--resume', 's2'], markerPath: '/tmp/m2' } });
    assert.strictEqual(operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(operations.filter(item => item.type === 'new-window').length, 2);
    assert.strictEqual(terminals.length, 1);
    await backend.detach(backend.getActive()[0]);
    assert.strictEqual(terminals[0].disposed, true);
    assert.strictEqual(backend.getActive().length, 2);
}
```

Use the same harness to exercise session layout producing two tmux sessions/two attach terminals, `focus()` selecting the target window, pending creation followed by `promotePending()`, an attach failure that does not call create again, and removal of `TMUX` from terminal environment.

- [ ] **Step 2: Run the focused check to verify it fails**

Run: `npm run test:tmux`

Expected: FAIL because `TmuxRuntimeBackend` is missing.

- [ ] **Step 3: Implement idempotent backend operations**

Add these request and executor contracts to `runtimeTypes.ts`; Tasks 8–11 must use them without renaming fields:

```ts
export interface AiSessionResumeRuntimeRequest {
    identity: AiSessionRuntimeIdentity & { sessionId: string };
    projectName: string;
    terminalName: string;
    launch: AiSessionLaunchSpec;
}

export interface AiSessionCreateRuntimeRequest {
    identity: AiSessionRuntimeIdentity & { pendingId: string };
    projectName: string;
    terminalName: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
    launch: AiSessionLaunchSpec;
}

export interface AiSessionRuntimeActionResult<TTerminal = unknown> {
    status: 'started' | 'focused' | 'cancelled' | 'settings' | 'conflict';
    runtime?: AiSessionRuntimeSnapshot<TTerminal>;
    conflicts?: AiSessionRuntimeSnapshot<TTerminal>[];
}

export interface AiSessionExecutableRuntimeBackend<TTerminal = unknown> extends AiSessionRuntimeBackend<TTerminal> {
    ensureResume(request: AiSessionResumeRuntimeRequest, layout?: AiSessionTmuxLayout): Promise<AiSessionRuntimeSnapshot<TTerminal>>;
    ensurePending(request: AiSessionCreateRuntimeRequest, layout?: AiSessionTmuxLayout): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>>;
    promotePending(pendingId: string, sessionId: string): Promise<AiSessionRuntimeSnapshot<TTerminal>[]>;
}
```

Use this exact constructor boundary in `tmuxRuntimeBackend.ts` so the test harness and dashboard composition do not depend on hidden globals:

```ts
export interface TmuxRuntimeBackendDependencies<TTerminal> {
    platform: NodeJS.Platform;
    client: TmuxClient;
    discovery: TmuxRuntimeDiscovery;
    runtimeStore: TmuxRuntimeBindingStore;
    attachStore: TmuxAttachBindingStore;
    withCreationLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
    createTerminal(options: vscode.TerminalOptions): TTerminal;
    nowMs(): number;
}
```

`ensureResume()` and `ensurePending()` must:

1. check POSIX platform and client availability;
2. acquire the hashed cross-instance lock;
3. force discovery after lock acquisition;
4. reuse a verified target or create exactly one target;
5. set managed metadata before persisting the known/pending record;
6. set window-local `automatic-rename off`, `allow-rename off`, and `remain-on-exit off`;
7. verify discovery postconditions before returning;
8. attach/focus without ever sending the provider command a second time.

Project layout uses one registry key `project:<projectKey>` and calls `select-window` before showing/creating its terminal. Session layout uses `session:<provider>:<sessionId>`. Terminal creation uses `{ shellPath: client.getExecutablePath(), shellArgs: ['attach-session', '-t', sessionName], env: { TMUX: null } }` while preserving other VS Code-inherited environment behavior.

`promotePending()` writes final metadata, renames the window/session, writes a known record, removes the pending record, and refreshes discovery. If the final target already exists with the same identity, reuse it and report conflict instead of killing either source.

- [ ] **Step 4: Run focused checks twice**

Run: `npm run test:tmux && npm run test:tmux`

Expected: PASS; project layout has one attach terminal, session layout has one per AI session, and detach leaves active snapshots intact.

- [ ] **Step 5: Commit the tmux backend**

```bash
git add src/aiSessions/tmuxRuntimeBackend.ts src/aiSessions/runtimeTypes.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: run AI sessions in managed tmux layouts"
```

### Task 8: Direct Backend Adapter and Runtime Coordinator

**Files:**
- Create: `src/aiSessions/directTerminalRuntimeBackend.ts`
- Create: `src/aiSessions/runtimeCoordinator.ts`
- Modify: `src/aiSessions/terminalService.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Produces: `DirectTerminalRuntimeBackend`, `AiSessionRuntimeCoordinator`.
- Consumes: existing terminal service, tmux backend, runtime configuration getter, warning/quick-pick callbacks.

- [ ] **Step 1: Add failing lookup precedence, conflict, fallback, and single-flight checks**

```js
const coordinatorModule = require('../out/aiSessions/runtimeCoordinator');

function fakeRuntime(backend, sessionId) {
    return { identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId }, backend, state: 'active', markerPath: '/tmp/m', runStartedAtMs: 1, attached: true };
}

function fakeResumeRequest(sessionId) {
    return { identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId }, projectName: 'App', terminalName: 'Codex: App', launch: { executable: 'codex', args: ['resume', sessionId], markerPath: '/tmp/m' } };
}

function createFakeRuntimeBackend(backend) {
    const fake = { backend, active: [], pending: [], ensureCalls: 0 };
    fake.refresh = async () => undefined;
    fake.getActive = () => fake.active.slice();
    fake.getPending = () => fake.pending.slice();
    fake.find = identity => fake.active.filter(item => item.identity.provider === identity.provider && item.identity.sessionId === identity.sessionId);
    fake.focus = async () => undefined;
    fake.detach = async () => undefined;
    fake.ensureResume = async request => { fake.ensureCalls++; const runtime = fakeRuntime(backend, request.identity.sessionId); fake.active.push(runtime); return runtime; };
    fake.ensurePending = async request => { fake.ensureCalls++; const runtime = { ...fakeRuntime(backend, ''), identity: request.identity, state: 'pending', createdAt: request.createdAt, excludedSessionIds: request.excludedSessionIds }; fake.pending.push(runtime); return runtime; };
    fake.promotePending = async () => [];
    return fake;
}

async function runRuntimeCoordinatorChecks() {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux');
    const coordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct, tmux, getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseConflict: async runtimes => runtimes[0],
        chooseTmuxFallback: async () => 'cancel',
    });
    tmux.active.push(fakeRuntime('tmux', 's1'));
    const existing = await coordinator.resume(fakeResumeRequest('s1'));
    assert.strictEqual(existing.runtime.backend, 'tmux');
    assert.strictEqual(direct.ensureCalls, 0);
    direct.active.push(fakeRuntime('vscode', 's1'));
    const conflict = await coordinator.resume(fakeResumeRequest('s1'));
    assert.strictEqual(conflict.status, 'conflict');
    assert.strictEqual(direct.ensureCalls + tmux.ensureCalls, 0);
}
```

Also call `resume()` twice before the first Promise resolves and assert one backend ensure call. Simulate tmux unavailable with fallback choices `direct`, `settings`, and `cancel`; assert no setting mutation and explicit direct creation only for `direct`.

- [ ] **Step 2: Run the focused check to verify it fails**

Run: `npm run test:tmux`

Expected: FAIL because coordinator and Direct adapter are missing.

- [ ] **Step 3: Implement backend-neutral orchestration**

The Direct adapter projects existing tracked/pending terminals into runtime snapshots and delegates completion/focus/close to `AiSessionTerminalService`; it does not change PID persistence.

The coordinator refreshes both backends before resume, deduplicates by provider/session ID, projects more than one match as conflict, and consults settings only for no-match creation. Export methods:

```ts
refresh(force?: boolean): Promise<void>;
getActive(): AiSessionRuntimeSnapshot<vscode.Terminal>[];
getPending(): AiSessionPendingRuntimeSnapshot<vscode.Terminal>[];
getById(provider: AiSessionProviderId, sessionId: string): AiSessionRuntimeSnapshot<vscode.Terminal> | null;
resume(request: AiSessionResumeRuntimeRequest): Promise<AiSessionRuntimeActionResult<vscode.Terminal>>;
create(request: AiSessionCreateRuntimeRequest): Promise<AiSessionRuntimeActionResult<vscode.Terminal>>;
promotePending(pendingId: string, sessionId: string): Promise<AiSessionRuntimeSnapshot<vscode.Terminal>[]>;
focus(identity: AiSessionRuntimeIdentity): Promise<void>;
detach(identity: AiSessionRuntimeIdentity): Promise<void>;
handleClosedTerminal(terminal: vscode.Terminal): void;
```

Single-flight keys are `resume:<provider>:<sessionId>` and `pending:<pendingId>`. If a known tmux hint exists but tmux cannot be queried, require the stronger `Resume in VS Code Anyway` decision before Direct creation and clear the hint only after acceptance.

- [ ] **Step 4: Run focused and terminal regression checks**

Run: `npm run test:tmux && npm run test:safety`

Expected: both PASS.

- [ ] **Step 5: Commit runtime orchestration**

```bash
git add src/aiSessions/directTerminalRuntimeBackend.ts src/aiSessions/runtimeCoordinator.ts src/aiSessions/terminalService.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: coordinate AI session runtime backends"
```

### Task 9: Backend-Neutral Pending and Active Projection

**Files:**
- Modify: `src/aiSessions/types.ts`
- Modify: `src/aiSessions/pendingTerminals.ts`
- Modify: `src/aiSessions/pendingTerminalResolver.ts`
- Modify: `src/aiSessions/projectHydrationController.ts`
- Modify: `src/aiSessions/activeSessionProjection.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: Active and pending view models containing `backend`, optional `tmuxLayout`, `attached`, and `conflict`.
- Consumes: coordinator snapshots and existing provider session read results.

- [ ] **Step 1: Add failing detached-tmux, pending-promotion, focus, and conflict projection checks**

```js
function runRuntimeProjectionChecks() {
    const providerFixtures = {
        codex: { id: 'codex', label: 'Codex', projectSessionsKey: 'codexSessions' },
        kimi: { id: 'kimi', label: 'Kimi', projectSessionsKey: 'kimiSessions' },
        claude: { id: 'claude', label: 'Claude', projectSessionsKey: 'claudeSessions' },
    };
    const projected = activeSessionProjection.applyAiSessionRuntimeProjection({
        projects: [{ id: 'p', path: '/work', codexSessions: [{ id: 's1', name: 'One' }], kimiSessions: [], claudeSessions: [] }],
        providers: providerFixtures,
        activeRuntimes: [{ identity: { provider: 'codex', sessionId: 's1', projectKey: 'pk', cwd: '/work' }, markerPath: '/tmp/m', state: 'active', runStartedAtMs: 1, backend: 'tmux', tmux: { layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-b' }, attached: false }],
        pendingRuntimes: [], focusedIdentity: null,
        getProjectCwd: project => project.path, normalizePath: value => value,
    });
    const model = projected[0].activeAiSessions[0];
    assert.strictEqual(model.backend, 'tmux');
    assert.strictEqual(model.tmuxLayout, 'project');
    assert.strictEqual(model.attached, false);
    assert.strictEqual(model.status, 'running');
}
```

Add a resolver fixture whose pending runtime has no terminal object; assert promotion calls `runtimeCoordinator.promotePending()` with the final provider session ID and keeps alias behavior.

- [ ] **Step 2: Run focused checks to verify they fail**

Run: `npm run test:tmux && npm run test:safety`

Expected: FAIL because the projection still accepts `activeTerminals`/`pendingTerminals` and pending promotion requires a terminal.

- [ ] **Step 3: Generalize projection and pending matching**

Rename projection inputs to `activeRuntimes` and `pendingRuntimes`. Extend `ActiveAiSessionStatus` with `conflict`. Extend `ActiveAiSessionViewModel` with:

```ts
backend: AiSessionRuntimeBackendId;
tmuxLayout?: AiSessionTmuxLayout;
attached: boolean;
conflict?: boolean;
```

Keep cwd-first project assignment with provider-history fallback. A detached tmux runtime remains active, and the view-model `tmuxLayout` comes from `runtime.tmux?.layout`. Focus uses the coordinator's selected runtime identity. Pending matching keeps provider/cwd/createdAt/excluded-ID rules, but promotes a runtime locator rather than moving a terminal object. Include the new snapshot fields in hydration cache signatures so backend changes invalidate incremental projections.

- [ ] **Step 4: Run focused and full AI safety checks**

Run: `npm run test:tmux && npm run test:safety`

Expected: both PASS; legacy Direct Terminal projection fixtures remain valid after adding explicit defaults.

- [ ] **Step 5: Commit backend-neutral projections**

```bash
git add src/aiSessions/types.ts src/aiSessions/pendingTerminals.ts src/aiSessions/pendingTerminalResolver.ts src/aiSessions/projectHydrationController.ts src/aiSessions/activeSessionProjection.ts scripts/run-ai-session-tmux-checks.js scripts/run-ai-session-safety-checks.js
git commit -m "refactor: project active AI session runtimes"
```

### Task 10: Creation, Resume, Focus, and Detach Controllers

**Files:**
- Modify: `src/aiSessions/creationController.ts`
- Modify: `src/aiSessions/resumeController.ts`
- Modify: `src/aiSessions/terminalCommandController.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: controller calls into `AiSessionRuntimeCoordinator.create/resume/focus/detach`.
- Consumes: coordinator request/result contracts, existing provider picker, title input, project lookup, and refresh callbacks.

- [ ] **Step 1: Add failing controller checks for both backends and explicit fallback**

Update controller fixtures so creation asserts one coordinator request containing project key/name, cwd, provider launch spec, existing IDs, title, marker path, and created time. Resume asserts the coordinator receives the history session identity and launch spec. Terminal command tests assert:

```js
await controller.focusActive('project', 'codex', 'session');
assert.deepStrictEqual(coordinator.focused, [{ provider: 'codex', sessionId: 'session', projectKey: 'pk', cwd: '/work' }]);
await controller.closeTerminal({ projectId: 'project', providerId: 'codex', sessionId: 'session' });
assert.strictEqual(coordinator.detached.length, 1);
```

Add a tmux detach confirmation expectation with `Detach Terminal`, and retain the Direct Terminal `Close Terminal` confirmation.

- [ ] **Step 2: Run focused checks to verify they fail**

Run: `npm run test:tmux && npm run test:safety`

Expected: FAIL because controllers still create/show/send directly through terminal service.

- [ ] **Step 3: Replace terminal-specific controller dependencies**

Creation keeps provider selection, title input, project validation, existing session-ID capture, and 15-second pending feedback. It delegates the actual runtime start to `coordinator.create()` and watches the returned pending identity.

Resume keeps project/session validation and cwd selection, then delegates to `coordinator.resume()`. A focused/reused result opens `ACTIVE`; cancelled/settings results do not create or track anything; conflict results refresh and announce the conflict.

Terminal commands resolve a runtime within the requested project before calling coordinator focus/detach. Confirmation copy depends on backend. Direct close keeps the interruption warning; tmux detach says the task keeps running. Do not expose a terminate call.

- [ ] **Step 4: Run controller and full safety checks**

Run: `npm run test:tmux && npm run test:safety`

Expected: both PASS.

- [ ] **Step 5: Commit controller integration**

```bash
git add src/aiSessions/creationController.ts src/aiSessions/resumeController.ts src/aiSessions/terminalCommandController.ts scripts/run-ai-session-tmux-checks.js scripts/run-ai-session-safety-checks.js
git commit -m "feat: route AI session actions through runtimes"
```

### Task 11: Attention, Archive, Dashboard Composition, and Configuration Changes

**Files:**
- Modify: `src/aiSessions/attentionController.ts`
- Modify: `src/aiSessions/archiveController.ts`
- Modify: `src/dashboard/runtimeController.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: complete extension-host composition and lifecycle refresh.
- Consumes: all runtime services from Tasks 1–10.

- [ ] **Step 1: Add failing host-wiring and lifecycle regression checks**

Add controller tests proving a detached active tmux runtime blocks archive, a current completion marker produces the existing completed attention signal, and a stopped runtime without a marker produces no completed signal. Add source-wiring assertions:

```js
const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
assert.ok(dashboardSource.includes('new TmuxRuntimeBackend'));
assert.ok(dashboardSource.includes('new AiSessionRuntimeCoordinator'));
assert.ok(dashboardSource.includes('onDidChangeConfiguration'));
assert.ok(dashboardSource.includes("affectsConfiguration('projectSteward.aiSession"));
assert.ok(!dashboardSource.includes('getTerminalById: (providerId, sessionId) => aiSessionTerminalService.getActiveById'));
```

- [ ] **Step 2: Run focused and safety checks to verify they fail**

Run: `npm run test:tmux && npm run test:safety`

Expected: FAIL because attention/archive/dashboard still use terminal-only ownership.

- [ ] **Step 3: Compose services and convert lifecycle consumers**

Construct stores under `context.globalStoragePath`, attach bindings under `context.workspaceState`, the configured `TmuxClient`, discovery, tmux backend, Direct adapter, and coordinator. Restore Direct terminals and tmux attach terminals before the first AI session hydration.

Change attention options to `getRuntimeById` and `isRuntimeComplete`. Only `completed` emits the current terminal-exit signal; `stopped` removes ownership without a completed event. Change archive guards to coordinator active runtime lookup.

Refresh tmux discovery before AI hydration on activation, forced user resume/create, relevant attention refresh, and when the dashboard becomes visible. Reuse cached snapshots during rendering. On terminal close, notify the coordinator before refreshing. On mode/layout/path configuration change, reread runtime configuration; when the path changes call `tmuxClient.setExecutablePath(newConfig.tmuxPath)`, clear its availability cache, invalidate discovery, and refresh without migrating runtimes. Log only redacted operation/category data.

Wire explicit tmux errors to these actions:

- `Use VS Code Terminal This Time`;
- `Resume in VS Code Anyway` with modal duplicate warning for known hints;
- `Open Settings` using the existing settings command.

- [ ] **Step 4: Run compile, tmux, safety, dashboard, and architecture checks**

Run: `npm run test-compile && node scripts/run-ai-session-tmux-checks.js && npm run test:safety && npm run test:dashboard && npm run test:architecture-baseline`

Expected: all commands exit 0; safety and tmux scripts print their pass messages.

- [ ] **Step 5: Commit host integration**

```bash
git add src/aiSessions/attentionController.ts src/aiSessions/archiveController.ts src/dashboard/runtimeController.ts src/dashboard.ts scripts/run-ai-session-tmux-checks.js scripts/run-ai-session-safety-checks.js
git commit -m "feat: integrate tmux runtimes with session lifecycle"
```

### Task 12: Webview UX, Real Tmux Smoke Test, Documentation, and Final Verification

**Files:**
- Create: `scripts/run-ai-session-tmux-smoke-checks.js`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/styles.scss`
- Generate: `media/webviewProjectScripts.js`
- Generate: `media/styles.css`
- Modify: `scripts/run-ai-session-tmux-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Create: `docs/manual-tests/ai-session-tmux-runtime.md`

**Interfaces:**
- Produces: user-visible tmux/runtime status, detach actions, isolated real tmux verification, and release documentation.
- Consumes: `ActiveAiSessionViewModel.backend`, `tmuxLayout`, `attached`, `conflict`, and host message routes.

- [ ] **Step 1: Add failing Webview and real-tmux checks**

Add HTML assertions:

```js
const projectWithTmuxRuntimeFixture = {
    id: 'p', name: 'App', path: '/work/app', activeAiSessionTab: 'active',
    activeAiSessions: [{ key: 'codex:s1', provider: 'codex', sessionId: 's1', name: 'One', status: 'running', focused: false, needsAttention: false, pending: false, backend: 'tmux', tmuxLayout: 'project', attached: false }],
    codexSessions: [], kimiSessions: [], claudeSessions: [],
};
const projectWithDirectRuntimeFixture = {
    ...projectWithTmuxRuntimeFixture,
    activeAiSessions: [{ ...projectWithTmuxRuntimeFixture.activeAiSessions[0], backend: 'vscode', tmuxLayout: undefined, attached: true }],
};
const tmuxRow = webviewContentModule.getAiSessionsDiv(projectWithTmuxRuntimeFixture);
assert.ok(tmuxRow.includes('data-session-backend="tmux"'));
assert.ok(tmuxRow.includes('ai-session-runtime-badge'));
assert.ok(tmuxRow.includes('tmux'));
assert.ok(tmuxRow.includes('Detach Terminal…'));
assert.ok(tmuxRow.includes('data-action="detach-ai-session-terminal"'));
const directRow = webviewContentModule.getAiSessionsDiv(projectWithDirectRuntimeFixture);
assert.ok(directRow.includes('Close Terminal…'));
```

Create `run-ai-session-tmux-smoke-checks.js` using `execFileSync` only. Generate `serverName = project-steward-test-<pid>-<random>`, call the configured path or `tmux`, always pass `-L serverName -f /dev/null`, and register `finally` cleanup with `kill-server`. Start two long-running fake provider commands using Node executables or `/bin/sh` marker fixtures; assert project layout has one session/two managed windows, session layout has two sessions, detached sessions keep their panes alive, metadata survives a new discovery instance, pending rename works, and provider exit removes only its window. Terminal-client detach itself remains covered by the fake VS Code backend test and the manual matrix because a real `attach-session` requires an interactive PTY.

- [ ] **Step 2: Run focused checks to verify they fail**

Run: `npm run test:tmux`

Expected: FAIL because runtime badges/actions and the smoke script are absent.

- [ ] **Step 3: Implement the final user experience and isolated smoke harness**

Render `tmux` as a quiet badge in Active rows, `Runtime conflict` for conflicts, and backend-specific actions. A detached tmux row stays clickable and active. The Webview sends `detach-ai-session-terminal` only for tmux; Direct rows retain `close-ai-session-terminal`. Preserve backend/layout/attachment attributes in incremental DOM patches and keyboard/context-menu actions.

Add SCSS using VS Code theme variables, visible focus, high-contrast borders, and no animation requirement. Run Gulp to copy/minify generated assets:

```bash
npx gulp copyWebviewAssets buildStyles --production
```

Document all three settings, project/session layouts, explicit fallback, detach semantics, Remote/Container behavior, native Windows limitation, shared current window across clients, and the host-awake requirement. Add the pure tmux script to `test:safety`; keep the real smoke test as `test:tmux:smoke` so ordinary CI never touches a user's tmux server.

- [ ] **Step 4: Run real smoke and the complete verification matrix**

Run:

```bash
npm run test:tmux
npm run test:tmux:smoke
npm run test:safety
npm run test:dashboard
npm run test:open-projects
npm run test:architecture-baseline
npm run lint
npm run webpack
npm run vscode:prepublish
git diff --check
```

Expected:

- all commands exit 0;
- tmux smoke prints `AI session tmux smoke checks passed.` and removes its isolated server;
- safety prints `AI session safety checks passed.`;
- lint has zero errors;
- Webpack and prepublish complete without errors;
- `git diff --check` prints nothing.

- [ ] **Step 5: Perform the manual acceptance matrix and record evidence**

Use the repository's local VSIX installation workflow to verify local Linux first, then record results for macOS/Homebrew path, Remote SSH, Dev Container, WSL, native Windows warning, reload, full reopen, disconnect/reconnect, both layouts, all three providers, detach/reattach, setting changes, and shared-window multi-client behavior. Save evidence in `docs/manual-tests/ai-session-tmux-runtime.md` with exact environment, action, observed result, and pass/fail; do not claim an environment passed without running it.

- [ ] **Step 6: Commit UX, tests, generated assets, and documentation**

```bash
git add package.json src/webview/webviewContent.ts src/webview/webviewProjectScripts.js media/webviewProjectScripts.js media/styles.scss media/styles.css scripts/run-ai-session-tmux-checks.js scripts/run-ai-session-tmux-smoke-checks.js scripts/run-ai-session-safety-checks.js README.md CHANGELOG.md docs/manual-tests/ai-session-tmux-runtime.md
git commit -m "feat: complete tmux AI session experience"
```

## Final Review Gate

Before push or PR creation:

1. Run `git status -sb` and confirm only intentional implementation work remains.
2. Run the complete Task 12 verification matrix again from the final commit.
3. Review `git diff <base>...HEAD --stat` and `git diff <base>...HEAD --check`.
4. Compare every acceptance criterion in `docs/superpowers/specs/2026-07-18-ai-session-tmux-runtime-design.md` to implementation and recorded evidence.
5. Use the repository's review/fix/commit loop before publishing.
6. Do not push, open a PR, merge, or install a VSIX unless the user separately authorizes that action.
