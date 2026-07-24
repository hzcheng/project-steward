# TODO Page Hierarchy Design

Date: 2026-07-24

Status: Approved for implementation

## Problem

The TODO page command bar and each TODO group currently emit the same
`group-title steward-group-header` shell. That makes the page title look like
another collapsible group even though it has different scope and behavior.

This design narrowly supersedes the TODO page-header requirement in
`2026-07-17-shared-visual-primitives-design.md`. TODO group headers and item
cards continue to use the shared Steward primitives.

## Considered approaches

1. Keep the shared group-header classes and override their shell properties.
   This is the smallest markup change, but retains misleading semantics and
   creates a growing list of specificity overrides.
2. Give the page command bar its own semantic and visual primitive. This keeps
   the group primitive honest, makes the hierarchy explicit, and is the
   selected approach.
3. Replace the command bar with a large summary card. This would distinguish
   the levels, but consumes scarce sidebar space and adds decoration without
   improving the workflow.

## Design

The first TODO row becomes a `todo-page-command-bar`. It is a lightweight page
heading with no group border, filled background, shadow, group indentation, or
collapse affordance. `TODO` uses a larger page-title treatment; open/group
counts remain secondary text beside it. Add TODO, add group, and show-completed
remain right-aligned page actions and stay visible because they are primary
page commands.

The groups start below the command bar and retain the bordered
`steward-group-header` shell, disclosure chevron, group metadata, drag handle,
and contextual actions. No TODO data, mutation, drag-and-drop, or keyboard
contracts change.

The unsupported-data state uses the same page-level heading primitive so its
visual hierarchy remains consistent.

## Responsive behavior

At narrow widths the command bar remains a single row. Metadata truncates
before the fixed-width action cluster; the title and actions remain visible.
The existing 320 px and 240 px layout rules continue to govern forms and task
cards.

## Verification

A P0 integration behavior will require both server-rendered and client-patched
TODO surfaces to:

- emit `todo-page-command-bar` for the page heading;
- omit `group-title` and `steward-group-header` from that heading;
- retain `steward-group-header` on real TODO groups; and
- define a borderless page-command-bar presentation with persistently visible
  actions.

Existing TODO interaction, dashboard style, deterministic, packaging, and
safety gates remain required.
