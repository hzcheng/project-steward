# OPEN / PROJECTS 双 Tab 实现计划

> **执行要求：** 实施时必须使用 `executing-plans` skill，按 checkbox（`- [ ]`）逐项推进。除非用户明确要求委派，否则不得使用 subagent。

**目标：** 将 Project Steward 侧边栏拆分为 `OPEN` 与 `PROJECTS` 两个 Tab，以真正按需加载的 PROJECTS 面板降低首次渲染成本，同时提供全局搜索、跨窗口项目 attention badge 和稳定的页面状态恢复。

**架构：** Extension Host 首次只渲染全局工具栏、Tab、实时 OPEN 面板和轻量 `DashboardSearchCatalog`，不生成 PROJECTS 卡片 HTML；Webview 首次激活 PROJECTS 时发送 `request-projects-panel`，Extension Host 再返回静态项目库 fragment。`webviewDashboardScripts.js` 是 Tab、搜索模式、PROJECTS 加载状态和滚动状态的唯一 controller，`webviewFilterScripts.js` 只负责输入框与快捷键。open-project publication、attention payload 和 bridge protocol 保持不变。

**技术栈：** TypeScript 4、VS Code Webview API、原生 JavaScript、SCSS、Node `assert` safety checks、Gulp、Webpack。

## 全局约束

- 在当前分支和当前工作区内实施，不创建 worktree。
- 保留用户已经 staged 的 PRD 与 SVG 文件，不覆盖 `.vscode/settings.json` 等无关改动。
- 未经用户 review 不执行 `git add`、`git commit` 或 `git push`；每个 Task 结束后停在 review checkpoint。
- `OPEN` 默认选中；当前 VS Code 窗口通过 `sessionStorage` 记住上次 Tab。
- `PROJECTS` 不显示 current-workspace highlight、AI session 数量、打开状态或 attention。
- `CURRENT WORKSPACE` 始终显示；OPEN 的 Collapse/Expand 只控制 `OTHER WINDOWS`。
- OTHER WINDOWS 只显示项目级未读 session 数量，不展示 session 名称、provider 或 reason；点击导航卡不 acknowledge attention。
- Tab、PROJECTS 和全局搜索结果不显示 attention。
- 全局搜索不依赖 PROJECTS 卡片 DOM，也不得触发 PROJECTS 面板加载。
- 不修改 open-project publication、attention payload 或 bridge protocol version。
- 保留 `.project`、`.project-container`、`.group`、`.group-title` 和 AI session 相关核心 class。
- 每次修改 `src/webview/*.js` 后，同一 Task 内运行 `npx gulp copyWebviewAssets` 并 review 对应 `media/*.js`，保证 checkpoint 可在扩展中运行。

## 文件职责

- `src/webview/dashboardViewModel.ts`：构建/序列化轻量搜索 catalog，定义 Webview 专用 catalog 类型。
- `src/webview/webviewContent.ts`：渲染初始 shell、OPEN fragment 和按需 PROJECTS fragment；不保存页面状态。
- `src/webview/webviewDashboardScripts.js`：管理 Tab、搜索模式、搜索结果、PROJECTS 请求状态和滚动恢复。
- `src/webview/webviewFilterScripts.js`：管理搜索输入、sessionStorage、Ctrl/Cmd+F 与 Escape，并调用 dashboard controller。
- `src/webview/webviewProjectScripts.js`：保留项目/session/group 操作、OPEN 增量更新和 attention DOM 更新；所有动态卡片交互使用事件委托。
- `src/webview/webviewDnDScripts.js`：只在已加载的 PROJECTS panel 内初始化一次 Dragula。
- `scripts/run-dashboard-webview-checks.js`：测试 dashboard 纯函数和关键 DOM/source contract。

---

### Task 1: 建立轻量 DashboardSearchCatalog

**Files:**
- Create: `src/webview/dashboardViewModel.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `Group[]`、包含 current/navigation cards 的 `Project[]`、`normalizeOpenProjectIdentity()`。
- Produces: `DashboardSearchCatalog`、`buildDashboardSearchCatalog(groups, openProjects)`、`serializeDashboardSearchCatalog(catalog)`。

- [x] **Step 1: 写 catalog 失败检查**

在 `scripts/run-ai-session-safety-checks.js` 的 VS Code module stub 生效期间加载 `out/webview/dashboardViewModel`，增加并调用：

```js
function runDashboardSearchCatalogChecks() {
    const groups = [{
        id: 'tools', groupName: 'TOOLS', collapsed: false,
        projects: [
            { id: 'saved', name: 'Dashboard', description: 'Saved', path: '/work/dashboard', favorite: true },
            { id: 'duplicate', name: 'Dashboard copy', description: 'Duplicate', path: '/work/dashboard/' },
            { id: 'other', name: 'Other', description: 'Other', path: '/work/other' },
        ],
    }];
    const openProjects = [{
        id: '__openProjects-0', name: 'Dashboard', description: 'Current', path: '/work/dashboard',
        openProjectCardKind: 'current',
        codexSessions: [{ id: 'c1', name: 'Fix dashboard', updatedAt: '2026-07-15T10:00:00Z' }],
        kimiSessions: [{ id: 'k1', name: 'Review layout', updatedAt: '2026-07-15T09:00:00Z' }],
        claudeSessions: [],
    }, {
        id: '__openProjectNavigation-remote', name: 'Remote Dashboard', description: 'Remote',
        path: 'vscode-remote://ssh-remote+host/work/dashboard-api',
        openProjectCardKind: 'projectNavigation', openProjectEnvironmentLabel: 'SSH',
    }];

    const catalog = dashboardViewModel.buildDashboardSearchCatalog(groups, openProjects);
    assert.deepStrictEqual(catalog.sessions.map(item => item.key), ['codex:c1', 'kimi:k1']);
    assert.deepStrictEqual(catalog.openProjects.map(item => item.action), ['open-current', 'switch-open']);
    assert.strictEqual(catalog.savedProjects.length, 2);
    assert.deepStrictEqual(catalog.savedProjects[0].groupLabels, ['FAVORITES', 'TOOLS']);
    assert.strictEqual(catalog.savedProjects[0].identity, '/work/dashboard');
    assert.strictEqual(catalog.openProjects[1].environmentLabel, 'SSH');

    const serialized = dashboardViewModel.serializeDashboardSearchCatalog({
        ...catalog,
        savedProjects: [{ ...catalog.savedProjects[0], name: '</script><script>bad()</script>' }],
    });
    assert.strictEqual(serialized.includes('</script>'), false);
    assert.deepStrictEqual(JSON.parse(serialized).savedProjects[0].name, '</script><script>bad()</script>');
}
```

- [x] **Step 2: 运行检查并确认红灯**

Run: `npm run test-compile && node scripts/run-ai-session-safety-checks.js`

Expected: FAIL，原因是 `out/webview/dashboardViewModel` 尚不存在。

- [x] **Step 3: 实现 catalog 类型和构建函数**

新增 `src/webview/dashboardViewModel.ts`，使用以下稳定接口：

```ts
import type { AiSessionProviderId, Group, Project } from '../models';
import { normalizeOpenProjectIdentity } from '../openProjects/projection';

export type DashboardSearchProjectAction = 'open-current' | 'switch-open' | 'open-saved';

export interface DashboardSearchSessionItem {
    key: string;
    searchText: string;
    projectId: string;
    projectName: string;
    provider: AiSessionProviderId;
    sessionId: string;
    name: string;
    updatedAt?: string;
}

export interface DashboardSearchProjectItem {
    key: string;
    identity: string;
    searchText: string;
    projectId: string;
    name: string;
    description: string;
    action: DashboardSearchProjectAction;
    environmentLabel?: string;
    groupLabels: string[];
}

export interface DashboardSearchCatalog {
    sessions: DashboardSearchSessionItem[];
    openProjects: DashboardSearchProjectItem[];
    savedProjects: DashboardSearchProjectItem[];
}
```

实现规则固定为：

- provider 顺序为 Codex、Kimi、Claude，保留每个 provider 已有 session 顺序。
- current card 生成 session items；navigation card 不生成 session items。
- saved project 使用 `normalizeOpenProjectIdentity(project.path) || project.id` 去重，保留首次出现项目的 `projectId/name/description`。
- `favorite: true` 追加 `FAVORITES`，随后按 group 遍历顺序追加不重复的 group name。
- `searchText` 使用项目/session 名、描述、provider、session id、环境和 group name 的小写拼接；不加入 attention 字段。

核心实现固定为：

```ts
const PROVIDERS: Array<{
    id: AiSessionProviderId;
    key: 'codexSessions' | 'kimiSessions' | 'claudeSessions';
}> = [
    { id: 'codex', key: 'codexSessions' },
    { id: 'kimi', key: 'kimiSessions' },
    { id: 'claude', key: 'claudeSessions' },
];

function searchable(...values: Array<string | undefined>): string {
    return values.filter(Boolean).join(' ').toLowerCase();
}

export function buildDashboardSearchCatalog(
    groups: Group[],
    openProjects: Project[]
): DashboardSearchCatalog {
    const sessions: DashboardSearchSessionItem[] = [];
    const openItems: DashboardSearchProjectItem[] = [];
    const savedByIdentity = new Map<string, DashboardSearchProjectItem>();

    (openProjects || []).forEach(project => {
        const identity = normalizeOpenProjectIdentity(project.path) || project.id;
        const current = project.openProjectCardKind !== 'projectNavigation';
        openItems.push({
            key: `open:${identity}`,
            identity,
            searchText: searchable(project.name, project.description, project.openProjectEnvironmentLabel),
            projectId: project.id,
            name: project.name || '',
            description: project.description || '',
            action: current ? 'open-current' : 'switch-open',
            environmentLabel: project.openProjectEnvironmentLabel,
            groupLabels: [],
        });
        if (!current) return;
        PROVIDERS.forEach(provider => (project[provider.key] || []).forEach(session => sessions.push({
            key: `${provider.id}:${session.id}`,
            searchText: searchable(session.name, project.name, provider.id, session.id),
            projectId: project.id,
            projectName: project.name || '',
            provider: provider.id,
            sessionId: session.id,
            name: session.name || session.id,
            updatedAt: session.updatedAt,
        })));
    });

    (groups || []).forEach(group => (group.projects || []).forEach(project => {
        const identity = normalizeOpenProjectIdentity(project.path) || project.id;
        let item = savedByIdentity.get(identity);
        if (!item) {
            item = {
                key: `saved:${identity}`,
                identity,
                searchText: searchable(project.name, project.description, group.groupName),
                projectId: project.id,
                name: project.name || '',
                description: project.description || '',
                action: 'open-saved',
                groupLabels: [],
            };
            savedByIdentity.set(identity, item);
        }
        if (project.favorite && !item.groupLabels.includes('FAVORITES')) item.groupLabels.push('FAVORITES');
        if (group.groupName && !item.groupLabels.includes(group.groupName)) item.groupLabels.push(group.groupName);
        item.searchText = searchable(item.searchText, project.name, project.description, group.groupName);
    }));

    return { sessions, openProjects: openItems, savedProjects: Array.from(savedByIdentity.values()) };
}
```

序列化函数必须安全嵌入 `application/json` script：

```ts
export function serializeDashboardSearchCatalog(catalog: DashboardSearchCatalog): string {
    return JSON.stringify(catalog)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}
```

- [x] **Step 4: 运行 catalog 与现有 safety checks**

Run: `npm run test-compile && node scripts/run-ai-session-safety-checks.js`

Expected: PASS，catalog 去重、排序和 script escaping 检查通过，现有检查无回归。

- [x] **Step 5: Review checkpoint**

Run: `git diff -- src/webview/dashboardViewModel.ts scripts/run-ai-session-safety-checks.js`

Expected: 只有 catalog 纯逻辑和检查；不要 stage 或 commit。

---

### Task 2: 移除 PROJECTS 运行态并优化 attention 投影

**Files:**
- Modify: `src/models.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/aiSessions/attentionProject.ts`
- Delete: `src/projects/currentWorkspaceState.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `AttentionAggregate`、`Project.openProjectCardKind`。
- Produces: `withAttentionProjects(projects, aggregate)`、`buildAttentionSessionIndex(aggregate)`；current-workspace 视觉只由 OPEN render context 决定。

- [x] **Step 1: 写静态 PROJECTS 与批量 attention 失败检查**

删除原 `runCurrentWorkspaceStateChecks()`，增加：

```js
function runAttentionProjectionChecks() {
    const aggregate = {
        protocolVersion: 1,
        aggregateRevision: '0'.repeat(64),
        generatedAtMs: 1,
        sessions: [
            { projectId: attentionProject.getAttentionProjectKey('/work/current'), sessionKey: 'codex:c1', reasons: ['completed'], eventIds: ['e1'], observedAtMs: 1 },
            { projectId: attentionProject.getAttentionProjectKey('/work/current'), sessionKey: 'kimi:k1', reasons: ['input-required'], eventIds: ['e2'], observedAtMs: 2 },
            { projectId: attentionProject.getAttentionProjectKey('/work/other'), sessionKey: 'claude:x1', reasons: ['failed'], eventIds: ['e3'], observedAtMs: 3 },
        ],
    };
    const input = [{ path: '/work/current' }, { path: '/work/other' }];
    const projected = attentionProject.withAttentionProjects(input, aggregate);
    assert.deepStrictEqual(projected.map(item => item.aiSessionAttentionCount), [2, 1]);
    assert.deepStrictEqual(projected[0].aiSessionAttentionEventIds, ['e1', 'e2']);
    assert.strictEqual(input[0].aiSessionAttentionCount, undefined);

    const index = attentionProject.buildAttentionSessionIndex(aggregate);
    assert.strictEqual(index.get(attentionProject.getAttentionSessionLookupKey(
        attentionProject.getAttentionProjectKey('/work/current'), 'kimi:k1'
    )).eventIds[0], 'e2');
}
```

同步增加 source contract：`dashboard.ts` 不再包含 `getGroupsWithAiSessionAttention`、`currentWorkspaceProjectIds` 或 `withAttentionProject(project, aggregate)`。

- [x] **Step 2: 运行检查并确认红灯**

Run: `npm run test:safety`

Expected: FAIL，缺少批量 projection/index，旧 current-workspace 和 saved attention 路径仍存在。

- [x] **Step 3: 实现 O(n) attention indexes**

在 `src/aiSessions/attentionProject.ts` 新增：

```ts
import type { AggregatedAttentionSession, AttentionAggregate } from './attentionAggregate';

export function getAttentionSessionLookupKey(projectKey: string, sessionKey: string): string {
    return `${projectKey}\n${sessionKey}`;
}

export function buildAttentionSessionIndex(
    aggregate: AttentionAggregate | null
): Map<string, AggregatedAttentionSession> {
    return new Map((aggregate?.sessions || []).map(session => [
        getAttentionSessionLookupKey(session.projectId, session.sessionKey),
        session,
    ] as [string, AggregatedAttentionSession]));
}

export function withAttentionProjects<TProject extends { path?: string; attentionProjectPath?: string }>(
    projects: TProject[],
    aggregate: AttentionAggregate | null
): Array<TProject & { aiSessionAttentionCount: number; aiSessionAttentionEventIds: string[] }> {
    const summaries = new Map(
        getAttentionProjectSummaries(aggregate).map(summary => [summary.projectKey, summary] as const)
    );
    return (projects || []).map(project => {
        const summary = summaries.get(getAttentionProjectKey(project.attentionProjectPath || project.path));
        return {
            ...project,
            aiSessionAttentionCount: summary?.attentionCount || 0,
            aiSessionAttentionEventIds: summary?.eventIds.slice() || [],
        };
    });
}
```

保留现有 `withAttentionProject()` 仅供其他调用者兼容；dashboard 新路径不得再使用它循环投影。

- [x] **Step 4: 将 dashboard 改为单次 aggregate/index 计算**

在 `withAiSessions()` 的 project loop 之前只计算一次：

```ts
const aggregate = getEffectiveAiSessionAttentionAggregate();
const aggregateByProjectAndSession = buildAttentionSessionIndex(aggregate);
const localAttentionBySession = aiSessionAttentionMonitor.getSnapshot();
```

session map 内使用：

```ts
const sessionKey = getAiSessionKey(providerId, session.id);
const aggregateAttention = aggregateByProjectAndSession.get(
    getAttentionSessionLookupKey(projectKey, sessionKey)
);
const attention = localAttentionBySession[sessionKey];
```

`withAiSessions()` 返回带 session row attention 的普通 project；`getOpenProjectCards()` 对 `projectOpenProjectCards(...)` 的最终 cards 调用一次 `withAttentionProjects()`。`getAiSessionsUpdatedMessage()` 调用一次 `getOpenProjectCards()`，过滤 navigation cards 后生成 session view models。

- [x] **Step 5: 删除 saved current-workspace/attention 路径**

执行以下收敛：

- `provider.refresh()` 直接传 `projectService.getGroups()`，删除 `getGroupsWithAiSessionAttention()`。
- 删除 `Project.isCurrentWorkspace` 和 `StewardInfos.currentWorkspaceProjectIds`。
- 删除 `src/projects/currentWorkspaceState.ts`、对应 import、`getCurrentWorkspaceProjectIds()` 和相关 safety checks。
- `getStewardContent()` 直接使用 `groups` 与 `infos.openProjects`，不再调用 `withCurrentWorkspaceState()`。
- `getOpenProjectsGroupContent()` 立即删除 `currentWorkspaceProjectIds` 参数，并同步 `postOpenProjectsUpdated()` 调用点，保证 Task 2 自身可编译。
- `getProjectDiv()` 不再读取 `project.isCurrentWorkspace`；Task 3 将通过明确 render option 只给 current OPEN card 输出 `data-current-workspace`。

- [x] **Step 6: 运行 safety checks**

Run: `npm run test:safety`

Expected: PASS；aggregate 查找不再位于 session `.find()` 循环，PROJECTS 输入不再被运行态装饰。

- [x] **Step 7: Review checkpoint**

Run: `git diff -- src/models.ts src/dashboard.ts src/aiSessions/attentionProject.ts src/projects/currentWorkspaceState.ts src/webview/webviewContent.ts scripts/run-ai-session-safety-checks.js`

Expected: 只包含运行态边界清理和 attention 索引优化；bridge protocol 文件无改动；不要 stage 或 commit。

---

### Task 3: 渲染初始 shell、OPEN sections 和空状态

**Files:**
- Modify: `src/constants.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Consumes: `buildDashboardSearchCatalog()`、带 aggregate summary 的 open cards。
- Produces: `getStewardContent()` 初始 shell、`getOpenProjectsGroupContent()`、`getProjectsPanelContent()`；初始 HTML 不包含 saved project cards。

- [x] **Step 1: 写 OPEN/shell/空状态失败检查**

对 `getStewardContent()` 和 `getOpenProjectsGroupContent()` 增加四组 fixture：current only、current + navigation、navigation only、no cards。断言：

```js
assert(shell.includes('role="tablist"'));
assert(shell.includes('data-dashboard-tab="open"'));
assert(shell.includes('data-dashboard-tab="projects"'));
assert(shell.includes('id="dashboard-tab-open"'));
assert(shell.includes('id="dashboard-tab-projects"'));
assert(shell.includes('aria-controls="dashboard-tab-open"'));
assert(shell.includes('aria-controls="dashboard-tab-projects"'));
assert(shell.includes('aria-labelledby="dashboard-tab-open-button"'));
assert(shell.includes('aria-labelledby="dashboard-tab-projects-button"'));
assert(shell.includes('id="dashboard-search-results"'));
assert(shell.includes('id="dashboard-search-catalog"'));
assert.strictEqual(shell.includes('dashboard-projects-template'), false);
assert.strictEqual(shell.includes('class="groups-wrapper"'), false);

assert(currentOnly.includes('CURRENT WORKSPACE'));
assert.strictEqual(currentOnly.includes('OTHER WINDOWS'), false);
assert(currentAndOther.includes('CURRENT WORKSPACE'));
assert(currentAndOther.includes('OTHER WINDOWS'));
assert(navigationOnly.includes('No folder is open in this window.'));
assert(navigationOnly.includes('OTHER WINDOWS'));
assert(noCards.includes('Open a folder to see running projects.'));
assert.strictEqual(noCards.includes('OTHER WINDOWS'), false);
```

为 navigation fixture 设置 `aiSessionAttentionCount: 2`，并断言 opening tag 有 `data-attention-project-key`、card 内有 `.project-ai-attention-badge`；单独调用 `getProjectsPanelContent()`，断言没有 `data-current-workspace`、`data-attention-project-key`、AI session HTML。

- [x] **Step 2: 运行检查并确认红灯**

Run: `npm run test:safety`

Expected: FAIL，缺少 Tab shell、OPEN section 拆分、空状态和按需 PROJECTS renderer。

- [x] **Step 3: 定义明确的 section/project render options**

保留 `OPEN_PROJECTS_GROUP_ID` 作为 OTHER WINDOWS 的 group id，使现有 `OPEN_PROJECTS_GROUP_COLLAPSED_KEY` 继续生效；只新增：

```ts
export const OPEN_CURRENT_WORKSPACE_GROUP_ID = '__openCurrentWorkspace';
```

将位置布尔参数替换为：

```ts
interface GroupSectionOptions {
    virtual: boolean;
    readOnlyProjects: boolean;
    draggableVirtualProjects: boolean;
    collapsible: boolean;
    className: string;
    systemBadge: string;
    projectAttentionMode: 'current' | 'navigation' | 'none';
}
```

所有调用点都传完整 options：CURRENT=`current` 且不可折叠，OTHER WINDOWS=`navigation` 且可折叠，Favorites/普通组=`none`。

- [x] **Step 4: 实现 OPEN 四种页面状态**

`getOpenProjectsGroupContent(cards, collapsed, infos)` 固定按 `openProjectCardKind` 拆分：

```ts
const currentCards = (cards || []).filter(card => card.openProjectCardKind !== 'projectNavigation');
const navigationCards = (cards || []).filter(card => card.openProjectCardKind === 'projectNavigation');
const currentContent = currentCards.length
    ? currentCards.map(card => getProjectDiv(card, currentOptions)).join('\n')
    : getOpenCurrentWorkspaceEmptyState(navigationCards.length > 0);
return [
    getOpenCurrentWorkspaceSection(currentContent),
    navigationCards.length ? getOtherWindowsSection(navigationCards, collapsed, infos) : '',
].join('\n');
```

空状态文案固定为：有 navigation 时 `No folder is open in this window.`；完全无 cards 时 `Open a folder to see running projects.`。CURRENT section 始终输出且无 `data-action="collapse"`。

- [x] **Step 5: 实现 attention 展示边界**

`getProjectDiv(project, options)` 使用：

```ts
const showCurrentAttention = options.projectAttentionMode === 'current';
const showNavigationAttention = options.projectAttentionMode === 'navigation';
const attentionProjectKey = options.projectAttentionMode === 'none'
    ? ''
    : getAttentionProjectKey(project.attentionProjectPath || project.path);
const projectAttentionBadge = showNavigationAttention && projectAttentionCount
    ? `<span class="project-ai-attention-badge" title="${projectAttentionCount} AI sessions need attention">${projectAttentionCount}</span>`
    : '';
```

current card 输出 `data-current-workspace`、AI session badge/rows；navigation 输出 project attention badge 但无 session HTML；PROJECTS 不输出上述运行态 attribute/class。

- [x] **Step 6: 实现初始 shell 与按需 PROJECTS renderer**

`getStewardContent()` 只输出 toolbar、tablist、OPEN panel、空 PROJECTS panel、search panel 和安全 catalog JSON。PROJECTS panel 初始内容固定为：

```html
<section id="dashboard-tab-projects" class="dashboard-tab-panel" role="tabpanel" hidden>
  <div class="dashboard-projects-loading" role="status" hidden>Loading projects…</div>
</section>
```

新增导出 `getProjectsPanelContent(groups, infos)`，其中才生成 Favorites、普通 groups、empty/import state 和 New Group。初始 `getStewardContent()` 不调用该函数。

- [x] **Step 7: 运行 safety checks**

Run: `npm run test:safety`

Expected: PASS；四种 OPEN 状态、attention 边界、初始 HTML 无 saved card DOM、PROJECTS fragment 静态化均有断言。

- [x] **Step 8: Review checkpoint**

Run: `git diff -- src/constants.ts src/webview/webviewContent.ts scripts/run-ai-session-safety-checks.js scripts/run-open-project-safety-checks.js`

Expected: 初始 HTML 只包含 OPEN 和 catalog；PROJECTS fragment 可独立生成；不要 stage 或 commit。

---

### Task 4: 实现 Tab controller 与真正按需加载 PROJECTS

**Files:**
- Create: `src/webview/webviewDashboardScripts.js`
- Create: `scripts/run-dashboard-webview-checks.js`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `package.json`
- Generated: `media/webviewDashboardScripts.js`
- Generated: `media/webviewProjectScripts.js`

**Interfaces:**
- Consumes: Task 3 shell 和 `getProjectsPanelContent()`。
- Produces: `initDashboard(options)` controller；Webview messages `request-projects-panel` / `projects-panel-content` version 1。

- [x] **Step 1: 写 controller 与消息失败检查**

新增 `scripts/run-dashboard-webview-checks.js`，用 `vm` 加载 dashboard script 并检查：

```js
assert.strictEqual(normalizeDashboardTab('projects'), 'projects');
assert.strictEqual(normalizeDashboardTab('invalid'), 'open');
assert.strictEqual(getAdjacentDashboardTab('open', 'ArrowRight'), 'projects');
assert.strictEqual(getAdjacentDashboardTab('projects', 'ArrowLeft'), 'open');
assert.strictEqual(validateProjectsPanelMessage({
    type: 'projects-panel-content', version: 1, requestId: 2, html: '<div></div>',
}), true);
assert.strictEqual(validateProjectsPanelMessage({
    type: 'projects-panel-content', version: 2, requestId: 2, html: '<div></div>',
}), false);
```

source contract 断言 active Tab storage、`aria-selected`、inactive `tabindex="-1"`、requestId 防旧响应、`scrollPositions`。dashboard safety 检查 Extension Host 存在两个 message type，并调用 `getProjectsPanelContent(projectService.getGroups(), stewardInfos)`。

在 `package.json` 同时增加：

```json
"test:dashboard": "npm run test-compile && node scripts/run-dashboard-webview-checks.js"
```

- [x] **Step 2: 运行检查并确认红灯**

Run: `npm run test-compile && node scripts/run-dashboard-webview-checks.js && node scripts/run-ai-session-safety-checks.js`

Expected: FAIL，dashboard script 和按需 panel message 尚不存在。

- [x] **Step 3: 实现 Tab 与 PROJECTS 请求状态机**

`initDashboard(options)` 内部状态固定为：

```js
const storageKey = 'projectSteward.activeDashboardTab';
const scrollPositions = { open: 0, projects: 0 };
let activeTab = normalizeDashboardTab(sessionStorage.getItem(storageKey));
let projectsState = 'unloaded';
let projectsRequestId = 0;
let acceptedProjectsRequestId = 0;
let pendingScrollRestoreTab = null;
```

controller 返回：

```js
return {
    activateTab,
    applyProjectsPanelMessage,
    ensureProjectsPanel,
    getActiveTab: () => activeTab,
    getProjectsState: () => projectsState,
    getScrollPosition: tab => scrollPositions[normalizeDashboardTab(tab)],
};
```

`activateTab()` 保存旧 Tab 的 `window.scrollY`，更新 panel hidden、`aria-selected`、tabindex 和 storage。切到已 mounted panel 时下一帧恢复该 Tab scroll；切到尚未 mounted 的 PROJECTS 时设置 `pendingScrollRestoreTab='projects'`，由 `applyProjectsPanelMessage()` 挂载完成后恢复，避免 loading panel 高度把 scroll clamp 为 0。激活 PROJECTS 时 `ensureProjectsPanel()` 只发送一次：

```js
options.postMessage({
    type: 'request-projects-panel',
    version: 1,
    requestId: ++projectsRequestId,
});
```

接收同 requestId 的 version 1 响应后才设置 `panel.innerHTML` 和 `projectsState='mounted'`，随后调用 `options.onProjectsMounted(panel)` 并处理 `pendingScrollRestoreTab`；旧 requestId、错误 version/html 不修改 DOM。

- [x] **Step 4: 在 Extension Host 响应 PROJECTS 请求**

`handleStewardMessage()` 新增：

```ts
case 'request-projects-panel':
    if (e.version !== 1 || !Number.isSafeInteger(e.requestId) || e.requestId < 1) {
        break;
    }
    await provider.postMessage({
        type: 'projects-panel-content',
        version: 1,
        requestId: e.requestId,
        html: getProjectsPanelContent(projectService.getGroups(), stewardInfos),
    });
    break;
```

该消息只存在于 Extension Host/Webview，不进入 open-project 或 attention bridge。

- [x] **Step 5: 将动态 PROJECTS 操作改为事件委托**

把 `add-project` 和 `import-from-other-storage` 分支加入现有 `onMouseEvent()`，删除初始化末尾两段 `querySelectorAll(...).addEventListener(...)`。新增 source contract 断言这两个 selector 不再出现在 `initProjects()` 的直接绑定中；PROJECTS 首次加载后 Add/Import 也由 document click listener 处理。

- [x] **Step 6: 接入脚本、fitty 和初始化顺序**

`webviewContent.ts` 加载 dashboard asset，并把现有 onload 前的 fitty 调用移入：

下面代码位于 `getStewardContent()` 返回的 inline script template literal 内，因此 fitty options 由 Extension Host 插值：

```ts
function fitProjectHeaders(root) {
    if (!document.body.classList.contains('steward-sidebar')) {
        Array.from(root.querySelectorAll('.project-header')).forEach(element =>
            fitty(element, ${JSON.stringify(FITTY_OPTIONS)})
        );
    }
}

window.onload = () => {
    initProjects();
    window.__projectStewardDashboard = initDashboard({
        postMessage: message => window.vscode.postMessage(message),
        onProjectsMounted: panel => fitProjectHeaders(panel),
    });
    fitProjectHeaders(document.getElementById('dashboard-tab-open'));
    initFiltering(${infos.config.searchIsActiveByDefault});
};
```

controller 初始化时移除 `body.preload`，注册 tab click/keyboard 和 `projects-panel-content` message listener。Left/Right 只移动 focus，Enter/Space 激活。Task 4/5 暂时保留旧 filter adapter，避免中间 checkpoint 的搜索框失效；Task 6 再原子替换为全局搜索 controller。

- [x] **Step 7: 生成 assets 并运行检查**

Run:

```bash
npx gulp copyWebviewAssets
npm run test:dashboard
npm run test:safety
cmp src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
```

Expected: 全部 exit 0；PROJECTS 请求只在首次激活发生，动态 Add/Import contract 通过。

- [x] **Step 8: Review checkpoint**

Run: `git diff -- src/dashboard.ts src/webview/webviewContent.ts src/webview/webviewDashboardScripts.js src/webview/webviewProjectScripts.js media/webviewDashboardScripts.js media/webviewProjectScripts.js scripts/run-dashboard-webview-checks.js package.json`

Expected: 一个明确的 PROJECTS request/response contract；初始页面不预生成项目库；不要 stage 或 commit。

---

### Task 5: 恢复 PROJECTS DnD 并持久化 active Tab 折叠状态

**Files:**
- Modify: `src/webview/webviewDnDScripts.js`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `src/webview/webviewContent.ts`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Generated: `media/webviewDnDScripts.js`
- Generated: `media/webviewProjectScripts.js`

**Interfaces:**
- Consumes: Task 4 `onProjectsMounted(panel)` 和现有 `collapse-group` message。
- Produces: 幂等 `initDnD(root)`、`window.__projectStewardSyncCollapseButton()`、每组持久化的 Collapse All。

- [x] **Step 1: 写 DnD/collapse 失败检查**

source/VM checks 固定断言：

```js
assert(dndSource.includes('function initDnD(root)'));
assert(dndSource.includes('root.__projectStewardDnDInitialized'));
assert.strictEqual(dndSource.includes('document.querySelectorAll(`${groupsContainerSelector}'), false);
assert(projectSource.includes("type: 'collapse-group'"));
assert(projectSource.includes("Collapse Other Windows"));
assert(projectSource.includes("Expand Other Windows"));
assert(projectSource.includes('aria-disabled'));
```

增加纯函数检查：

```js
assert.deepStrictEqual(getCollapseButtonState('open', []), {
    disabled: true, collapsed: false, title: 'No other windows to collapse',
});
assert.strictEqual(getCollapseButtonState('open', [false]).title, 'Collapse Other Windows');
assert.strictEqual(getCollapseButtonState('open', [true]).title, 'Expand Other Windows');
assert.strictEqual(getCollapseButtonState('projects', [false, true]).title, 'Collapse All Groups');
assert.strictEqual(getCollapseButtonState('projects', [true, true]).title, 'Expand All Groups');
```

- [x] **Step 2: 运行检查并确认红灯**

Run: `npm run test:dashboard`

Expected: FAIL，DnD 仍是 document-wide，Collapse All 不持久化。

- [x] **Step 3: 将 DnD 完全限制在 PROJECTS root**

`initDnD(root)` 必须：

- 无 root 或已初始化时直接返回。
- 只用 `root.querySelectorAll('.group-list')` 和 `root.querySelectorAll('.groups-wrapper')` 创建 drakes。
- reorder 时只从 root 内读取普通 groups、tempGroup 和 project ids。
- PROJECTS 首次响应后调用一次，OPEN/search 永不调用。
- Escape/auto-scroll listener 只创建一次；将 disposable/drakes 保存到 `root.__projectStewardDnD`。

- [x] **Step 4: 实现可持久化的 Collapse All**

`getActiveCollapsibleGroups()` 固定返回：OPEN 的 `#dashboard-tab-open .open-other-windows-group[data-group-id]`，或已 mounted PROJECTS 的 `#dashboard-tab-projects .group[data-group-id]`。对每个目标调用：

```js
function setGroupCollapsed(group, collapsed, persist) {
    group.classList.toggle('collapsed', collapsed);
    if (persist) {
        window.vscode.postMessage({
            type: 'collapse-group',
            groupId: group.getAttribute('data-group-id'),
            collapsed,
        });
    }
}
```

实现纯函数：

```js
function getCollapseButtonState(tab, collapsedStates) {
    if (!collapsedStates.length) {
        return {
            disabled: true,
            collapsed: false,
            title: tab === 'open' ? 'No other windows to collapse' : 'No project groups to collapse',
        };
    }
    const collapsed = collapsedStates.every(Boolean);
    return {
        disabled: false,
        collapsed,
        title: tab === 'open'
            ? (collapsed ? 'Expand Other Windows' : 'Collapse Other Windows')
            : (collapsed ? 'Expand All Groups' : 'Collapse All Groups'),
    };
}
```

OTHER WINDOWS 继续使用 `OPEN_PROJECTS_GROUP_ID`，因此 Extension Host 复用现有 globalState key；Favorites 和普通 groups 分别走现有 Favorites key/projectService update。单组点击和 Collapse All 后都调用全局 `window.__projectStewardSyncCollapseButton()`。

- [x] **Step 5: 接入 mount/tab/open-update 回调**

Task 4 的 controller options 增加 `onActiveTabChanged`。初始化固定为：

```js
window.__projectStewardDashboard = initDashboard({
    postMessage: message => window.vscode.postMessage(message),
    onProjectsMounted: panel => {
        fitProjectHeaders(panel);
        initDnD(panel);
        window.__projectStewardSyncCollapseButton();
    },
    onActiveTabChanged: () => window.__projectStewardSyncCollapseButton(),
});
```

`applyOpenProjectsUpdate()` 完成 fragment 替换后也同步按钮。PROJECTS loading/unloaded 或 OPEN 无 Other Windows 时 button 设置 `disabled` 和 `aria-disabled="true"`。

- [x] **Step 6: 生成 assets 并运行检查**

Run:

```bash
npx gulp copyWebviewAssets
npm run test:dashboard
npm run test:safety
cmp src/webview/webviewDnDScripts.js media/webviewDnDScripts.js
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
```

Expected: 全部 exit 0；DnD root/幂等和折叠持久化 contract 通过。

- [x] **Step 7: Review checkpoint**

Run: `git diff -- src/webview/webviewDnDScripts.js src/webview/webviewProjectScripts.js src/webview/webviewContent.ts media/webviewDnDScripts.js media/webviewProjectScripts.js scripts/run-dashboard-webview-checks.js`

Expected: OPEN 不进入 DnD；每个被 Collapse All 修改的 group 都发送持久化消息；不要 stage 或 commit。

---

### Task 6: 实现统一全局搜索 controller 和安全结果 DOM

**Files:**
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/webview/webviewFilterScripts.js`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `src/webview/webviewContent.ts`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Generated: `media/webviewDashboardScripts.js`
- Generated: `media/webviewFilterScripts.js`
- Generated: `media/webviewProjectScripts.js`

**Interfaces:**
- Consumes: 初始 `DashboardSearchCatalog` JSON、Task 4 controller。
- Produces: `setSearchQuery(query)`、`replaceSearchCatalog(catalog)`、`isSearchActive()`；`initFiltering()` 返回 `{ clear, focus, apply }`。

- [x] **Step 1: 写搜索纯函数与 source contract 失败检查**

VM 检查：

```js
function makeDashboardCatalog() {
    return {
        sessions: [{
            key: 'codex:c1', searchText: 'fix dashboard codex c1', projectId: 'current',
            projectName: 'Dashboard', provider: 'codex', sessionId: 'c1', name: 'Fix dashboard',
        }],
        openProjects: [{
            key: 'open:/work/dashboard', identity: '/work/dashboard', searchText: 'dashboard current',
            projectId: 'current', name: 'Dashboard', description: 'Current',
            action: 'open-current', groupLabels: [],
        }],
        savedProjects: [{
            key: 'saved:/work/dashboard', identity: '/work/dashboard', searchText: 'dashboard tools',
            projectId: 'saved', name: 'Dashboard', description: 'Saved',
            action: 'open-saved', groupLabels: ['FAVORITES', 'TOOLS'],
        }],
    };
}

function makeUpdatedDashboardCatalog() {
    const catalog = makeDashboardCatalog();
    return {
        ...catalog,
        sessions: catalog.sessions.concat({
            key: 'kimi:k1', searchText: 'review dashboard kimi k1', projectId: 'current',
            projectName: 'Dashboard', provider: 'kimi', sessionId: 'k1', name: 'Review dashboard',
        }),
    };
}

assert.strictEqual(globToDashboardRegex('dash*').test('dashboard'), true);
assert.strictEqual(globToDashboardRegex('data?').test('data1'), true);
const sections = filterDashboardCatalog(makeDashboardCatalog(), 'dashboard');
assert.deepStrictEqual(sections.map(section => section.id), [
    'ai-sessions', 'open-projects', 'saved-projects',
]);
assert.strictEqual(filterDashboardCatalog(makeDashboardCatalog(), 'missing').length, 0);
assert.deepStrictEqual(normalizeDashboardSearchCatalog(null), {
    sessions: [], openProjects: [], savedProjects: [],
});
```

提取 `renderDashboardSearchResults` 函数体，断言包含 `textContent`、`createElement('button')`，不包含 `innerHTML`、`project-ai-attention-badge` 或 `data-current-workspace`。filter source 必须同时包含 `ctrlKey`、`metaKey` 和 Escape。

- [x] **Step 2: 运行检查并确认红灯**

Run: `npm run test:dashboard`

Expected: FAIL，dashboard 尚无搜索 catalog/controller/results。

- [x] **Step 3: 实现 catalog normalization 和纯匹配模型**

dashboard script 新增：

```js
function normalizeDashboardSearchCatalog(value) {
    return value && Array.isArray(value.sessions)
        && Array.isArray(value.openProjects)
        && Array.isArray(value.savedProjects)
        ? value
        : { sessions: [], openProjects: [], savedProjects: [] };
}

function readInitialDashboardSearchCatalog() {
    const element = document.getElementById('dashboard-search-catalog');
    try {
        return normalizeDashboardSearchCatalog(JSON.parse(element?.textContent || ''));
    } catch (_error) {
        return normalizeDashboardSearchCatalog(null);
    }
}

function globToDashboardRegex(value) {
    const escaped = value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(escaped, 'i');
}
```

`filterDashboardCatalog()` 始终按 AI SESSIONS、OPEN PROJECTS、SAVED PROJECTS 顺序返回非空 sections，并保留 catalog 内排序。`globToDashboardRegex()` 先转义所有 regex 元字符，再只展开 `*` 和 `?`，因此用户输入不会产生无效正则。

- [x] **Step 4: 实现单一搜索状态所有者**

`initDashboard()` 解析 `#dashboard-search-catalog.textContent`，并扩展返回值：

```js
return {
    activateTab,
    applyProjectsPanelMessage,
    ensureProjectsPanel,
    getActiveTab: () => activeTab,
    getProjectsState: () => projectsState,
    isSearchActive: () => searchQuery.length > 0,
    replaceSearchCatalog,
    setSearchQuery,
};
```

进入搜索前保存 active Tab scroll；搜索期间隐藏 tablist、Collapse 和两个 tabpanel，只显示 search results；退出后恢复 active Tab，若它是尚未加载的 PROJECTS 才发请求，并在 panel 可用后恢复对应 scroll。初始 stored filter 非空时不得请求 PROJECTS，即使 stored active Tab 是 PROJECTS。

- [x] **Step 5: 用 DOM API 渲染和执行搜索结果**

每条结果必须是 `<button type="button" class="dashboard-search-result">`，所有名称、描述和 badges 通过 `textContent` 设置。action 固定为：

```js
switch (button.dataset.searchAction) {
    case 'resume-session':
        window.__projectStewardAcknowledgeSession(button.dataset.provider, button.dataset.sessionId);
        window.vscode.postMessage({
            type: `resume-${button.dataset.provider}-session`,
            provider: button.dataset.provider,
            projectId: button.dataset.projectId,
            sessionId: button.dataset.sessionId,
        });
        break;
    case 'show-current-project':
        options.clearSearch();
        activateTab('open', false);
        window.__projectStewardShowCurrentProject(button.dataset.projectId);
        break;
    case 'switch-open-project':
    case 'open-saved-project':
        window.vscode.postMessage({
            type: 'selected-project',
            projectId: button.dataset.projectId,
            projectOpenType: 0,
        });
        break;
}
```

no-results 使用 `role="status"`。搜索 DOM 不复用 `.project` 或任何 attention/current class。

- [x] **Step 6: 将 filter script 收敛为输入 adapter**

`initFiltering(activeByDefault, dashboard)` 返回：

```js
return {
    clear: () => {
        filterInput.value = '';
        sessionStorage.setItem('filterValue', '');
        dashboard.setSearchQuery('');
    },
    focus: () => filterInput.focus(),
    apply: () => dashboard.setSearchQuery(filterInput.value),
};
```

输入事件更新 storage 后调用 `dashboard.setSearchQuery()`；Ctrl/Cmd+F 只聚焦并 select，不清空；Escape/clear button 调用 `clear()`。初始化使用：

```js
const storedFilter = sessionStorage.getItem('filterValue') || '';
let filtering;
const dashboard = initDashboard({
    initialSearchQuery: storedFilter,
    clearSearch: () => filtering.clear(),
    postMessage: message => window.vscode.postMessage(message),
    onProjectsMounted: panel => {
        fitProjectHeaders(panel);
        initDnD(panel);
        window.__projectStewardSyncCollapseButton();
    },
    onActiveTabChanged: () => window.__projectStewardSyncCollapseButton(),
});
window.__projectStewardDashboard = dashboard;
filtering = initFiltering(${infos.config.searchIsActiveByDefault}, dashboard);
filtering.apply();
```

当 `searchIsActiveByDefault` 为 true 且 stored filter 为空时，只在初始化后 focus/select 搜索框，不进入搜索结果模式。

- [x] **Step 7: 暴露 current/session 操作的稳定接口**

把 row-based acknowledgement 的核心提取为 `window.__projectStewardAcknowledgeSession(provider, sessionId)`。新增 `window.__projectStewardShowCurrentProject(projectId)`：遍历 current OPEN cards 精确比较 `data-id`；若未展开则调用现有 `toggleCodexSessions(projectDiv, projectId)` 以持久化展开状态；设置临时 `tabindex="-1"`、focus 并 `scrollIntoView({ block: 'nearest' })`，blur 后移除临时 tabindex。navigation card 点击不调用 acknowledge。

- [x] **Step 8: 生成 assets、运行检查和 review**

Run:

```bash
npx gulp copyWebviewAssets
npm run test:dashboard
npm run test:safety
cmp src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js
cmp src/webview/webviewFilterScripts.js media/webviewFilterScripts.js
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git diff --check
```

Expected: 全部 exit 0；搜索不加载 PROJECTS、不拼接不可信文本、不显示 attention，并能恢复 Tab/scroll。把 Task 6 diff 交给用户 review，不 stage 或 commit。

---

### Task 7: 在增量更新中同步搜索 catalog 且不重置页面状态

**Files:**
- Modify: `src/aiSessions/types.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Generated: `media/webviewDashboardScripts.js`
- Generated: `media/webviewProjectScripts.js`

**Interfaces:**
- Consumes: `DashboardSearchCatalog`、`AiSessionsUpdatedMessage`、`open-projects-updated`。
- Produces: 两类增量 Webview message 的 `searchCatalog` 字段；controller `replaceSearchCatalog()`。

- [x] **Step 1: 写消息 contract 与状态保持失败检查**

从 `dashboard.ts` 提取 `getAiSessionsUpdatedMessage()` 和 `postOpenProjectsUpdated()` 函数体，增加 source contract：

```js
assert(getAiSessionsUpdatedMessageBody.includes('searchCatalog: buildDashboardSearchCatalog('));
assert(postOpenProjectsUpdatedBody.includes('searchCatalog: buildDashboardSearchCatalog('));
assert(projectScriptSource.includes('replaceSearchCatalog(message.searchCatalog)'));
assert.strictEqual(projectScriptSource.includes("sessionStorage.setItem('projectSteward.activeDashboardTab', 'open')"), false);
```

增加纯状态检查：

```js
const state = {
    activeTab: 'projects',
    searchQuery: 'dash',
    scrollPositions: { open: 12, projects: 34 },
    catalog: makeDashboardCatalog(),
};
const next = replaceDashboardSearchCatalogState(state, makeUpdatedDashboardCatalog());
assert.strictEqual(next.activeTab, 'projects');
assert.strictEqual(next.searchQuery, 'dash');
assert.deepStrictEqual(next.scrollPositions, { open: 12, projects: 34 });
assert.notStrictEqual(next.catalog, state.catalog);
```

- [x] **Step 2: 运行检查并确认红灯**

Run: `npm run test:dashboard && npm run test:safety`

Expected: FAIL，两类增量消息尚无 catalog。

- [x] **Step 3: 扩展 AI session Webview message**

在 `src/aiSessions/types.ts` 为 `AiSessionsUpdatedMessage` 增加：

```ts
import type { DashboardSearchCatalog } from '../webview/dashboardViewModel';

searchCatalog: DashboardSearchCatalog;
```

`getAiSessionsUpdatedMessage()` 只调用一次 `getOpenProjectCards()`：current cards 生成 `openProjects` view models，全部 cards 与原始 groups 生成 catalog。

- [x] **Step 4: 扩展 open-project fragment message**

`postOpenProjectsUpdated()` 使用同一 `cards` 同时生成 OPEN html 和：

```ts
searchCatalog: buildDashboardSearchCatalog(projectService.getGroups(), cards),
```

不修改 publication/aggregate 类型、version 或 bridge extension。

- [x] **Step 5: Webview 接受 catalog 并保持状态**

`applyAiSessionsUpdate()` 与 `applyOpenProjectsUpdate()` 在原 sequence/revision 校验通过后调用：

```js
window.__projectStewardDashboard.replaceSearchCatalog(message.searchCatalog);
```

`replaceSearchCatalog()` normalize 后只替换内存 catalog；仅在 search active 时重新渲染 results，不调用 `activateTab()`、`ensureProjectsPanel()`、`scrollTo()` 或清空输入。

dashboard script 新增并由 controller 使用：

```js
function replaceDashboardSearchCatalogState(state, catalog) {
    return {
        ...state,
        catalog: normalizeDashboardSearchCatalog(catalog),
    };
}
```

两类增量 handler 在接受消息前都要求 `normalizeDashboardSearchCatalog(message.searchCatalog) === message.searchCatalog`；不合法时沿用现有 full-refresh recovery，不用空 catalog 覆盖当前搜索。

- [x] **Step 6: 生成 asset 并运行检查**

Run:

```bash
npx gulp copyWebviewAssets
npm run test:dashboard
npm run test:safety
cmp src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
```

Expected: 全部 exit 0；open-project/attention bridge safety checks 保持通过。

- [x] **Step 7: Review checkpoint**

Run: `git diff -- src/aiSessions/types.ts src/dashboard.ts src/webview/webviewDashboardScripts.js src/webview/webviewProjectScripts.js media/webviewDashboardScripts.js media/webviewProjectScripts.js scripts/run-ai-session-safety-checks.js scripts/run-dashboard-webview-checks.js`

Expected: catalog 仅扩展 Extension Host/Webview contract；页面状态不被增量消息重置；不要 stage 或 commit。

---

### Task 8: 样式、性能证据、文档和端到端验证

**Files:**
- Modify: `media/styles.scss`
- Generated: `media/styles.css`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `docs/running-projects-tabs-prd.md` only if implementation reveals an approved behavior mismatch

**Interfaces:**
- Consumes: Tasks 1–7 的 DOM/data/message contracts。
- Produces: 主题兼容 UI、确定性的首次渲染性能证据、用户文档和完整验证记录。

- [x] **Step 1: 写样式与性能结构 contract 失败检查**

检查 `media/styles.scss` 包含：

```js
for (const selector of [
    '.dashboard-tab-list', '.dashboard-tab-button', '.dashboard-tab-panel',
    '.dashboard-search-results', '.dashboard-search-section', '.dashboard-search-result',
    '.open-current-workspace-group', '.open-other-windows-group', '.dashboard-projects-loading',
]) {
    assert(styles.includes(selector), `missing ${selector}`);
}
```

保留 Task 3 的确定性性能断言：初始 `getStewardContent()` 不含 `.groups-wrapper`/saved project card，只有 `getProjectsPanelContent()` 含项目库；dashboard check 断言 `request-projects-panel` 只从 `ensureProjectsPanel()` 发出，搜索路径不调用它。

- [x] **Step 2: 实现主题、窄宽度和焦点样式**

样式必须：

- 使用 VS Code theme tokens，不写死生产深色背景。
- Toolbar 第一行保持 Search、Collapse、Settings；Tab 第二行 sticky。
- `[aria-selected="true"]` 同时以背景、边框和 font-weight 表达选中；所有按钮有 `:focus-visible`。
- CURRENT WORKSPACE 无折叠箭头；OTHER WINDOWS 有。
- navigation 复用 `.project-ai-attention-badge` 有限动画；搜索结果不匹配该 class。
- 小于 240px 时截断 description/group badges，保留 Tab、环境 badge 和按钮点击区域。

- [x] **Step 3: 生成全部发布 assets**

Run: `npx gulp buildStyles copyWebviewAssets`

Expected: exit 0；`media/styles.css` 更新，四个 Webview JS 与 `src/webview` mirrors 一致。

- [x] **Step 4: 更新 README 与 CHANGELOG**

README 说明 OPEN/PROJECTS 职责、三类全局搜索、OTHER WINDOWS attention 和静态 PROJECTS。CHANGELOG 在 `1.1.8` 之前新增 `## [Unreleased]`，记录：

- 新增 OPEN/PROJECTS Tab 与全局搜索。
- PROJECTS 改为按需加载。
- attention 仅显示在 OPEN。
- 旧 `.steward-sticky-header > .sticky-groups-wrapper` 自定义 CSS 层级发生变化。

- [x] **Step 5: 运行自动验证**

依次执行：

```bash
npm run test:dashboard
npm run test:safety
npm run test:release-notes
npm run lint
npm run webpack
npm run attention:bridge:bundle
npm run vscode:prepublish
cmp src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js
cmp src/webview/webviewDnDScripts.js media/webviewDnDScripts.js
cmp src/webview/webviewFilterScripts.js media/webviewFilterScripts.js
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
```

Expected: 每条命令 exit 0；无 assertion、TypeScript、TSLint、Webpack 或 production build failure。

- [ ] **Step 6: 手工验证 OPEN/PROJECTS/搜索**

在至少两个 VS Code 窗口验证：

1. 首次显示 OPEN；恢复 PROJECTS 时只发一次 panel request。
2. 当前窗口有项目、current+other、navigation only、所有窗口无项目四种 OPEN 状态均符合 PRD。
3. PROJECTS 加载前 DevTools Elements 中没有 saved project cards；加载后 Add/Import、编辑、打开、Favorites/跨组拖拽正常。
4. OPEN Collapse 只影响 OTHER WINDOWS；PROJECTS Collapse 影响 Favorites/普通组；刷新后状态保留。
5. 另一个窗口 session 完成后 navigation card 显示数量 badge；点击 navigation 不清除，点击具体 session 后各窗口收敛消失。
6. PROJECTS、Tab、全局搜索均无 attention/current highlight。
7. 搜索 session/current/navigation/saved 分别进入正确 section；saved URI 去重且显示 Favorites/group badges。
8. 搜索期间不请求 PROJECTS；Escape 后恢复原 Tab、滚动、group 和 session 展开状态。
9. AI/open 增量更新不跳 Tab、不丢 query、不重置滚动，也不重建 Webview。
10. Local、SSH、WSL、Dev Container 和 Remote navigation badge/打开行为正确。

- [ ] **Step 7: 收集性能与兼容性证据**

记录以下确定性结果和 DevTools Performance 三次采样的中位数：

- 初始 HTML 字节数及其中 saved card DOM 数（必须为 0）。
- sidebar 从 reload 到 OPEN 可交互的耗时。
- 首次点击 PROJECTS 到 panel mounted 的耗时。
- PROJECTS 未加载和已加载两种状态下，open-project fragment 更新均不得调用 `provider.refresh()`。
- 自定义 CSS 使用 `.project/.group` 核心 selector 仍生效。

性能采样只写入 review 记录，不提交机器相关阈值测试。

- [x] **Step 8: 最终 review checkpoint**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: 只包含本计划涉及的实现、测试、生成 assets 和文档；PRD/SVG staged 状态及无关改动未被改变。把完整 diff、自动验证结果、手工场景和性能记录交给用户 review，不 stage、不 commit、不 push。
