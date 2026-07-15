# AI Session Terminal Process-ID 归属恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 VS Code 重载后仍可获得的 `Terminal.processId` 恢复 Project Steward terminal 与 AI session 的归属，避免点击 session 卡片重复打开 terminal。

**Architecture:** `AiSessionTerminalBindingStore` 使用 `aiSessionTerminalProcessBinding.v2.<pid>` 独立 key 保存 `pending`/`bound` 记录，并把带 2 秒上限的 PID Promise 解析纳入自身串行写队列。`AiSessionTerminalService` 不再依赖创建环境中的随机实例 ID；激活时异步读取每个 terminal 的 process ID，并用 provider terminal 名称前缀防止 PID 重用误绑定，恢复完成后 dashboard 才继续注册视图、首次刷新和 attention interval。

**Tech Stack:** TypeScript、VS Code Extension API `Terminal.processId`/`Memento`、现有 Node.js 安全回归脚本、Webpack、VSCE。

## Global Constraints

- 只跟踪由 Project Steward 创建的 AI terminal。
- 保证 `Developer: Reload Window` 且原 terminal 进程仍存活的恢复场景。
- 不保证完整退出后 terminal 进程以不同 PID 重建的恢复场景。
- 不读取 `/proc`，保持本地、SSH 和 DevContainer 的统一实现。
- 不修改 provider 生命周期解析、attention payload 或 Webview UI。
- 持久化失败不得阻止 provider 命令执行。
- 保留用户未提交的 `.vscode/settings.json`、`docs/assets/` 和 `docs/running-projects-tabs-prd.md`。

---

### Task 1: 将绑定存储改为 process-ID v2 key

**Files:**
- Modify: `src/aiSessions/terminalBindingStore.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: VS Code `Memento` 兼容的 `AiSessionTerminalBindingState`。
- Produces: `AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX`、`get(processId)`、`setPending(processIdOrPromise, record)`、`setBound(processIdOrPromise, record)`、`remove(processIdOrPromise)`、`flush()`。

- [x] **Step 1: Write the failing process-ID store test**

把 store 测试的随机 32 位 ID 替换为 PID，并断言 v2 key：

```js
const processId = 42001;
first.setPending(Promise.resolve(processId), pendingRecord);
await first.flush();
assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId).state, 'pending');
assert.ok(stateData[AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + processId]);
```

并保留两个 store 的并发写测试，分别使用 `42002` 和 `42003`，证明不同 PID key 不会覆盖。

- [x] **Step 2: Run the store test and verify RED**

Run: `npm run test-compile && node scripts/run-ai-session-safety-checks.js`

Expected: FAIL，因为当前 store 只接受 32 位十六进制实例 ID，process-ID 记录无法写入或读取。

- [x] **Step 3: Implement the v2 process-ID store**

在 `terminalBindingStore.ts` 中改为：

```ts
export const AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX = 'aiSessionTerminalProcessBinding.v2.';
export type AiSessionTerminalProcessId = number | PromiseLike<number | undefined>;

get(processId: number): AiSessionTerminalBinding | null;
setPending(processId: AiSessionTerminalProcessId, input: PendingAiSessionTerminalBindingInput): void;
setBound(processId: AiSessionTerminalProcessId, input: BoundAiSessionTerminalBindingInput): void;
remove(processId: AiSessionTerminalProcessId): void;
```

`enqueueWrite()` 必须先进入现有 `writeQueue`，再 `await processId` 并校验 `Number.isSafeInteger(pid) && pid > 0`，最后更新 `aiSessionTerminalProcessBinding.v2.<pid>`。这样即使多个调用共享一个尚未 resolve 的 Promise，`pending → bound → remove` 仍按调用顺序执行。

PID Promise 从调用时就并行启动 2 秒 timeout；timeout 后该操作跳过，不能永久卡住后续写入。测试还要使用 deferred PID 验证 `pending → bound → remove` 的实际 update 顺序。

- [x] **Step 4: Run the store test and verify GREEN**

Run: `npm run test-compile && node scripts/run-ai-session-safety-checks.js`

Expected: `AI session safety checks passed.`

---

### Task 2: 通过相同 process ID 恢复无 env 的 terminal

**Files:**
- Modify: `src/aiSessions/terminalService.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: Task 1 的 process-ID store API、`vscode.Terminal.processId`。
- Produces: `restorePersistedTerminals(terminals): Promise<void>`；现有 `track`、`trackPending`、`untrack`、`handleClosedTerminal` 使用 `terminal.processId` 持久化。

- [x] **Step 1: Write the real reload regression test**

创建 terminal 后持久化 `pending`，再构造一个新的 terminal wrapper。新 wrapper 不含创建时 env，但返回相同 PID：

```js
const processId = await created.processId;
const restoredPendingTerminal = {
    name: created.name,
    creationOptions: { name: created.name, cwd: '/work/app' },
    processId: Promise.resolve(processId),
    sendText() {},
};
await secondService.restorePersistedTerminals([restoredPendingTerminal]);
assert.strictEqual(secondService.getPendingTerminals()[0].terminal, restoredPendingTerminal);
```

随后把记录升级为 `bound`，用第三个无 env wrapper 再次恢复，断言 `getById('codex', 'session-new').terminal` 是第三个 wrapper。关闭 terminal 后按 PID 删除记录。另保留过期 pending 清理测试。

再增加两个边界测试：永不完成的 `processId` 不能阻塞另一个有效 terminal 恢复；普通 `bash` terminal 重用历史 Codex PID 时不得恢复旧 session，并删除该陈旧绑定。

- [x] **Step 2: Run the reload test and verify RED**

Run: `npm run test-compile && node scripts/run-ai-session-safety-checks.js`

Expected: FAIL；当前 `restorePersistedTerminals()` 从 `creationOptions.env` 读取实例 ID，无 env wrapper 无法恢复。

- [x] **Step 3: Implement process-ID persistence and async restore**

删除 `crypto` 和 `AI_SESSION_TERMINAL_INSTANCE_ENV_KEY`，`createTerminal()` 只合并调用方 env。把所有持久化调用改成直接传递 `terminal.processId`：

```ts
this.bindingStore?.setBound(normalizedEntry.terminal.processId, binding);
this.bindingStore?.setPending(entry.terminal.processId, binding);
this.bindingStore?.remove(terminal.processId);
```

恢复方法改为：

```ts
async restorePersistedTerminals(terminals: readonly vscode.Terminal[]): Promise<void> {
    await Promise.all((terminals || []).map(async terminal => {
        let processId: number;
        try {
            processId = await terminal.processId;
        } catch {
            return;
        }
        let binding = this.bindingStore?.get(processId);
        // 名称不符合 provider 前缀时删除 stale binding；否则按 bound/pending 分支恢复内存。
    }));
}
```

- [x] **Step 4: Run the reload test and verify GREEN**

Run: `npm run test-compile && node scripts/run-ai-session-safety-checks.js`

Expected: `AI session safety checks passed.`

---

### Task 3: 阻断 dashboard 激活恢复竞态并完成交付

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `docs/superpowers/plans/2026-07-15-ai-session-terminal-ownership-persistence.md`

**Interfaces:**
- Consumes: Task 2 的 `restorePersistedTerminals(...): Promise<void>`。
- Produces: `activate(context): Promise<void>`，在注册视图、刷新 watcher 和 attention interval 之前完成 terminal ownership 恢复。

- [x] **Step 1: Write the activation ordering assertion**

在 dashboard 源码检查中增加：

```js
assert.ok(dashboard.includes('export async function activate(context: vscode.ExtensionContext)'));
assert.ok(dashboard.includes('await aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals)'));
```

- [x] **Step 2: Run the ordering test and verify RED**

Run: `npm run test-compile && node scripts/run-ai-session-safety-checks.js`

Expected: FAIL，因为当前 `activate` 和恢复调用都是同步形式。

- [x] **Step 3: Await restoration during activation**

在 `src/dashboard.ts` 中修改：

```ts
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 创建 store 与 terminal service
    await aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals);
    // 后续 pin store、attention monitor、interval、view provider 注册保持现有顺序
}
```

- [x] **Step 4: Run full verification**

Run:

```bash
npm run test:safety
npm run webpack
npm run lint
npm run vscode:prepublish
npx --yes @vscode/vsce package --allow-star-activation --out artifacts/project-steward-1.1.8-terminal-process-ownership.vsix
git diff --check
```

Expected: 安全测试、AI/Bridge TypeScript、Open Project 回归、Webpack、VSIX 打包全部退出 0；lint 只允许项目已有 warning。

- [x] **Step 5: Install and inspect the DevContainer bundle**

Run:

```bash
code --install-extension artifacts/project-steward-1.1.8-terminal-process-ownership.vsix --force
rg -o "aiSessionTerminalProcessBinding.v2.|restorePersistedTerminals" /home/hzcheng/.vscode-server/extensions/hzcheng.project-steward-1.1.8/dist/dashboard.js | sort -u
```

Expected: 安装成功，bundle 同时包含 v2 process key 和恢复方法。

- [x] **Step 6: Review, commit, and push only scoped files**

Review the complete diff, fix all Critical/Important findings, then run fresh verification. Stage only:

```bash
git add src/aiSessions/terminalBindingStore.ts src/aiSessions/terminalService.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js docs/superpowers/plans/2026-07-15-ai-session-terminal-ownership-persistence.md
git commit -m "fix: restore AI terminal ownership by process id"
git push origin feat/ai-session-attention-monitor
```

Do not stage `.vscode/settings.json`, `docs/assets/`, or `docs/running-projects-tabs-prd.md`.
