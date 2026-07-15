# AI Session Attention Production Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship cross-window AI-session attention aggregation for local, SSH, WSL, and Dev Container Project Steward windows through a local UI-host companion extension.

**Architecture:** Project Steward remains the workspace-side owner and publishes bounded complete snapshots through private VS Code commands. A UI-only companion validates and atomically stores one leased snapshot per owner, aggregates all active owners in the local Profile, applies exact event acknowledgements, and routes the aggregate back to each originating window. Missing or incompatible bridges degrade to the existing window-local monitor.

**Tech Stack:** TypeScript 4, VS Code Extension API, Node.js filesystem APIs, webpack 5, `@vscode/vsce`, Node `assert` safety checks.

## Global Constraints

- Preserve `.vscode/settings.json`; never stage it.
- Keep the main extension usable when the bridge is missing or incompatible.
- Do not write prompts, responses, hostnames, remote authorities, or absolute paths.
- Use 10-second evaluation, 30-second quiet threshold, 30-second heartbeat, 90-second lease, two-second scan, 24-hour cleanup, and 256 KiB file limit.
- Validate all command and file payloads; ignore symlinks and non-regular files.
- Build two VSIX artifacts and install the UI bridge before the main extension.

---

### Task 1: Production protocol and aggregate

**Files:**
- Modify: `src/aiSessions/attentionPayload.ts`
- Create: `src/aiSessions/attentionAggregate.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `AttentionOwnerSnapshot`, `AttentionAggregate`, `validateAttentionOwnerSnapshot()`, `aggregateAttentionSnapshots()`.
- Consumes: `AttentionPayloadItem` and exact event IDs.

- [ ] Write failing checks for bounds, canonical sorting, semantic hashes, duplicate-session counts, leases, and exact acknowledgements.
- [ ] Run `npm run test:safety` and observe RED.
- [ ] Implement validators and pure aggregation.
- [ ] Run `npm run test:safety` and observe PASS.

### Task 2: UI bridge companion storage

**Files:**
- Create: `extensions/attention-ui-bridge/package.json`
- Create: `extensions/attention-ui-bridge/.vscodeignore`
- Create: `extensions/attention-ui-bridge/src/extension.ts`
- Create: `extensions/attention-ui-bridge/src/localAttentionStore.ts`
- Create: `extensions/attention-ui-bridge/webpack.config.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: owner snapshots from `_projectStewardAttention.bridge.publish`.
- Produces: `_projectStewardAttention.workspace.aggregate`, acknowledgement, handshake, and status commands.

- [ ] Add failing atomic-store tests for replacement, rollback, corruption, size, symlinks, lease expiry, and cleanup.
- [ ] Implement the UI-only extension and two-second scan/watcher fallback.
- [ ] Package the bridge VSIX and run store tests.

### Task 3: Workspace bridge client

**Files:**
- Create: `src/aiSessions/attentionBridgeClient.ts`
- Modify: `src/dashboard.ts`
- Modify: `package.json`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: monitor snapshots and project/session assignments.
- Produces: complete owner snapshots, heartbeat publications, aggregate callbacks, exact acknowledgements, and local-only degraded state.

- [ ] Add failing client tests for handshake, retry, heartbeat, semantic suppression, aggregate routing, and missing bridge.
- [ ] Implement the client and register reverse commands before handshake.
- [ ] Wire it into the independent 10-second monitor and click acknowledgement flow.
- [ ] Verify `npm run test:safety` and `npm run webpack`.

### Task 4: Aggregate-driven UI and configuration

**Files:**
- Create: `src/aiSessions/attentionViewState.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/aiSessions/types.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/styles.scss`
- Modify: `package.json`

**Interfaces:**
- Consumes: `AttentionAggregate`.
- Produces: repo counts, unread session event IDs, full-rerender recovery, and three-cycle animation decisions.

- [ ] Add failing tests for `data-id`, repo counts, session dots, active-terminal coexistence, and replay suppression.
- [ ] Implement aggregate view mapping and the `projectSteward.aiSessionAttention.enabled` setting.
- [ ] Build webview assets and run safety checks.

### Task 5: Packaging, installation, and final verification

**Files:**
- Create: `scripts/package-attention-extensions.js`
- Modify: `scripts/build-test-package-install.sh`
- Modify: `package.json`
- Modify: `.vscodeignore`
- Create: `extensions/attention-ui-bridge/README.md`

**Interfaces:**
- Produces: one UI Bridge VSIX, one Project Steward VSIX, and a single-command local installation flow.

- [ ] Add release packaging checks for dependency/version alignment and artifact names.
- [ ] Build both production VSIX files.
- [ ] Run `npm run test:safety`, `npm run webpack`, bridge tests, `git diff --check`, and VSIX content inspection.
- [ ] Self-review all changes, commit, and push while preserving `.vscode/settings.json`.
