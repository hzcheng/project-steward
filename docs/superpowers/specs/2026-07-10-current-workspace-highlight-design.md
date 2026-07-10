# 当前 Workspace 卡片高亮设计

## 目标

在 Project Steward 侧边栏中，持续高亮与当前 VS Code 窗口所打开 workspace 对应的项目卡片，帮助用户快速确认当前所在项目。

同一个保存项目可能同时出现在普通 Group、`FAVORITES` 和 `OPEN PROJECT`。所有对应卡片都应展示相同的高亮状态。

## 产品行为

- 当前窗口打开 `.code-workspace` 文件时，高亮与该 workspace 文件匹配的保存项目卡片。
- 当前窗口直接打开一个或多个文件夹时，高亮每一个能够与 workspace folder 匹配的保存项目卡片。
- `OPEN PROJECT` 中代表当前 workspace 或 workspace folder 的卡片始终高亮。
- 普通 Group 和 `FAVORITES` 中指向同一项目的卡片副本同时高亮。
- 没有打开 workspace 时，不高亮任何项目卡片。
- 高亮状态仅代表当前窗口，不写入项目配置、VS Code settings 或扩展存储，也不参与跨机器同步。

## 匹配规则

匹配在 Extension Host 中完成，复用 `openProjectMatcher` 的 URI 和 remote-aware 路径匹配逻辑。

- 本地项目比较规范化后的文件路径。
- SSH、WSL、Dev Container 等远程项目比较规范化后的 URI authority 和路径。
- 对远端运行环境只暴露普通文件路径的情况，沿用现有 remote type 与路径唯一匹配回退逻辑。
- 不使用项目名称匹配，避免同名项目误判。

## 数据流

1. Dashboard 构建视图数据时读取当前 `workspaceFile` 和 `workspaceFolders`。
2. 对每个当前 workspace URI 调用现有保存项目匹配器。
3. 收集匹配到的保存项目 ID。
4. 为匹配项目和 `OPEN PROJECT` 虚拟项目设置仅运行时使用的 `isCurrentWorkspace` 字段。
5. Webview 将该字段渲染为 `data-current-workspace` 属性。
6. workspace 或项目数据变化触发现有刷新流程时，重新计算状态。

`isCurrentWorkspace` 不属于持久化项目数据。读取旧配置或导入数据时不需要迁移。

## 视觉设计

高亮采用现代、克制的主题适配样式：

- 使用 VS Code 当前主题的 selection background 形成轻微底色。
- 使用 `focusBorder` 或对应主题 token 显示细描边和弱外发光。
- 不显示 `CURRENT` 文字，不增加图标，不使用闪烁或循环动画。
- 保留项目自定义颜色竖条及 Project Aura 效果，高亮不得覆盖它们。
- Hover 时继续保持当前状态底色，只适度增强描边和阴影。
- 展开的 AI session 区域属于同一项目卡片，应自然包含在高亮卡片内部。

## 实现边界

- 不尝试追踪其他 VS Code 窗口打开的项目；状态只描述承载当前 Project Steward 实例的窗口。
- 不增加设置项，高亮默认启用。
- 不改变卡片点击、窗口切换、收藏或项目颜色行为。
- 不增加轮询；使用现有 workspace 事件和 Dashboard 刷新机制。

## 测试

- 本地 folder 项目能够正确高亮。
- 本地 `.code-workspace` 项目能够正确高亮。
- multi-root folder 模式下所有匹配项目都高亮。
- SSH 和 Dev Container 保存 URI 能够正确匹配。
- 同一项目在普通 Group 与 `FAVORITES` 中的副本同时高亮。
- 不同路径的同名项目不会被高亮。
- 无 workspace 窗口不产生高亮。
- 高亮状态不出现在序列化和同步数据中。
- Hover、收藏星标、项目颜色竖条和展开 session 列表与高亮样式兼容。
