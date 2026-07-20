# AI Session Tmux Mode PRD

> Superseded by `docs/superpowers/specs/2026-07-18-ai-session-tmux-runtime-design.md`. Do not use the decisions or open questions below for implementation; the newer design reflects the current AI session runtime architecture and the confirmed project/session tmux layout decision.

## 背景

Project Steward 现在可以在 `OPEN PROJECT` 卡片下展示 Codex、Kimi、Claude 等智能体 session。用户点击某个 session 时，插件会打开 VS Code 自带的集成终端，并运行对应 provider 的恢复命令，例如：

```text
codex resume --cd "<cwd>" "<session-id>"
kimi --work-dir "<cwd>" --resume "<session-id>"
claude --resume "<session-id>"
```

这个体验很方便，但它有一个明显限制：活跃的智能体进程和 VS Code terminal 进程绑定在一起，也和 terminal 所在的执行环境绑定在一起。如果用户关闭 VS Code、SSH 断开、远程窗口 reload、terminal 被关闭，活跃 session 就可能停止或失联。

这个功能要解决的用户诉求是：

> 我希望重要的智能体 session 即使在可见的 VS Code terminal 不见了以后，也能继续运行；之后我再回来时，Project Steward 可以重新连接到同一个正在运行的 session。

`tmux` 是一个适合第一版落地的方案，因为它可以把长期运行的 shell 进程从可见 terminal 客户端中解耦出来。Project Steward 可以把智能体命令启动在一个命名的 tmux session 里，之后再用 VS Code terminal attach 回这个 tmux session。

需要明确的关键限制：

> Tmux 只能在执行宿主保持唤醒并持续运行时保活进程。它不能让已经睡眠的笔记本继续计算。对本地 laptop 来说，合盖后操作系统仍然可能挂起，智能体也会暂停。Tmux 最适合 Remote SSH、常开机器，以及关闭 VS Code 后仍继续运行的 Dev Container。

## 目标

1. 为 AI session 增加一种基于 `tmux` 的 persistent terminal mode。
2. 让 Codex、Kimi、Claude session 可以运行在稳定命名的 tmux session 中。
3. 再次点击同一个 session 时，优先重新 attach 已存在的 tmux session，而不是启动重复的智能体进程。
4. 保留当前 VS Code terminal 行为，作为默认模式或明确 fallback。
5. 在产品文案中清晰说明 tmux 能保活什么、不能保活什么。
6. 实现方式保持 provider-neutral，方便后续新增更多智能体 provider。

## 非目标

- 不实现自定义 terminal emulator。
- 不替换 Codex、Kimi、Claude 自己的 session 存储。
- 不让睡眠中的笔记本继续运行。
- 第一版不管理操作系统电源设置。
- 不把 tmux 暴露为网络服务。
- 不在此功能中实现 Codex app-server、Codex Cloud 或 provider-specific remote runtime。
- 不要求所有用户都安装 tmux 才能使用 Project Steward。
- 不改变 session 发现、pin、rename、archive 的现有行为。

## 目标用户

### Remote SSH 开发者

用户在远程 SSH 服务器上工作。他从 Project Steward 启动一个 Codex 或 Kimi session，然后关闭 VS Code，稍后再回来。只要远程主机仍然在线，Project Steward 就可以重新 attach 到原来的 tmux session。

### Dev Container 开发者

用户在 Dev Container 中工作，且 container 所在宿主会保持运行。用户希望智能体 session 能够跨 VS Code terminal reload、远程窗口断开继续存在。

如果 container 本身停止，那么 container 内的 tmux session 也会停止。

### 本地 Laptop 开发者

用户在本地 laptop 上工作。Tmux 可以防止关闭 terminal tab 或 reload VS Code 导致 session 消失，但不能防止系统睡眠。UI 和文档不能暗示它可以在合盖睡眠期间继续计算。

## 产品形态

### 设置项

新增设置：

```json
"projectSteward.aiSessionTerminalMode": "vscode"
```

可选值：

```text
vscode
tmux
```

含义：

- `vscode`：当前行为。直接打开 VS Code 集成终端，并在其中运行 provider 命令。
- `tmux`：打开 VS Code 集成终端，但终端只负责 attach 到一个命名 tmux session。provider 命令运行在 tmux session 中。

第一版推荐默认值：

```text
vscode
```

理由：

- 现有用户体验不变。
- 用户需要在理解执行宿主限制并安装 tmux 后主动开启。
- 发布风险更低。

### 未来可选设置

第一版之后可以考虑增加：

```json
"projectSteward.aiSessionTmuxCommand": "tmux"
```

这个设置用于支持自定义 tmux 路径或 wrapper。在特殊环境中有用，但不是第一版必须能力。

### UI 入口

第一版不新增卡片按钮。

session 卡片行为保持不变：

```text
点击 session row -> resume 或 attach
点击 create session -> 创建新的 AI session
```

区别只在于 terminal 进程如何启动。

如果启用了 `tmux` mode，Project Steward 可以在 tooltip 或 terminal name 中弱提示当前使用 tmux，但不在 session card 中增加额外视觉噪音。

terminal 名称示例：

```text
Codex tmux: Fix save project [019f2c7f]
Kimi tmux: data loader [019f3a11]
Claude tmux: refactor view [019f9caa]
```

### 用户可见文案

设置项描述需要明确：

```text
Controls how Project Steward opens AI sessions. "vscode" runs the agent directly in a VS Code terminal. "tmux" runs the agent inside a named tmux session and attaches VS Code terminals to it. Tmux keeps the session alive only while the execution host remains awake and running.
```

中文语义：

```text
控制 Project Steward 如何打开 AI session。"vscode" 会直接在 VS Code terminal 中运行智能体。"tmux" 会把智能体运行在命名 tmux session 中，并让 VS Code terminal attach 到它。Tmux 只有在执行宿主保持唤醒并运行时才能保活 session。
```

当启用 tmux mode 但当前环境找不到 tmux 时：

```text
Project Steward could not find tmux in this environment. Install tmux, or switch AI Session Terminal Mode back to "vscode".
```

中文语义：

```text
Project Steward 在当前环境中找不到 tmux。请安装 tmux，或把 AI Session Terminal Mode 切回 "vscode"。
```

当当前环境是原生 Windows 且不是 WSL/remote 时：

```text
Tmux mode is not available in this Windows environment. Use the default VS Code terminal mode, WSL, SSH, or a Dev Container with tmux installed.
```

中文语义：

```text
当前 Windows 环境不支持 tmux mode。请使用默认 VS Code terminal mode，或在安装了 tmux 的 WSL、SSH、Dev Container 环境中使用。
```

## 核心行为

### 恢复已有 Session

当用户点击已有 AI session，且 terminal mode 为 `tmux` 时：

1. 根据 provider 和 session ID 生成稳定的 tmux session name。
2. 打开一个 VS Code terminal。
3. 在 terminal 中运行命令：如果 tmux session 已存在则 attach。
4. 如果 tmux session 不存在，则创建它，并在其中运行 provider resume 命令。

概念命令：

```bash
tmux new-session -A -s project-steward-codex-019f2c7f "codex resume --cd '/work/project' '019f2c7f-...'"
```

实际实现必须谨慎处理路径、session ID 和 shell command 的 quoting，不能把用户可控字符串直接拼接进 shell 命令。

期望结果：

- 如果 tmux session 已经存在，VS Code terminal 直接 attach。
- 如果 tmux session 不存在，tmux 创建 session 并启动 provider 命令。
- 重复点击同一个 session，不会启动重复的智能体进程。

### 创建新 Session

创建新 session 更复杂，因为 provider 最终生成的 session ID 在启动前并不知道。

第一版建议使用 pending tmux session name：

```text
project-steward-new-<provider>-<timestamp>-<random>
```

流程：

1. 用户点击 create session。
2. Project Steward 像现在一样询问本地显示 title。
3. Project Steward 用 provider 的 new-session command 启动一个 pending tmux session。
4. 现有 pending-session resolver 继续监听 provider 新生成的 session。
5. 当 Project Steward 发现 provider session ID 后，记录这个 session ID 和 tmux session 的关联。
6. 如果安全可行，可以把 pending tmux session rename 成稳定的 provider/session ID 名称。

第一版中 rename 可以是可选项。如果 rename 风险较高，可以保留 pending tmux 名称，只要 Project Steward 后续仍能把发现到的 provider session ID 和该 tmux session 关联起来即可。

### Attach 已存在的 Tmux Session

即使 Project Steward 没有内存中的 terminal entry，也应该能通过 tmux session name 重新 attach。

这对以下场景很重要：

- VS Code reload。
- extension host 重启。
- 用户关闭了所有 VS Code terminal。
- 稍后重新打开项目。

在 tmux mode 下，判断运行中进程复用的主要信号应该是：

```text
tmux has-session -t <tmux-session-name>
```

而不是只看：

```text
vscode.window.terminals
```

### Terminal Completion Marker

当前代码用 marker file 判断 terminal command 是否已经完成。在 tmux mode 下，这个判断需要重新定义。

对 tmux session 来说：

- 运行中的 tmux session 意味着交互式智能体仍然活着，或者至少 tmux shell 仍然活着。
- marker file 不适合作为主要复用信号。
- 主要复用信号应该是 `tmux has-session`。

对直接 VS Code terminal mode 来说：

- 保持当前 marker 行为不变。

### Tmux Session 命名

tmux session name 应该稳定、短，并且 shell-safe。

推荐格式：

```text
project-steward-<provider>-<short-hash>
```

其中：

```text
short-hash = sha256(provider + ":" + sessionId) 的前 12 个字符
```

不直接使用 raw session ID 的原因：

- tmux target 语法存在特殊字符和边界情况。
- 后续 provider 的 ID 格式不一定完全一致。
- hash 方案更稳定、紧凑、provider-neutral。

可见 terminal title 仍然可以展示 session name 和 short session ID。

## 环境规则

### 本地 macOS/Linux

如果 `PATH` 中能找到 `tmux`，则可以使用 tmux mode。

它可以防止：

- 关闭 VS Code terminal。
- reload VS Code。
- 在机器保持唤醒时稍后重新 attach。

它不能防止：

- laptop sleep。
- 关机。
- 用户 logout 导致 tmux 被杀。

### Remote SSH

tmux 运行在 remote extension host 上。

这是第一版最强的使用场景。只要 SSH host 保持在线，智能体就可以在 VS Code 断开后继续运行。

### Dev Container

tmux 运行在 container 内。

如果 container 保持运行，它可以防止 VS Code terminal 断开导致 session 丢失。

它不能防止：

- container stop。
- container rebuild。
- host shutdown。

### Windows

第一版不支持原生 Windows 环境下的 tmux mode。

Windows 用户可用路径：

- 安装了 tmux 的 WSL workspace。
- 安装了 tmux 的 Remote SSH workspace。
- 安装了 tmux 的 Dev Container。

## 错误处理

### 找不到 Tmux

当启用 tmux mode 但当前环境没有 tmux 时：

1. 显示 warning。
2. 不要静默回退到 direct terminal mode，除非用户明确选择 fallback。

推荐按钮：

```text
Install tmux
Use VS Code Terminal This Time
Open Settings
```

第一版可以只实现：

```text
Use VS Code Terminal This Time
Open Settings
```

### 创建 Tmux Session 失败

显示可操作错误：

```text
Project Steward could not start the tmux session for this AI chat. Check that tmux works in this environment.
```

中文语义：

```text
Project Steward 无法为这个 AI chat 启动 tmux session。请检查当前环境中的 tmux 是否可用。
```

完整命令和错误写入 Project Steward output channel，但 UI message 中避免暴露敏感信息。

### Tmux Session 存在但 Attach 失败

如果 `tmux has-session` 成功，但 attach 失败，显示：

```text
The tmux session exists, but Project Steward could not attach to it.
```

中文语义：

```text
tmux session 存在，但 Project Steward 无法 attach 到它。
```

这可能由 nested tmux、terminal 兼容性问题、tmux server 异常状态等导致。

## 安全性

这个功能会在用户 shell 环境中执行命令，因此必须把 session ID、路径、title、provider command 都视为需要安全 quoting 的字符串。

实现要求：

- 所有 path 和 session ID 都必须 quote。
- 除非严格 quote，否则不要把 raw title text 插入 shell command。
- provider-specific command 仍然通过 provider command builder 生成。
- tmux session name 从 hash 派生，不使用 raw user text。
- 不存储带有 secret 的 command string。
- 不暴露 tmux WebSocket、socket 或网络 listener。

## 与现有 AI Provider 的兼容

### Codex

Resume command：

```text
codex resume --cd <cwd> <session-id>
```

New session command：

```text
codex --cd <cwd>
```

Codex title 仍然作为 Project Steward 本地 alias。Project Steward 不应该尝试把 title 写入 Codex。

### Kimi

Resume command：

```text
kimi --work-dir <cwd> --resume <session-id>
```

New session command：

```text
kimi --work-dir <cwd>
```

Kimi title 仍然作为 Project Steward 本地 alias，除非未来 Kimi 提供安全的原生命名接口。

### Claude

Resume command：

```text
claude --resume <session-id>
```

如果 cwd 可用，Project Steward 应该先进入该 cwd，再运行 Claude，保持当前行为一致。

New session command：

```text
claude --name <title>
```

当前 Claude title 行为可以保持不变，除非后续决定所有 provider 的 title 都只作为 alias 处理。

## UI 场景

### 场景 1：在 SSH 上恢复已有 Codex Session

1. 用户在 SSH 项目中打开 Project Steward。
2. `aiSessionTerminalMode` 为 `tmux`。
3. 用户点击一个 Codex session。
4. Project Steward 打开名为 `Codex tmux: <session>` 的 terminal。
5. terminal attach 到 `project-steward-codex-<hash>`。
6. 用户关闭 VS Code。
7. Codex 继续在 SSH host 上运行。
8. 用户重新打开项目并点击同一个 session。
9. Project Steward attach 到同一个 tmux session。

### 场景 2：本地 Laptop 进入睡眠

1. 用户在 Mac laptop 上打开本地项目。
2. 用户启动一个 Codex tmux session。
3. 用户合上 laptop，系统进入睡眠。
4. Codex 随系统一起暂停。
5. 用户重新打开 laptop。
6. tmux session 可能仍然存在并可重新 attach，但 laptop 睡眠期间不会继续工作。

产品上必须把这视为预期行为，而不是 bug。

### 场景 3：找不到 Tmux

1. 用户启用 tmux mode。
2. 用户在 Dev Container 中点击一个 session。
3. container 没有安装 tmux。
4. Project Steward 弹出 warning，提供本次使用 VS Code terminal 或打开 settings。

## 可观测性

Project Steward 应该把 tmux 生命周期事件写入 output channel：

- 当前选择了 tmux mode。
- tmux availability check 结果。
- tmux session name。
- create vs attach 决策。
- provider command 类型。
- attach/create 失败原因。

日志中避免记录 raw prompt 内容，也避免 dump 环境变量。

## 验收标准

1. 当 `projectSteward.aiSessionTerminalMode` 为 `vscode` 时，所有 AI session 行为保持不变。
2. 当 mode 为 `tmux` 时，点击已有 Codex session 会启动或 attach 到确定性的 tmux session。
3. 重复点击同一个 session 不会启动重复的 provider 进程。
4. 关闭可见 VS Code terminal 不会杀死 tmux session。
5. reload VS Code 后，Project Steward 仍能 attach 到已存在的 tmux session。
6. 找不到 tmux 时显示清晰 warning，extension 不崩溃。
7. 原生 Windows 环境不尝试执行不支持的 tmux 行为。
8. Codex、Kimi、Claude 都走同一套 provider-neutral tmux lifecycle。
9. 现有 session discovery、alias、pin、archive、provider selector 继续工作。
10. 命令构建测试覆盖带空格、引号和特殊字符的路径。

## 成功指标

这个功能成功的标志：

- 用户可以把长时间运行的 AI session 留在 SSH 或常开宿主上，并在稍后重新连接。
- 用户不再因为重复点击同一个 session 而看到多个重复 terminal/provider 进程。
- 默认 VS Code terminal mode 用户没有行为回归。
- 当 tmux 不可用或宿主无法持续运行时，错误信息足够清楚。

## 待讨论问题

1. `tmux` mode 应该是全局设置，还是每个 provider 单独设置？
2. tmux 缺失时，Project Steward 是否应该提供“一次性使用 VS Code terminal”的 fallback？
3. 创建新 session 后，Project Steward 是否应该在发现 provider session ID 后 rename tmux session？
4. session card 上是否需要小的 UI 标识，表明该 session 运行在 tmux 中？
5. 是否需要提供 `Project Steward: Kill AI Session Tmux Session` 这样的命令？
6. 本地 laptop 用户第一次启用 tmux mode 时，是否需要额外提示“睡眠期间不会继续运行”？
7. 原生 Windows 上应该隐藏 tmux mode，还是展示但 disabled 并解释原因？

## 推荐 V1 范围

V1 包含：

- 全局 `projectSteward.aiSessionTerminalMode` 设置。
- `vscode` 和 `tmux` 两种模式。
- tmux availability check。
- provider-neutral tmux command wrapper。
- 通过 tmux 恢复已有 session。
- 通过 pending tmux name 创建新 session。
- VS Code reload 后 attach 已存在的 tmux session。
- tmux 不可用时显示清晰 warning。
- command building 和 tmux session naming 的单元测试。

V1 不包含：

- provider 级别的 terminal mode 设置。
- 电源管理集成。
- 除 terminal name 和 tooltip 外的 UI badge。
- 自动安装 tmux。
- tmux session browser 或 kill command。
- Codex app-server 或 cloud integration。

## 讨论方向

关键产品决策是：Project Steward 应该如何命名这个能力。

选项一：

```text
Persistent terminal mode
```

优点是友好；缺点是可能过度承诺。

选项二：

```text
Run AI sessions in tmux
```

优点是准确；缺点是更技术化。

折中方案：

```text
Persistent terminal mode (tmux)
```

同时在设置描述中明确说明：执行宿主必须保持唤醒并持续运行。
