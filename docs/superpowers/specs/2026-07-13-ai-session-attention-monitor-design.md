# AI Session Attention Monitor Design

## Problem

A user working across multiple VS Code windows on the same machine has no way
to know when an AI session in another window has stopped producing output and is
waiting for their input. They must manually switch windows and scan session rows
to detect this state, which defeats the purpose of running sessions in parallel.

## Goal

When an AI session in any window on the same machine goes silent — its session
file stops being written to — and that session is not the one actively tracked
in the current window's terminal, surface a visual attention signal on the
corresponding project card so the user can act without switching windows first.

## Scope

Included:

- Codex, Kimi, and Claude sessions whose data files are readable from the
  current machine (`~/.codex/`, `~/.claude/projects/`, `~/.kimi/`);
- sessions that belong to projects already open in the current window's
  Open Projects group;
- detection based on session file modification time going quiet for a
  configurable threshold (default 30 s);
- a red badge on the project card's top-right corner;
- a low-frequency pulse animation on the card while the badge is present;
- automatic badge removal when the session becomes active again;
- badge removal when the user interacts with the card (resume, archive, rename,
  any click);
- an opt-out setting and a configurable silence threshold.

Excluded:

- sessions that are open in a terminal in the current window (already covered
  by the active-terminal highlight);
- sessions belonging to projects not in the Open Projects group;
- cross-physical-machine detection (session data is not shared across machines);
- badge removal on window focus or workspace switch (no VS Code cross-window
  API exists);
- a count or list of waiting sessions per card (badge is binary: attention
  needed or not);
- provider or session name shown on the badge;
- clicking the badge to jump to or resume the session directly;
- sound or OS-level notifications.

## Applicable Scope: Same-Machine Windows

Session data files (`~/.claude/`, `~/.codex/`, `~/.kimi/`) live on the local
machine. Every VS Code window connecting to the same machine — including
multiple local windows and multiple Remote SSH windows pointing at the same
vscode-server host — shares these files. The extension's `globalStoragePath`
and the session service's file reads all resolve to the same filesystem paths.

Windows connected to different physical machines have separate session data and
cannot observe each other. This is not a limitation of the design; it reflects
that those sessions are independent AI workflows.

## Detection Model

The extension already polls each provider's session service on a 3-second
watcher interval. The attention monitor piggybacks on the same data rather than
introducing a separate filesystem watcher.

**Session file mtime** is the signal. Each provider reads its session files and
exposes a `updatedAt` timestamp derived from the file's modification time or
its last JSONL event timestamp. When an AI model is producing output, the file
is written continuously. When it stops and waits for user input, the file stops
changing and `updatedAt` freezes.

A session is considered **waiting** when all of the following hold:

1. The provider is available and the session appears in the provider's session
   list.
2. `now - updatedAt > silenceThresholdMs` (default 30 000 ms).
3. The session is **not** currently tracked in the current window's terminal
   service (checked via `AiSessionTerminalService.getTrackedSessionKeys()`).
4. The session **cwd** matches at least one Open Project in the current window
   (same path-containment rule used by `assignAiSessionsToProjects`).

Condition 3 excludes the session the user is actively working with in this
window, which already has the active-terminal highlight treatment. Condition 4
limits attention signals to projects already visible in the sidebar.

**Attention is cleared** when any of the following occur:

- `updatedAt` advances (the session became active again);
- the session disappears from the provider list (archived or deleted);
- the user interacts with the project card in the current window.

## Architecture

```
New file:
  src/aiSessions/attentionMonitor.ts

Modified files:
  src/dashboard.ts
  media/styles.scss
  media/webviewProjectScripts.js
  src/webview/webviewContent.ts   (data attribute on project card)
```

### AttentionMonitor

A plain class with no VS Code API dependency, instantiated once in
`dashboard.ts`.

```
AttentionMonitor
  state:
    attentionMap: Map<sessionKey, { provider, sessionId, projectId }>
      — sessions currently in the waiting state

  inputs (injected at construction):
    getTrackedSessionKeys(): Set<string>
    getSessions(providerId): AiSessionReadResult
    getOpenProjectCandidates(): Array<{ project, path }>
    silenceThresholdMs: number

  public API:
    check(): AttentionDiff
      — runs one evaluation cycle; returns { added, removed }
        where added/removed are sets of { provider, sessionId, projectId }
    clear(sessionKey): void
      — marks a session as user-dismissed; suppresses future signals for
        that key until the session becomes active again, at which point
        the suppression is lifted automatically
```

`check()` is called by `dashboard.ts` on every existing AI session refresh
tick (after `scheduleAiSessionRefresh` fires). No separate timer is introduced.

### dashboard.ts Changes

After the existing `refreshAiSessionViewsIncrementally()` call resolves session
data, call `attentionMonitor.check()` and post the diff to the webview:

```
ai-session-attention-changed
{
  type: 'ai-session-attention-changed',
  added: [{ projectId, provider, sessionId }],
  removed: [{ projectId, provider, sessionId }]
}
```

When the user interacts with a project card (any existing message handler that
carries a `projectId` — resume, archive, rename, toggle-pin, select-provider,
toggle-sessions), call `attentionMonitor.clear(sessionKey)` for all sessions
belonging to that project, then send an `ai-session-attention-changed` message
removing those entries.

### Webview State

The webview maintains an in-memory set `attentionProjectIds: Set<string>`.

On `ai-session-attention-changed`:
- add all `added[].projectId` entries to the set;
- remove all `removed[].projectId` entries from the set;
- call `syncAttentionBadges()`.

`syncAttentionBadges()` walks all `.project-container` elements, reads their
`data-project-id` attribute, and toggles a `has-attention` CSS class.

The same sync runs after an `ai-sessions-updated` message replaces session
markup, so badges survive incremental refreshes.

### Suppression After User Interaction

`attentionMonitor.clear(sessionKey)` records the session key in a suppression
set. On the next `check()`, if a suppressed session's `updatedAt` has advanced
past the moment of suppression, the suppression is lifted and the session can
raise attention again normally. If `updatedAt` has not advanced, the session
stays suppressed (the user already dismissed it; re-raising would be noise).

This prevents the badge from immediately reappearing on the next poll cycle
after the user interacts with the card.

## Visual Design

**Badge:** A solid red circle, 10 px diameter, positioned at the top-right
corner of the project card, overlapping the card border. No number or icon
inside. Uses `--vscode-errorForeground` or a hardcoded `#e5534b` fallback.

**Pulse animation:** While `has-attention` is set on the card, the card
background alternates between its normal value and a very subtle warm tint
(2-second period, `ease-in-out`). The effect is deliberately restrained —
perceptible but not distracting.

**Coexistence with existing states:**
- The badge and pulse are additive with the current-workspace highlight border
  and the active-terminal accent; none suppress the others.
- Batch-selection checkboxes and selected-row backgrounds are unaffected.
- The badge appears in light, dark, and high-contrast VS Code themes.

## Configuration

Two settings added to the `projectSteward` section:

```jsonc
"projectSteward.aiSessionAttentionMonitor.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Show a badge on project cards when an AI session in another window is waiting for input."
},
"projectSteward.aiSessionAttentionMonitor.silenceThresholdSeconds": {
  "type": "number",
  "default": 30,
  "minimum": 10,
  "maximum": 300,
  "description": "Seconds of inactivity before an AI session is considered to be waiting for input."
}
```

When `enabled` is false, `AttentionMonitor.check()` returns an empty diff and
any existing badges are cleared.

## Error Handling

- If a provider's session read fails, its sessions are omitted from the
  evaluation cycle; no attention signal is raised and no existing badge is
  cleared. The next cycle retries.
- If `updatedAt` cannot be parsed for a session, that session is skipped.
- If posting the `ai-session-attention-changed` message fails, it is logged
  through the existing output channel; the next check cycle will re-derive the
  correct state.
- `attentionMonitor.clear()` is safe to call with an unknown session key
  (no-op).

## Testing

Regression coverage must verify:

- a session whose `updatedAt` is older than the threshold and is not tracked in
  the current window is added to the attention set;
- a session tracked in the current window's terminal is never added regardless
  of its `updatedAt`;
- a session whose `updatedAt` advances past the threshold is removed from the
  attention set;
- a session belonging to no Open Project candidate is never added;
- `clear()` suppresses a session; suppression lifts when `updatedAt` advances;
- `check()` returns empty diffs when `enabled` is false;
- the webview `syncAttentionBadges()` adds `has-attention` to cards in the set
  and removes it from cards not in the set;
- badges survive an `ai-sessions-updated` incremental refresh;
- interacting with a project card (any existing message type carrying projectId)
  clears attention for that project's sessions.

Repository verification:

```bash
npm run test:safety
npm run lint
npx gulp buildStyles copyWebviewAssets
npm run webpack
git diff --check
```

## Acceptance Criteria

- A project card in the current window shows a red badge when a session
  belonging to that project has been silent for the configured threshold and is
  not open in the current window's terminal.
- The badge disappears automatically when the session produces new output.
- The badge disappears when the user interacts with the project card.
- Sessions open in the current window's terminal never trigger the badge.
- Sessions belonging to projects not in the Open Projects group are ignored.
- Disabling the setting clears all badges and prevents new ones.
- Existing terminal highlight, workspace highlight, and batch-management
  behavior is unchanged.
