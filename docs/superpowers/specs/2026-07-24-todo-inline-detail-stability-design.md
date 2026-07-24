# TODO Inline Detail and Rendering Stability Design

Date: 2026-07-24

Status: Approved by the user's standing implementation approval and explicit
acceptance feedback.

## Problem

The first continuous-workflow iteration has three user-visible defects:

1. The group disclosure control is rendered as a text `⌄` after controller
   mount. The collapsed-state CSS rotates only SVG elements, so the glyph
   remains downward in both states and its font metrics leave it off-center.
2. Opening a task replaces the list with a dedicated detail surface. This
   removes surrounding context and makes a simple card inspection feel like a
   page transition.
3. Every local state change and every host acknowledgement assigns the full
   TODO root `innerHTML`, then destroys and recreates drag-and-drop. An
   optimistic command followed by its successful acknowledgement therefore
   causes at least two full redraws.

## Interaction design

Each group disclosure button uses the same centered SVG chevron. Expanded
groups point down; collapsed groups rotate the chevron to point right. The
button remains 20 by 20 pixels with an explicit focus ring and matching
`aria-expanded` state.

Clicking a task card or title toggles an inline detail region inside that card.
The surrounding group and list remain visible. Only one task is expanded at a
time. Clicking the expanded card again closes it. Search opens the matching
card without accidentally closing an already-open result. `Escape` and
`Alt+Left` close the expanded card and return focus to its title.

The expanded card shows the full title and then vertically ordered detail rows:
notes, group, priority, created time, updated time, and completed time when
present. Complete/Reopen, Edit, and Delete actions remain at the bottom.
Editing replaces the inline detail rows with the existing title, notes,
priority, group, Save, and Cancel controls; it never leaves the list.

## Rendering design

The TODO controller keeps the list surface, Undo region, and live region as
stable siblings. It caches the last rendered list-surface markup.

- Expanding, collapsing, editing, completion toggles, and group disclosure
  patch only the affected task or group DOM.
- A successful host acknowledgement updates the authoritative snapshot, Undo,
  and live regions. If its list-surface markup matches the already optimistic
  surface, it performs no list DOM assignment and does not reinitialize
  drag-and-drop.
- Structural changes such as adding, deleting, moving, or sorting may replace
  the list surface once. Their acknowledgement does not replace it a second
  time when the resulting markup is unchanged.
- Failure responses restore the authoritative snapshot and redraw only when
  the visible surface differs from the optimistic state.

The host remains authoritative and the existing versioned command, revision,
rollback, and five-second Undo contracts do not change.

## Verification

Automated integration coverage must prove:

- dynamic and initial markup both use an SVG chevron whose collapsed class
  rotates it right;
- card activation expands details inline while the list stays present, and a
  second activation collapses it;
- full title and vertically ordered metadata remain visible in the card;
- a successful acknowledgement matching an optimistic completion does not
  trigger a second surface render or drag-and-drop reinitialization;
- failures still restore authoritative state and surface an accessible error;
- search continues to open the inline card.

The focused integration suite, Dashboard checks, deterministic suite,
architecture guards, safety checks, production build, release packaging, and
installed-asset hash comparison must pass before handoff.
