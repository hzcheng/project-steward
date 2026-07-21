# Unified OPEN and PROJECTS Card Style Design

## Goal

OPEN, OTHER WINDOWS, and PROJECTS cards must look like one product surface. Workspace cards may expose different actions and content, but they must not introduce a second card shell or color language.

## Shared Visual Contract

All three surfaces use the existing Project card primitives for background, border, radius, shadow, hover/focus treatment, title spacing, description typography, aura, and left accent bar. The current workspace no longer receives a permanently blue/focused shell; its location under CURRENT WINDOW already communicates its status.

Workspace-specific rules are limited to content behavior:

- CURRENT WINDOW can grow to display AI Sessions and can show the save action.
- OTHER WINDOWS remains compact, read-only, and navigable.
- PROJECTS retains favorite, color, edit, remove, and drag behavior.

## Color Resolution

Workspace cards gain the same optional `color` value used by Project cards.

- For the current workspace, resolve its `navigationUri` against Saved Projects and reuse the matched Project color.
- For OTHER WINDOWS, resolve each published workspace `navigationUri` against the same local Saved Projects collection and reuse the matched color.
- If a workspace is unsaved or has no matching Saved Project, render no accent color: the aura stays transparent and the accent bar does not fall back to foreground white.
- Color is resolved locally; the open-workspace bridge protocol does not transmit presentation data and does not change.

## Rendering Boundary

Project and workspace renderers remain separate because their actions differ, but both feed the same card-shell variables and shared CSS classes. A small color-normalization helper produces the inline `--project-color` variable and accent background for both renderers, preventing future drift.

## Validation

Automated checks verify:

- current and OTHER WINDOWS cards reuse matching Saved Project colors;
- unmatched workspace cards have neither a white accent fallback nor a colored aura;
- Project color rendering remains unchanged;
- current workspace no longer uses a permanent selected/focus shell;
- workspace-only session expansion and save behavior remain intact;
- narrow-sidebar and reduced-motion rules continue to apply through shared card primitives.
