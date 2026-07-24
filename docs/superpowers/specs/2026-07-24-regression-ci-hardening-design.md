# Regression CI Hardening Design

## Goal

Prevent the recently fixed TODO layout, AI-session card activation, and CI-coverage ownership behaviors from silently regressing while required pull-request checks remain green.

## Scope

The change adds three protections:

1. A Chromium layout test renders the production TODO markup, compiled CSS, and production TODO controller. It verifies that a long expanded card owns its complete rendered height, grows the configured group viewport, stays reachable without overlap, and returns to the configured collapsed viewport after closing.
2. A focused AI-session card activation behavior contract covers active, inactive, pending, and nested interactive targets. It replaces reliance on an assertion buried only in the legacy safety script.
3. The main-capability audit rejects non-documentation implementation commits after its recorded audit head. A documentation-only audit-maintenance commit may remain after the head so the manifest can record the preceding implementation commit without an impossible self-reference.

## CI Reachability

- Browser layout and focused Webview interaction tests run from `test:ci:linux`, which is owned by the required `quality-linux` job.
- Capability audit freshness runs from `test:behavior-contracts` inside `test:ci:linux`.
- Existing Windows and real-tmux jobs remain unchanged.

## Browser Boundary

Use `playwright-chromium` so the test controls a known Chromium build instead of depending on an unversioned system browser. The fixture uses `getTodoPanelContent`, `media/styles.css`, and `src/webview/webviewTodoScripts.js`; it mocks only `vscode.postMessage`. Assertions use browser-computed geometry and DOM identity, not synthetic `scrollHeight` values.

The browser test is a component-level Webview test, not a claim that a real VS Code Webview loaded successfully. The current Extension Host API test cannot observe Webview DOM readiness, so that real-environment gap remains scheduled/manual until a reliable UI-driver boundary exists.

## AI Session Activation Boundary

Extract the decision that maps a click target and session row to a host message into a small browser-compatible function in the existing Webview script. The production click handler and the focused Node test call the same function. Interactive controls other than the primary session action return no activation message.

## Capability Audit Freshness

`check-behavior-contracts.js` collects both the recorded audited range and the tail from the recorded head to `HEAD`. Validation rejects any tail commit that changes non-documentation paths. This forces every implementation batch to advance and assign the audit before merge while allowing the final manifest-only commit.

## Non-goals

- No visual snapshot or pixel-perfect theme testing.
- No fake claim that multi-window focus, sleep/disconnect, or remote lifecycle is automated.
- No production behavior change beyond extracting the existing session-card message decision.
