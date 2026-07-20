# Project Steward 2.1.3 Release Design

Date: 2026-07-20

Status: Approved

## Goal

Publish the completed tmux session support as Project Steward `2.1.3` through the repository's protected-main and tag-triggered GitHub Release workflow.

## Release Scope

- Bump the main extension from `2.1.2` to `2.1.3` in `package.json` and `package-lock.json`.
- Keep the UI-only attention bridge at `0.1.3`; it has no versioned code change in this release.
- Move the current tmux entries from `Unreleased` to a dated `2.1.3` section and include the final execution-handoff and focused-window synchronization fixes.
- Publish a GitHub Release only. Do not publish either extension to VS Code Marketplace.

## Protected-Main Flow

1. Make and verify the version/changelog commit on `feat/session-tmux-support` in its existing worktree.
2. Push the feature branch to `origin` and create a ready-for-review PR targeting `hzcheng/project-steward:main`.
3. Confirm the PR base/head, mergeability, conversations, and required checks. The user has explicitly authorized merging this PR once those gates pass.
4. Merge with a merge commit and re-fetch `origin/main`; do not push commits directly to `main`.
5. Verify the PR is merged and resolve the exact `origin/main` merge commit.

## Tag and Automated Release

- Create an annotated `v2.1.3` tag, matching the repository's existing release-tag style, on the verified `origin/main` merge commit.
- Push only that tag after confirming `package.json` at the tagged commit is `2.1.3` and no remote `v2.1.3` tag or release exists.
- The tag triggers `.github/workflows/release-vsix.yml`, which verifies release notes and packaging, compiles and lints, packages the unchanged `0.1.3` bridge plus the `2.1.3` main extension, and creates GitHub Release `v2.1.3`.
- Monitor the workflow to completion and verify the release is non-draft/non-prerelease with both expected VSIX assets.

## Failure Boundaries

- Do not tag a feature-branch commit or an unverified local `main` commit.
- Do not create or move `v2.1.3` if the version, PR merge, or remote main commit is inconsistent.
- Do not publish to Marketplace.
- Treat GitHub transport errors as unknown outcomes and re-query PR, tag, workflow, and release state before retrying.
- If required checks fail, stop publication, diagnose the failure, and fix through the feature branch/PR rather than bypassing protected `main`.

## Verification

Before push, run the complete tmux/safety/smoke matrix, compile, production prepublish, release-note checks, release-packaging checks, and `git diff --check`.

After publication, verify:

- PR merged into `main` with a confirmed merge commit;
- `refs/tags/v2.1.3` peels to that merge commit;
- the Release VSIX workflow completed successfully;
- GitHub Release `v2.1.3` exists and is published;
- assets include `project-steward-2.1.3.vsix` and `project-steward-attention-ui-bridge-0.1.3.vsix`.
