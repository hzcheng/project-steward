# Shared Visual Primitives Design

## Goal

Unify Project Steward's visual rendering layer after the global TODO tab addition, so `OPEN`, `PROJECTS`, and `TODO` use the same styling primitives instead of separate visual systems.

## Scope

- Add shared CSS primitives with the `steward-*` prefix for sections, section headers, cards, compact cards, icon buttons, buttons, badges, metadata, and empty states.
- Keep existing behavior classes such as `group`, `project`, `todo-item`, and `todo-icon-button` so current scripts and tests continue to work.
- Apply shared primitives to existing project groups/cards and TODO groups/items/summary controls.
- Do not rewrite dashboard routing, TODO storage, mutation handlers, search, drag-and-drop, or AI session rendering.

## Approach

The first phase is additive. Existing markup keeps its current class names and receives shared `steward-*` classes where the element represents a reusable visual concept. Shared styles live in `media/styles.scss` before TODO-specific styles, allowing TODO-specific details to remain local while borders, backgrounds, buttons, badges, and metadata converge.

Project cards keep their established dimensions and specialized project styling. TODO items use `steward-card steward-card-compact` because they are compact list rows rather than full project cards.

## Acceptance Criteria

- Project group wrappers use `steward-section`.
- Project group headers use `steward-section-header`.
- Project cards use `steward-card`.
- TODO summary, groups, headers, items, action buttons, badges, and metadata use matching `steward-*` primitives.
- Dashboard webview checks enforce the shared class contract.
- Generated `media/styles.css` stays synchronized with `media/styles.scss`.
