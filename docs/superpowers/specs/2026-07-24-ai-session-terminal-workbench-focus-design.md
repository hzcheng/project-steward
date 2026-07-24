# AI Session Terminal Workbench Focus Design

Date: 2026-07-24

Status: Approved

## Goal

Make a click on an active or pending AI-session card finish in the VS Code Terminal work area that contains the selected runtime, rather than leaving keyboard focus in the Project Steward sidebar.

## Confirmed Problem

The reported Codex session `019f9178-8dce-79d1-8b5d-d19ffa92c3dd` has a valid durable runtime, a live tmux target, and an attached tmux client. The target window `ps-vscode-dashboard-0a5108ed:codex-快速修复-ac81bb8e` exists and can be selected, and no runtime-focus failure is logged.

The click path currently considers the operation successful after the runtime backend calls `Terminal.show()`. It then refreshes the AI-session projection, but it never explicitly transfers workbench focus from the sidebar Webview to the Terminal view. A successful tmux selection can therefore remain visually indistinguishable from a failed card click.

VS Code does not expose a reliable command for focusing an exact existing application window. This change consequently guarantees the supported local outcome: select the exact managed runtime, reveal its terminal, and focus the VS Code Terminal work area in the current window.

## Product Semantics

- A successful active-session click selects the exact validated runtime and then focuses the Terminal work area.
- A successful pending-session click follows the same rule.
- A successful explicit conflict selection follows the same rule.
- Missing, stale, cancelled, ambiguous, or failed selections do not move workbench focus.
- Runtime ownership, tmux target validation, conflict handling, detach behavior, and refresh behavior remain unchanged.
- The action does not claim to focus an exact external VS Code application window.

## Architecture

`AiSessionTerminalCommandController` owns the user transaction because it already distinguishes successful focus from all no-op and failure paths. Its options gain an injected asynchronous `focusTerminalView()` operation.

After the runtime coordinator reports success, the controller requests the existing incremental session refresh and then awaits `focusTerminalView()`. Dashboard composition implements the operation with the built-in `workbench.action.terminal.focus` command. Keeping this as an injected dependency makes the behavior deterministic in contract tests and avoids coupling the controller to the VS Code module.

The callback is invoked only after:

1. scoped workspace ownership succeeds;
2. the exact active or pending runtime is resolved;
3. tmux verification and selection, or Direct Terminal focus, succeeds;
4. an explicit conflict choice remains valid after refresh.

## Error Handling

Failure to focus the Terminal work area is part of the focus transaction. It follows the existing safe focus error path, logs only the existing operation category, shows the existing user-facing error, and refreshes the projection. It does not retry, select a fallback runtime, or expose tmux identifiers.

## Test Strategy

The existing `SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001` contract will assert:

- ordinary active focus orders runtime selection, incremental refresh, and Terminal workbench focus;
- invalid or foreign workspace requests do not focus the Terminal workbench;
- pending focus invokes the workbench focus only after runtime focus succeeds;
- explicit conflict selection invokes the workbench focus only after the selected runtime is still valid;
- runtime focus failures do not invoke the workbench focus.

The contract is reached by the required Linux check through:

`quality-linux` → `npm run test:ci:linux` → `npm run test:deterministic:run` → `tests/contract/aiSessions/sessionControllers.test.js`.

## Acceptance Criteria

- Clicking the reported healthy current-session card leaves keyboard focus in the Terminal work area.
- The exact tmux runtime is still validated and selected before any UI focus transfer.
- No unsupported exact-window focus relay is introduced.
- Focus failures and rejected requests do not move the user away from Project Steward.
- Focused contract, behavior catalog, deterministic suite, Linux CI-equivalent gate, packaging, and local installation verification pass.
