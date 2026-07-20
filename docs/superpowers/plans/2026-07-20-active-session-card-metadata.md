# Active Session Card Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an explicit `tmux` or `vscode` badge before every Active Session name and remove redundant Provider and `Focused` text from the metadata line.

**Architecture:** Keep runtime state and projection unchanged. Update only the Active Session HTML renderer and its existing scoped SCSS, with renderer-level regression assertions in the AI Session safety suite.

**Tech Stack:** TypeScript, HTML template strings, SCSS/Gulp, Node.js `assert` safety checks.

## Global Constraints

- The first line order is backend badge followed by Session name.
- Both backends render a badge: exact visible values are `tmux` and `vscode`.
- The second line must not render `Codex`, `Kimi`, `Claude`, or `Focused`.
- Focus remains represented by `data-session-focused` and existing focus styling.
- Provider-aware ARIA labels, action titles, and Provider icons remain unchanged.
- Runtime conflict, needs-attention, stale, execution, date, and short-ID metadata remain available.
- No runtime model, projection, discovery, command, or persistence changes.

---

### Task 1: Active Session rendering contract

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:4650-4720`
- Modify: `src/webview/webviewContent.ts:771-835`
- Modify: `media/styles.scss:2903-2948`

**Interfaces:**
- Consumes: `ActiveAiSessionViewModel.backend`, `ActiveAiSessionViewModel.focused`, and the existing `getActiveAiSessionRow(model)` renderer.
- Produces: `.codex-session-title-line` containing `.ai-session-runtime-badge` followed by `.codex-session-name`; the existing `.codex-session-meta` with redundant labels removed.

- [ ] **Step 1: Write the failing rendering assertions**

Add explicit `backend` and `attached` values to the Active Session fixtures, including a focused `vscode` card and a `tmux` card. Add assertions equivalent to:

```js
assert.ok(sessionTabsHtml.includes(
    '<span class="codex-session-title-line"><span class="ai-session-runtime-badge" title="Direct VS Code terminal" aria-label="Direct VS Code terminal">vscode</span><span class="codex-session-name">Codex live</span></span>'
));
assert.ok(sessionTabsHtml.includes(
    '<span class="codex-session-title-line"><span class="ai-session-runtime-badge" title="Managed tmux runtime" aria-label="Managed tmux runtime">tmux</span><span class="codex-session-name">Kimi waiting</span></span>'
));
const activeMetadata = Array.from(sessionTabsHtml.matchAll(
    /<span class="codex-session-meta">([\s\S]*?)<\/span>\s*<\/span>/g
), match => match[1]);
assert.ok(activeMetadata.length >= 4);
assert.ok(activeMetadata.every(metadata => !/Codex|Kimi|Claude|Focused/.test(metadata)));
assert.ok(sessionTabsHtml.includes('data-session-focused'));
```

- [ ] **Step 2: Run the focused suite and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because the `vscode` badge and `.codex-session-title-line` are absent, while Provider and `Focused` remain in visible metadata.

- [ ] **Step 3: Implement the minimal renderer change**

In `getActiveAiSessionRow`, create the badge for both backends and restrict runtime status text:

```ts
var runtimeStatusLabel = model.status === 'conflict' || model.conflict ? 'Runtime conflict'
    : model.status === 'needsAttention' ? 'Needs attention'
        : '';
var runtimeBadgeDescription = model.backend === 'tmux'
    ? 'Managed tmux runtime'
    : 'Direct VS Code terminal';
var runtimeBadge = `<span class="ai-session-runtime-badge" title="${runtimeBadgeDescription}" aria-label="${runtimeBadgeDescription}">${model.backend}</span>`;
var metadata = [staleStatus, runtimeStatusLabel, executionStatus, createdAt, shortSessionId]
    .filter(Boolean)
    .join(' · ');
```

Render the first text line in this exact order:

```ts
<span class="codex-session-title-line">${runtimeBadge}<span class="codex-session-name">${sessionName}</span></span>
```

- [ ] **Step 4: Add the first-line layout rule**

Add a scoped layout beside `.codex-session-text`:

```scss
.codex-session-title-line {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;

    .ai-session-runtime-badge {
        flex: 0 0 auto;
    }

    .codex-session-name {
        flex: 1 1 auto;
        min-width: 0;
    }
}
```

- [ ] **Step 5: Run the focused suite and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 6: Compile styles and run Dashboard regressions**

Run:

```bash
npx gulp --production
npm run test:dashboard
```

Expected: Gulp completes and `Dashboard Webview checks passed.`

- [ ] **Step 7: Run final verification and commit**

Run:

```bash
npm run test:safety
npm run lint
git diff --check
```

Expected: all commands exit `0`; existing lint warnings may remain, with no new error.

Commit:

```bash
git add scripts/run-ai-session-safety-checks.js src/webview/webviewContent.ts media/styles.scss media/styles.css
git commit -m "fix: simplify active session card metadata"
```
