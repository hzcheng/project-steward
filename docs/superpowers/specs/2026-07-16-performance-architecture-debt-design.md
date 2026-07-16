# 架构与性能债优化设计

## 背景

Project Steward 2.0.0 已经从项目收藏面板演进为本机多窗口项目与 AI session 控制台。当前能力包括：

- `OPEN` / `PROJECTS` 双 tab。
- 当前窗口和其他窗口的 live project cards。
- Codex、Kimi、Claude session 发现、恢复、终端绑定和归档。
- AI session attention、跨窗口红点、输入等待和完成态提示。
- UI Bridge 双插件发布流程。

这说明产品方向成立，但也让实现复杂度进入新的阶段。继续堆功能前，需要优先处理架构和性能债，避免后续每个功能都必须穿透 `dashboard.ts`、webview HTML 字符串、provider 分支和多套刷新路径。

## 目标

1. 降低高频 AI session / open project 更新对 webview 的重渲染成本。
2. 拆清 `dashboard.ts` 的职责边界，让功能演进可以分区修改和测试。
3. 统一 Codex、Kimi、Claude provider 模型，减少 provider-specific 分支。
4. 约束 session 文件扫描、watcher、polling、cache invalidation 和同步 I/O。
5. 为性能路径增加 safety checks，防止后续回退到全量刷新或无界扫描。
6. 保持用户可见行为、配置、存储格式、命令 ID 和 release identity 不变。

## 非目标

1. 不引入 React、Vue、Svelte 等前端框架。
2. 不重写 UI Bridge 协议。
3. 不改 Marketplace 扩展 ID 或命令 ID。
4. 不一次性重写 `dashboard.ts`。
5. 不改变 saved project 数据格式。
6. 不在本阶段新增新的 AI provider。

## 总体策略

采用“行为冻结、边界前移、分阶段替换”的方式推进。

每个阶段都必须满足：

- 对用户可见行为保持等价。
- 有针对性的 safety checks。
- 可以独立 review。
- 出问题时能回退到已有 full refresh 或已有 provider 路径。

这次不做一次性大爆炸重构。大文件拆分必须围绕真实边界完成，不能为了拆文件而拆文件。

## 基线与度量

实施前必须记录以下基线，后续每个阶段都对照这些基线说明收益：

1. `src/dashboard.ts` 行数。
2. `provider.refresh()` 调用点数量和调用原因。
3. 高频路径中允许调用 full refresh 的 fallback reason 列表。
4. AI session refresh、open project aggregate、attention update 的消息类型和版本。
5. provider scan 的触发原因、扫描文件数和耗时统计。

每个阶段的验收不能只写“更快”或“更清晰”，必须落到可检查的 source contract、测试断言、行数变化、调用点变化或 diagnostics 输出。

当前基线通过 `npm run test:architecture-baseline` 记录。该脚本输出 `dashboard.ts` 行数、`provider.refresh()` 调用点数量、`webview.html` assignment 数量和已注册 provider 列表，后续阶段完成后用同一命令对比变化。

## 阶段一：高频渲染路径收敛

### 当前状态

项目已经有部分增量消息：

- `ai-sessions-updated`
- `open-projects-updated`
- attention state / attention projects messages
- active AI terminal message

但这些消息的构建、发送、fallback、搜索索引更新仍主要散在 `src/dashboard.ts` 和 webview 脚本里。`provider.refresh()` 仍然是大量路径的通用兜底，容易在新增功能时被误用。

### 设计

先不新增 UI 行为，只把高频消息路径标准化：

1. 定义 webview update channel 的约束：
   - 消息必须有 `type`、`version`。
   - 高频消息必须有 sequence 或 semantic revision。
   - webview 必须拒绝旧消息。
   - unsupported message 触发 full refresh fallback。

2. 把 host 侧消息构建移出 `dashboard.ts`：
   - `getAiSessionsUpdatedMessage()` 移到独立模块。
   - `postOpenProjectsUpdated()` 的 message 构建移到独立模块。
   - `provider.postMessage(...).then(fallback)` 统一封装。

3. webview 侧保留现有 DOM 脚本，但给核心 update 函数增加更明确的测试入口：
   - apply AI session update。
   - apply open projects update。
   - replace search catalog。
   - fallback request。

### 验收标准

- 高频 AI session 更新路径不调用 full `webview.html` rebuild；只允许 unsupported message、missing DOM target、webview hidden/delivery failed 这类显式 fallback reason 触发 full refresh。
- open project aggregate 更新路径不调用 full `webview.html` rebuild；只允许 unsupported message、webview hidden/delivery failed 这类显式 fallback reason 触发 full refresh。
- 搜索 catalog 与增量更新保持一致。
- tab、搜索框、展开状态、batch archive 状态不被高频更新重置。
- safety check 能识别新增代码中高频路径误用 `provider.refresh()`。

## 阶段二：`dashboard.ts` 职责拆分

### 当前状态

`src/dashboard.ts` 同时负责：

- extension activation。
- view provider。
- webview message dispatch。
- project CRUD。
- open project projection。
- AI session provider service wiring。
- AI session terminal lifecycle。
- attention publish / acknowledge。
- batch archive。
- window color。
- diagnostics。

这个文件是当前迭代成本最高的点。

### 设计

按行为边界拆分，而不是按技术层机械拆分。

建议拆成以下模块：

1. `src/dashboard/viewProvider.ts`
   - 管理 `WebviewViewProvider`。
   - 提供 `refresh()` / `postMessage()` / `visible`。
   - 不知道 project、AI session、bridge 的业务细节。

2. `src/dashboard/messageRouter.ts`
   - 接收 webview message。
   - 按 `type` 分派给 handler。
   - 验证 message shape。
   - 不直接操作 filesystem 或 terminal。

3. `src/openProjects/dashboardController.ts`
   - 管理 open project aggregate 到 cards 的投影。
   - 管理 `open-projects-updated` message。
   - 管理 open project diagnostics。

4. `src/aiSessions/dashboardController.ts`
   - 管理 AI session refresh、watchers、assignment、view model。
   - 管理 `ai-sessions-updated` message。
   - 依赖 provider registry 和 terminal service。

5. `src/aiSessions/attentionController.ts`
   - 管理 attention monitor、bridge client、acknowledge、attention projects。
   - 不直接渲染 HTML。

6. `src/projects/projectCommands.ts`
   - 管理 add/save/remove/edit/reorder/favorite/open commands。
   - 保留现有 ProjectService 数据模型。

### 拆分原则

- 第一轮只移动代码，不改行为。
- 每次移动后都运行现有 safety checks。
- 被移动函数的输入输出要显式化，避免继续依赖 `dashboard.ts` 闭包里的大量变量。
- 如果某段逻辑必须依赖十几个闭包变量，先封装上下文对象，再移动。

### 验收标准

- `dashboard.ts` 仍是 activation 入口，但不再直接包含大段 provider/open project/message 构建逻辑。
- `dashboard.ts` 行数、`provider.refresh()` 调用点数量、webview message dispatch 分支数量在实施计划中记录基线和目标，阶段完成时必须给出实际变化。
- 现有 safety checks 通过。
- webview message dispatch 可以单独测试。
- open project 和 AI session controller 可以独立构造测试输入。

## 阶段三：AI Provider Registry 收敛

### 当前状态

已有 `AI_SESSION_PROVIDER_IDS`、provider definition 和部分类型，但 dashboard 里仍有 provider service record、provider-specific project session keys、terminal candidate lookup、archive/resume/new session 等分散逻辑。

### 设计

把 provider 抽象从“显示定义”提升为“运行时能力注册表”。

Provider runtime 应包含：

- `id`
- `label`
- `service`
- project session key 读写规则
- terminal command builders
- terminal marker directory
- archive capability
- lifecycle signal capability
- unavailable state mapping

Dashboard 和 controllers 只面向 registry：

```ts
for (const provider of aiSessionRegistry.providers()) {
    const result = provider.service.getSessions(options);
    // projection / terminal / archive / lifecycle use provider capabilities
}
```

### 约束

- 初期仍只支持 `codex`、`kimi`、`claude`。
- 不改变 session display model。
- 不改变 existing provider services 的文件解析逻辑。
- 不为了抽象牺牲 provider-specific lifecycle correctness。

### 验收标准

- 新增 provider 的入口收敛到 registry。
- dashboard/controller 中 provider-specific switch 或 parallel maps 的剩余调用点必须在实施计划中列出，阶段完成时必须解释保留原因。
- terminal resume/new/archive 不再需要多套 parallel maps。
- provider registry 有 safety checks 覆盖 provider id、label、service、command builder、project keys。

## 阶段四：I/O 与扫描治理

### 当前状态

AI session provider 需要读取 Codex/Kimi/Claude 的本地 session 文件。open project 和 attention 需要 watcher、fallback polling、cache invalidation。随着多窗口和 session 数量增加，无界扫描和同步读取会放大卡顿风险。

### 设计

建立扫描预算和缓存规则：

1. Provider `getSessions()` 支持 options：
   - `forceRefresh`
   - `candidatePaths`
   - `maxFiles`
   - `reason`

2. 高频路径禁止无界扫描：
   - watcher callback 不直接做重扫描。
   - callback 只 schedule debounce refresh。
   - refresh 合并同一时间窗口内的多次请求。

3. 文件读取分级：
   - 小文件可直接读取。
   - 大 JSONL 文件必须有 bounded tail / sampled read。
   - 无法解析的文件进入短期 negative cache。

4. Diagnostics：
   - 输出 refresh reason。
   - 输出 provider scan duration。
   - 输出 file count。
   - 输出 fallback full refresh reason。

### 验收标准

- safety checks 能验证 watcher callback 不直接执行 provider full scan。
- provider scan 有 bounded options。
- 大文件读取路径保持 bounded。
- diagnostics 可以解释一次 refresh 是由什么触发、耗时多少、扫描了多少文件。

## 阶段五：测试与性能护栏

### 设计

现有测试主要是 Node safety checks。继续沿用这个方向，避免引入沉重测试框架。

新增或加强：

1. Dashboard source contract checks：
   - 高频 update path 不调用 `provider.refresh()`。
   - full refresh fallback 必须带 reason。
   - message type/version 必须稳定。

2. Webview VM checks：
   - 旧 sequence 被忽略。
   - 缺 DOM target 触发 fallback。
   - search catalog 被替换。
   - tab/search state 不被重置。

3. Provider registry checks：
   - 所有 provider 都有 service。
   - 所有 provider 都有 terminal builders。
   - 所有 provider id 都被 view model 支持。

4. I/O budget checks：
   - 大文件读取 helper 有 size/line/window 上限。
   - watcher callback 只 schedule，不直接 scan。

## 实施顺序

推荐按以下顺序推进：

1. 先做高频渲染路径收敛。
2. 再拆 `dashboard.ts` 的 view provider 和 message router。
3. 再拆 open projects controller。
4. 再拆 AI sessions controller。
5. 再提升 provider registry。
6. 最后补 I/O budget 和 diagnostics。

这个顺序的原因是：渲染消息协议稳定后，后续 controller 拆分有清晰边界；provider registry 放在 controller 边界之后做，可以避免在最大闭包里硬抽象。

## 风险与控制

### 风险：增量更新遗漏某些 DOM 状态

控制：

- 保留 full refresh fallback。
- 增加 webview VM checks。
- 先覆盖 AI session 和 open project 两条最高频路径。

### 风险：拆 `dashboard.ts` 时引入行为漂移

控制：

- 每个拆分 task 或 commit 只移动一个边界。
- 先写 source contract test。
- 保留原函数签名或增加薄 wrapper。

### 风险：provider registry 过度抽象

控制：

- 只抽已有三家 provider 的共同能力。
- provider-specific lifecycle parsing 留在各自 service。
- 不为未来未知 provider 设计复杂插件系统。

### 风险：性能优化不可观测

控制：

- 增加 diagnostics。
- safety checks 覆盖“是否走了高频增量路径”。
- 必要时在 output channel 输出 refresh reason 和 scan duration。

## 验收标准

整轮优化完成后应满足：

1. 高频 AI session 和 open project 更新不触发 full webview HTML rebuild。
2. `dashboard.ts` 的核心职责减少，至少 view provider、message router、open project update、AI session update 有独立模块。
3. Provider runtime 能通过 registry 遍历和使用。
4. Watcher / polling / scan 有 debounce、bounded read 或明确 cache 策略。
5. Release、dashboard、AI session、open project safety checks 全部通过。
6. 用户可见功能与 2.0.0 保持一致。

## 后续实施计划要求

实施计划必须拆成多个 reviewable tasks。每个 task 都要包含：

- 需要修改的文件。
- 先写或先更新的 safety check。
- 最小实现范围。
- 验证命令。
- 是否允许 fallback 到 full refresh。

不允许一个 task 同时做大规模移动、行为变更和性能策略变更。
