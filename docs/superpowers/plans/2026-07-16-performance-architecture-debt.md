# 架构与性能债优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 Project Steward 2.0.0 用户可见行为的前提下，收敛高频渲染路径、拆分 `dashboard.ts` 职责、提升 AI provider registry，并为扫描/I/O 增加预算和诊断护栏。

**Architecture:** 采用行为冻结、测试先行、边界前移的方式。先用 source contract 和 VM checks 锁住现有行为，再把 message 构建、view provider、message router、open project controller、AI session controller 从 `dashboard.ts` 中逐步抽离。Provider registry 和 I/O budget 放在 controller 边界稳定之后推进。

**Tech Stack:** TypeScript 4、VS Code Extension API、Node.js safety checks、现有 webview DOM scripts、Webpack、TSLint。

## Global Constraints

- 不引入 React、Vue、Svelte 等前端框架。
- 不重写 UI Bridge 协议。
- 不改 Marketplace 扩展 ID 或命令 ID。
- 不一次性重写 `dashboard.ts`。
- 不改变 saved project 数据格式。
- 不在本阶段新增新的 AI provider。
- 用户可见功能必须与 2.0.0 保持一致。
- 每个 task 先写或更新 safety check，再做最小实现。
- 保留 full refresh fallback，但每个 fallback 必须有显式 reason。
- 不提交 `.vscode/settings.json`。

---

## Baseline

当前基线：

- `src/dashboard.ts`: 2946 行。
- `src/webview/webviewProjectScripts.js`: 1296 行。
- `provider.refresh()` 调用点在 `src/dashboard.ts` 中有 5 处。
- 已存在增量消息：`ai-sessions-updated`、`open-projects-updated`、`ai-session-attention-state`、`ai-session-attention-projects-updated`、`active-ai-session-terminal-changed`。
- 已存在 provider definition：`src/aiSessions/providers.ts`。
- 已存在 provider service contract：`src/aiSessions/types.ts`。

Baseline commands:

```bash
wc -l src/dashboard.ts src/webview/webviewProjectScripts.js
rg -n "provider\\.refresh\\(|webview\\.html|postOpenProjectsUpdated\\(|getAiSessionsUpdatedMessage\\(" src/dashboard.ts
npm run test:dashboard
npm run test:safety
```

---

### Task 1: Lock High-Frequency Refresh Contracts

**Files:**
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- No production code changes in this task.

**Interfaces:**
- Consumes: existing `src/dashboard.ts` functions `postOpenProjectsUpdated()`, `getAiSessionsUpdatedMessage()`, `refreshAiSessionViewsIncrementally()`, `refreshStewardViews()`, and webview `applyAiSessionsUpdate()`.
- Produces: failing or passing source contract checks that define allowed full refresh fallback points before refactoring starts.

- [x] **Step 1: Add dashboard source contract checks**

  In `scripts/run-dashboard-webview-checks.js`, extend `runSourceContractChecks()` with checks that:

  ```js
  const refreshStewardViewsBody = extractFunctionBody(extensionHostSource, 'refreshStewardViews');
  const postOpenProjectsBody = extractFunctionBody(extensionHostSource, 'postOpenProjectsUpdated');
  const aiSessionsMessageBody = extractFunctionBody(extensionHostSource, 'getAiSessionsUpdatedMessage');

  assert.ok(refreshStewardViewsBody.includes('provider.refresh();'));
  assert.ok(postOpenProjectsBody.includes("type: 'open-projects-updated'"));
  assert.ok(postOpenProjectsBody.includes('version: 1'));
  assert.ok(postOpenProjectsBody.includes('semanticRevision: openProjectAggregate.semanticRevision'));
  assert.ok(postOpenProjectsBody.includes('searchCatalog: buildDashboardSearchCatalog('));
  assert.ok(aiSessionsMessageBody.includes("type: 'ai-sessions-updated'"));
  assert.ok(aiSessionsMessageBody.includes('version: 1'));
  assert.ok(aiSessionsMessageBody.includes('sequence: ++aiSessionUpdateSequence'));
  assert.ok(aiSessionsMessageBody.includes('searchCatalog: buildDashboardSearchCatalog('));
  ```

- [x] **Step 2: Add open project fallback contract checks**

  In `scripts/run-open-project-safety-checks.js`, extend `runOpenProjectIncrementalRenderingChecks()` with checks that:

  ```js
  const postOpenProjectsUpdated = extractFunctionBody(dashboard, 'postOpenProjectsUpdated');
  assert.ok(postOpenProjectsUpdated.includes('provider.postMessage(message).then('));
  assert.ok(postOpenProjectsUpdated.includes('if (!delivered && provider.visible)'));
  assert.ok(postOpenProjectsUpdated.includes("logError('Failed to post OPEN PROJECT update message.'"));
  assert.ok(postOpenProjectsUpdated.includes('provider.refresh();'));
  ```

- [x] **Step 3: Add AI session fallback contract checks**

  In `scripts/run-ai-session-safety-checks.js`, add a source contract check near existing `ai-sessions-updated` checks:

  ```js
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
  const refreshFunction = extractFunctionBody(dashboard, 'refreshAiSessionViewsIncrementally');
  assert.ok(refreshFunction.includes('let message = getAiSessionsUpdatedMessage();'));
  assert.ok(refreshFunction.includes('provider.postMessage(message).then(delivered =>'));
  assert.ok(refreshFunction.includes('if (!delivered)'));
  assert.ok(refreshFunction.includes('refreshStewardViews();'));
  ```

- [x] **Step 4: Run targeted checks**

  Run:

  ```bash
  npm run test:dashboard
  npm run test:open-projects
  npm run test:safety
  ```

  Expected: all pass. If a check fails because the current code uses different exact strings, adjust the check to assert the real source contract, not a desired future shape.

---

### Task 2: Extract Webview Update Message Builders

**Files:**
- Create: `src/dashboard/webviewUpdateMessages.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces:
  - `buildOpenProjectsUpdatedMessage(input: BuildOpenProjectsUpdatedMessageInput): OpenProjectsUpdatedMessage`
  - `buildAiSessionsUpdatedMessage(input: BuildAiSessionsUpdatedMessageInput): AiSessionsUpdatedMessage`
- Consumes:
  - `getOpenProjectsGroupContent()`
  - `buildDashboardSearchCatalog()`
  - `OpenProjectAggregate`
  - `OpenProjectAiSessionViewModel[]`

- [x] **Step 1: Write failing source checks for the new module**

  Update `scripts/run-dashboard-webview-checks.js` to assert:

  ```js
  const updateMessagePath = path.join(__dirname, '..', 'src', 'dashboard', 'webviewUpdateMessages.ts');
  assert.ok(fs.existsSync(updateMessagePath));
  const updateMessages = fs.readFileSync(updateMessagePath, 'utf8');
  assert.ok(updateMessages.includes('export function buildOpenProjectsUpdatedMessage('));
  assert.ok(updateMessages.includes('export function buildAiSessionsUpdatedMessage('));
  assert.ok(updateMessages.includes("type: 'open-projects-updated'"));
  assert.ok(updateMessages.includes("type: 'ai-sessions-updated'"));
  assert.ok(updateMessages.includes('version: 1'));
  ```

  Run:

  ```bash
  npm run test:dashboard
  ```

  Expected: fail because the file does not exist yet.

- [x] **Step 2: Create `src/dashboard/webviewUpdateMessages.ts`**

  Create the module with explicit interfaces:

  ```ts
  'use strict';

  import { Group, Project, StewardInfos } from '../models';
  import { getOpenProjectsGroupContent } from '../webview/webviewContent';
  import { buildDashboardSearchCatalog, DashboardSearchCatalog } from '../webview/dashboardViewModel';
  import type { AiSessionsUpdatedMessage, OpenProjectAiSessionViewModel } from '../aiSessions/types';

  export interface OpenProjectsUpdatedMessage {
      type: 'open-projects-updated';
      version: 1;
      semanticRevision: string;
      projectCount: number;
      searchCatalog: DashboardSearchCatalog;
      html: string;
  }

  export interface BuildOpenProjectsUpdatedMessageInput {
      groups: Group[];
      cards: Project[];
      collapsed: boolean;
      stewardInfos: StewardInfos;
      semanticRevision: string;
  }

  export interface BuildAiSessionsUpdatedMessageInput {
      groups: Group[];
      cards: Project[];
      sequence: number;
      generatedAt: string;
      openProjects: OpenProjectAiSessionViewModel[];
  }

  export function buildOpenProjectsUpdatedMessage(input: BuildOpenProjectsUpdatedMessageInput): OpenProjectsUpdatedMessage {
      return {
          type: 'open-projects-updated',
          version: 1,
          semanticRevision: input.semanticRevision,
          projectCount: input.cards.length,
          searchCatalog: buildDashboardSearchCatalog(input.groups, input.cards),
          html: getOpenProjectsGroupContent(input.cards, input.collapsed, input.stewardInfos),
      };
  }

  export function buildAiSessionsUpdatedMessage(input: BuildAiSessionsUpdatedMessageInput): AiSessionsUpdatedMessage {
      return {
          type: 'ai-sessions-updated',
          version: 1,
          sequence: input.sequence,
          generatedAt: input.generatedAt,
          openProjects: input.openProjects,
          searchCatalog: buildDashboardSearchCatalog(input.groups, input.cards),
      };
  }
  ```

- [x] **Step 3: Use the builders in `src/dashboard.ts`**

  Import:

  ```ts
  import { buildAiSessionsUpdatedMessage, buildOpenProjectsUpdatedMessage } from './dashboard/webviewUpdateMessages';
  ```

  Replace the object literal in `postOpenProjectsUpdated()` with:

  ```ts
  const message = buildOpenProjectsUpdatedMessage({
      groups: projectService.getGroups(),
      cards,
      collapsed: stewardInfos.openProjectsGroupCollapsed,
      stewardInfos,
      semanticRevision: openProjectAggregate.semanticRevision,
  });
  ```

  Replace the returned object in `getAiSessionsUpdatedMessage()` with:

  ```ts
  return buildAiSessionsUpdatedMessage({
      groups: projectService.getGroups(),
      cards,
      sequence: ++aiSessionUpdateSequence,
      generatedAt: new Date().toISOString(),
      openProjects: openProjects.map(project => getOpenProjectAiSessionViewModel(project)),
  });
  ```

- [x] **Step 4: Update source checks**

  Update checks that currently extract `postOpenProjectsUpdated()` and `getAiSessionsUpdatedMessage()` to allow message construction through the new builders. Keep assertions that dashboard still passes `projectService.getGroups()` and `cards` into the builders.

- [x] **Step 5: Verify**

  Run:

  ```bash
  npm run test:dashboard
  npm run test:open-projects
  npm run test:safety
  npm run test-compile
  ```

  Expected: all pass.

---

### Task 3: Add Baseline Metrics Script

**Files:**
- Create: `scripts/run-performance-architecture-baseline-checks.js`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-07-16-performance-architecture-debt-design.md`

**Interfaces:**
- Produces: `npm run test:architecture-baseline`
- Produces JSON-like console output with dashboard line count, refresh call count, message builder module presence, provider definition count.

- [x] **Step 1: Write the baseline script**

  Create `scripts/run-performance-architecture-baseline-checks.js`:

  ```js
  'use strict';

  const assert = require('assert');
  const fs = require('fs');
  const path = require('path');

  const root = path.resolve(__dirname, '..');

  function read(relativePath) {
      return fs.readFileSync(path.join(root, relativePath), 'utf8');
  }

  const dashboard = read('src/dashboard.ts');
  const dashboardLines = dashboard.split(/\r?\n/).length;
  const refreshCalls = (dashboard.match(/provider\.refresh\(/g) || []).length;
  const webviewHtmlAssignments = (dashboard.match(/webview\.html/g) || []).length;
  const providerDefinitions = read('src/aiSessions/providers.ts');

  assert.ok(dashboardLines > 0);
  assert.ok(refreshCalls >= 1);
  assert.ok(webviewHtmlAssignments >= 1);
  assert.ok(providerDefinitions.includes("codex:"));
  assert.ok(providerDefinitions.includes("kimi:"));
  assert.ok(providerDefinitions.includes("claude:"));

  console.log(JSON.stringify({
      dashboardLines,
      refreshCalls,
      webviewHtmlAssignments,
      providers: ['codex', 'kimi', 'claude'],
  }, null, 2));
  ```

- [x] **Step 2: Add npm script**

  Add to `package.json`:

  ```json
  "test:architecture-baseline": "node scripts/run-performance-architecture-baseline-checks.js"
  ```

- [x] **Step 3: Verify**

  Run:

  ```bash
  npm run test:architecture-baseline
  ```

  Expected: exit 0 and prints current baseline numbers.

---

### Task 4: Extract Sidebar View Provider

**Files:**
- Create: `src/dashboard/viewProvider.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Produces: `SidebarStewardViewProvider` exported from `src/dashboard/viewProvider.ts`
- Consumes:
  - `renderContent(): string`
  - `renderError(error: unknown): string`
  - `onMessage(message: unknown): Promise<void>`
  - `onVisibleChanged(visible: boolean): void`

- [x] **Step 1: Write failing source check**

  In `scripts/run-dashboard-webview-checks.js`, assert:

  ```js
  const viewProviderPath = path.join(__dirname, '..', 'src', 'dashboard', 'viewProvider.ts');
  assert.ok(fs.existsSync(viewProviderPath));
  const viewProviderSource = fs.readFileSync(viewProviderPath, 'utf8');
  assert.ok(viewProviderSource.includes('export class SidebarStewardViewProvider implements vscode.WebviewViewProvider'));
  assert.ok(viewProviderSource.includes('refresh()'));
  assert.ok(viewProviderSource.includes('postMessage(message: unknown)'));
  ```

  Run:

  ```bash
  npm run test:dashboard
  ```

  Expected: fail because the module does not exist yet.

- [x] **Step 2: Create `src/dashboard/viewProvider.ts`**

  Move the current inner class into the new file and inject dependencies through constructor:

  ```ts
  export interface SidebarStewardViewProviderOptions {
      getWebviewOptions: () => vscode.WebviewOptions;
      renderContent: (webview: vscode.Webview) => string;
      renderError: (error: unknown) => string;
      onMessage: (message: unknown) => Promise<void>;
      onVisibleChanged: (visible: boolean) => void;
      logError: (message: string, error: unknown) => void;
  }
  ```

  Keep behavior:

  - `resolveWebviewView()` sets `_view`.
  - `refresh()` assigns `webview.html`.
  - visible changes call `refresh()` when visible.
  - `postMessage()` resolves `false` when no view exists.

- [x] **Step 3: Replace inner class in `src/dashboard.ts`**

  Import the class:

  ```ts
  import { SidebarStewardViewProvider } from './dashboard/viewProvider';
  ```

  Instantiate with closures that preserve current behavior:

  ```ts
  const provider = new SidebarStewardViewProvider({
      getWebviewOptions,
      renderContent: webview => getStewardContent(context, webview, projectService.getGroups(), stewardInfos, true),
      renderError: getErrorContent,
      onMessage: handleStewardMessage,
      onVisibleChanged: visible => {
          setAiSessionWatchersActive(visible);
          activeAiSessionTerminalHighlighter.setVisible(visible);
      },
      logError,
  });
  ```

- [x] **Step 4: Verify**

  Run:

  ```bash
  npm run test:dashboard
  npm run test:safety
  npm run test-compile
  ```

  Expected: all pass. `src/dashboard.ts` line count decreases.

---

### Task 5: Extract Webview Message Router

**Files:**
- Create: `src/dashboard/messageRouter.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Produces:
  - `createDashboardMessageRouter(handlers: DashboardMessageHandlers): (message: unknown) => Promise<void>`
  - `DashboardMessageHandlers`
- Consumes: existing message handler logic from `handleStewardMessage(e)`.

- [x] **Step 1: Add failing source check**

  Assert in `scripts/run-dashboard-webview-checks.js`:

  ```js
  const routerPath = path.join(__dirname, '..', 'src', 'dashboard', 'messageRouter.ts');
  assert.ok(fs.existsSync(routerPath));
  const routerSource = fs.readFileSync(routerPath, 'utf8');
  assert.ok(routerSource.includes('export interface DashboardMessageHandlers'));
  assert.ok(routerSource.includes('export function createDashboardMessageRouter('));
  ```

- [x] **Step 2: Create router shell**

  Create `src/dashboard/messageRouter.ts` with explicit handler names for existing message types. Keep handlers broad initially so this task moves dispatch without rewriting behavior:

  ```ts
  export interface DashboardMessageHandlers {
      handleRawMessage: (message: unknown) => Promise<void>;
  }

  export function createDashboardMessageRouter(handlers: DashboardMessageHandlers): (message: unknown) => Promise<void> {
      return message => handlers.handleRawMessage(message);
  }
  ```

  This is intentionally thin. It creates a testable seam before extracting individual handlers.

- [x] **Step 3: Wire router in `dashboard.ts`**

  Replace direct `handleStewardMessage` wiring with:

  ```ts
  const dashboardMessageRouter = createDashboardMessageRouter({
      handleRawMessage: handleStewardMessage,
  });
  ```

  Pass `dashboardMessageRouter` into the view provider options.

- [x] **Step 4: Verify**

  Run:

  ```bash
  npm run test:dashboard
  npm run test:safety
  npm run test-compile
  ```

  Expected: all pass. No behavior change.

---

### Task 6: Extract Open Project Dashboard Controller

**Files:**
- Create: `src/openProjects/dashboardController.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces:
  - `OpenProjectDashboardController`
  - `postUpdated(): void`
  - `setAggregate(aggregate: OpenProjectAggregate | null): void`
  - `getCards(): Project[]`
- Consumes:
  - `OpenProjectBridgeClient`
  - `projectOpenProjectCards()`
  - `buildOpenProjectsUpdatedMessage()`
  - provider `postMessage()`

- [x] **Step 1: Add failing source check**

  In `scripts/run-open-project-safety-checks.js`, assert:

  ```js
  const controllerPath = path.join(__dirname, '..', 'src', 'openProjects', 'dashboardController.ts');
  assert.ok(fs.existsSync(controllerPath));
  const controllerSource = fs.readFileSync(controllerPath, 'utf8');
  assert.ok(controllerSource.includes('export class OpenProjectDashboardController'));
  assert.ok(controllerSource.includes('postUpdated('));
  assert.ok(controllerSource.includes('buildOpenProjectsUpdatedMessage'));
  ```

- [x] **Step 2: Create controller with existing logic**

  Move only these responsibilities from `dashboard.ts`:

  - `openProjectAggregate`
  - `openProjectNavigationCardsById`
  - `getOpenProjectCards()`
  - message construction through `buildOpenProjectsUpdatedMessage()`
  - post message fallback for open project updates

  Keep diagnostics injected:

  ```ts
  interface OpenProjectDashboardControllerOptions {
      getOpenProjects: () => Project[];
      getGroups: () => Group[];
      getStewardInfos: () => StewardInfos;
      getBridgeInstanceId: () => string;
      postMessage: (message: unknown) => Thenable<boolean>;
      refresh: () => void;
      isVisible: () => boolean;
      logDiagnostic: (source: string, event: Record<string, unknown>) => void;
      logError: (message: string, error: unknown) => void;
  }
  ```

- [x] **Step 3: Wire controller in `dashboard.ts`**

  Replace local functions with controller calls:

  - `getOpenProjectCards()` delegates to controller.
  - `postOpenProjectsUpdated()` delegates to controller.
  - bridge callback calls controller `setAggregate()` then `postUpdated()`.

- [x] **Step 4: Verify**

  Run:

  ```bash
  npm run test:open-projects
  npm run test:dashboard
  npm run test:safety
  npm run test-compile
  ```

  Expected: all pass.

---

### Task 7: Extract AI Session Dashboard Update Controller

**Files:**
- Create: `src/aiSessions/dashboardController.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces:
  - `AiSessionDashboardController`
  - `scheduleRefresh(): void`
  - `setWatchersActive(active: boolean): void`
  - `refreshNow(force?: boolean): Promise<void>`
- Consumes:
  - provider registry/service lookup
  - `assignAiSessionsToProjects()`
  - `prepareAiSessionsForDisplay()`
  - `buildAiSessionsUpdatedMessage()`
  - attention aggregate lookup

- [x] **Step 1: Add failing source check**

  In `scripts/run-ai-session-safety-checks.js`, assert:

  ```js
  const controllerPath = path.join(__dirname, '..', 'src', 'aiSessions', 'dashboardController.ts');
  assert.ok(fs.existsSync(controllerPath));
  const controllerSource = fs.readFileSync(controllerPath, 'utf8');
  assert.ok(controllerSource.includes('export class AiSessionDashboardController'));
  assert.ok(controllerSource.includes('scheduleRefresh('));
  assert.ok(controllerSource.includes('setWatchersActive('));
  assert.ok(controllerSource.includes('buildAiSessionsUpdatedMessage'));
  ```

- [x] **Step 2: Move scheduling and watcher activation first**

  Move these functions without changing assignment/view-model logic:

  - `scheduleAiSessionRefresh()`
  - `setAiSessionWatchersActive()`
  - watcher disposable ownership
  - debounce timeout ownership

  Keep `refreshAiSessionViewsIncrementally()` in dashboard for this task by injecting it into the controller as `refreshNow`.

- [x] **Step 3: Verify**

  Run:

  ```bash
  npm run test:safety
  npm run test:dashboard
  npm run test-compile
  ```

- [x] **Step 4: Move `refreshAiSessionViewsIncrementally()` and `getAiSessionsUpdatedMessage()` dependencies**

  Move the current `refreshAiSessionViewsIncrementally()` / post / fallback flow into controller after Step 3 is green. Keep `withAiSessions()` and project assignment helpers injected if moving them would require too many closures in the same task.

- [x] **Step 5: Verify**

  Run:

  ```bash
  npm run test:safety
  npm run test:dashboard
  npm run test-compile
  ```

  Expected: all pass.

---

### Task 8: Upgrade Provider Registry to Runtime Registry

**Files:**
- Modify: `src/aiSessions/providers.ts`
- Modify: `src/aiSessions/types.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/aiSessions/dashboardController.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces:
  - `createAiSessionProviderRegistry(services: Record<AiSessionProviderId, AiSessionService>): AiSessionProviderRegistry`
  - `AiSessionProviderRegistry.get(providerId: AiSessionProviderId): AiSessionProvider`
  - `AiSessionProviderRegistry.providers(): AiSessionProvider[]`

- [x] **Step 1: Add failing registry checks**

  In `scripts/run-ai-session-safety-checks.js`, add checks that `src/aiSessions/providers.ts` includes:

  ```js
  assert.ok(providersSource.includes('export interface AiSessionProviderRegistry'));
  assert.ok(providersSource.includes('export function createAiSessionProviderRegistry('));
  assert.ok(providersSource.includes('providers(): AiSessionProvider[]'));
  ```

- [x] **Step 2: Implement registry**

  Add to `src/aiSessions/providers.ts`:

  ```ts
  export interface AiSessionProviderRegistry {
      get(providerId: AiSessionProviderId): AiSessionProvider | null;
      providers(): AiSessionProvider[];
  }

  export function createAiSessionProviderRegistry(services: Record<AiSessionProviderId, AiSessionService>): AiSessionProviderRegistry {
      const providers = AI_SESSION_PROVIDER_IDS.map(id => ({
          ...AI_SESSION_PROVIDER_DEFINITIONS[id],
          service: services[id],
      }));
      const byId = new Map(providers.map(provider => [provider.id, provider]));
      return {
          get: providerId => byId.get(providerId) || null,
          providers: () => providers.slice(),
      };
  }
  ```

- [x] **Step 3: Replace dashboard provider lookup**

  Replace `getRegisteredAiSessionProvider(providerId)` implementation with registry lookup. Keep the function name initially as a compatibility wrapper so this task stays scoped.

- [x] **Step 4: Replace direct `AI_SESSION_PROVIDER_IDS.map(...)` where low-risk**

  In controller/dashboard paths that already call `getRegisteredAiSessionProvider()`, prefer `aiSessionProviderRegistry.providers()` when it reduces duplicate lookups. Do not move provider-specific lifecycle parsing in this task.

- [x] **Step 5: Verify**

  Run:

  ```bash
  npm run test:safety
  npm run test:dashboard
  npm run test-compile
  ```

  Expected: all pass.

---

### Task 9: Add I/O Budget Options and Diagnostics

**Files:**
- Modify: `src/aiSessions/types.ts`
- Modify: `src/services/codexSessionService.ts`
- Modify: `src/services/kimiSessionService.ts`
- Modify: `src/services/claudeSessionService.ts`
- Modify: `src/aiSessions/dashboardController.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Extends `AiSessionQueryOptions` with:
  - `maxFiles?: number`
  - `reason?: string`
- Produces scan diagnostics through existing Project Steward output channel or injected diagnostics callback.

- [x] **Step 1: Add failing type/source checks**

  In `scripts/run-ai-session-safety-checks.js`, assert:

  ```js
  const typesSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'types.ts'), 'utf8');
  assert.ok(typesSource.includes('maxFiles?: number;'));
  assert.ok(typesSource.includes('reason?: string;'));
  ```

- [x] **Step 2: Extend `AiSessionQueryOptions`**

  Update `src/aiSessions/types.ts`:

  ```ts
  export interface AiSessionQueryOptions {
      forceRefresh?: boolean;
      candidatePaths?: string[];
      maxFiles?: number;
      reason?: string;
  }
  ```

- [x] **Step 3: Thread reason through controller refresh**

  When scheduling refreshes, pass reasons such as:

  - `watcher`
  - `visibility`
  - `new-session`
  - `manual-refresh`
  - `attention`

  Do not enforce `maxFiles` yet if provider internals need separate work. This task establishes the public contract and diagnostics path.

- [x] **Step 4: Add diagnostics**

  Add diagnostic logging around provider `getSessions()` calls in the controller:

  ```ts
  const startedAt = Date.now();
  const result = provider.service.getSessions({ candidatePaths, reason });
  logDiagnostic({
      event: 'ai-session-scan',
      provider: provider.id,
      reason,
      durationMs: Date.now() - startedAt,
      sessionCount: result.sessions.length,
      available: result.available,
  });
  ```

- [x] **Step 5: Verify**

  Run:

  ```bash
  npm run test:safety
  npm run test-compile
  ```

  Expected: all pass.

---

### Task 10: Final Architecture Verification

**Files:**
- Modify: `scripts/run-performance-architecture-baseline-checks.js`
- Modify: `docs/superpowers/specs/2026-07-16-performance-architecture-debt-design.md` only if implementation discoveries require clarifying the design.

**Interfaces:**
- Produces final baseline comparison output.

- [x] **Step 1: Update baseline script with target assertions**

  Add assertions that:

  - `src/dashboard/viewProvider.ts` exists.
  - `src/dashboard/messageRouter.ts` exists.
  - `src/dashboard/webviewUpdateMessages.ts` exists.
  - `src/openProjects/dashboardController.ts` exists.
  - `src/aiSessions/dashboardController.ts` exists.
  - `src/aiSessions/providers.ts` exports `createAiSessionProviderRegistry`.

- [x] **Step 2: Run full verification**

  Run:

  ```bash
  npm run test:architecture-baseline
  npm run test:dashboard
  npm run test:open-projects
  npm run test:safety
  npm run test:release-packaging
  npm run test:release-notes
  npm run lint
  git diff --check
  ```

  Expected:

  - all commands exit 0;
  - lint may print existing warnings but must exit 0;
  - no whitespace errors.

- [x] **Step 3: Report final metrics**

  Record in final handoff:

  - final `src/dashboard.ts` line count;
  - final `provider.refresh()` call count;
  - modules created;
  - verification commands and results;
  - any remaining intentional fallback paths.

---

## Execution Notes

- Work in current branch `refactor/performance-architecture-debt`.
- Do not commit `.vscode/settings.json`.
- Prefer small commits after each task if the user asks to commit; otherwise leave changes reviewable.
- Do not start implementation until this plan is reviewed.
- If a task reveals that moving code would require large behavior changes, stop and split the task rather than forcing the move.
