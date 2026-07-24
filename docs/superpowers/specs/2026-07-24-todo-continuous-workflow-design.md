# TODO Continuous Workflow Design

## Goal

Turn the global TODO tab into a continuous planning surface for medium-sized
lists (roughly 20–100 items) where users can read every task in full, move
between list and detail views without losing context, and complete common
mutations without whole-panel replacement.

## User Priorities

- Optimize daily task-entry and task-processing speed before adding new
  planning dimensions.
- Support mixed mouse and keyboard use.
- Keep the synchronized `TodoDataV1` storage format unchanged.
- Allow Webview state, message contracts, and host-side interaction
  coordination to change.
- Preserve existing storage selection, migration, search, and future-version
  read-only behavior.

## Existing Experience Problems

- Titles and notes are forced into compact single-line rows, so clicking a task
  does not provide a reliable way to read the complete task.
- The whole TODO panel is replaced after ordinary mutations, losing local
  focus, expansion, form, and nested-list scroll state.
- The entire item body doubles as a drag target and an expand target.
- The top-level compose form, inline item editor, VS Code input boxes, and
  modal deletion confirmations create inconsistent editing flows.
- Every group creates its own scrolling region after five visible items.
- Completion hides an item immediately and deletion is permanent, with no
  reversible feedback.
- Icon-only controls and silent validation failures make actions hard to
  discover and diagnose.
- TODO interaction code is embedded in the general project Webview script,
  which makes state restoration and regressions increasingly difficult.

## Chosen Product Direction

Use a single page-level scrolling list plus a focused detail state inside the
existing TODO tab.

### List State

- Render task titles on up to two lines. Only genuinely longer titles may be
  ellipsized.
- Clicking the task body, or pressing `Enter` while the row is focused, opens
  the focused detail state.
- Keep completion on the checkbox and dragging on a dedicated six-dot handle.
  The task body is not a drag handle.
- Remove per-group maximum-height scrolling. The TODO tab owns the only
  vertical scroll region.
- Clicking a group's add action inserts a quick-create row in that group.
  Global add targets Inbox.
- `Enter` creates from the quick row and `Escape` cancels it.
- Hide the medium-priority badge. High and low remain visible so priority
  styling communicates exceptions instead of repeating the default.
- Replace the ambiguous completed icon with a textually clear completed-items
  control while preserving the existing local `showCompleted` setting.

### Focused Detail State

- Replace the list content inside the TODO tab with a dedicated task detail
  surface. This is a local view state, not a new Dashboard tab or stored field.
- Show the complete title, complete plain-text notes, priority, group,
  creation date, and completion date/status.
- Provide a back button and support `Escape` and `Alt+Left`.
- Returning to the list restores the previous page scroll position and focuses
  the task row that opened the detail.
- Editing happens inside the detail surface. Users can change title, notes,
  priority, and group without a VS Code InputBox.
- Empty titles show an inline validation error and retain the draft.

### Reversible Mutations

- Completion and deletion update the affected UI immediately.
- A five-second status message offers Undo.
- Undo restores the exact task ID, group, completion state, and order.
- Undo records are process-local and short-lived. They do not change
  `TodoDataV1` and do not survive extension restart.
- Reordering and collapse changes update only their affected list regions.

## Architecture

The host remains authoritative for normalized data and persistence. The
Webview owns transient interaction state and applies local patches after
command acknowledgements.

### Webview Boundary

Add a focused TODO interaction module rather than continuing to grow
`webviewProjectScripts.js`.

It owns:

- list/detail mode;
- selected task ID;
- list scroll and focus restoration;
- quick-create and detail-edit drafts;
- pending request snapshots;
- undo presentation;
- TODO click, submit, change, keyboard, and result-message handling;
- local DOM patches for task, group, summary, and detail regions.

The existing Dashboard controller continues to mount the initial TODO HTML and
replace it for exceptional authoritative snapshots. Project and AI-session
interaction code does not inspect TODO-internal state.

### Host Boundary

Add a TODO command coordinator between the Dashboard message router and
`TodoService`.

It owns:

- message validation;
- monotonically increasing runtime revision numbers;
- calling `TodoService` mutations;
- returning normalized task/group patches and aggregate counts;
- maintaining expiring inverse-operation records for Undo;
- mapping persistence failures to stable result messages.

`TodoService` continues to serialize writes. It gains only the model
operations needed to restore an exact task snapshot and to move a task while
preserving valid group-local order.

### Message Flow

Ordinary mutations use version 2 command envelopes:

```ts
interface TodoCommandMessage {
    type: 'todo-command';
    version: 2;
    requestId: number;
    action: TodoCommandAction;
    payload: unknown;
}
```

The host replies with:

```ts
interface TodoCommandResultMessage {
    type: 'todo-command-result';
    version: 2;
    requestId: number;
    revision: number;
    success: boolean;
    snapshot?: TodoPanelSnapshot;
    undoToken?: string;
    errorCode?: 'invalid' | 'not-found' | 'conflict' | 'storage' | 'undo-expired';
}
```

`TodoPanelSnapshot` contains normalized `TodoDataV1` plus local view projection
inputs. Sending a complete normalized snapshot in the acknowledgement avoids a
second persistent model in the Webview while still allowing the controller to
patch only changed DOM regions and retain transient state.

The initial lazy panel request and exceptional recovery paths may still send
full HTML. Ordinary add, update, complete, delete, reorder, collapse, completed
visibility, and Undo commands must not replace the TODO root.

### Ordering and Stale Results

- `TodoService` keeps its mutation queue.
- Each accepted host result receives a monotonically increasing runtime
  revision.
- The Webview records request snapshots for rollback and ignores results older
  than its last accepted revision.
- While one task has an in-flight mutation, duplicate commands for that task
  are disabled; unrelated tasks remain interactive.

## Error Handling

- Invalid input is reported beside the originating field.
- Storage failure rolls back only the originating optimistic change.
- Edit drafts, selected detail task, page scroll, and unrelated pending work
  remain intact after failure.
- A storage conflict keeps the current draft and presents a stable message
  explaining that synchronized data changed.
- If an authoritative external snapshot changes a task with a dirty draft,
  the draft is retained and the detail surface asks the user to retry or
  discard it.
- An expired Undo token reports a non-destructive status and does not mutate
  data.
- Unsupported future data versions remain read-only and never enter the
  command flow.

## Accessibility and Responsive Behavior

- Task rows are focusable and expose their complete action through an
  accessible name.
- Checkbox, detail navigation, edit controls, group controls, and drag handle
  are separate focus targets.
- `Enter` opens a focused row, `Space` toggles its checkbox when the checkbox
  has focus, `Escape` cancels input or returns from detail, and `Alt+Left`
  returns from detail.
- Pending, error, success, and Undo messages use a polite live region.
- The layout remains usable between approximately 240px and 600px sidebar
  width in VS Code dark, light, and high-contrast themes.

## Testing

### Unit and Contract Tests

- Preserve `TodoDataV1` normalization and serialized storage behavior.
- Cover exact task restoration, group moves, and stable group-local ordering.
- Cover command payload validation, revisions, duplicate request containment,
  Undo expiry, storage failure, and conflict mapping.
- Cover list/detail state transitions, scroll/focus restoration state, draft
  retention, optimistic rollback, and stale-result rejection.

### Webview Integration Tests

- Long titles render on two lines in the list and in full in detail.
- The task body opens detail while the dedicated handle alone starts drag.
- Returning from detail restores scroll and task focus.
- Quick create supports `Enter` and `Escape`.
- Ordinary commands do not replace the TODO root.
- Completion and deletion Undo restore exact identity and order.
- A 20–100 item fixture has no group-local vertical scrolling.
- Keyboard paths, live-region announcements, narrow widths, and theme-variable
  styling remain covered.

### Repository Gates

- Run focused TODO tests throughout implementation.
- Run deterministic unit, contract, and integration tests.
- Run behavior-contract validation and Dashboard Webview checks.
- Regenerate and verify source/media Webview scripts and SCSS/CSS artifacts.
- Run architecture, safety, packaging, and local VSIX installation checks
  before handoff.

## Acceptance Criteria

- List titles display up to two lines; detail displays the full title and notes.
- Opening detail and returning restores scroll within one task-row height and
  restores focus to the originating row.
- Ordinary TODO commands never replace the TODO root.
- Completion and deletion can be undone for five seconds with exact identity,
  group, state, and order restoration.
- Medium-sized lists use one vertical page scroll and no per-group scroll.
- Mouse and keyboard can both create, open, edit, complete, return, and cancel.
- Pending, success, failure, and Undo feedback are accessible and leave the
  displayed state consistent with authoritative persistence.

## Non-Goals

- Due dates, reminders, recurrence, estimates, Markdown, bulk actions, and
  project-linked tasks.
- Cross-device or restart-persistent Undo.
- A client-side framework or a second persisted TODO store.
- Changes to TODO storage selection, sync conflict policy, or Settings Sync
  behavior.
