# Active AI Session Terminal Highlight Design

## Problem

Project Steward can already associate Codex, Kimi, and Claude sessions with
integrated terminals. The session list does not show which visible session is
currently running in the VS Code terminal that has focus, so users must compare
terminal titles or session IDs manually.

## Goal

Highlight the visible AI session row that corresponds to the currently active
VS Code integrated terminal, but only while that terminal's AI session command
is still running.

## Scope

Included:

- Codex, Kimi, and Claude sessions managed by the existing terminal service;
- exactly one highlighted session, matching `vscode.window.activeTerminal`;
- immediate updates when the active terminal changes or closes;
- removal of the highlight when the existing completion marker appears;
- recovery after full Webview rendering and incremental session updates;
- delayed binding for newly created sessions whose ID is discovered after the
  terminal starts.

Excluded:

- highlighting every open or running AI terminal;
- persisting the highlighted session;
- automatically expanding a project;
- automatically switching the selected AI provider;
- parsing terminal output or shell prompts;
- changing the existing session resume or terminal reuse behavior.

## Source of Truth

The feature does not introduce a second terminal lifecycle model. It reuses:

- `AiSessionTerminalService` for the session-to-terminal association;
- `vscode.window.activeTerminal` and `onDidChangeActiveTerminal` for focus;
- the existing `.done` marker and `AiSessionTerminalService.isComplete()` for
  command completion;
- `onDidCloseTerminal` and the existing terminal cleanup path for closure.

A session is highlighted only when all of the following are true:

1. the active VS Code terminal can be resolved to a provider and session ID;
2. the terminal is still associated with that session;
3. the associated entry's completion marker does not exist;
4. the matching project, provider, and session row are currently visible.

If the command has exited but its terminal tab remains open and focused, the
marker exists and the session is not highlighted.

## Terminal Resolution

`AiSessionTerminalService` gains a reverse-resolution operation that returns a
provider, session ID, and tracked terminal entry for a terminal.

Resolution follows existing matching behavior rather than creating new naming
rules:

1. Search the in-memory provider/session maps for the same terminal object.
2. If it is not already tracked, inspect provider-specific session environment
   variables created for resumed terminals.
3. When necessary, compare the terminal name with current session candidates
   using the existing provider prefix and short-session-ID convention.
4. Cache a successfully recovered association in the existing tracking map.

New-session terminals initially have no session ID. They remain unhighlighted
until the existing pending-terminal reconciliation discovers the new session
and calls `track()`; the highlight is then synchronized again.

## Extension Host Lifecycle

The extension host owns a single transient active-highlight state and at most
one completion timer.

It recalculates that state when:

- `onDidChangeActiveTerminal` fires;
- `onDidCloseTerminal` fires;
- a session is tracked after resume;
- a pending new-session terminal is matched to a session;
- the Webview requests its initial active-terminal state;
- the Sidebar becomes visible again.

When the active terminal resolves to a running AI session, the host sends an
`active-ai-session-terminal-changed` message containing its provider and
session ID, then starts a one-second completion check. Each check verifies that
the same terminal is still active and that its marker is still absent.

When the terminal changes, closes, becomes unresolvable, or its marker appears,
the host sends the same message with no active session and stops the timer.
Starting a new check always disposes the previous one, so no more than one timer
can exist.

The completion check runs only while the Sidebar is visible and the active
terminal represents a running AI session. When the Sidebar is hidden, the host
stops the check. The Webview requests a fresh state when it is rendered again.

## Webview Protocol and State

The Webview sends a `request-active-ai-session-terminal` message after its
event listeners are installed. This handshake prevents the initial state from
being lost while full Webview HTML is loading.

The host responds with:

```text
active-ai-session-terminal-changed
{
  provider: "codex" | "kimi" | "claude" | null,
  sessionId: string | null
}
```

The Webview stores this value as transient in-memory state. It applies a
`data-ai-session-active-terminal` attribute only to the visible row whose
`data-session-provider` and `data-session-id` both match.

The same DOM synchronization runs:

- when an active-terminal message arrives;
- after an `ai-sessions-updated` message replaces session markup;
- after provider changes render a different session list.

The Webview never changes the selected provider or project expansion state in
response to this feature. If the matching row is not visible, no row is
highlighted; the transient identity remains available so a later matching DOM
update can apply it.

## Visual Design

The active row uses a left-side VS Code focus-color accent and a subtle
theme-derived background. It does not animate.

The style must remain distinguishable but compatible with:

- normal row hover;
- pinned rows;
- batch-management checkboxes;
- batch-selected row backgrounds;
- light, dark, and high-contrast VS Code themes.

Batch selection remains the stronger full-row state. The active-terminal accent
continues to appear at the left edge when the same row is batch-selected.

## Error Handling

- An ordinary or unrecognized terminal produces a cleared highlight.
- A stale tracked entry whose terminal has closed is removed by the existing
  close handler and cannot remain highlighted.
- A marker read failure is treated conservatively as the current result of the
  existing `isComplete()` behavior; the next one-second check retries.
- Failure to post a Webview message is logged through the existing output
  channel and does not affect terminal operation.
- Invalid Webview requests contain no trusted state and only trigger a fresh
  host-side calculation.

## Testing

Regression coverage must verify:

- reverse lookup resolves each provider from an already tracked terminal;
- reverse lookup can recover supported existing terminals using current
  environment/name matching rules;
- ordinary terminals do not resolve;
- changing from one running AI terminal to another changes the active identity;
- changing to an ordinary terminal clears the identity;
- closing the active terminal clears the identity and tracking;
- an absent marker permits highlighting and a present marker clears it;
- only one completion timer is active and every exit path stops it;
- pending new-session reconciliation triggers a new active-state calculation;
- full Webview initialization requests the current state;
- incremental HTML replacement reapplies the highlight;
- hidden providers and collapsed projects are not automatically revealed;
- active-terminal styling coexists with batch selection;
- source and generated Webview assets remain identical.

Repository verification includes:

```bash
npm run test:safety
npm run lint
npx gulp buildStyles copyWebviewAssets
npm run webpack
git diff --check
```

## Acceptance Criteria

- At most one session row is highlighted.
- The highlighted row corresponds to the currently focused VS Code terminal.
- The row is highlighted only while the associated AI session command is
  running according to the existing completion marker.
- Switching or closing the terminal removes the previous highlight promptly.
- Session completion removes the highlight within approximately one second.
- No provider switch or project expansion occurs automatically.
- Existing terminal reuse, resume, archive, and batch-management behavior is
  unchanged.
