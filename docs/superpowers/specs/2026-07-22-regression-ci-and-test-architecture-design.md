# 回归防护 CI 与测试架构设计

## 背景

Project Steward 已经形成较稳定的项目管理、跨窗口聚合、AI session、Direct Terminal、tmux、attention、TODO 和双扩展发布行为。当前开发中反复出现的问题不是缺少单个测试命令，而是已有行为没有形成统一、可追踪的契约：修改一个领域时，另一个已经稳定的行为可能悄然回退。

仓库已有大量 Node safety checks，且上一轮架构优化已经把 `src/dashboard.ts` 从 2946 行降低到约 1802 行，并将其中的 `provider.refresh()` 调用点从 5 个降低到 2 个。不过，现有检查集中在几个超大脚本中，部分断言依赖源码字符串、函数名和文件结构。GitHub Actions 当前只有发布工作流，没有覆盖 pull request 的常规门禁；发布流程也没有执行核心的 dashboard 和 safety checks。TSLint 虽退出成功，但仍输出历史 warning，因而不能阻止新增静态质量问题。

本设计把“冻结已确认行为”作为首要目标。重构仅用于建立稳定、可隔离的测试边界，不在本阶段进行无关的工具链现代化或大规模业务重写。

## 目标

1. 建立权威、可追踪的行为契约清单，覆盖已经稳定的用户行为和兼容性规则。
2. 为项目主要领域补充全面的单元、契约、集成、环境 smoke 和场景验证。
3. 建立 Linux、Windows 和真实 tmux 分层 PR 门禁，阻止行为回退进入受保护分支。
4. 让发布流程复用核心验证，防止 PR 与 release 的验证集合漂移。
5. 逐步用行为测试替代脆弱的源码字符串检查，同时保留少量必要的架构禁令。
6. 建立 lint warning 与代码覆盖率的单向 ratchet，禁止质量基线下降。
7. 通过有界、行为保持的重构提高生产代码可测试性。

## 非目标

1. 不把当前实现的所有细节自动视为正确规范。
2. 不一次性升级 TypeScript、TSLint、Webpack、VS Code engine 或全部依赖。
3. 不引入 React、Vue、Svelte 等 Webview 框架。
4. 不改变命令 ID、配置键、持久化格式、协议版本、扩展 ID 或用户可见行为。
5. 不要求所有 SSH、WSL、Dev Container 和多窗口场景都成为每个 PR 的自动化检查。
6. 不以追求单一代码覆盖率百分比替代有语义的行为断言。

## 核心原则

- 行为规范优先于当前实现。README、PRD、历史设计、配置与命令、现有测试和用户确认共同构成行为证据；发现冲突时必须先明确预期，不能直接固化代码现状。
- 每项行为在能够稳定验证它的最低层测试。只有确实跨越边界的行为才上升为集成、真实环境或手动场景。
- 全面覆盖不等于把所有组合都放进端到端测试。
- 重构前先建立行为保护；重构后测试不应依赖文件位置、函数名或排版。
- CI 必须确定、隔离、可诊断，并且不读取开发者真实 session 或用户数据。

## 行为契约清单

建立权威行为清单，并按领域拆分。每条行为使用稳定 ID，例如 `SESSION-RESUME-003`，至少记录：

- 行为名称和领域；
- 前置条件；
- 用户或系统操作；
- 可观察的预期结果；
- 适用 provider、runtime 和平台；
- 优先级；
- 自动化状态：`automated`、`scheduled` 或 `manual`；
- 对应测试或手动验证文档；
- manual 状态无法自动化的理由。

行为清单至少覆盖以下领域：

1. 项目管理：新增、编辑、删除、分组、收藏、排序、重复项、路径识别和打开方式。
2. OPEN 与跨窗口：当前 workspace、其他窗口、聚合、焦点切换、重复窗口、过期 publication 和失效清理。
3. AI Session：Codex、Kimi、Claude 的发现、创建、恢复、状态、归档、别名和 pin。
4. Runtime：Direct Terminal、tmux project layout、tmux session layout、复用、attach、detach、完成、冲突、stale 和 unavailable。
5. Attention：Running、Waiting、Completed、Stopped、跨窗口合并、确认、保留、乱序和重复消息。
6. Webview：OPEN、PROJECTS、TODO、搜索、折叠、拖拽、编辑状态、增量刷新、旧 sequence 和 fallback。
7. 持久化与兼容：正常数据、旧版本数据、缺字段、损坏数据、并发更新和恢复策略。
8. 错误处理：文件不可读、provider 命令不存在、tmux 输出异常、bridge 超时、非法 Webview 消息和中途资源消失。
9. 发布：主扩展、UI Bridge、版本一致性、VSIX 内容和 release notes。

测试名称或测试元数据必须引用行为 ID。CI 应能检查每个行为 ID 都有有效归属，避免清单中出现无人负责的行为。

## 测试分层

### 1. 单元测试

验证纯函数、parser、排序、规范化、状态投影、view model 和确定性状态转换。测试不接触真实 filesystem、terminal、tmux 或 VS Code API。

### 2. 契约测试

验证 controller、provider、store、协议和错误映射。通过共享 contract suite 对 Codex、Kimi、Claude，以及 Direct、tmux project、tmux session 后端执行相同的共同约束，同时保留 provider-specific 和 backend-specific 断言。

### 3. 集成测试

验证 Dashboard 装配、消息路由、增量更新、Webview 状态流、bridge 协作和跨 controller 交互。边界外资源使用可控 fake；测试关注输入、输出和副作用，不关注内部函数或文件结构。

### 4. 环境 smoke

Linux PR 环境运行隔离的真实 tmux smoke，并执行 production bundle 与 VSIX 内容检查。smoke 只创建带有唯一测试身份的 tmux server、socket 和临时目录，结束时无条件验证并清理其拥有的资源。

### 5. 场景验证

macOS 确定性测试和可稳定自动化的 VS Code Extension Host 场景进入定时工作流。真实多窗口、SSH、WSL、Dev Container 中无法可靠托管的场景保留为明确的手动矩阵。

## 测试目录与运行器

新增统一目录：

```text
tests/
  unit/
  contract/
  integration/
  platform/
  fixtures/
  helpers/
```

使用 Node 22 内置测试运行器和 `assert`，避免为本阶段引入额外测试框架。Node 22 是测试与 CI 工具运行时，不改变扩展的 VS Code runtime 兼容目标。测试通过编译后的模块或明确导出的接口执行。纯测试可以并行；使用共享状态或副作用的集成测试必须串行。

共享 helper 至少提供：

- VS Code API fake；
- terminal 与 process fake；
- filesystem 和临时目录 helper；
- fake clock、timer 和 watcher；
- bridge client/server fake；
- tmux client fake；
- 最小化、去标识化的 provider/session fixtures。

每个测试必须隔离状态，显式等待异步工作，并清理 timer、watcher、terminal、临时文件和 tmux 资源。禁止读取真实 Codex、Kimi、Claude session 目录，禁止依赖测试执行顺序。

## 现有 Safety Checks 迁移

现有大型检查脚本采用渐进迁移，不一次性重写：

1. 为现有断言关联行为 ID，形成迁移前覆盖基线。
2. 抽取共享 fake、fixture 和测试 helper。
3. 按领域把断言迁入独立测试文件。
4. 迁移期间同时运行新旧用例，并验证新测试能够捕获同一回退。
5. 删除已经被等价行为测试覆盖的源码字符串检查。
6. 最终将旧脚本缩减为兼容入口或少量架构护栏。

源码检查仅保留难以从外部行为稳定证明的架构禁令，例如高频更新路径不得调用 full refresh、受限模块不得引入同步无界扫描。此类检查必须解释它保护的风险，不能用于冻结普通函数名或文件布局。

## 全面行为矩阵

行为用例通过参数化 contract suite 覆盖主要组合：

- path kind：local、workspace、SSH、WSL、Dev Container；
- provider：Codex、Kimi、Claude；
- runtime：Direct、tmux project layout、tmux session layout；
- lifecycle：创建、恢复、复用、运行、等待、完成、停止、归档；
- runtime condition：attached、detached、stale、conflict、unavailable；
- message condition：正常、重复、乱序、过期、非法、delivery failure；
- persisted input：正常、旧版本、缺字段、损坏、冲突。

参数化用于保证共同能力不会只在单个 provider 或平台上被修复；各 provider 的原生 session 格式和生命周期差异仍由专门 fixture 与断言覆盖。

## 回归策略

1. 每个已知历史回退都必须有行为 ID 和自动化用例。
2. 新发现 bug 必须先添加能够稳定复现的失败用例，再实施修复。
3. PR 有意修改既有行为时，必须在同一 PR 更新行为清单和测试。
4. 关键回归测试需执行受控反向验证：临时撤销修复或改变关键分支时，用例必须失败，以证明测试确实保护目标行为。
5. 大段 HTML 或 JSON snapshot 只能作为辅助；关键字段和状态转换必须使用语义断言。
6. 代码覆盖率先记录基线，随后禁止下降。覆盖率用于暴露盲区，不作为行为完整性的唯一标准。

## CI 架构

建立可复用的核心验证工作流，使 PR、push 和 release 使用同一套验证能力。

### PR Required Checks

#### `quality-linux`

- `npm ci`；
- 主扩展和 UI Bridge TypeScript 编译；
- lint warning 基线检查；
- 单元、契约和集成测试；
- Dashboard/Webview 行为测试；
- production bundle；
- release notes 与 VSIX 内容检查。

#### `platform-windows`

- 编译；
- 路径标准化、Windows drive、workspace URI 测试；
- shell 与命令参数转义测试；
- 不运行 tmux 或依赖 Unix 工具的测试。

#### `tmux-smoke-linux`

- 安装并验证 tmux；
- 运行隔离的真实 tmux smoke；
- 成功或失败后都验证资源清理。

### Workflow 规则

- PR 有新提交时取消旧的同分支运行。
- 默认权限为 `contents: read`。
- required check 名称保持稳定。
- 门禁不得使用 `continue-on-error` 掩盖失败。
- 失败输出包含行为 ID、fixture 名称和最小诊断上下文。
- 仅上传必要的测试报告与构建产物，不上传 session 内容或真实用户路径。
- Linux 主门禁目标在五分钟内完成。

### 定时与手动验证

定时工作流运行 macOS 确定性测试，以及能够稳定托管的 VS Code Extension Host/多窗口场景。SSH、WSL、Dev Container 等外部环境场景使用版本化手动矩阵，记录执行日期、环境和结果。

### 发布闭环

release workflow 在打包和创建 GitHub Release 之前调用同一套核心验证。发布专属的版本、release notes、VSIX 和 artifact 检查仍保留，但不能替代行为门禁。

## Lint 与覆盖率 Ratchet

### Lint

按文件和 rule 记录当前 TSLint warning 数量，形成机器可读基线。该形式不会因代码行移动产生无意义变化。CI 将当前 warning 与基线比较：

- 新增 warning 或 warning 数量上升时失败；
- 删除 warning 时允许通过并更新基线；
- 生产文件发生实质重构时，该文件不得增加任何 rule 的 warning 数量；不改变行为即可安全修正的现存 warning 在同一提交清理，可能扩大行为范围的清理拆为独立任务；
- ESLint 迁移作为后续独立工作，不与本轮行为冻结捆绑。

### 覆盖率

首次可重复运行后，以 `quality-linux` 的固定 Node 22 环境记录 unit、contract 和 integration 覆盖率基线。后续 PR 不得降低基线；确因生成代码或边界移动需要重新校准时，PR 必须说明原因并证明行为 ID 覆盖没有减少。新增领域不能仅通过未触达的占位测试维持全局数字；行为清单仍是验收覆盖完整性的主依据。

## 针对性生产代码重构

只进行直接服务于测试隔离的重构：

- 将时间、filesystem、process、VS Code API 和 tmux 命令执行变为可注入依赖；
- 将状态计算与副作用分开；
- 将 `dashboard.ts` 的复杂装配按领域拆为 bootstrap 或 factory；
- 为 controller、store 和 runtime backend 定义明确输入输出；
- 移除测试对闭包、全局状态和开发者环境的隐式依赖。

每次重构前必须已有对应行为测试。不得借此改变命令、配置、协议、存储或 UI 行为。

## 实施阶段

### 阶段 1：行为盘点

从 README、PRD、配置、命令、协议、现有测试和历史回退提取行为清单，分配 ID、优先级及验证状态。

### 阶段 2：测试基础设施与基础 CI

建立测试目录、runner、fake、fixture、lint warning 基线和覆盖率基线。先接入 Linux、Windows PR workflow，保持初始门禁可稳定通过。

### 阶段 3：全面迁移与补充

按 Project/Webview、Open Project、AI Provider、Runtime/Attention、Persistence/Error Handling 的顺序迁移现有断言并补充行为缺口。新旧用例在迁移期间并行。

### 阶段 4：针对性重构

在行为测试保护下拆分阻碍测试的装配和副作用边界，逐步删除已被替代的源码字符串检查。

### 阶段 5：环境与发布闭环

加入真实 tmux smoke、macOS 定时验证、Extension Host/远程场景矩阵，并让 release workflow 复用核心门禁。

## 验收标准

1. PR 必须通过稳定命名的 Linux、Windows 和 tmux required checks。
2. 行为清单每项都有 `automated`、`scheduled` 或 `manual` 归属；manual 项有明确理由和执行文档。
3. 核心用户行为在 PR 或定时 CI 中自动验证，manual 仅保留无法可靠托管的远程、跨主机或视觉场景。
4. 已知历史回退均有对应行为 ID 和自动化用例。
5. 新增 lint warning、覆盖率下降、构建失败或行为测试失败会阻止合并。
6. CI 不读取真实用户 session，不泄露本地路径，并完整清理临时资源。
7. release 在生成或发布 VSIX 前执行同一套核心行为门禁。
8. Linux 主门禁目标不超过五分钟，失败能够定位到具体行为 ID。
9. 生产代码重构不改变命令 ID、配置、存储格式、协议、扩展 identity 或用户可见行为。

## 风险与控制

### 风险：把缺陷当成既有行为固化

行为清单必须综合文档、历史和用户确认。证据冲突时先明确预期，再写测试。

### 风险：全面覆盖导致 PR CI 过慢

把行为放在最低稳定层测试，真实环境场景分流到独立 required check、定时或手动工作流；Linux 主门禁以五分钟为目标。

### 风险：迁移测试时丢失已有覆盖

新旧用例并行，行为 ID 建立映射，等价验证后才删除旧断言。

### 风险：fake 与真实 VS Code/tmux 行为偏离

使用少量真实 tmux smoke、Extension Host 场景和版本化手动矩阵校验 fake 的边界假设。

### 风险：源码架构检查阻碍正常重构

只保留有明确架构风险说明的禁令；普通行为一律通过公开输入输出验证。

### 风险：历史 lint warning 让门禁无法启用

采用精确基线 ratchet，禁止新增而不要求本轮一次性偿还全部历史债务。
