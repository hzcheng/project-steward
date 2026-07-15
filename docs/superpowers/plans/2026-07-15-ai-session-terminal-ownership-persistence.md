# AI Session Terminal 归属持久化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让 Project Steward 创建的 AI terminal 在 VS Code 窗口重载后仍能恢复准确的 session 归属，从而正确复用 terminal 并把 attention 标记到对应 session 卡片。

**架构：** 新增一个只负责校验和持久化 terminal 绑定的 `AiSessionTerminalBindingStore`，通过 `context.workspaceState` 为每个 terminal 实例 ID 使用独立 key 保存 `pending`/`bound` 记录。`AiSessionTerminalService` 为每个新 terminal 注入稳定实例 ID，所有内存跟踪变化同步到 store，并在扩展激活时根据当前窗口的 terminal 恢复绑定。

**技术栈：** TypeScript、VS Code Extension API `Memento`/`Terminal`、Node.js `crypto`、现有 `scripts/run-ai-session-safety-checks.js` 回归测试。

## 全局约束

- 只跟踪由 Project Steward 创建的 AI terminal。
- 不修改 provider 生命周期解析、attention payload 或 Webview UI。
- 不根据 cwd 或 transcript 时间猜测 terminal 归属。
- 持久化失败不得阻止 provider 命令执行。
- 不恢复实例 ID 机制上线前已经创建的 terminal。
- 保留用户未提交的 `.vscode/settings.json`、`docs/assets/` 和 `docs/running-projects-tabs-prd.md`。

---

### 任务 1：实现有边界的 terminal 绑定存储

**文件：**
- 新建：`src/aiSessions/terminalBindingStore.ts`
- 修改测试：`scripts/run-ai-session-safety-checks.js`

**接口：**
- 输入：实现 `get<T>(key, defaultValue)` 和 `update(key, value)` 的 workspace state 适配器。
- 输出：`AiSessionTerminalBindingStore.get(instanceId)`、`setPending(instanceId, record)`、`setBound(instanceId, record)`、`remove(instanceId)`、`flush()`。
- 输出记录：`PendingAiSessionTerminalBinding` 与 `BoundAiSessionTerminalBinding` 联合类型。

- [x] **步骤 1：先写失败测试**

在 `runAiSessionTerminalBindingStoreChecks()` 中使用内存 state，覆盖 pending 写入、重新实例化读取、bound 升级、删除和非法记录过滤：

```js
const stateData = {};
const state = {
    get: (key, fallback) => key in stateData ? stateData[key] : fallback,
    update: async (key, value) => { stateData[key] = value; },
};
const first = new AiSessionTerminalBindingStore(state);
first.setPending('a'.repeat(32), {
    providerId: 'codex', markerPath: '/tmp/pending.done', cwd: '/work/app',
    createdAt: '2026-07-15T08:00:00.000Z', excludedSessionIds: ['old'], title: 'New chat',
});
await first.flush();
const restoredPending = new AiSessionTerminalBindingStore(state).get('a'.repeat(32));
assert.strictEqual(restoredPending.state, 'pending');

const second = new AiSessionTerminalBindingStore(state);
second.setBound('a'.repeat(32), {
    providerId: 'codex', sessionId: 'session-new',
    markerPath: '/tmp/session-new.done', runStartedAtMs: 1784102400000,
});
await second.flush();
assert.strictEqual(new AiSessionTerminalBindingStore(state).get('a'.repeat(32)).sessionId, 'session-new');
```

同时注入一个 provider 非法的记录，断言 `get()` 返回 `null` 且有效记录仍可读取；再让两个 store 的 `update` Promise 交错完成，证明不同 terminal 的独立 key 不会互相覆盖。

- [x] **步骤 2：运行测试确认 RED**

执行：`npm run test-compile && node scripts/run-ai-session-safety-checks.js`

预期：编译或 require 失败，明确指出 `terminalBindingStore`/`AiSessionTerminalBindingStore` 尚不存在。

- [x] **步骤 3：写最小存储实现**

在 `terminalBindingStore.ts` 中定义版本化独立绑定项和严格校验：

```ts
export const AI_SESSION_TERMINAL_BINDING_KEY_PREFIX = 'aiSessionTerminalBinding.v1.';
export const AI_SESSION_TERMINAL_INSTANCE_ENV_KEY = 'PROJECT_STEWARD_AI_TERMINAL_INSTANCE_ID';

export type AiSessionTerminalBinding = PendingAiSessionTerminalBinding | BoundAiSessionTerminalBinding;

export default class AiSessionTerminalBindingStore {
    get(instanceId: string): AiSessionTerminalBinding | null;
    setPending(instanceId: string, record: Omit<PendingAiSessionTerminalBinding, 'version' | 'state' | 'updatedAtMs'>): void;
    setBound(instanceId: string, record: Omit<BoundAiSessionTerminalBinding, 'version' | 'state' | 'updatedAtMs'>): void;
    remove(instanceId: string): void;
    flush(): Promise<void>;
}
```

每次写入进入同一个 Promise 队列，并直接更新 `aiSessionTerminalBinding.v1.<instance-id>`；不同 terminal 使用不同 key，避免跨窗口丢更新。`update` 连续失败时只调用一次注入的 `onError`，且不向调用方抛出。

- [x] **步骤 4：运行测试确认 GREEN**

执行：`npm run test-compile && node scripts/run-ai-session-safety-checks.js`

预期：`AI session safety checks passed.`

- [x] **步骤 5：提交独立存储单元**

```bash
git add src/aiSessions/terminalBindingStore.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: persist AI terminal bindings"
```

---

### 任务 2：让 terminal service 跨重载恢复 pending 与 bound 归属

**文件：**
- 修改：`src/aiSessions/terminalService.ts`
- 修改测试：`scripts/run-ai-session-safety-checks.js`

**接口：**
- 输入：任务 1 的 `AiSessionTerminalBindingStore`。
- 输出：`AiSessionTerminalService.restorePersistedTerminals(terminals)`。
- 行为：`createTerminal()` 自动注入实例 ID；`trackPending()`、`track()`、`untrack()`、`removePendingForTerminal()`、`handleClosedTerminal()` 同步持久化状态。

- [x] **步骤 1：先写跨重载失败测试**

扩展 `runAiSessionTerminalResolutionChecks()`：用同一个内存 workspace state 创建三个 service 实例，模拟 `pending → bound → reload`：

```js
const firstStore = new AiSessionTerminalBindingStore(state);
const firstService = new AiSessionTerminalService(tempRoot, getProvider, 0, undefined, firstStore);
const created = firstService.createTerminal({ name: 'Codex: App', cwd: '/work/app', logError() {}, cwdFailureMessage: '', cwdWarningMessage: '' }).terminal;
firstService.trackPending({
    provider: 'codex', terminal: created, markerPath: '/tmp/pending.done', cwd: '/work/app',
    createdAt: new Date().toISOString(), excludedSessionIds: [], title: 'App',
});
await firstStore.flush();

const secondStore = new AiSessionTerminalBindingStore(state);
const secondService = new AiSessionTerminalService(tempRoot, getProvider, 0, undefined, secondStore);
secondService.restorePersistedTerminals([created]);
assert.strictEqual(secondService.getPendingTerminals()[0].terminal, created);

secondService.track('codex', 'session-new', {
    terminal: created, markerPath: '/tmp/session-new.done', runStartedAtMs: 1784102400000,
});
await secondStore.flush();

const thirdService = new AiSessionTerminalService(tempRoot, getProvider, 0, undefined, new AiSessionTerminalBindingStore(state));
thirdService.restorePersistedTerminals([created]);
assert.strictEqual(thirdService.getById('codex', 'session-new').terminal, created);
```

再调用 `handleClosedTerminal(created)`、等待 `flush()`，断言第四个 store 不再读取到该实例绑定。

- [x] **步骤 2：运行测试确认 RED**

执行：`npm run test-compile && node scripts/run-ai-session-safety-checks.js`

预期：失败于 terminal 没有实例 ID、`restorePersistedTerminals` 不存在或重载后 `getById` 返回 `null`。

- [x] **步骤 3：实现 terminal service 集成**

在 `createTerminal()` 中合并调用方 env，并始终覆盖内部实例 ID：

```ts
const terminalInstanceId = crypto.randomBytes(16).toString('hex');
const env = {
    ...(options.env || {}),
    [AI_SESSION_TERMINAL_INSTANCE_ENV_KEY]: terminalInstanceId,
};
```

新增辅助方法从 `terminal.creationOptions.env` 读取实例 ID，并实现恢复：

```ts
restorePersistedTerminals(terminals: readonly vscode.Terminal[]) {
    for (const terminal of terminals || []) {
        const instanceId = this.getTerminalInstanceId(terminal);
        const binding = instanceId ? this.bindingStore?.get(instanceId) : null;
        if (binding?.state === 'bound') {
            this.trackInMemory(binding.providerId, binding.sessionId, {
                terminal, markerPath: binding.markerPath, runStartedAtMs: binding.runStartedAtMs,
            });
        } else if (binding?.state === 'pending') {
            this.trackPendingInMemory({ ...binding, provider: binding.providerId, terminal });
        }
    }
}
```

把现有 `track()`/`trackPending()` 分成“更新内存”和“更新 store”两层，恢复时只更新内存，正常创建或匹配时更新两者。关闭或取消跟踪时根据实例 ID 删除 store 记录。

- [x] **步骤 4：运行测试确认 GREEN**

执行：`npm run test-compile && node scripts/run-ai-session-safety-checks.js`

预期：`AI session safety checks passed.`

- [x] **步骤 5：提交 terminal service 集成**

```bash
git add src/aiSessions/terminalService.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: restore AI terminal ownership after reload"
```

---

### 任务 3：接入扩展激活流程并完成回归验证

**文件：**
- 修改：`src/dashboard.ts`
- 修改测试：`scripts/run-ai-session-safety-checks.js`
- 更新：`docs/superpowers/plans/2026-07-15-ai-session-terminal-ownership-persistence.md`

**接口：**
- 输入：`context.workspaceState`、现有 `logError`、`vscode.window.terminals`。
- 输出：扩展启动后、首次 attention evaluation 之前恢复 terminal ownership。

- [x] **步骤 1：先写 wiring 失败测试**

在 dashboard 源码安全检查中增加以下断言：

```js
assert.ok(dashboard.includes('new AiSessionTerminalBindingStore(context.workspaceState'));
assert.ok(dashboard.includes('restorePersistedTerminals(vscode.window.terminals)'));
```

- [x] **步骤 2：运行测试确认 RED**

执行：`npm run test-compile && node scripts/run-ai-session-safety-checks.js`

预期：失败于 dashboard 尚未创建 store 或尚未调用恢复方法。

- [x] **步骤 3：完成 dashboard wiring**

在创建 terminal service 时注入 store，并在创建 attention timer 前恢复：

```ts
const aiSessionTerminalBindingStore = new AiSessionTerminalBindingStore(
    context.workspaceState,
    error => logError('Failed to persist AI session terminal ownership.', error)
);
const aiSessionTerminalService = new AiSessionTerminalService(
    context.globalStoragePath,
    providerId => getRegisteredAiSessionProvider(providerId),
    undefined,
    undefined,
    aiSessionTerminalBindingStore
);
aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals);
```

- [x] **步骤 4：运行全部验证**

依次执行：

```bash
npm run test:safety
npm run webpack
npm run lint
npm run vscode:prepublish
npx --yes @vscode/vsce package --allow-star-activation --out artifacts/project-steward-1.1.8-terminal-ownership.vsix
git diff --check
```

预期：安全测试、TypeScript、Webpack 和 VSIX 打包全部成功；lint 退出码为 0，仅允许项目已有 warning；`git diff --check` 无输出。

- [x] **步骤 5：安装到当前 DevContainer 并检查 bundle**

```bash
code --install-extension artifacts/project-steward-1.1.8-terminal-ownership.vsix --force
rg -o "restorePersistedTerminals|PROJECT_STEWARD_AI_TERMINAL_INSTANCE_ID" /home/hzcheng/.vscode-server/extensions/hzcheng.project-steward-1.1.8/dist/dashboard.js | sort -u
```

预期：安装成功，并输出两个新标识。随后只要求用户重载窗口并新建一次 session 进行最终实测。

- [x] **步骤 6：复审、提交并推送**

```bash
git add src/aiSessions/terminalBindingStore.ts src/aiSessions/terminalService.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js docs/superpowers/plans/2026-07-15-ai-session-terminal-ownership-persistence.md
git commit -m "fix: persist AI terminal ownership across reloads"
git push origin feat/ai-session-attention-monitor
```

只提交上述功能文件，保留用户自己的未提交文件。
