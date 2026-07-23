# 回归修复 CI 优先 Skill 设计

## 背景

仓库已经具备行为契约清单、分层测试命令和 PR CI 门禁，`docs/testing/README.md` 也规定了回归修复必须先 RED 再修复。但这条流程目前没有仓库级 Skill 在收到 bug、功能回退或“为什么 CI 没卡住”时主动触发。

主检出目录还存在四个未被 Git 追踪的仓库 Skill。它们在当前机器上可用，但不会随仓库克隆或 `main` 分支传播。

## 目标

1. 将现有四个仓库 Skill 原样纳入版本控制：
   - `installing-vscode-extensions-locally`
   - `protecting-main-with-worktrees`
   - `publishing-and-merging-github-prs`
   - `review-fix-commit-loop`
2. 新增 `fixing-regressions-with-ci`，在本仓库修复 bug 或功能回退时触发。
3. 强制修复顺序为：确认根因、补充 CI 可达的失败用例、观察正确 RED、最小修复、验证 GREEN。
4. 通过当前 `fix/logical-attention-card-count` worktree 提交并在后续 PR 中合并到 `main`，不直接推送 `main`。

## 非目标

- 本次不修复 session 别名迁移问题；该问题将作为新 Skill 的首个真实使用场景。
- 不修改四个现有 Skill 的内容。
- 不新增或改名 GitHub required check。
- 不发布 VSIX 或创建产品版本。

## 仓库结构

```text
.codex/skills/
  fixing-regressions-with-ci/
    SKILL.md
    agents/openai.yaml
  installing-vscode-extensions-locally/
  protecting-main-with-worktrees/
  publishing-and-merging-github-prs/
  review-fix-commit-loop/
```

新 Skill 保持自包含且精简，不增加脚本、模板或重复的测试文档。具体测试命令与行为目录格式继续引用 `docs/testing/README.md` 和仓库 `package.json`。

## Skill 行为契约

### 触发范围

以下请求必须触发：

- 修复 bug、异常行为或功能回退；
- 用户指出历史上修复过但再次出现；
- 用户询问为什么 CI 没有阻止问题；
- review 发现用户可观察行为已损坏。

普通新功能与纯重构继续由通用 TDD 流程负责，不由本 Skill 扩大范围。

### 强制工作流

1. **隔离与诊断**
   - 从最新受保护基线使用独立 worktree；已有用户指定 worktree 时先确认其干净并包含最新基线。
   - 使用系统化调试确认根因、预期行为和回退路径，不能先改生产代码。
2. **建立回归契约**
   - 选择现有 behavior ID，或在 `docs/testing/behavior-contracts.json` 新增稳定 ID。
   - 在能够稳定验证行为的最低测试层增加 focused test。
   - 确认该测试文件由现有 PR CI 命令实际执行；“本地能运行”不等于“CI 已覆盖”。
3. **验证 RED**
   - 在未修复实现上运行 focused test。
   - 测试必须因目标缺陷失败，而不是编译错误、fixture 错误或无关断言失败。
   - 如果测试直接通过，说明没有复现回退，必须修正测试而不能进入实现。
4. **最小修复**
   - 只在确认 RED 后修改生产代码。
   - 不借机加入无关重构或新功能。
5. **验证 GREEN 与门禁**
   - 先运行 focused test，再运行行为目录检查和受影响的 unit、contract、integration、platform 或 tmux 层级。
   - 在提交、推送或 PR 前执行与风险相称的完整 CI 等价命令和 fresh review。

### 无法自动化时

如果行为只能依赖真实远程环境、多窗口生命周期或视觉判断，必须暂停并向用户说明阻碍。只有用户明确同意后，才能登记为 scheduled/manual，并写明原因和验证所有者；不得自行以手工验证替代 PR CI。

## Skill 自身验证

该 Skill 属于纪律约束型 Skill，按文档 TDD 验证：

1. 在不提供新 Skill 的隔离场景中运行压力用例，记录代理是否会因“改动很简单”“已有手工复现”“赶时间”等理由先改实现。
2. 编写最小 Skill，针对观察到的实际绕过理由设置明确禁令与停止条件。
3. 使用相同场景加载新 Skill，确认代理会先建立 CI 可达测试并观察 RED。
4. 增加至少一个测试无法稳定自动化的场景，确认代理会暂停请求授权，而不是伪造 CI 覆盖。
5. 运行 Skill frontmatter 与 `agents/openai.yaml` 校验，确认名称、描述和触发文本一致。

压力测试只允许读取仓库或操作隔离临时目录，不得修改生产服务、远程分支或用户数据。

## 提交与集成

工作在现有 `fix/logical-attention-card-count` worktree 中继续进行。该分支已快进到合并后的 `origin/main`。提交分为：

1. 设计文档；
2. 现有仓库 Skill 纳入追踪；
3. 新 Skill 及其验证证据；
4. review 修正（如有）。

完成后创建新的 PR 合并到 `main`。本次不发布版本，并保留 worktree 供随后使用新 Skill 修复 session 别名回退。

## 验收标准

1. 五个 Skill 及其 `agents/openai.yaml` 都被 Git 追踪。
2. 新 Skill 能在 bug、regression、CI coverage gap 场景中被发现。
3. 新 Skill 明确禁止在观察到正确 RED 之前修改生产代码。
4. 新测试必须能通过现有 PR CI 命令到达，并关联 behavior ID。
5. 无法自动化的例外必须由用户明确批准。
6. Skill 通过 baseline、加载后压力场景和结构校验。
7. 主检出目录现有 `.codex` 和 `.vscode/settings.json` 不被修改。
8. 不直接推送 `main`，不发布版本。
