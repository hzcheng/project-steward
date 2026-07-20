# Active Session Card Metadata Design

## Goal

Make Active Session cards easier to scan without changing their runtime behavior. The backend must be visible beside the session name, while redundant Provider and focus text must be removed from the metadata line.

## Display Contract

Each Active Session card keeps its existing Provider icon, actions, attention indicator, execution indicator, and focus styling.

The first line renders, in order:

1. A backend badge containing `tmux` or `vscode`.
2. The session name.

The second line may render runtime conflict, needs-attention, stale-runtime, execution state, date, and short Session ID metadata. It must not render `Codex`, `Kimi`, `Claude`, or `Focused`.

A focused card continues to expose `data-session-focused` and its existing focus border, so focus remains visually apparent without duplicate text.

## Implementation Shape

The change stays within the Active Session row renderer in `src/webview/webviewContent.ts` and the existing session-card styles in `media/styles.scss`.

The renderer will create an explicit backend badge for both supported backends. The badge will move out of the metadata array and into a new first-line wrapper before the session-name element. Provider labels remain available in the card's `aria-label`, action labels, titles, and fallback session name; only the redundant visible metadata value is removed.

No model, runtime projection, tmux discovery, focus synchronization, command, or persistence behavior changes.

## Accessibility and Failure Behavior

The backend badge exposes a descriptive title and accessible label for `Managed tmux runtime` or `Direct VS Code terminal`. Existing Provider-aware card and action labels remain unchanged.

The renderer already receives a normalized `tmux` or `vscode` backend. If future data introduces another value, the existing typed boundary remains responsible for rejecting or normalizing it; this UI change adds no fallback runtime behavior.

## Testing

Rendering regression tests will verify:

- both `tmux` and `vscode` badges are emitted;
- each backend badge appears before its session name in the first-line wrapper;
- visible Active Session metadata contains no Provider label;
- a focused model still emits `data-session-focused` but no visible `Focused` metadata;
- conflict, attention, stale, execution, date, and short-ID metadata remain unaffected;
- production styles compile after the new first-line layout rule is added.

The normal AI Session safety suite and Dashboard webview suite will be run after implementation.
