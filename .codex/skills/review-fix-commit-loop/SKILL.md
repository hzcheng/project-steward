---
name: review-fix-commit-loop
description: Use when this repository's code changes need review, requested fixes, fresh verification, and intentional follow-up commits before push, PR, or merge.
---

# Review Fix Commit Loop

## Overview

Turn review findings into focused fixes without losing traceability: inspect, fix Critical/Important findings, verify freshly, then commit only the intended files.

## Workflow

1. Establish scope:
   - `git status -sb`
   - `git diff --stat`
   - `git diff <base>..HEAD` for committed branch review

2. Request or perform review.
   - Use a read-only reviewer for substantial changes or before merge.
   - Give the reviewer base/head SHAs and concrete requirements.
   - Tell the reviewer not to mutate the checkout.

3. Triage findings by severity.
   - Critical: fix before continuing.
   - Important: fix before push/merge unless demonstrably invalid.
   - Minor: fix if cheap and low-risk; otherwise note as follow-up.
   - If a reviewer is wrong, explain with code or test evidence.

4. Patch narrowly.
   - Keep review fixes separate from unrelated refactors.
   - Add or tighten tests for every behavior bug found.
   - Preserve user changes in dirty worktrees.

5. Verify after fixes, not before only.
   - Run the smallest commands that prove the fix.
   - Also run the branch-level checks needed for the PR.
   - Include `git diff --check` when code or docs changed.

6. Commit intentionally.
   - Stage explicit paths.
   - Use a commit message that names the fixed issue, e.g. `fix: tighten open projects update consistency`.
   - Re-check `git status -sb`.

## Reporting

Summarize:
- reviewer Critical/Important findings
- what was fixed
- verification commands and outcomes
- commit hash or message
- any Minor items intentionally left for later

## Pitfalls

- Do not call a review complete until fresh verification has run after the final fix.
- Do not bury review fixes inside unrelated feature commits unless the user requested squashing.
- Do not trust subagent output blindly; inspect the actual diff and rerun evidence-producing commands.
