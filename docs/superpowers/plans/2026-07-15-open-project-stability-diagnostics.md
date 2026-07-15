# OPEN PROJECT Stability Diagnostics and Incremental Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make disappearing live-project registrations diagnosable and stop normal OPEN PROJECT updates from rebuilding the entire dashboard.

**Architecture:** Workspace and UI Bridge emit bounded structured diagnostics at each protocol boundary. Bridge events are forwarded to the paired Workspace and persisted in a capped JSONL file. Aggregate changes are rendered as a host-generated OPEN PROJECT fragment delivered to the existing Webview, which replaces only its sticky group wrapper.

**Tech Stack:** TypeScript 4, VS Code Extension API, Node.js filesystem, Webview JavaScript, Node `assert` safety checks, Webpack, Gulp.

## Global Constraints

- Do not commit without explicit user approval.
- Do not modify or stage `.vscode/settings.json`, `docs/assets/`, or `docs/running-projects-tabs-prd.md`.
- Do not log AI session content, credentials, or unbounded payloads.
- Healthy repeated scans are suppressed except for one snapshot every 30 seconds.
- Full Webview HTML refresh is recovery-only for OPEN PROJECT aggregate changes.

---

### Task 1: Add Observable Coordinator Diagnostics

**Files:**
- Modify: `extensions/attention-ui-bridge/src/openProjectCoordinator.ts`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces: `OpenProjectDiagnosticEvent` callback events for publish, renew, unregister, scan, deliver, and error.

- [x] Add failing coordinator checks asserting membership changes, non-zero counters, and timer/watcher errors are reported.
- [x] Run `npm run test:open-projects`; expect the diagnostic checks to fail because no callback exists.
- [x] Add a bounded diagnostic callback to coordinator dependencies and a Bridge output channel; replace swallowed catches with error events.
- [x] Run `npm run test:open-projects`; expect all checks to pass.

### Task 2: Add Workspace Boundary Diagnostics

**Files:**
- Modify: `src/openProjects/bridgeClient.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces: structured activation, publication, failure, aggregate, and render-delivery log lines in `Project Steward` output.

- [x] Add failing bridge-client checks for publish results and aggregate registration summaries.
- [x] Run `npm run test:open-projects`; expect failure because diagnostics are absent.
- [x] Add bounded diagnostic callbacks, forward Bridge events to Workspace, and persist a capped JSONL log.
- [x] Run `npm run test:open-projects`; expect all checks to pass.

### Task 3: Render OPEN PROJECT Incrementally

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Generate: `media/webviewProjectScripts.js`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces: `getOpenProjectsGroupContent(...)`, `open-projects-updated`, and `open-projects-rendered`.

- [x] Add failing source/behavior checks proving aggregate callbacks do not call `refreshStewardViews()` and the Webview replaces only `.sticky-groups-wrapper`.
- [x] Run `npm run test:open-projects`; expect failure on the current full-refresh callback.
- [x] Export the group-fragment renderer, keep the sticky wrapper mounted, post the fragment from `dashboard.ts`, and reconcile it in the Webview.
- [x] Copy Webview assets with `npx gulp copyWebviewAssets`.
- [x] Run `npm run test:open-projects`; expect all checks to pass.

### Task 4: Verify and Package

**Files:**
- Verify all scoped source and generated files.
- Produce: `artifacts/project-steward-1.1.8.vsix`
- Produce: `artifacts/project-steward-attention-ui-bridge-0.1.1.vsix`

- [x] Run `npm run test:safety`, `npm run lint`, `npm run webpack`, and `npm run attention:bridge:bundle`.
- [x] Run `git diff --check` and review the scoped diff for lifecycle and logging leaks.
- [x] Package both VSIX artifacts and record SHA-256 hashes.
- [x] Install the main VSIX in the current Docker; leave the Mac UI Bridge installation to the user.

No commit step is included because review approval is required first.

### Task 5: Keep Lease Renewal Independent From Aggregate Delivery

**Files:**
- Modify: `extensions/attention-ui-bridge/src/openProjectCoordinator.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

- [x] Capture the runtime transition where an inactive window's 30-second lease
  expires without `dispose` or `unregister`.
- [x] Add a failing regression test with permanently stalled aggregate delivery.
- [x] Release the mutation queue before scanning/delivering so later interval
  renewals can still write the local registration.
- [x] Run `npm run test:open-projects`; expect all checks to pass.
- [x] Run the full verification suite and repackage the UI Bridge VSIX.
