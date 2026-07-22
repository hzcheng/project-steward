# Workspace Parity Verification Report

## Scope

This verification covers the Workspace parity recovery defined by:

- docs/superpowers/specs/2026-07-22-workspace-parity-attention-promotion-design.md
- docs/superpowers/plans/2026-07-22-workspace-parity-attention-promotion.md

The production changes restore root-aware Session attention projection,
attention-only OTHER WINDOWS refreshes, canonical attention root identities,
and workspace-native pending Session promotion. No card styles or UI Bridge
protocol fields changed.

## Commits

- 587b417 — deterministic tmux cross-host test ordering
- 7b0970c — Workspace Session attention projection
- f02a330 — attention-only OTHER WINDOWS refresh and canonical root identity
- aa2b38c — workspace pending Session promotion
- 52e44f1 — Workspace parity lifecycle and production-wiring gate
- 2668127 — source-format review fix

## Review

The committed diff from 79cbe4b through 2668127 was reviewed for:

- unintended Project compatibility restoration;
- automatic acknowledgement outside Session clicks;
- workspace/root identity leakage;
- duplicate or non-retryable pending promotion;
- changes to card markup, SCSS/CSS, or UI Bridge source;
- production modules that could become test-only.

Critical findings: none.

Important findings: none.

Minor finding fixed: the new promotion controller had one extra blank line at
EOF. Commit 2668127 removed it, followed by fresh compile and Workspace parity
verification.

## Automated Verification

All commands were run from the feat/workspace-support worktree on 2026-07-22.

| Command | Result |
| --- | --- |
| npm run test:workspace-parity | PASS — single-folder, saved multi-root, and untitled multi-root lifecycle checks |
| npm run test:safety | PASS — Workspace parity, tmux, AI Session, and open-workspace safety checks |
| npm run test:dashboard | PASS — Dashboard Webview checks |
| npm run test:tmux:smoke | PASS — tmux smoke checks |
| npm run test:release-packaging | PASS — release compilation, bundles, VSIX contents, and stale-output protection |
| git diff --check | PASS |

The dedicated parity suite covers:

- pending to promoted to running to needsAttention to acknowledged;
- alias persistence, active-runtime synchronization, execution evaluation, and
  incremental refresh after promotion;
- failed promotion retry and concurrent hydration deduplication;
- workspace-scope isolation;
- logical and run-scoped attention keys;
- canonical root identity and same-Session-ID root isolation;
- attention-only OTHER WINDOWS semantic revisions;
- attention persistence through collapse/refresh;
- synchronized CURRENT/OTHER clearing after explicit acknowledgement state;
- production imports/calls for attention, promotion, and open-workspace refresh;
- continued direct OTHER WINDOWS navigation without acknowledgement.

## Package and Installation

Main artifact:

- Path: artifacts/project-steward-2.1.3.vsix
- Size: 223.77 KB packaged output (224 KB filesystem display)
- SHA-256: e2b065b5e4d63caa63f3630dc6ed16b2ea1a269f3f75b89863bd02b632345a0e

The main VSIX was installed with the pinned Dev Container code-server binary
using an absolute artifact path. Installation output:

~~~text
Extension 'project-steward-2.1.3.vsix' was successfully installed.
~~~

Installed extension versions after installation:

~~~text
hzcheng.project-steward@2.1.3
hzcheng.project-steward-attention-ui-bridge@0.1.3
~~~

The release packaging command also generated an attention UI Bridge 0.1.4
artifact from the repository's existing package metadata. It was not installed.
The user's existing UI Bridge 0.1.3 installation was not overwritten.

## Manual Two-Window Matrix

These rows remain for user verification after reloading the Dev Container
window. The completion indicator must remain until the corresponding Session
row is clicked. Clicking an OTHER WINDOWS workspace card must navigate directly
and must not acknowledge.

| Backend | Workspace shape | Running animation | Completion red dot | Persists until Session click | CURRENT/OTHER clear together |
| --- | --- | --- | --- | --- | --- |
| VS Code Terminal | single folder | [ ] | [ ] | [ ] | [ ] |
| VS Code Terminal | saved multi-root | [ ] | [ ] | [ ] | [ ] |
| VS Code Terminal | untitled multi-root | [ ] | [ ] | [ ] | [ ] |
| tmux | single folder | [ ] | [ ] | [ ] | [ ] |
| tmux | saved multi-root | [ ] | [ ] | [ ] | [ ] |
| tmux | untitled multi-root | [ ] | [ ] | [ ] | [ ] |

Additional checks:

- [ ] OTHER WINDOWS card click jumps directly to the target window.
- [ ] OTHER WINDOWS card click does not clear its attention indicator.
- [ ] Refresh, tab switching, and CURRENT WORKSPACE collapse do not clear the
  indicator.
- [ ] Clicking the matching Session clears the indicator in CURRENT WORKSPACE
  and OTHER WINDOWS after aggregate synchronization.
