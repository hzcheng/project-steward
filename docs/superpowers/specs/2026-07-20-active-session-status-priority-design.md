# Active Session Status Priority Design

## Goal

Make the Active Session card's second line prioritize execution state and avoid duplicating the attention indicator in text.

## Current Behavior and Root Cause

An Active Session with unread attention renders both a red attention dot and the text `Needs attention`. The metadata builder also places stale/runtime status before execution state, so `Running`, `Stopped`, or `Starting` can be pushed out of view on narrow cards.

The attention state itself is correct. The duplication and ordering come from `getActiveAiSessionRow` composing metadata as stale status, runtime status, execution status, time, and short Session ID.

## Display Rules

- Keep the red attention dot as the sole visible attention indicator.
- Keep the dot's tooltip and accessible label `AI session needs attention`.
- Never render the visible text `Needs attention` on an Active Session card.
- Always place `Running`, `Stopped`, or `Starting` first on the second line.
- Preserve `stale` and `Runtime conflict` diagnostics after the execution state.
- Preserve the existing timestamp and short Session ID after diagnostic metadata.
- Do not change attention acknowledgement, runtime state, focus, tmux, or VS Code terminal behavior.

The resulting metadata order is:

```text
Execution state · stale · Runtime conflict · timestamp · short Session ID
```

Only populated fields are included, so ordinary rows remain compact, for example:

```text
Stopped · 2 minutes ago · #abc12345
```

## Implementation Boundary

Update only the Active Session row renderer in `src/webview/webviewContent.ts` and its existing safety checks in `scripts/run-ai-session-safety-checks.js`. No view-model or attention lifecycle change is required because the renderer already receives separate `executionState` and `needsAttention` values.

## Verification

Regression checks will verify that:

- all Active Session metadata lines begin with their execution state;
- an attention row still renders the red dot and its accessible description;
- Active Session metadata never contains `Needs attention`;
- `Runtime conflict` and `stale` remain available after execution state;
- existing safety and Dashboard test suites continue to pass.
