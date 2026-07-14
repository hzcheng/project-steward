# Open Project Attention Badge Deduplication

## Goal

Remove the redundant repository-level attention badge from cards in the
virtual **Open Projects** group. Those cards already show the same attention
count inside their AI-session statistics badge.

## Behavior

- Open-project cards do not render or dynamically receive a
  `project-ai-attention-badge` in the top-left corner.
- Their existing AI-session statistics badge continues to show the attention
  count.
- Saved repository cards outside Open Projects retain the top-left aggregate
  badge so users can identify repositories that need attention across windows.
- Individual session rows retain their unnumbered attention indicator and
  animation.

## Implementation

The initial HTML renderer omits the aggregate badge for open-project cards.
The incremental attention updater detects `data-open-project`, removes any
stale aggregate badge left by an older render, updates session-row indicators,
and skips aggregate-badge insertion for that card.

## Verification

Safety checks cover initial rendering and incremental updates for both open
and saved project cards. Existing attention, webview, TypeScript, build, and
lint checks must continue to pass.
