# Explicit Session Close Attention Acknowledgement

## Problem

An active AI session can show a red attention dot after completing work. Clicking the session card acknowledges that event, but clicking the row's Close Terminal or Detach Terminal action currently bypasses the acknowledgement path. The terminal is closed or detached while the red dot remains.

## Accepted behavior

- A user-initiated Close Terminal or Detach Terminal action on a final session acknowledges every attention event currently represented by that session row.
- The acknowledgement is initiated before the close or detach command so the explicit user action is not lost if terminal disposal changes the visible runtime state.
- Pending sessions have no final session attention identity and are not acknowledged by this behavior.
- Terminal processes that exit, crash, disconnect, or are closed outside the session-card action do not acknowledge attention. Their red dot remains until the user explicitly interacts with the session.

## Design

Reuse the webview's existing `acknowledgeAiSessionRow` path, which is already used by primary session activation and archive actions. When the Close/Detach control resolves a final session row, the webview first posts the row's current attention event IDs and then posts the existing close/detach message. The extension-host terminal-close event remains non-acknowledging.

No attention protocol, persistence schema, card markup, or visual styling changes are required.

## Verification

- A final session row with attention posts acknowledgement before Close Terminal.
- A final tmux session row with attention posts acknowledgement before Detach Terminal.
- A pending row still posts only its close/detach request.
- Closing a terminal through the VS Code terminal lifecycle continues not to acknowledge attention.
- Existing session activation, archive, attention retention, and tmux safety checks remain green.
