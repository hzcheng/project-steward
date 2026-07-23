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
