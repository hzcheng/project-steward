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

Mark the existing AI Sessions root with a dedicated data attribute. Do not insert a summary wrapper because an extra flex child could affect the current card layout. The data attribute is an event boundary only and has no style selector.

The delegated project-card click handler toggles a current workspace only when the event target is outside that AI Sessions boundary. Existing action dispatch remains ahead of the boundary check so save and other controls preserve their behavior.

The divider is the AI Sessions root's existing top border, so it is inside the non-toggle boundary together with the header, tabs, lists, controls, and panel whitespace. This makes the hit area structural rather than dependent on coordinates or animation state.

## Visual Compatibility

This change must not alter the current card appearance. It does not change SCSS/CSS, card dimensions, spacing, separator placement, color accents, hover/focus treatment, or expand/collapse animation.

No new element, inline style, CSS declaration, or visual selector is permitted for this fix.

## Testing and Acceptance Criteria

- A regression test proves a click inside the summary invokes the existing toggle path.
- A regression test proves clicks in the AI Sessions module and on its divider do not invoke the toggle path.
- Existing AI Session action, OTHER WINDOWS navigation, and card rendering tests continue to pass.
- Generated card markup marks the existing AI Sessions root as the non-toggle boundary.
- `media/styles.scss` and generated `media/styles.css` remain unchanged by the implementation.
- The packaged main extension is installed into the Dev Container; the UI bridge is not installed or overwritten.
