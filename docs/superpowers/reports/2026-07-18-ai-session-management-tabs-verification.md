# AI Session Management Tabs Verification Report

**Date:** 2026-07-18  
**Implementation commit:** `612c540`  
**Specification:** `docs/superpowers/specs/2026-07-18-ai-session-management-tabs-design.md`  
**Implementation plan:** `docs/superpowers/plans/2026-07-18-ai-session-management-tabs.md`

## Automated verification

The following commands were run from the feature worktree after the final runtime fixes:

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run test:safety` | PASS | TypeScript and attention bridge compiled; AI Session and Open Project safety checks passed. |
| `npm run test:dashboard` | PASS | Dashboard Webview checks passed. |
| `npm run test:open-projects` | PASS | TypeScript and attention bridge compiled; Open Project safety checks passed. |
| `npm run test:architecture-baseline` | PASS | Architecture baseline completed with the three registered providers and no threshold failure. |
| `npm run lint` | PASS with existing warnings | TSLint exited 0; it reported the repository's pre-existing warning set. |
| `npm run vscode:prepublish` | PASS | Production Webpack and Gulp builds completed successfully. |
| `git diff --check` | PASS | No whitespace errors. |
| Webview source/media `cmp` checks | PASS | Project and Dashboard generated JavaScript match their source copies. |

## PRD acceptance audit

| # | Requirement | Result | Automated or source evidence |
| --- | --- | --- | --- |
| 1 | Project card shows shared `ACTIVE / SESSIONS` tabs and `NEW`. | PASS | Webview rendering and Dashboard VM checks. |
| 2 | `ACTIVE` aggregates live Codex, Kimi, and Claude Sessions. | PASS | Active projection multi-provider fixtures. |
| 3 | `SESSIONS` retains provider history, including Active Sessions. | PASS | Projection preserves history and renderer checks retain provider lists. |
| 4 | A Session has consistent identity and state in both tabs. | PASS | Provider/session identity projection and active-history rendering checks. |
| 5 | Clicking an Active Session focuses its Terminal without duplication. | PASS | Terminal command and resume controller checks. |
| 6 | Resuming inactive history enters `ACTIVE`. | PASS | Success and failure controller checks prove the tab changes only after a successful resume. |
| 7 | Adaptive first default is `ACTIVE` when non-empty, otherwise `SESSIONS`. | PASS | View-model projection checks. |
| 8 | A manual tab choice is not stolen by later state changes. | PASS | Per-project Webview-state reconciliation checks. |
| 9 | `NEW` explicitly asks for Codex, Kimi, or Claude each time. | PASS | Provider availability and creation controller picker checks. |
| 10 | `Starting` upgrades in place without a duplicate row. | PASS | Pending-terminal ownership and projection checks. |
| 11 | Active Sessions cannot be archived or batch-selected. | PASS | Webview action and batch-guard checks. |
| 12 | Closing a Terminal requires confirmation and preserves history. | PASS | Terminal close controller checks; the action changes runtime ownership only. |
| 13 | Reload restores Terminal bindings before projecting the default tab. | PASS | Binding-store restoration and Dashboard startup-order checks. |
| 14 | Project summary distinguishes total, Active, and attention counts. | PASS | Summary/view-model rendering checks. |
| 15 | Search routes Active entries to focus and inactive entries to resume. | PASS | Search catalog and resume/focus routing checks. |
| 16 | Local and Remote extension hosts use the same path semantics. | PASS (automated) | Comparable-cwd normalization, persisted cwd, and extension-host-local Terminal tests. |
| 17 | Tabs retain independent scroll; refresh preserves provider, Manage, and expansion state. | PASS | Hidden-panel scroll restoration and incremental reconciliation tests. |
| 18 | Narrow widths, keyboard, screen-reader, high-contrast, and reduced-motion support. | PARTIAL | ARIA, keyboard context-menu, theme-token, responsive, and reduced-motion source checks pass; live visual inspection remains pending. |
| 19 | Existing Session actions and attention behavior do not regress. | PASS | AI Session safety regression suite. |
| 20 | Session updates render incrementally without rebuilding the Dashboard. | PASS | Incremental payload and catalog-preservation checks. |

## Extension package and installation

- `artifacts/project-steward-2.1.0.vsix` and `artifacts/project-steward-attention-ui-bridge-0.1.2.vsix` were rebuilt successfully.
- The main VSIX was installed successfully with the active VS Code Server's `code-server --install-extension` command.
- SHA-256 for the worktree and installed `dist/dashboard.js` matched after installation: `66f5287033cbab1dbbe86fc1eb13f450497ba8b90ce656df348b1ad1d23be633`.
- The user subsequently reloaded the VS Code windows. New Remote Extension Hosts started at 10:58 and 10:59 and both activated `hzcheng.project-steward` through `onView:projectSteward.steward`.
- The new Project Steward instances hydrated Codex, Kimi, and Claude history for one-project and three-project workspaces, delivered incremental Webview updates, and exchanged navigation-only cross-window registrations. No Project Steward runtime error was logged.
- VS Code itself logged stale workspace-lock and empty-JSON errors before extension activation. The same hosts recovered their locks, activated Project Steward, and continued normal hydration and heartbeat processing, so these startup messages are recorded as environment noise rather than a feature failure.

## Extension Development Host interaction matrix

The table distinguishes deterministic automated coverage from live UI inspection. The live column is not marked PASS unless the freshly installed extension was loaded into a new/reloaded host and observed directly.

| # | Interaction | Automated evidence | Fresh-host live result |
| --- | --- | --- | --- |
| 1 | No Active Session defaults to `SESSIONS`. | PASS | NOT OBSERVED — requires a project with no Active Session. |
| 2 | Active Sessions default to `ACTIVE` only before a manual choice. | PASS | NOT OBSERVED — client-side selected tab is not present in server logs. |
| 3 | Codex, Kimi, and Claude Active rows appear together. | PASS | NOT OBSERVED — history for all providers loaded, but live rows require terminals for each provider. |
| 4 | Active history rows remain listed and focus without duplication. | PASS | NOT OBSERVED — requires client interaction. |
| 5 | `NEW` always opens provider selection, then optional title. | PASS | NOT OBSERVED — requires client interaction. |
| 6 | `Starting` upgrades without duplication. | PASS | NOT OBSERVED — requires creating a live Session. |
| 7 | Close confirmation cancels safely and closes only after confirmation. | PASS | NOT OBSERVED — requires client interaction with a disposable Terminal. |
| 8 | Active Archive and batch selection are unavailable. | PASS | NOT OBSERVED — requires client inspection. |
| 9 | Reload restores Terminal ownership before default-tab selection. | PASS | PARTIAL — fresh-host activation and hydration observed; selected-tab pixels were not observable from the server. |
| 10 | 260px/400px, keyboard-only, high contrast, and reduced motion are usable. | PARTIAL | NOT OBSERVED — visual and assistive-technology inspection required. |
| 11 | `OTHER WINDOWS` exposes no Session details. | PASS | PARTIAL — two live registrations and navigation-card delivery observed; client pixels were not observable from the server. |

## Remaining manual gate

The final build is now loaded and producing normal runtime logs. Execute the remaining client-side interactions in the matrix above. In particular, acceptance criterion 18 is not considered fully verified until the width, theme, keyboard, and reduced-motion cases have been observed in the real Webview.
