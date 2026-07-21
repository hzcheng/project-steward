# Unified OPEN and PROJECTS Card Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OPEN, OTHER WINDOWS, and PROJECTS cards share the same card shell and Saved Project color accents.

**Architecture:** Resolve workspace colors locally from Saved Projects and attach the optional color to workspace card view models; do not change the bridge protocol. Render Project and workspace cards through the same color-style helper and shared shell CSS, while preserving separate action/content renderers.

**Tech Stack:** TypeScript, VS Code extension API, SCSS/CSS, server-rendered webview HTML, Node assertion safety suites.

## Global Constraints

- Saved current and OTHER WINDOWS workspaces reuse the matching Project color.
- Unmatched or unsaved workspaces use a transparent accent and aura, never foreground white.
- Current workspace has no permanent selected/focus shell.
- Workspace session expansion, save action, navigation, narrow-sidebar behavior, and bridge protocol remain unchanged.

---

### Task 1: Propagate Saved Project Colors to Workspace Cards

**Files:**
- Modify: `src/models.ts`
- Modify: `src/openWorkspaces/dashboardController.ts`
- Modify: `src/dashboard.ts`
- Test: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Consumes: `getWorkspaceProjectColor(workspace: { navigationUri: string; kind: OpenWorkspaceKind }): string`.
- Produces: optional `WorkspaceCardViewModel.color` on current and navigation cards.

- [x] **Step 1: Write failing color projection tests**

Create current and OTHER WINDOWS fixtures whose navigation URIs resolve to distinct colors. Assert both card view models contain those colors and an unmatched workspace contains an empty color. Assert local resolution receives navigation metadata only and protocol records remain unchanged.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm run test-compile && node scripts/run-open-project-safety-checks.js`

Expected: FAIL because `WorkspaceCardViewModel` and the dashboard controller do not expose workspace colors.

- [x] **Step 3: Implement local color resolution**

Add `color?: string` to `WorkspaceCardViewModel`, require `getWorkspaceProjectColor` in controller options, set it for the current card, and apply it to navigation projections. In `dashboard.ts`, widen the saved-project lookup input to the navigation fields it uses and inject a resolver returning `matchedProject?.color || ''`.

- [x] **Step 4: Run focused checks and verify GREEN**

Run: `npm run test-compile && node scripts/run-open-project-safety-checks.js`

Expected: PASS with current and navigation color assertions satisfied.

### Task 2: Share Project Card Color and Shell Styling

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `media/styles.scss`
- Modify: `media/styles.css`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: optional Project or workspace card color.
- Produces: one sanitized color-style result containing `cardStyle` (`--project-color`) and `accentStyle` (`background`) for both renderers.

- [x] **Step 1: Write failing renderer and CSS tests**

Assert a colored current card and colored OTHER WINDOWS card render the same `--project-color` and accent background format as a Project card. Assert an unmatched workspace has no color style, the shared accent fallback is transparent, and current workspace is absent from permanent selected-shell selectors.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm run test-compile && node scripts/run-dashboard-webview-checks.js`

Expected: FAIL because workspace markup drops color and SCSS uses `currentColor` for the accent glow and selected-shell rules for current workspace.

- [x] **Step 3: Implement the shared shell contract**

Extract a sanitizing helper from `getProjectDiv`, use it in both Project and workspace renderers, set workspace card and accent styles, change shared accent background/glow fallbacks to transparent, and restrict permanent selected-shell rules to `.selected` Project cards only. Preserve current-workspace height/session rules.

- [x] **Step 4: Rebuild styles and verify GREEN**

Run: `npm run test-compile && npx gulp --production && node scripts/run-dashboard-webview-checks.js && node scripts/run-open-project-safety-checks.js`

Expected: both suites PASS and generated `media/styles.css` matches SCSS.

### Task 3: Verify, Package, Install, and Commit

**Files:**
- Modify: `docs/superpowers/plans/2026-07-21-unified-open-project-card-style.md`

**Interfaces:**
- Consumes: completed color propagation and shared shell work.
- Produces: verified and installed Dev Container main extension; UI bridge remains untouched.

- [x] **Step 1: Run full verification**

Run: `npm run lint && npm run test:safety && npm run test:dashboard && npm run test:architecture-baseline && npm run test:release-notes && git diff --check`

Expected: all commands exit 0; lint may retain repository baseline warnings.

- [x] **Step 2: Package and check archives**

Run: `npm run package:release && node scripts/run-release-packaging-checks.js`

Expected: `artifacts/project-steward-2.1.3.vsix` and bridge `0.1.4` package successfully; archive checks PASS.

- [x] **Step 3: Install only the main extension**

Run the pinned Dev Container `code-server --install-extension artifacts/project-steward-2.1.3.vsix --force`, verify `hzcheng.project-steward@2.1.3`, and compare the packaged and installed `dist/dashboard.js` SHA-256 hashes. Do not install or overwrite the UI bridge.

- [x] **Step 4: Commit**

Run: `git add docs/superpowers/plans/2026-07-21-unified-open-project-card-style.md src/models.ts src/openWorkspaces/dashboardController.ts src/dashboard.ts src/webview/webviewContent.ts media/styles.scss media/styles.css scripts/run-ai-session-safety-checks.js scripts/run-open-project-safety-checks.js scripts/run-dashboard-webview-checks.js && git commit -m "fix: unify workspace and project card styling"`

Expected: the feature branch is clean with the tested UI/style changes committed.
