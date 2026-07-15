# 双插件发布流程设计

## 背景

Project Steward 现在由两个生产扩展组成：

- 主扩展：`hzcheng.project-steward`
- UI Bridge 扩展：`hzcheng.project-steward-attention-ui-bridge`

主扩展通过 `extensionDependencies` 依赖 UI Bridge。这个边界不能简单合并，因为主扩展需要在 workspace 或 remote extension host 中访问项目、终端和 AI session；UI Bridge 需要稳定运行在本机 UI extension host 中，使用本机 Profile 级存储聚合多个窗口的状态。

因此发布目标不是合并成一个插件，而是把双插件发布流程产品化，让用户感知仍接近“只安装 Project Steward”。

## 目标

1. 正式发布产物包含两个生产 VSIX：主扩展和 UI Bridge。
2. Marketplace 发布顺序固定为先发布 UI Bridge，再发布主扩展。
3. 本地安装、GitHub Release、Marketplace 发布三条路径都使用同一套版本和产物规则。
4. spike/probe 扩展不进入正式发布路径。
5. 发布前自动校验主扩展依赖、Bridge manifest、产物名称和版本，避免发布不完整的组合。

## 非目标

1. 不合并两个 extension host 运行时。
2. 不把 workspace probe 作为生产插件发布。
3. 不改变 AI attention 或 OTHER WINDOWS 的运行协议。
4. 不引入新的外部发布工具，继续使用 `@vscode/vsce`。

## 发布模型

主扩展继续声明：

```json
"extensionDependencies": [
  "hzcheng.project-steward-attention-ui-bridge"
]
```

UI Bridge 继续声明：

```json
"extensionKind": ["ui"]
```

Marketplace 用户只需要安装 `Project Steward`。VS Code 根据依赖自动解析并安装 UI Bridge。手动 VSIX 安装时必须先安装 UI Bridge，再安装主扩展。

## 脚本职责

### 生产打包

新增或调整一个生产打包入口，例如：

```bash
npm run package:release
```

它只生成两个生产产物：

- `artifacts/project-steward-attention-ui-bridge-<bridgeVersion>.vsix`
- `artifacts/project-steward-<mainVersion>.vsix`

该入口不生成 `project-steward-attention-workspace-probe`。

### Spike/Probe 打包

保留独立 spike 入口，例如：

```bash
npm run spike:attention:package
```

该入口可以继续生成 probe 产物，但它不被 GitHub Release、Marketplace publish、本地正式安装流程调用。

### 本地安装

`npm run install-local` 的顺序固定为：

1. 编译和校验。
2. 生成生产 release 产物。
3. 安装 UI Bridge VSIX。
4. 安装主扩展 VSIX。

安装脚本不再硬编码 `project-steward-attention-ui-bridge-0.1.2.vsix`，而是从 Bridge `package.json` 读取版本。

### Marketplace 发布

`npm run publish-marketplace` 应发布两个扩展：

1. 打包并发布 UI Bridge。
2. 验证 UI Bridge 发布步骤成功。
3. 打包并发布主扩展。

`DRY_RUN=1` 时只生成两个 VSIX 并输出将要发布的扩展 ID 和文件路径，不调用 `vsce publish`。

如果设置 `VERSION` 或 `BUMP`，只作用于主扩展版本。Bridge 版本独立维护，避免主扩展每次 patch 都强制 bump Bridge。只有 Bridge manifest、协议、存储格式或行为变化时才 bump Bridge。

### GitHub Release

`.github/workflows/release-vsix.yml` 应上传两个生产 VSIX 到同一个 GitHub Release：

- 主扩展 VSIX
- UI Bridge VSIX

Release notes 仍从主扩展 `CHANGELOG.md` 的版本段落生成。Release 标题仍使用主扩展版本，例如 `Project Steward 1.1.9`。

当前 GitHub 自动发版流程必须改。现在的 workflow 在 tag push 和
`workflow_dispatch` 下只读取主扩展 metadata，只执行一次 `vsce package`，
只上传主扩展 VSIX，也只把主扩展 VSIX 作为 GitHub Release asset。双插件
发布后这会生成一个不完整 release。

改造后的自动发版流程应为：

1. `Read package metadata` 同时读取主扩展和 UI Bridge 的 `name`、`version`、`publisher`。
2. tag 校验仍以主扩展版本为准，即 `v<mainVersion>`。
3. workflow 运行 release packaging 校验，确保主扩展依赖的 Bridge ID 与 Bridge manifest 一致。
4. workflow 编译主扩展和 UI Bridge。
5. workflow 生成两个生产 VSIX，不能调用会生成 workspace probe 的 spike 打包入口。
6. workflow artifact 上传两个 VSIX，artifact 名称可以是一个 release bundle，也可以分别上传两个文件。
7. `gh release create` 同时附带两个 VSIX 文件。
8. workflow summary 输出两个产物的文件名、扩展 ID、版本和 SHA-256。

GitHub Release 只负责发布 VSIX 资产，不自动发布 Marketplace。Marketplace 发布仍由 `npm run publish-marketplace` 或单独手动 workflow 控制，避免 tag push 直接把两个 Marketplace 扩展发布出去。

## 发布前校验

增加一个 release 校验脚本，例如：

```bash
npm run test:release-packaging
```

校验项：

1. 主扩展 `extensionDependencies` 精确包含 `hzcheng.project-steward-attention-ui-bridge`。
2. Bridge `publisher.name` 组合等于主扩展依赖 ID。
3. Bridge `extensionKind` 精确为 `["ui"]`。
4. 生产打包脚本不会把 workspace probe 放进 release 产物列表。
5. 本地安装脚本不硬编码 Bridge 版本号。
6. Marketplace 发布脚本包含 Bridge 先、主扩展后的发布顺序。
7. GitHub Release workflow 上传两个生产 VSIX。

该校验应并入 `npm run test:safety` 或 release workflow 的验证步骤。

## 错误处理

如果 Bridge 发布失败，发布脚本必须停止，不允许继续发布主扩展。

如果主扩展发布失败但 Bridge 已发布，脚本应明确输出当前状态：Bridge 已发布，主扩展未发布。因为 Bridge 是向后兼容的无 UI 依赖扩展，该状态可以接受，但需要人工决定是否重试主扩展发布。

如果本地安装时 VS Code CLI 挂起或不可用，脚本应保留 VSIX 产物并输出手动安装顺序。当前开发环境里 `code --install-extension` 曾经出现挂起，发布流程不应因为安装步骤失败而丢失可验证产物。

## 版本策略

主扩展版本用于用户可见 release 节奏。

Bridge 版本用于协议和存储兼容性。主扩展可以依赖一个已发布的 Bridge 版本，不要求每次主扩展发布都 bump Bridge。

当主扩展需要新的 Bridge 能力时：

1. 先 bump Bridge 版本并保持向后兼容。
2. 先发布 Bridge。
3. 再发布依赖新能力的主扩展。

## 测试策略

发布流程改造需要覆盖：

1. 静态 release packaging 校验。
2. `DRY_RUN=1 npm run publish-marketplace` 能生成两个生产 VSIX，且不发布。
3. `npm run install-local` 使用动态 Bridge 版本路径。
4. `npm run test:release-notes` 仍通过。
5. 现有 `npm run test:safety`、`npm run test:dashboard`、`npm run lint` 不回退。

## 实施顺序

1. 新增 release packaging 校验，先让测试暴露当前发布流程缺口。
2. 拆分生产 Bridge 打包和 spike/probe 打包。
3. 改造本地安装脚本，去掉 Bridge 版本硬编码。
4. 改造 Marketplace 发布脚本，按 Bridge 到主扩展的顺序发布。
5. 改造 GitHub Release workflow，上传两个生产 VSIX。
6. 更新文档，明确双插件发布和手动安装顺序。

## 验收标准

1. 一个命令可以生成两个生产 VSIX，且不包含 probe。
2. 本地安装流程先装 Bridge，再装主扩展。
3. Marketplace dry run 明确展示两个待发布扩展。
4. GitHub Release workflow 明确上传两个生产 VSIX。
5. release 校验能防止主扩展依赖、Bridge manifest、产物路径三类常见错误。
