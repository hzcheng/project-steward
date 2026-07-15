# 双插件发布流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Project Steward release, local install, and Marketplace publish flows produce and handle both production extensions: `hzcheng.project-steward` and `hzcheng.project-steward-attention-ui-bridge`.

**Architecture:** Keep runtime as two extensions. Add a production packaging script that only emits the main VSIX and UI Bridge VSIX. Keep spike/probe packaging separate. Add static release packaging checks so future workflow or script drift is caught by tests.

**Tech Stack:** Bash, Node.js scripts, GitHub Actions YAML, `@vscode/vsce`, existing npm test scripts.

## Global Constraints

- Do not merge the main extension and UI Bridge extension.
- Do not include `project-steward-attention-workspace-probe` in production release or Marketplace flows.
- Marketplace publish order is UI Bridge first, main extension second.
- GitHub Release tag validation remains based on the main extension version, `v<mainVersion>`.
- Do not commit automatically.

---

### Task 1: Add Release Packaging Checks

**Files:**
- Create: `scripts/run-release-packaging-checks.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run test:release-packaging`
- Consumes: existing `package.json`, `extensions/attention-ui-bridge/package.json`, `.github/workflows/release-vsix.yml`, `scripts/build-test-package-install.sh`, `scripts/publish-marketplace.sh`

- [ ] Write `scripts/run-release-packaging-checks.js` with assertions for dependency ID, Bridge `extensionKind`, no hardcoded Bridge VSIX in install script, Marketplace bridge-first publish, GitHub Release two-asset packaging, and production packaging excluding workspace probe.
- [ ] Add `test:release-packaging` to `package.json`.
- [ ] Run `npm run test:release-packaging`.
- [ ] Confirm it fails against the current scripts because release workflow and publish script are still single-extension.

### Task 2: Add Production Release Packaging

**Files:**
- Create: `scripts/package-release-extensions.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run package:release`
- Produces: `artifacts/project-steward-<mainVersion>.vsix`
- Produces: `artifacts/project-steward-attention-ui-bridge-<bridgeVersion>.vsix`

- [ ] Implement `scripts/package-release-extensions.js` to read versions from both manifests and run `npx @vscode/vsce package` for Bridge and main extension.
- [ ] Ensure the script removes and recreates `artifacts/`.
- [ ] Ensure the script never packages `spikes/attention-local-bridge/workspace`.
- [ ] Add `package:release` to `package.json`.
- [ ] Keep `spike:attention:package` available for probe workflows.

### Task 3: Update Local Install and Marketplace Publish

**Files:**
- Modify: `scripts/build-test-package-install.sh`
- Modify: `scripts/publish-marketplace.sh`

**Interfaces:**
- Consumes: `npm run package:release`
- Produces: local install order Bridge VSIX then main VSIX
- Produces: Marketplace publish order Bridge then main

- [ ] Update local install to derive both VSIX paths from package metadata.
- [ ] Update local install to call `npm run package:release`.
- [ ] Update Marketplace publish dry run to build both VSIX files and print both extension IDs.
- [ ] Update Marketplace publish live mode to publish Bridge first and main second using `--packagePath`.
- [ ] Preserve `VERSION` and `BUMP` behavior for the main extension only.

### Task 4: Update GitHub Release Workflow

**Files:**
- Modify: `.github/workflows/release-vsix.yml`
- Modify: `scripts/run-release-notes-checks.js`

**Interfaces:**
- Consumes: `npm run package:release`
- Produces: GitHub Release with two VSIX assets

- [ ] Update workflow metadata step to expose main and Bridge VSIX filenames.
- [ ] Add release packaging check to the workflow.
- [ ] Replace single `vsce package` step with `npm run package:release`.
- [ ] Upload both VSIX files as workflow artifacts.
- [ ] Create GitHub Release with both VSIX files.
- [ ] Add a workflow summary listing both files and SHA-256 values.
- [ ] Update release notes checks to assert the workflow still extracts notes and now includes two assets.

### Task 5: Verify

**Files:**
- No new files expected.

**Interfaces:**
- Consumes: all changed scripts and workflow.

- [ ] Run `npm run test:release-packaging`.
- [ ] Run `npm run test:release-notes`.
- [ ] Run `npm run test:safety`.
- [ ] Run `npm run test:dashboard`.
- [ ] Run `npm run lint`.
- [ ] Run `DRY_RUN=1 SKIP_NPM_CI=1 npm run publish-marketplace`.
- [ ] Check `git diff --check`.
- [ ] Report changed files and remaining risks.
