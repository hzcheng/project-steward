# Favorites 组内拖拽排序设计

## 目标

允许用户在 Project Steward 的 `FAVORITES` 虚拟组内通过鼠标拖动重新排列已有收藏项目卡片。该顺序独立于普通 Group 的项目顺序，并跟随现有项目数据跨机器同步。

## 产品行为

- 只有 `FAVORITES` 组内的已有收藏卡片可以参与 Favorites 排序。
- 卡片只能从 `FAVORITES` 拖到同一个 `FAVORITES` 组中的其他位置。
- 不允许从普通 Group 或 `OPEN PROJECT` 拖入 `FAVORITES`。
- 不允许把 Favorites 卡片拖到普通 Group、`OPEN PROJECT` 或其他区域。
- Favorites 拖动不得改变项目在原始 Group 中的顺序或所属 Group。
- 新收藏的项目默认追加到 Favorites 末尾。
- 取消收藏后，该项目立即从 Favorites 消失；再次收藏时作为新收藏追加到末尾。
- 按 Escape 取消拖动时不保存顺序。
- 拖动后的顺序刷新侧边栏、重启 VS Code 和切换机器后保持一致，前提是项目数据使用 VS Code Settings 存储并参与 Settings Sync。

## 数据模型

在 `Project` 上增加可选字段：

```ts
favoriteOrder?: number;
```

该字段与现有 `favorite` 字段一起保存在 `projectData` 中：

- 收藏项目使用从 `0` 开始的连续整数表示顺序。
- 非收藏项目不保留 `favoriteOrder`。
- 不新增独立配置键、globalState 键或 ID 顺序数组。
- 当 `storeProjectsInSettings` 为 `true` 时，顺序自然参与 Settings Sync；为 `false` 时遵循现有项目数据的本机存储行为。

## 兼容与规范化

旧版本收藏项目没有 `favoriteOrder`，渲染时按以下规则处理：

1. 有有效 `favoriteOrder` 的项目按数值升序排列。
2. 没有有效顺序的收藏项目追加在已排序项目之后，并保持它们在原始 Group 汇总列表中的相对顺序。
3. 第一次拖动或新增收藏时，把当前 Favorites 显示顺序规范化为连续整数。

有效顺序必须是有限、非负整数。重复、负数、`NaN` 或非数字值按缺失顺序处理。保存一次新的顺序后会被规范化。

## 拖拽交互

继续使用现有 Dragula 实例，但为 Favorites 增加明确的源与目标判断：

- 普通项目拖拽保持现有逻辑，只能在非虚拟 Group 之间移动。
- `OPEN PROJECT` 继续禁止拖拽。
- Favorites 项目允许开始拖动，但目标必须与源相同且属于 `FAVORITES`。
- Favorites 拖动继续使用现有拖动透明度、占位和自动滚动反馈。
- Favorites drop 不调用普通的 `onReordered()`，而是读取 Favorites 组内当前卡片 ID，并发送独立消息：

```ts
{
    type: 'reordered-favorites',
    projectIds: string[]
}
```

Webview 不自行修改收藏状态或持久化数据。

## Extension Host 处理

Dashboard 收到 `reordered-favorites` 后：

1. 读取当前 Groups 和所有收藏项目。
2. 对消息中的 ID 去重，忽略未知 ID 和已经取消收藏的项目。
3. 按消息顺序排列有效收藏项目。
4. 将未出现在消息中的现有收藏项目追加到末尾，避免并发同步或刷新期间丢失项目。
5. 为最终列表写入连续的 `favoriteOrder`。
6. 清除所有非收藏项目残留的 `favoriteOrder`。
7. 调用现有 `ProjectService.saveGroups()` 并刷新 Dashboard。

普通 Group 数组和每个 Group 内的 `projects` 数组顺序均保持不变，只更新项目对象上的排序字段。

## 收藏切换

收藏一个项目时：

1. 按当前 Favorites 显示规则取得已有收藏项目。
2. 将已有项目规范化为连续顺序。
3. 把新收藏项目追加到末尾并写入最后一个序号。

取消收藏时清除 `favoriteOrder`。再次收藏会获得新的末尾序号，不恢复历史位置。

## 模块边界

新增一个纯逻辑模块负责 Favorites 排序，避免把排序规则散落在 Dashboard 和 Webview：

- 判断 `favoriteOrder` 是否有效。
- 根据原始项目列表生成稳定的 Favorites 显示顺序。
- 根据拖拽 ID 列表生成规范化顺序。
- 在不改变 Group/项目数组顺序的前提下更新项目排序字段。

Dashboard 负责读取/保存数据和处理消息；Webview 负责渲染及发送拖拽结果；Dragula 只负责交互约束。

## 错误处理

- 空 ID 列表不会删除收藏项目；当前收藏项目按已有显示顺序保留并规范化。
- 重复 ID 只采用第一次出现的位置。
- 未知或非收藏 ID 被忽略。
- 同步期间新增但未出现在 drop 消息里的收藏项目追加到末尾。
- 保存失败沿用现有错误记录/提示路径，不在 Webview 中乐观持久化。

## 测试

- 旧数据没有 `favoriteOrder` 时保持原汇总顺序。
- 有效顺序按数值排序，无效和重复顺序稳定追加。
- 新收藏项目追加到末尾，取消收藏清除顺序，再收藏仍追加到末尾。
- 拖拽 ID 中的重复、未知和非收藏项目被忽略。
- drop 消息遗漏的现有收藏项目追加到末尾。
- 排序后 `favoriteOrder` 为从 `0` 开始的连续整数。
- Favorites 排序不改变普通 Group 或 Group 内项目数组顺序。
- Favorites 只接受同组拖拽，拒绝所有跨组拖入和拖出。
- Open Project 保持不可拖动，普通 Group 拖拽行为不回归。
- Webview 发送 `reordered-favorites`，Dashboard 不把它交给普通 `reordered-projects` 处理器。
- 编译后的 Webview 脚本与源脚本保持同步。
