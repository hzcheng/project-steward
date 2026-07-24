# TODO Completion Without Reload Design

Date: 2026-07-24

Status: Approved for implementation

## Problem

Completing a TODO stored in Settings writes `projectSteward.todoData`. The
Dashboard lifecycle currently treats every change below `projectSteward` as a
reason to rebuild the complete Webview document. The target
`reddb-dts-dual-active` Extension Host recorded four
`full-refresh / configuration-changed` events for one completion.

The Webview also calls its broad `render()` path for the optimistic completion,
replacing `.todo-list-surface` even when the host document refresh is avoided.
Both paths violate the continuous TODO interaction contract.

## Selected approach

The TODO service records the normalized fingerprint of its most recent
successful Settings write. A `projectSteward.todoData` configuration event
whose current value has that fingerprint is a local write echo and does not
enter the Dashboard full-refresh path. A different fingerprint remains an
external change and preserves the existing synchronization behavior. A failed
Settings write cannot leave a suppressing fingerprint behind.

In the Webview, completion becomes a targeted DOM patch:

- update the target card in place when it remains visible;
- set only the target card to `hidden` when completed items are not shown;
- update the page summary, group count, hidden-completed text, and empty state;
- preserve the TODO root, list surface, group element, sibling cards, scroll,
  and drag-and-drop instance;
- exclude hidden optimistic cards from drag-order payloads; and
- retain the existing full-render fallback for missing DOM, rejected writes,
  and other recovery cases.

The authoritative matching command result continues to update state and
feedback without a second visual patch.

## Alternatives rejected

- A timeout or debounce around Settings writes is timing-dependent across
  local, SSH, container, and synchronized configurations.
- Ignoring every `todoData` configuration event would lose genuine external
  Settings Sync changes.
- Replacing only the whole TODO panel still produces the visible reload that
  this change must remove.

## Verification

Add P0 behavior `TODO-COMPLETION-INCREMENTAL-001`, owned by focused contract and
integration tests. It must prove:

- a successful local Settings write is recognized only while the current
  normalized data matches it;
- a failed or externally changed value is not recognized as a local echo;
- a matching configuration echo produces no Dashboard refresh or publication;
- optimistic completion does not invoke the broad Webview render callback;
- the target card becomes hidden while its sibling node remains identical;
- summary and group counts update; and
- hidden cards are absent from drag-order collection.

The required `quality-linux` check reaches these tests through
`npm run test:ci:linux` and `npm run test:deterministic:run`.
