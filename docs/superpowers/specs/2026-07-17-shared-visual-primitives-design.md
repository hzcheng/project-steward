# Shared Dashboard and TODO Visual System Design

Date: 2026-07-17

Status: Approved for implementation planning

## 1. Goal

Refactor the Dashboard rendering layer so `OPEN`, `PROJECTS`, and `TODO` use the same real group-header and item-card components. TODO must look like another view of Project Steward, not a separately designed application placed inside the Dashboard.

The established `OPEN` and `PROJECTS` visual language is authoritative. Shared components are extracted from that implementation, and TODO adopts those components exactly.

## 2. Relationship to Existing Specifications

This document replaces the earlier contents of this file and supersedes the following visual-only requirements:

- The independent Notion/Linear-inspired TODO treatment in `2026-07-16-todo-ui-polish-design.md`.
- The statement in `global-todo-list-prd.md` that TODO items should be visually lighter than project cards.
- The additive approach in the earlier shared-primitives design that kept separate project and TODO card shells.

The TODO product behavior, data model, Settings Sync storage, mutations, search, and message contracts in `global-todo-list-prd.md` remain unchanged.

## 3. Design Principles

### 3.1 Exact reuse, not visual imitation

Shared components own the complete shell appearance: dimensions, colors, border, radius, shadow, spacing, hover, focus, transition, and disabled treatment. Domain-specific selectors may arrange content inside the shell but must not redefine it.

Changing a shared shell token or rule must update the corresponding UI in all three tabs.

### 3.2 Preserve Dashboard density

The normal item card uses the existing project-card proportions, including the established 58 px collapsed height and 18 px radius. TODO does not introduce a miniature row, a decorative summary panel, nested cards, or a separate page canvas.

### 3.3 Domain behavior remains local

Shared visual components do not own project drag-and-drop, favorites, save state, AI session expansion, TODO completion, TODO editing, or TODO sorting. Existing domain classes remain stable for scripts and tests.

## 4. Shared Component Architecture

### 4.1 Shared group header

The shared group header uses the visual class `steward-group-header`. It is extracted from the current `OPEN` and `PROJECTS` group title bar and owns:

- height and internal spacing;
- background and foreground colors;
- border, radius, and shadow;
- title, metadata, and action alignment;
- collapse affordance;
- hover, keyboard focus, and action visibility;
- icon size and interaction states.

The TODO page header and every TODO group use this same component. Existing classes such as `group-title`, `todo-group-header`, and `todo-summary` may remain as behavior or content hooks, but they do not define a second shell.

### 4.2 Shared item card

The shared item card uses the visual class `steward-item-card`. It is extracted from the existing `.project` card and owns:

- the 58 px collapsed height;
- horizontal and vertical padding;
- the 18 px radius;
- background, foreground, border, accent rail, and shadow;
- hover and `focus-within` feedback;
- expanded and editing geometry;
- reduced-motion behavior.

Existing state classes `expanded`, `editing`, `completed`, and `selected` remain the behavior contract when applied to a shared item card. Shared state rules may alter height, emphasis, or accessibility feedback without introducing a domain-specific shell.

The component exposes content slots rather than project-specific markup:

- leading control or icon;
- primary title;
- single-line secondary text;
- trailing badge or status;
- hover and focus actions;
- expanded content;
- editing content.

Projects populate these slots with project identity, path, status, actions, and AI sessions. TODO populates them with checkbox, title, notes, priority, task actions, details, and the edit form.

### 4.3 Domain selectors

Classes including `.project-*` and `.todo-*` remain available for business behavior and domain content layout. They may control details such as checkbox placement, priority color, AI session structure, or form field layout.

They must not override the shared card or group shell's background, border, radius, shadow, base height, or shell-level hover treatment.

## 5. TODO Page Structure

### 5.1 Page header

The current TODO summary card is removed. The page starts with one shared group header:

- left: `TODO`, open task count, and group count;
- right: add TODO, add group, and show-completed controls;
- controls use the same icon-button treatment as existing group actions, with `title` and `aria-label` text;
- the show-completed control has an explicit selected state without changing the header shell.

The page header is not collapsible. It uses the shared group header appearance so it aligns with the first visible title bar in the other tabs.

### 5.2 TODO groups

Each TODO group uses the same shared group header and section spacing as a project group. A group header contains:

- collapse/expand control and group title;
- visible task count;
- add TODO, sort, and delete actions.

The existing group deletion confirmation and collapse behavior remain unchanged. The Dashboard-level expand/collapse-all actions operate on TODO groups when TODO is active.

An empty group retains its normal header and shows a lightweight text hint beneath it. The hint is not wrapped in a card.

### 5.3 TODO cards

A collapsed TODO card uses the shared 58 px item-card shell and displays:

- completion checkbox;
- title on one line;
- notes preview on one line when available;
- priority badge;
- edit and delete actions on hover or keyboard focus.

Long titles and notes use ellipsis and never increase collapsed card height. The full title is available through the native hover tooltip and accessible labeling.

Completed tasks keep the same shell. They use the shared completed modifier to reduce emphasis while retaining readable text and controls.

## 6. Interaction States

### 6.1 Default and expanded

Cards start collapsed. Activating a card's non-control surface toggles expansion. Controls such as checkbox, edit, delete, links, form controls, and action buttons do not trigger the surface toggle.

An expanded card retains the same header region and opens the shared expanded-content slot beneath it. The content includes full notes and available task dates or metadata. Edit and delete commands remain reachable.

### 6.2 Editing

Starting edit automatically expands the complete card. The card header remains visible and the edit slot shows all editable fields at once:

- title;
- priority;
- notes;
- cancel;
- save.

The form must not be clipped to collapsed-card height. Priority selection provides an immediate visible selected state before save. Cancel restores the prior non-editing state; save applies the existing mutation flow and leaves the card in its normal list context.

### 6.3 Per-group scrolling

Each expanded group initially reserves enough list height for the configured number of collapsed cards, which defaults to five. Additional cards are available through vertical scrolling inside that group.

When a card enters editing, the affected group temporarily removes its list height cap so the full editor is visible. Cancel or save restores the configured capped list behavior. Expanding a non-editing card does not shrink the card; the list remains scrollable when its content exceeds the cap.

### 6.4 Focus and motion

Mouse hover and `focus-within` expose the same shared actions and shell feedback. Keyboard users can reach every command and form control. Existing reduced-motion support disables nonessential transitions without hiding state changes.

## 7. Data Flow and Ownership

This work changes rendering composition, not application data flow:

1. Existing project and TODO view models produce domain data.
2. Their renderers emit shared shell classes plus stable domain behavior classes.
3. Shared SCSS owns shell appearance and state modifiers.
4. Domain SCSS owns only slot content and domain-specific details.
5. Existing event delegation routes project and TODO actions through their current message contracts.

No new persistence key, command, setting, webview message, or cross-machine synchronization behavior is introduced.

## 8. Compatibility and Error States

- All colors derive from VS Code theme variables and must work in dark, light, and high-contrast themes.
- Existing `hidden`, `aria-expanded`, `aria-label`, focus order, and keyboard semantics are preserved or improved.
- Loading, empty, and error states use shared section spacing and plain status content. They do not introduce decorative cards.
- Project drag-and-drop, favorites, save state, AI session expansion, attention badges, and current-workspace treatment keep their existing behavior.
- Generated CSS and generated webview assets remain synchronized with their source files.
- No new runtime dependency is added.

## 9. Implementation Boundaries

In scope:

- extract the project group-header and item-card shells into shared SCSS components;
- apply shared classes to project and TODO renderers;
- replace the TODO summary card with a shared page header;
- align TODO default, expanded, editing, completed, empty, and scrolling states;
- adjust focused source-contract and behavior tests.

Out of scope:

- changing TODO storage, Settings Sync, or conflict behavior;
- changing TODO fields or adding workflow states;
- redesigning tab navigation in this refactor;
- changing project or AI session business behavior;
- adding a design-system framework or dependency;
- unrelated stylesheet cleanup.

## 10. Testing Strategy

### 10.1 Source-contract checks

- Verify project groups, TODO page header, and TODO groups emit the shared group-header class.
- Verify project and TODO items emit the shared item-card class.
- Verify stable domain classes and action attributes remain present.
- Verify generated webview assets and CSS match their sources.

### 10.2 Style-boundary checks

- Assert that shell background, border, radius, shadow, and base height are defined by shared selectors.
- Prevent TODO selectors from redefining those shell properties.
- Verify shared expanded, editing, completed, hover, focus, and reduced-motion states.

### 10.3 Behavior checks

- TODO card default collapse and surface-toggle expansion.
- Control clicks do not accidentally toggle cards.
- Edit opens the full form and priority selection is visibly updated.
- Cancel and save leave the card usable and restore group scrolling.
- The configured card-count cap defaults to five and overflow remains scrollable.
- Group collapse, deletion, and Dashboard-level expand/collapse-all continue to work.

### 10.4 Regression and visual checks

- Re-run dashboard, TypeScript, and existing safety checks.
- Verify project card drag-and-drop, favorites, save state, AI sessions, and attention badges.
- Inspect `OPEN`, `PROJECTS`, and `TODO` at 220, 280, 350, and 420 px sidebar widths.
- Inspect dark, light, and high-contrast themes.
- Confirm no text overlaps controls and no expanded or editing content is clipped.

## 11. Acceptance Criteria

- TODO page header and group headers use the same shell component as Dashboard group headers.
- TODO and project cards use the same shell component, including color, 58 px collapsed height, 18 px radius, border, shadow, hover, and focus behavior.
- A shared shell style change is visible across `OPEN`, `PROJECTS`, and `TODO` without parallel domain overrides.
- Collapsed TODO titles remain one line with ellipsis and reveal their full value on hover.
- Expanded TODO cards show full details without shrinking or clipping.
- Editing shows title, priority, notes, cancel, and save at the same time.
- The default five-card group viewport and overflow scrolling work before and after editing.
- Completed and empty states remain clear without introducing a separate TODO visual system.
- Existing project, AI session, TODO data, synchronization, search, and mutation behavior has no regression.
