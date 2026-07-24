# Max Visible Todos Per Group Restoration Design

## Problem

`projectSteward.maxVisibleTodosPerGroup` is still exposed in Settings, but the TODO continuous-layout change removed every production consumer of the value and explicitly deprecated the setting. As a result, changing it has no visible effect.

## Approved outcome

- The setting controls how many collapsed 58 px TODO cards remain visible in each expanded group before that group scrolls.
- The default and invalid-value fallback remain `5`; positive fractional values are floored.
- All TODOs remain rendered in the DOM, so search, reordering, completion, and accessibility are not changed.
- Opening a card inline adds the expanded card's measured extra height to that group's viewport, so the detail remains visible and the following cards move down naturally.
- Completing a TODO keeps the current card-level incremental update path. It must not remount the TODO panel or lose the configured limit.
- Changing the setting may refresh the TODO panel through the existing configuration lifecycle because the root CSS variables must change.

## Architecture

The extension host reads and normalizes the workspace setting, then passes a small `TodoPanelRenderOptions` object to the server-side TODO renderer. The renderer writes stable CSS custom properties on `.todo-panel`. Incremental client rendering only replaces `.todo-list-surface`, leaving that root and its configured properties intact.

SCSS uses the custom-property height as each group's collapsed viewport cap. The TODO client controller recalculates only the extra height contributed by an inline-expanded card after a DOM patch, avoiding full-panel replacement.

## Error handling

Missing, non-numeric, zero, negative, and non-finite values fall back to `5`. The package contribution continues enforcing a minimum of `1`, while runtime normalization protects manually edited or stale configuration.

## Verification

A P0 behavior contract owns the renderer option, normalization, CSS cap, extension-host wiring, and incremental-render preservation. Focused integration tests must fail on the current implementation before production changes, then pass alongside dashboard checks and the Linux CI-equivalent suite.
