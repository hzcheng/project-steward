---
name: protecting-main-with-worktrees
description: Use when working in this repository and main/master is protected, must not be directly pushed, or feature work should happen in a local .worktree without touching user changes in the primary checkout.
---

# Protecting Main With Worktrees

## Overview

Keep this repository's protected branches and the user's primary checkout clean by doing feature work in an isolated git worktree under the project.

## Workflow

1. Inspect state before creating anything:
   - `git status -sb`
   - `git branch --show-current`
   - `git remote -v`
   - `git worktree list`
   - identify the intended repository remote and base branch from the user request, local tracking branch, or remote default

2. If the user asks for a worktree under the current project, place it under `.worktree/<topic>`.
   - Do not add `.worktree/` to tracked `.gitignore` unless the user explicitly wants a repo change.
   - Prefer local ignore: `printf '.worktree/\n' >> .git/info/exclude` if needed.

3. Create from the protected base:
   - `git fetch <remote> <base>`
   - `git worktree add -b <branch> .worktree/<topic> <remote>/<base>`
   - Use `origin/main` only after confirming that `origin` and `main` are the intended target.

4. Work only in the feature worktree.
   - Use `git -C .worktree/<topic> ...` or set `workdir` there.
   - Treat dirty files in the primary checkout as user changes. Do not revert them.
   - Stage explicit paths when the tree is mixed.

5. After merge, clean up intentionally:
   - Confirm the worktree is clean with `git -C .worktree/<topic> status -sb`.
   - `git worktree remove .worktree/<topic>`
   - `git worktree prune`
   - Re-run `git worktree list`.

## Guardrails

- Never push directly to `main`/`master` when the user said it is protected.
- Never repair the `.gitignore` mistake by committing ignore-only churn to protected main.
- Never assume `origin/main` when the repo also has `upstream` or the user named a different target.
- If a feature branch tracks a deleted remote after merge, that is expected; remove the worktree after checking it is clean.
- If a command accidentally affects the primary checkout, stop and inspect before continuing.
