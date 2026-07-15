# AI Session Terminal 归属持久化设计

## 问题

Project Steward 创建新的 AI session 时，provider 还没有分配最终的 session ID。此时 terminal 会先以“待匹配”状态被跟踪，等发现新 session 后，再在扩展进程内存中把 terminal 与 session 绑定。

VS Code 窗口重新加载后，这个仅存在于内存中的绑定会丢失。原 terminal 的创建环境中没有最终 session ID，名称也不是恢复 session 时使用的 `[session-id-prefix]` 格式，因此 Project Steward 无法再次识别它。这会造成两个用户可见的问题：

- session 提醒无法归属到原 session；
- 再次点击 session 卡片时会打开重复 terminal，而不是聚焦已有 terminal。

## 范围

只持久化由 Project Steward 创建的 terminal 归属关系。不修改 provider 生命周期解析、attention payload、UI 渲染，也不接管在 Project Steward 之外打开的 terminal。

## 设计

### 稳定的 terminal 实例标识

Project Steward 创建每个 AI terminal 时，都在 terminal 创建环境中写入一个随机且不包含隐私信息的实例 ID。这个 ID 标识 terminal，而不是 provider session，并且会随 VS Code 的 terminal 持久化机制跨窗口重载保留。

### Workspace 级独立绑定项

扩展在 `context.workspaceState` 中为每个 terminal 实例 ID 保存一个独立的绑定项，key 格式为 `aiSessionTerminalBinding.v1.<instance-id>`。记录分为两种状态：

- `pending`：保存 provider、cwd、创建时间、marker 路径、创建前已有的 session ID，以及可选标题；
- `bound`：保存 provider、最终 session ID、marker 路径和本轮运行开始时间。

terminal 实例 ID 为随机值，记录只保存在当前 workspace 的扩展环境中。绑定项不保存 prompt 或 transcript 内容。

不同 terminal 使用不同的 workspaceState key。多个窗口同时创建或更新各自的 terminal 时，不会读取并覆盖同一个聚合对象，因此不依赖 `workspaceState.update` 提供 CAS 或事务能力。

### 恢复流程

扩展激活时，terminal service 枚举当前窗口可见的 terminal，并按实例 ID 分别读取绑定项：

1. 从每个 terminal 的创建环境中读取实例 ID。
2. 将匹配的 `bound` 记录直接恢复到已跟踪 terminal 映射中。
3. 将匹配的 `pending` 记录恢复到待匹配队列中。
4. 当前窗口中不存在对应 terminal 时，不枚举或删除其他实例 ID 的绑定项，避免误删同一 workspace 另一个窗口仍在使用的记录。

待匹配流程发现 provider session 后，先把记录从 `pending` 原子升级为 `bound`，后续刷新再使用最终 session ID。

### 生命周期与清理

- 恢复已有 session 时，新 terminal 立即以 `bound` 状态持久化。
- 新建 session 时，新 terminal 立即以 `pending` 状态持久化。
- terminal 被关闭或显式取消跟踪时，删除对应绑定项。
- 同一扩展实例发起的持久化写入串行执行，保证 `pending → bound → remove` 顺序不被颠倒。
- 不同 terminal 写入不同 workspaceState key，避免跨窗口整表覆盖。
- 恢复时发现超过 24 小时的 `pending` 绑定会立即删除。
- 无效、超限或格式错误的持久化记录会被忽略。每条记录对字符串和数组长度设置明确上限。

## 错误处理

持久化采用尽力而为策略。如果 `workspaceState.update` 失败，当前窗口中的内存跟踪仍然继续工作，并通过现有 Project Steward 输出通道为该 store 实例记录一次错误。持久化失败不会阻止 provider 命令执行。

## 测试

回归测试必须证明：

1. 创建新的 terminal 并进入 `pending` 状态后，新建 terminal-service 实例可以恢复它。
2. `pending` terminal 匹配到 provider session 后，再次新建 terminal-service 实例可以恢复准确的最终 session ID，并且 `getById` 返回原 terminal。
3. 点击或恢复该 session 时会复用已恢复的 terminal，而不是再创建一个。
4. 关闭 terminal 后会删除持久化绑定。
5. 格式错误的持久化记录会被忽略，不影响有效记录恢复。
6. 两个窗口交错写入不同 terminal 绑定时，两条记录都会保留。
7. 超过 24 小时的 `pending` 绑定在恢复时被清除。
8. 现有 AI session 安全测试、显式生命周期提醒测试和 Open Project 测试继续通过。

## 非目标

- 恢复实例 ID 机制上线前已经创建的 terminal。
- 根据 cwd 或最近 transcript 时间猜测 terminal 归属。
- 在不同机器或不同 VS Code remote authority 之间共享 terminal 归属。
