# ACTIVE Session 执行状态指示灯设计

## 1. 背景

当前 ACTIVE Session 卡片使用单一 `status` 在 `Starting`、`Running`、`Focused` 和 `Needs attention` 之间互相覆盖。这个模型混合了三种不同问题：AI 本轮是否仍在执行、Session 是否需要用户处理、Terminal 是否获得焦点。

用户需要在多个 ACTIVE Session 之间快速判断“哪些 AI 还在干活、哪些已经停下”，同时保持 attention 作为独立功能。运行指示灯因此表达 turn-level execution activity，而不是 Terminal 或 CLI 进程是否存活。

## 2. 产品目标

- 用户扫视 ACTIVE 列表即可区分正在执行和已经停止的 Session。
- 执行活动、attention 和 focus 成为三条正交状态轴，任何一条都不覆盖另外两条。
- 保留 ACTIVE 的现有含义：卡片代表当前窗口中仍由存活 Terminal 承载的 Session。
- 状态更新稳定、可访问，并兼容 VS Code 明暗主题。

## 3. 非目标

- 不在 SESSIONS Tab 的历史行上增加执行灯。
- 不新增 Running 数量角标、状态筛选器或排序开关。
- 不按 Running/Stopped 重新排序 ACTIVE 卡片。
- 不改变 attention 的通知、确认、聚合或跨窗口规则。
- 不改变 Terminal 关闭、完成释放或 ACTIVE 移除规则。
- 不通过静默时长猜测 AI 是否停止。
- 不增加闪烁、呼吸或循环动画。

## 4. 状态语义

### 4.1 三条状态轴

| 状态轴 | 取值 | 产品含义 |
| --- | --- | --- |
| 执行活动 | `starting / running / stopped` | 本轮 AI 是否正在生成或执行工具 |
| Attention | `true / false` | 是否存在未处理的用户关注事件 |
| Focus | `true / false` | 对应 Terminal 是否获得 VS Code 焦点 |

执行活动不能从 `needsAttention` 布尔值反推。Provider 的同一个生命周期事件可以同时产生一条执行状态变化和一条 attention 事件，但两个消费者必须独立维护状态。

### 4.2 执行状态

| 状态 | 进入条件 | 退出条件 | 指示灯 |
| --- | --- | --- | --- |
| `Starting` | NEW 已创建 pending Terminal，尚未获得明确执行信号 | Session 绑定或收到运行信号 | 灰色实心圆 |
| `Running` | 收到开始生成、继续执行或工具执行信号 | 收到完成、取消、失败或请求用户输入信号 | 绿色实心圆 |
| `Stopped` | 本轮完成、取消、失败、等待用户输入，或绑定后没有可靠运行证据 | 收到下一轮运行信号 | 灰色实心圆 |

长时间没有新输出不是停止证据。只接受明确的生命周期信号，避免长工具调用被错误变灰。

### 4.3 正交组合

| 执行状态 | Attention | 卡片结果 |
| --- | --- | --- |
| Running | 否 | 绿灯 `Running` |
| Running | 是 | 绿灯 `Running`，同时保留 attention 红点 |
| Stopped | 否 | 灰灯 `Stopped` |
| Stopped | 是 | 灰灯 `Stopped`，同时保留 attention 红点 |
| Starting | 否 | 灰灯 `Starting` |

确认 attention 只清除 attention 表达，不改变执行灯。Focus 变化只改变聚焦边框，不改变执行灯。

## 5. 产品形态

### 5.1 卡片布局

指示灯位于 ACTIVE 卡片第二行元信息内，紧跟 provider：

```text
[Terminal]  修复 Session 状态
            Codex · ● Running · 2 min · #019f7592
```

停止时：

```text
            Codex · ● Stopped · 2 min · #019f7592
```

选择行内状态而不是图标角标或左侧色条，原因是：

- 颜色和文字同时出现，含义明确；
- 不占用 attention 的左上红点；
- 不与 provider 色条、Focused 蓝色边框竞争；
- 窄侧栏中仍可按现有 ellipsis 规则自然降级。

### 5.2 视觉规则

- Running 使用 VS Code Terminal green 主题色，并提供稳定 fallback。
- Stopped 和 Starting 使用弱化的 description foreground。
- 圆点为静态实心圆，不闪烁、不脉冲。
- attention 保持左上红点及现有红色强调。
- focused 保持蓝色边框。
- 执行状态不改变卡片背景、provider 色条或操作按钮。

### 5.3 文案与无障碍

颜色不是唯一信息。圆点后始终保留状态文字，并分别提供：

- `Running`：`AI is currently executing`
- `Stopped`：`AI is not currently executing`
- `Starting`：`Waiting for AI activity`

Attention 继续单独读作 `AI session needs attention`。运行状态与 attention 在屏幕阅读器中不得合并成一个互斥状态。

## 6. 信息架构

### 6.1 领域模型

ACTIVE View Model 增加独立的执行字段：

```ts
type AiSessionExecutionState = 'starting' | 'running' | 'stopped';

interface ActiveAiSessionViewModel {
    executionState: AiSessionExecutionState;
    focused: boolean;
    needsAttention: boolean;
}
```

当前过载的 `ActiveAiSessionStatus = 'starting' | 'running' | 'focused' | 'needsAttention'` 不再承担三条状态轴。排序直接读取 `needsAttention`、`focused` 和活动时间，渲染直接读取 `executionState`。

### 6.2 归一化生命周期信号

Provider 日志先归一化为包含两条独立输出的领域信号：

```ts
interface AiSessionLifecycleSignal {
    phase: 'running' | 'needsAttention';
    reason?: 'completed' | 'input-required' | 'failed' | 'aborted';
    executionState: 'running' | 'stopped';
    occurredAtMs: number;
    token: string;
}
```

- Execution Activity Projector 只读取 `executionState`。
- Attention Monitor 继续只读取现有 `phase`、`reason` 及自身的确认状态。
- 下一轮开始事件可以同时输出 `executionState: running` 和 `phase: running`；后者保留现有“清除旧 attention”的语义。
- 一个完成事件可以同时输出 `executionState: stopped`、`phase: needsAttention` 和 `reason: completed`，但确认 attention 不会反向修改 execution state。

`executionState` 是 additive domain field，不替换现有 attention 字段。ACTIVE projection 不得依赖 `phase` 或 Session 上的 `needsAttention` 布尔值推导执行状态。

### 6.3 执行状态所有权

新增独立的 Execution Monitor/Controller：

- Execution Monitor 按 Session key 保存最后一个 `executionState`、signal token 和 `occurredAtMs`，负责幂等与乱序保护。
- Execution Controller 枚举当前窗口拥有 Terminal 的已绑定 Session，通过现有 provider service 的 `getLifecycleSignals` 读取信号并更新 monitor。
- Provider lifecycle parser 按 `occurredAtMs` 选择最新信号，而不是假设文件物理行序永远等于事件时间顺序。
- Execution Controller 不读取 attention 配置，也不由 attention enabled 开关控制。
- Attention Controller 保持自己的 monitor、确认和发布流程；新增的 lifecycle 字段不会改变其行为。
- Provider service 继续复用现有 lifecycle 文件读取与缓存，避免引入第二套 provider parser。
- ACTIVE runtime projection 从 Execution Controller 获取只读 snapshot，并以 Session key 查找 `executionState`。

关闭 attention 功能后，执行状态采集和绿/灰指示灯必须继续工作。

### 6.4 数据流

```text
Provider lifecycle log
        │
        ▼
Normalized lifecycle signal
        ├───────────────┐
        ▼               ▼
Execution controller Attention controller
        │               │
        ▼               ▼
executionState       needsAttention
        └───────┬───────┘
                ▼
       ACTIVE session view model
                │
                ▼
        Card indicator + red dot
```

Terminal focus 独立提供 `focused`。Terminal close 继续从 ACTIVE 移除卡片。

## 7. 状态更新与恢复

- 每个 Session 只接受 `occurredAtMs` 晚于当前执行状态的信号，忽略乱序旧事件。
- 下一轮运行信号把 Stopped 切回 Running。
- 完成、取消、失败或请求输入把 Running 切到 Stopped。
- Pending card 为 Starting；绑定后若暂时没有可靠运行信号，保守显示 Stopped。
- 扩展重载后从 provider 日志的最新 lifecycle signal 重建状态，不为 execution state 新增用户配置。
- Provider 日志不可读或没有可判定信号时不显示绿色；绑定 Session 使用 Stopped，pending 使用 Starting。
- Attention 功能关闭时仍持续计算 execution state，但不产生或展示 attention。
- 更新沿用现有增量 Session payload，只刷新受影响的 project/session，保持 Tab、焦点和滚动位置。

## 8. 排序与计数

执行灯是识别信息，不是优先级：

1. Needs attention 仍优先；
2. Focused 其次；
3. 其余按最近活动时间；
4. Starting 保持现有 pending 规则。

Running/Stopped 切换不得触发卡片重排。ACTIVE 数量、项目角标和 attention 数量保持不变。

## 9. 错误与边界处理

- 乱序事件：按 `occurredAtMs` 忽略旧状态。
- 重复事件：按 token 保持幂等。
- 长时间无输出：维持最后明确状态，不使用 inactivity timeout。
- Provider 数据不可用：保守灰灯，不伪造 Running。
- Terminal 关闭：按现有规则移除卡片，不留下 Stopped 历史项。
- Attention 与 execution 短时同时存在：允许渲染绿灯加红点，不能通过 UI 条件互斥掉任一信号。
- Reduced Motion：本设计没有循环动画，不产生额外处理。

## 10. 测试策略

### 10.1 生命周期归一化

- Codex、Kimi、Claude 的运行事件输出 `running`。
- 完成、取消、失败和请求输入事件输出 `stopped`。
- attention reason 与 execution state 可以在同一信号中独立存在。
- running phase 清除旧 attention 的既有语义保持不变。
- 乱序旧事件不能覆盖更新状态。

### 10.2 Projection

- pending 映射为 Starting。
- 明确运行信号映射为 Running。
- 明确停止信号或无运行证据映射为 Stopped。
- attention 确认不改变 execution state。
- attention enabled 设置不改变 execution state 计算。
- focused 变化不改变 execution state。
- Running/Stopped 不影响排序优先级。

### 10.3 渲染

- 三种 execution state 输出正确 class、data attribute、颜色入口、可见文字和 aria 文案。
- Running 与 attention 同时渲染绿灯和红点。
- Stopped 与 attention 同时渲染灰灯和红点。
- Focused 边框可与任一 execution state 共存。
- 窄宽度、明暗主题和 reduced-motion 环境保持可读。

### 10.4 增量更新

- 单个 Session 的 execution state 更新不会重置 Tab、滚动或焦点。
- 相同 payload 不重复替换 DOM。
- Terminal close 仍移除 ACTIVE 卡片。

## 11. 验收标准

1. ACTIVE 卡片第二行显示静态圆点和 `Starting / Running / Stopped` 文案。
2. AI 开始生成或执行工具后圆点变绿；本轮结束、取消、失败或等待输入后变灰。
3. 用户确认 attention 后，只移除红点，执行灯保持原状态。
4. Focus 切换只改变蓝色聚焦样式，执行灯保持原状态。
5. Running 与 Stopped 切换不导致 ACTIVE 列表跳动。
6. 没有可靠运行证据时绝不显示绿色。
7. Terminal 关闭后卡片按现有规则从 ACTIVE 移除。
8. SESSIONS Tab、项目计数、attention 聚合和通知行为不变。
9. 关闭 attention 功能后，ACTIVE 卡片的执行灯仍能在 Running 和 Stopped 之间更新。
