# Open Projects Codex Sessions PRD

## 背景

Project Steward 已经有 `Open Projects` 组，用来展示当前 VS Code 窗口打开的项目。当前这些卡片再次点击时实际价值不高，因为项目已经处于打开状态。

Codex 本机会保存 session 历史，并且 active session 的 `session_meta` 中包含 `cwd`。这使 Project Steward 可以根据当前项目路径，动态发现属于这个项目的 Codex 对话，而不需要用户手动关联。

## 目标

在 `Open Projects` 组中，让当前打开的项目卡片可以展开，展示该项目相关的本机 Codex sessions。

用户打开 Project Steward 后，可以直接从当前项目卡片下看到最近的 Codex 对话历史，并通过点击 session 在 VS Code 当前窗口中打开 terminal，运行 `codex resume` 恢复该 session。

## 非目标

- 不同步 Codex session。
- 不把 session id/name 写入 `projectData`。
- 不保存完整 Codex 对话内容。
- 不修改 Codex 插件内部数据。
- 第一版不依赖 Codex VS Code 插件公开命令或内部 API。
- 第一版不在 Project Steward webview 内直接渲染 Codex 对话内容。

## 数据来源

Project Steward 从当前扩展运行环境可访问的 Codex 数据目录读取轻量索引和 session 元数据。

读取目录优先级：

```text
1. $CODEX_HOME
2. ~/.codex
```

注意：在 Remote SSH / Dev Container 场景中，扩展可能运行在 remote extension host。此时读取的是该 remote/container 环境可访问的 Codex 数据目录，而不一定是用户本机 host 上的 `~/.codex`。

目录下需要读取：

```text
session_index.jsonl
sessions/**/*.jsonl
```

`session_index.jsonl` 提供：

```ts
id: string;
thread_name: string;
updated_at: string;
```

如果存在 `session_index.jsonl`，Project Steward 只展示 index 中仍有 active session 文件的记录，避免已经被归档或不再活跃的历史文件重新出现在列表里。

如果没有 `session_index.jsonl`，Project Steward 才会回退到扫描 active session 文件，并使用 session id 作为名称兜底。

活跃 session 文件的第一条 `session_meta` 提供：

```ts
payload.id: string;
payload.cwd: string;
payload.source?: string;
```

Project Steward 只读取 active session 的第一条元数据，不读取完整对话内容。

## 匹配规则

每个 `Open Projects` 卡片都有当前项目路径。Project Steward 使用该路径和 `session_meta.payload.cwd` 匹配。

本地项目匹配：

```text
session.cwd == project.path
```

或者 session cwd 是项目路径的子目录：

```text
session.cwd startsWith project.path + "/"
```

Remote / Dev Container 项目匹配：

从 remote URI 中提取 path 部分，例如：

```text
vscode-remote://dev-container+xxx/workspaces/project
```

提取为：

```text
/workspaces/project
```

然后用同样规则和 `session.cwd` 匹配。

如果同一个 session 同时匹配多个 `Open Projects` 卡片，归属给路径最长、最具体的项目，避免在父目录项目和子目录项目中重复展示。

归属示例：

```text
Open Projects:
/workspaces/reddb
/workspaces/reddb/core/datanode

session.cwd:
/workspaces/reddb/core/datanode/src

结果：
session 只显示在 /workspaces/reddb/core/datanode 下
```

如果无法读取 Codex 数据，或没有匹配 session，Project Steward 不报错，只展示空状态。

## UI 行为

只在 `Open Projects` 组里的项目卡片支持 Codex sessions 展开。

普通 group 和 `Favorites` 里的项目卡片保持现有行为：点击打开项目。

`Open Projects` 卡片行为改为：

```text
点击项目卡片主体 -> 展开 / 收起 Codex sessions
```

卡片上展示轻量 session 数量标识：

```text
Codex 3
```

没有匹配 session 时可以弱化展示：

```text
Codex 0
```

展开后，在该项目卡片下方展示 session 子列表：

```text
project steward
Project Steward extension

Codex Sessions
修复 dev container 保存路径        2026-07-04
发布 GitHub Release 自动化        2026-07-03
项目管理 vscode 插件              2026-07-01
```

session 子项使用窄条样式，展示：

- session name
- updated time
- short session id

## 视觉规范

Codex session 列表必须作为 project 卡片内部的展开详情展示，不能做成和 project 一样的二级卡片。

层级关系：

```text
project card
  Codex Sessions section
    compact session row
    compact session row
```

Project 卡片是主视觉容器：

- 保留当前现代卡片风格、背景、边框、形状和项目图标。
- 项目名和 description 仍然是主信息。
- 右侧展示轻量 `Codex N` 标识。
- 展开后 project 卡片高度增加，session 列表位于卡片内部下方。

Codex Sessions 区域是从属信息：

- 顶部显示弱化标题 `Codex Sessions`。
- 标题下方使用细分割线。
- 整个 session 列表相对 project 主内容缩进。
- session row 使用 flat list item 样式，不使用大背景、不使用独立卡片阴影、不复用 project card 的形状。
- session row 默认安静显示，只在 hover 时出现轻微背景高亮。
- session name 字号小于 project name。
- session metadata 使用更弱的颜色，展示日期和 short session id。
- session row 左侧使用醒目的 terminal 图标，作为可恢复 Codex 对话的主要视觉锚点。

推荐视觉结构：

```text
project steward                         Codex 3
Project Steward extension

Codex Sessions
────────────────
> 修复 dev container 保存路径
  2026-07-04 · 019f2c7f

> 发布 GitHub Release 自动化
  2026-07-03 · 019f1c4a
```

视觉目标：

- 用户一眼能看出 project 是实体，session 是该 project 的历史上下文。
- 不能出现“卡片套卡片”的感觉。
- 侧边栏宽度较窄时仍然紧凑、清晰、可点击。

session 列表按 `updated_at` 倒序排序。

第一版最多展示最近 20 个匹配 session，避免某个项目历史过多导致 `Open Projects` 区域过高。

## 交互行为

点击 `Open Projects` 项目卡片：

```text
如果当前收起 -> 展开
如果当前展开 -> 收起
```

点击 session 子项：

```text
1. 如果该 session 已经有对应 terminal，则直接切换到该 terminal
2. 否则在当前 VS Code 窗口中打开一个 terminal
3. terminal 工作目录优先设置为该 session 的 cwd
4. 运行 codex resume <session-id>
```

推荐命令形态：

```text
codex resume --cd "<cwd>" "<session-id>"
```

`<cwd>` 选择规则：

```text
1. 优先使用 session_meta.payload.cwd
2. 如果 session cwd 缺失，使用当前 Open Project 的 filesystem path
3. Remote URI 不能直接作为 terminal cwd；必须先提取 URI path 部分
```

如果无法可靠获得 filesystem cwd，则退化为：

```text
codex resume "<session-id>"
```

第一版不做 Codex CLI 预检。点击 session 后直接打开 terminal 并执行命令；如果 `codex` 不在 PATH 中，错误由 terminal 自身展示。

session row 右侧提供归档图标，用于清理不再需要展示的 active session：

```text
点击归档图标 -> 确认 -> 移动到 archived_sessions
```

第一版不额外提供手动关联 session 的入口。session 和项目的关系完全由本机 Codex session metadata 动态计算。

## 展开状态

`Open Projects` 中每个项目卡片的展开状态保存在本机 `globalState`，不参与 Settings Sync。

建议 key：

```text
openProjectsExpandedCodexSessions
```

保存内容使用 normalized project path 或其 hash。

Project Steward 刷新后可以保持展开状态；换机器后展开状态不同步。

## 刷新行为

Project Steward 渲染时读取 Codex sessions。

以下情况会刷新 session 展示：

- 打开 Project Steward 面板
- webview 刷新
- Open Projects 变化
- Codex session index 或 active session 文件变化

Project Steward 使用轻量轮询检测 `session_index.jsonl` 和 `sessions/**/*.jsonl` 的变化。检测到变化后清理 session cache 并刷新侧边栏。

如果用户刚刚在 Codex 中创建新 session，短暂等待后会自动显示。

## 错误和空状态

没有 Codex 数据目录：

```text
No Codex history found
```

当前项目没有匹配 session：

```text
No sessions yet
```

空状态只在用户展开对应 Open Project 卡片后显示，使用弱化的小号文字，不占用大块空间。

点击 session 右侧归档按钮：

```text
1. 弹出确认
2. 确认后将该 session 文件从 sessions 目录移动到 archived_sessions
3. 刷新 Open Projects，归档后的 session 不再展示
```

读取某个 active session 失败：

```text
跳过该 session，不弹错误打断 UI。
```

`session_index.jsonl` 中有 id，但找不到对应 active session 文件：

```text
跳过该 session，可在 debug log 中记录。
```

## 性能要求

不读取完整 session 内容。

只读取：

```text
session_index.jsonl
每个 active session 文件的第一条 session_meta
```

session 列表按 `updated_at` 倒序排序。

第一版限制每个项目最多展示最近 20 个匹配 session。

## 隐私和同步

Codex session 只从本机读取：

- 不上传
- 不同步
- 不写入 Project Steward 项目配置
- 不增加 Settings Sync 体积

Project Steward settings sync 仍然只同步项目入口数据。

换机器后，如果那台机器没有相同 Codex 本地历史，`Open Projects` 里不会显示旧机器的 Codex sessions。这是预期行为。

## 验收标准

1. 打开 Project Steward 后，`Open Projects` 组里的当前项目卡片可以点击展开/收起。
2. 展开后能看到 `cwd` 匹配当前项目路径的 Codex sessions。
3. 普通项目组和 `Favorites` 的卡片点击行为不变。
4. 本地项目可以正确匹配 Codex sessions。
5. Dev Container / Remote 项目可以通过 URI path 部分匹配容器内 `cwd`。
6. 点击 session 子项会在当前 VS Code 窗口打开 terminal，并运行 `codex resume` 恢复该 session。
7. 多次点击同一个 session 时复用已有 terminal，不重复打开。
8. session row 右侧提供归档图标，确认后该 session 从列表中消失。
9. 没有 Codex session 时 UI 不报错，展示空状态。
10. 不改动 `projectData` 数据结构。
11. 不增加 Settings Sync 数据体积。
