# Current Workspace Summary Click Target Design

## Goal

Restrict CURRENT WORKSPACE expand/collapse clicks to the card summary above the AI Sessions divider. Clicking the divider or anything below it must not collapse the card accidentally.

## Interaction Contract

- Clicking the current workspace summary toggles AI Sessions expansion.
- The summary contains the existing workspace icon, name, folder count, status badges, and save action.
- Existing actionable controls continue to handle their own clicks and must not also toggle expansion.
- Clicking the divider, AI Sessions header, tabs, rows, controls, or empty panel space does not toggle expansion.
- OTHER WINDOWS navigation cards and PROJECTS cards retain their current click behavior.

## DOM and Event Design

Wrap the existing current workspace summary markup in a semantic event-boundary element identified by a dedicated data attribute. The wrapper is emitted only as an interaction boundary; it does not receive layout or visual styles.

The delegated project-card click handler toggles a current workspace only when the event target is inside that summary boundary. Clicks outside the boundary return without toggling. Existing action dispatch remains ahead of the summary check so save and other controls preserve their behavior.

The divider and AI Sessions module remain outside the summary boundary. This makes the required hit area structural rather than dependent on CSS classes, coordinates, animation state, or exclusions that could become incomplete later.

## Visual Compatibility

This change must not alter the current card appearance. It does not change SCSS/CSS, card dimensions, spacing, separator placement, color accents, hover/focus treatment, or expand/collapse animation.

If the wrapper element would affect layout through browser defaults, render it with a neutral element whose default display does not introduce spacing and verify the generated DOM preserves the existing layout. No new visual selector is permitted for this fix.

## Testing and Acceptance Criteria

- A regression test proves a click inside the summary invokes the existing toggle path.
- A regression test proves clicks in the AI Sessions module and on its divider do not invoke the toggle path.
- Existing AI Session action, OTHER WINDOWS navigation, and card rendering tests continue to pass.
- Generated card markup has the summary boundary above the AI Sessions module.
- `media/styles.scss` and generated `media/styles.css` remain unchanged by the implementation.
- The packaged main extension is installed into the Dev Container; the UI bridge is not installed or overwritten.
