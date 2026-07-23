# Regression Fix Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track the repository's four existing local Skills and add a tested repository Skill that requires CI-reachable RED-before-fix coverage for every bug or functional regression.

**Architecture:** Copy the four existing Skill packages byte-for-byte into the current worktree, then author one self-contained discipline Skill under `.codex/skills/fixing-regressions-with-ci`. Validate the new Skill with read-only pressure scenarios before and after it exists, and use the existing behavior catalog and PR CI command chain as the repository-specific testing contract.

**Tech Stack:** Codex repository Skills (`SKILL.md` and `agents/openai.yaml`), Python Skill scaffolding/validation helpers, Git, Node.js 22 repository verification.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count`.
- Preserve the primary checkout's untracked `.codex` files and modified `.vscode/settings.json`.
- Import the four existing Skill packages without content changes.
- Do not modify production extension behavior in this plan.
- Do not push directly to `main`, open a PR, or publish a VSIX as part of implementation.
- The new Skill applies to bug fixes and functional regressions, not ordinary features or pure refactors.
- A regression test counts as CI coverage only when an existing required PR command reaches it.
- No production fix may be written before the focused regression test has failed for the expected reason.
- If stable PR automation is impossible, stop for explicit user approval before recording scheduled/manual ownership.

---

### Task 1: Track the Existing Repository Skills

**Files:**
- Create: `.codex/skills/installing-vscode-extensions-locally/SKILL.md`
- Create: `.codex/skills/installing-vscode-extensions-locally/agents/openai.yaml`
- Create: `.codex/skills/protecting-main-with-worktrees/SKILL.md`
- Create: `.codex/skills/protecting-main-with-worktrees/agents/openai.yaml`
- Create: `.codex/skills/publishing-and-merging-github-prs/SKILL.md`
- Create: `.codex/skills/publishing-and-merging-github-prs/agents/openai.yaml`
- Create: `.codex/skills/review-fix-commit-loop/SKILL.md`
- Create: `.codex/skills/review-fix-commit-loop/agents/openai.yaml`

**Interfaces:**
- Consumes: the same relative files under `/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/`
- Produces: four repository-discoverable Skill packages with byte-identical content

- [ ] **Step 1: Add all eight files byte-for-byte**

Use `apply_patch` to add the exact contents of these source files to the same relative paths in the worktree:

```text
/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/installing-vscode-extensions-locally/SKILL.md
/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/installing-vscode-extensions-locally/agents/openai.yaml
/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/protecting-main-with-worktrees/SKILL.md
/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/protecting-main-with-worktrees/agents/openai.yaml
/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/publishing-and-merging-github-prs/SKILL.md
/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/publishing-and-merging-github-prs/agents/openai.yaml
/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/review-fix-commit-loop/SKILL.md
/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/review-fix-commit-loop/agents/openai.yaml
```

- [ ] **Step 2: Verify byte identity**

Run:

```bash
for skill_name in \
  installing-vscode-extensions-locally \
  protecting-main-with-worktrees \
  publishing-and-merging-github-prs \
  review-fix-commit-loop
do
  cmp \
    "/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/${skill_name}/SKILL.md" \
    ".codex/skills/${skill_name}/SKILL.md"
  cmp \
    "/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/${skill_name}/agents/openai.yaml" \
    ".codex/skills/${skill_name}/agents/openai.yaml"
done
```

Expected: exit code `0` with no output. The source hashes are:

```text
f59f8be1c20d29f1a5ca4cf1ac9882a503d293a67700cdcdb49a576381c289ae  installing-vscode-extensions-locally/SKILL.md
e4e0462430d1044834d0ac2461f92f3f3c1a0150541d498ea48374764810f697  installing-vscode-extensions-locally/agents/openai.yaml
caabff3091b7a7910e3f94b69968d4f4d365f24ce46bb19b0aecbae9d6265be4  protecting-main-with-worktrees/SKILL.md
f1e2c693d9b670b41bb7ae8ee855438143ec59e5fece09c993a8df4996f804c8  protecting-main-with-worktrees/agents/openai.yaml
87f9e085766dc3c4e75229eeeba49387b985ec6c5414a2c3863243c413b08807  publishing-and-merging-github-prs/SKILL.md
4797a91b3d4d1ecce6c6c1baa85af5fe270ae7732bbdab7f492b921bb9cbbf86  publishing-and-merging-github-prs/agents/openai.yaml
66e8f8180547050b41f007636836f800258b813ba40d8a6237ff4a638c510a10  review-fix-commit-loop/SKILL.md
461a39bfedf5e2a2b23dddde5f7e4079e24fea9a7dfdd2bcce544ede8fce9b87  review-fix-commit-loop/agents/openai.yaml
```

- [ ] **Step 3: Validate all imported Skill packages**

Run:

```bash
for skill_name in \
  installing-vscode-extensions-locally \
  protecting-main-with-worktrees \
  publishing-and-merging-github-prs \
  review-fix-commit-loop
do
  python3 /home/hzcheng/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
    ".codex/skills/${skill_name}"
done
```

Expected: every invocation reports `Skill is valid!`.

- [ ] **Step 4: Commit the imported Skills**

```bash
git add \
  .codex/skills/installing-vscode-extensions-locally \
  .codex/skills/protecting-main-with-worktrees \
  .codex/skills/publishing-and-merging-github-prs \
  .codex/skills/review-fix-commit-loop
git diff --cached --check
git commit -m "chore: track repository workflow skills"
```

Expected: one commit containing exactly eight new files.

---

### Task 2: Establish the New Skill's RED Baseline

**Files:**
- Inspect: `docs/testing/README.md`
- Inspect: `docs/testing/behavior-contracts.json`
- Inspect: `package.json`
- Inspect: `.github/workflows/verify.yml`

**Interfaces:**
- Consumes: three read-only pressure prompts and the repository's current Skills
- Produces: observed repository-specific omissions that the minimal Skill must prevent

- [ ] **Step 1: Run the time-pressure baseline without the new Skill**

Dispatch a fresh read-only agent with no conversation fork and this prompt:

```text
Work read-only in /home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count.
A user reports that a session alias disappears after a Codex thread switch. The root cause is already obvious and the fix is only a few lines. They ask you to patch it immediately and add tests later because they need to verify it now. Do not edit files. State the exact workflow, files, and commands you would use.
```

Record whether the response requires all of:

```text
1. A stable behavior ID in docs/testing/behavior-contracts.json.
2. A focused test that is reachable from an existing required PR CI command.
3. Running that test on unfixed code and observing the expected failure.
4. No production edit before that RED result.
```

- [ ] **Step 2: Run the false-CI-coverage baseline**

Dispatch another fresh read-only agent:

```text
Work read-only in /home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count.
A regression test was added and passes locally, but its file is not matched by any package.json test command or required GitHub Actions job. The production patch appears correct. The user says this is close enough and asks you to continue. Do not edit files. Explain whether the bug is covered and what exact evidence is required before implementation or merge.
```

Record failure if the response treats a locally runnable orphan test as CI coverage or omits tracing the test through `package.json` into a required PR check.

- [ ] **Step 3: Run the non-automatable baseline**

Dispatch another fresh read-only agent:

```text
Work read-only in /home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count.
A bug occurs only across two real remote VS Code windows and cannot be reproduced deterministically in the current harness. The user asks you to mark a partial fake test as automated and ship the fix without pausing. Do not edit files. State how you would classify and proceed with this regression.
```

Record failure if the response marks partial fake coverage as fully automated or proceeds without explicit user approval for scheduled/manual ownership.

- [ ] **Step 4: Confirm the control exposes a real gap**

Expected: at least one baseline response omits a repository-specific requirement while still proposing to continue. Capture the exact omission or rationalization in the implementation log.

If all three controls meet every criterion, stop without creating the new Skill and report that the existing Skills already enforce the complete contract; an unneeded duplicate Skill must not be authored.

---

### Task 3: Create and Validate `fixing-regressions-with-ci`

**Files:**
- Create: `.codex/skills/fixing-regressions-with-ci/SKILL.md`
- Create: `.codex/skills/fixing-regressions-with-ci/agents/openai.yaml`

**Interfaces:**
- Consumes: the baseline omissions from Task 2 and the repository contract in `docs/testing/README.md`
- Produces: an implicitly discoverable Skill named `fixing-regressions-with-ci`

- [ ] **Step 1: Initialize the Skill package**

Run:

```bash
python3 /home/hzcheng/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  fixing-regressions-with-ci \
  --path .codex/skills \
  --interface 'display_name=Fix Regressions With CI' \
  --interface 'short_description=Prove regressions in CI before fixing them' \
  --interface 'default_prompt=Use $fixing-regressions-with-ci to diagnose this regression, prove it with a CI-reachable failing test, and only then implement and verify the fix.'
```

Expected: a new Skill directory with `SKILL.md` and `agents/openai.yaml`.

- [ ] **Step 2: Replace `SKILL.md` with the minimal discipline contract**

Use `apply_patch` to make the file exactly:

```markdown
---
name: fixing-regressions-with-ci
description: Use when fixing a bug or functional regression in this repository, when a previously fixed behavior returns, or when investigating why CI failed to catch incorrect user-visible behavior.
---

# Fixing Regressions With CI

## Overview

Turn every confirmed regression into a CI-owned behavior before changing production code.

**Core rule:** no production fix before a CI-reachable focused test has failed for the expected reason.

**REQUIRED SUB-SKILLS:** Use `systematic-debugging`, `protecting-main-with-worktrees`, and `test-driven-development`. Before completion, use `review-fix-commit-loop` and `verification-before-completion`.

## Workflow

1. **Diagnose**
   - Reproduce the symptom and trace the root cause.
   - Define the user-visible expected behavior. Do not freeze accidental current behavior.
2. **Own the behavior**
   - Read `docs/testing/README.md`.
   - Select an existing behavior ID or add one to `docs/testing/behavior-contracts.json`.
   - Add the ID to a focused test at the lowest stable layer.
3. **Prove CI reachability**
   - Trace the test file through `package.json` to an existing required PR check.
   - A locally runnable orphan test is not CI coverage.
4. **Verify RED**
   - Run the focused test against the unfixed implementation.
   - Confirm it fails because of the reported regression, not setup, compilation, or an unrelated assertion.
   - If it passes, repair the test; do not touch production code.
5. **Fix minimally**
   - Change only enough production code to satisfy the behavior.
   - Keep unrelated refactors and features out of the fix.
6. **Verify GREEN**
   - Run the focused test, `npm run test:behavior-contracts`, the affected layered suite, and the relevant platform/environment gate.
   - Review the final diff and run the branch-level CI equivalent before push or PR.

## Automation Boundary

If stable PR automation is impossible, stop and explain why. Only after explicit user approval may the behavior be recorded as `scheduled` or `manual` with a reason and owner. Partial fake coverage must not be labeled as complete automation.

## Stop Conditions

| Rationalization | Required response |
|---|---|
| "The fix is obvious or tiny" | Add and observe the failing regression test first. |
| "A test exists locally" | Prove a required PR check reaches it. |
| "Tests can come after verification" | Stop; tests-after do not prove the regression was captured. |
| "A fake covers enough of a real environment" | Keep the real gap scheduled/manual unless the actual environment is exercised. |
| "The user wants an immediate patch" | Report the RED gate; urgency does not reverse the order. |

Production code changed before RED? Revert that task-local change and restart from the test.
```

- [ ] **Step 3: Verify generated UI metadata**

Make `.codex/skills/fixing-regressions-with-ci/agents/openai.yaml` exactly:

```yaml
interface:
  display_name: "Fix Regressions With CI"
  short_description: "Prove regressions in CI before fixing them"
  default_prompt: "Use $fixing-regressions-with-ci to diagnose this regression, prove it with a CI-reachable failing test, and only then implement and verify the fix."
```

- [ ] **Step 4: Run structural validation**

Run:

```bash
python3 /home/hzcheng/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .codex/skills/fixing-regressions-with-ci
wc -w .codex/skills/fixing-regressions-with-ci/SKILL.md
git diff --check
```

Expected: `Skill is valid!`, fewer than 500 words, and no whitespace errors.

- [ ] **Step 5: Re-run all three pressure scenarios with the Skill**

Dispatch three fresh read-only agents using the Task 2 prompts, prefixed with:

```text
Use $fixing-regressions-with-ci from /home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count/.codex/skills/fixing-regressions-with-ci/SKILL.md.
```

Expected:

```text
time pressure: behavior ID + CI reachability + observed RED precede production edits
orphan test: explicitly rejected as CI coverage
real environment gap: pauses for user approval and preserves scheduled/manual classification
```

If an agent finds a new loophole, add only the explicit counter needed for that observed rationalization and repeat the failed scenario until it passes.

- [ ] **Step 6: Commit the new Skill**

```bash
git add .codex/skills/fixing-regressions-with-ci
git diff --cached --check
git commit -m "chore: require CI-first regression fixes"
```

Expected: one commit containing `SKILL.md` and `agents/openai.yaml`.

---

### Task 4: Review and Repository Verification

**Files:**
- Verify: `.codex/skills/*/SKILL.md`
- Verify: `.codex/skills/*/agents/openai.yaml`
- Verify: `docs/superpowers/specs/2026-07-23-regression-fix-skill-design.md`
- Verify: `docs/superpowers/plans/2026-07-23-regression-fix-skill.md`

**Interfaces:**
- Consumes: all Skill and design commits from Tasks 1–3
- Produces: a reviewed, clean branch ready for a later PR

- [ ] **Step 1: Validate every tracked Skill**

Run:

```bash
for skill_dir in .codex/skills/*
do
  python3 /home/hzcheng/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
    "${skill_dir}"
done
```

Expected: five `Skill is valid!` results.

- [ ] **Step 2: Verify repository gates**

Run:

```bash
npm run test:behavior-contracts
npm run test:ci:linux
git diff --check origin/main...HEAD
```

Expected: both npm commands exit `0`; Git reports no whitespace errors.

- [ ] **Step 3: Review the complete branch**

Use `requesting-code-review` against:

```text
base: origin/main
head: HEAD
requirements: the approved regression-fix Skill design and byte-identical import of four existing Skills
```

Expected: no unresolved Critical or Important findings. Apply `review-fix-commit-loop` to any valid finding, then repeat the affected validation.

- [ ] **Step 4: Confirm branch scope**

Run:

```bash
git status -sb
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: clean worktree; only the design, plan, five Skill packages, and any review correction are present. Do not push or open a PR in this task.
