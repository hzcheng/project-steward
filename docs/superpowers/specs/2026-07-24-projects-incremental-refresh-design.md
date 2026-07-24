# Projects Incremental Refresh Design

Date: 2026-07-24

Status: Approved by the user's standing authorization for follow-up UX fixes

## Problem

The `PROJECTS` tab still feels as if it reloads unpredictably. Live evidence
from the `reddb-dts-dual-active` Extension Host shows twelve
`configuration-changed` full Dashboard refreshes between
`2026-07-24T06:12:14.713Z` and `2026-07-24T06:12:16.506Z`.

The refresh storm has two causes:

1. a local project catalog mutation writes both `projectSyncData` and the
   compatibility `projectData` setting; every resulting configuration event
   reconciles the catalog and resets the complete Webview document;
2. mutation controllers call `refreshAfterMutation`, which performs another
   full provider refresh after the write succeeds.

Collapse actions are already optimistic in the browser, and drag-and-drop has
already moved the DOM into the requested order. Rebuilding the document discards
that useful client state, resets scripts and lazy panels, repeats AI-session
scans, and produces visible flicker.

## Approaches Considered

### 1. Debounce full refreshes

Coalesce the configuration events and keep one provider refresh.

This reduces twelve refreshes to one but still destroys the complete Webview
document after every mutation. It does not satisfy the interaction goal.

### 2. Replace the complete Projects panel

Suppress local configuration echoes and replace only
`#dashboard-tab-projects` after every mutation.

This preserves the document, active tab, and TODO/OPEN panels. It is a safe
fallback, but it still redraws all project groups after a drag whose DOM is
already correct.

### 3. Incremental Projects updates with an authoritative fallback

Suppress local project-catalog write echoes, post a versioned Projects update,
and preserve the current Projects DOM when its drag order already matches the
authoritative order. CRUD and favorite changes replace only the Projects panel.
External synchronization uses the same partial update after reconciliation.
Malformed, stale, inconsistent, or undeliverable updates fall back to the
existing full refresh.

This is the selected approach because it removes the frequent collapse and drag
flicker while retaining a simple authoritative recovery path.

## Host Design

`ProjectCatalogSyncService` owns separate pending echo queues for
`projectSyncData` and `projectData`.

- A token is registered before each Settings write.
- A matching configuration event consumes exactly one token.
- A mismatching, invalid, or unreadable current value clears the relevant
  queue and is treated as external.
- A failed write removes only its own token.
- An event that affects both keys is local only when every affected key
  consumes a matching token.

`DashboardLifecycleController` classifies configuration events:

- pure local project catalog echoes do not reconcile or refresh;
- pure external project catalog changes reconcile and publish a Projects
  partial update;
- mixed events that include another Project Steward setting retain the current
  full-refresh path;
- external TODO data and storage-backend changes retain their existing
  authoritative behavior.

Successful project mutations call a new project-surface refresh function rather
than `DashboardRuntimeController.refreshAfterMutation`. That function:

1. posts a `projects-panel-updated` message;
2. forces an incremental OPEN/search-catalog publication so saved-state,
   project color, and search results remain current;
3. applies the current project color and publishes open-workspace metadata.

The Projects message contains:

- protocol version and a monotonic sequence;
- freshly rendered Projects panel HTML;
- the complete Dashboard search catalog;
- authoritative saved-group and favorite project orders;
- an update mode indicating whether matching browser order may preserve the
  existing Projects DOM.

Delivery failure falls back to a full provider refresh. If the Projects panel
has not been mounted, the next lazy panel request reads current state, so no
eager DOM work is required.

## Client Design

`initDashboard` accepts only valid, newer `projects-panel-updated` messages.
It always replaces the search catalog.

For ordinary CRUD, group, color, or favorite mutations, it replaces only the
Projects panel HTML, then reinitializes fit/DnD behavior. The Webview document,
tab controller, OPEN panel, TODO controller, active tab, and window scroll stay
alive.

For drag acknowledgements, the client derives saved-group and favorite order
from the current DOM:

- if it exactly matches the authoritative order, no Projects DOM is replaced;
- if it differs or cannot be validated, the complete Projects panel HTML is
  applied as the authoritative fallback.

Group collapse and collapse-all remain optimistic and receive no Projects
panel update. Their Settings events are consumed as local echoes.

## Concurrency and Error Handling

- Message sequences reject stale Projects updates.
- External Settings Sync is never suppressed by an old local token; mismatches
  clear pending echoes.
- External project changes are reconciled before rendering.
- Mixed project and unrelated configuration changes retain a full refresh.
- A reorder mismatch, invalid message, or failed partial delivery uses the
  existing full-refresh recovery.
- Partial panel replacement reinitializes DnD once and restores focus when the
  previously focused project/action still exists.

## User-Visible Acceptance

1. Collapsing one or all Projects groups does not replace the Webview document
   or Projects panel.
2. A successful drag whose authoritative order matches the DOM does not replace
   the Projects panel.
3. Add, edit, color, favorite, remove, and group mutations update only the
   Projects panel, not the complete Webview.
4. The active tab, TODO state, OPEN state, scroll position, and sibling DOM
   identities survive a Projects mutation.
5. A local catalog write does not trigger configuration-driven full refreshes.
6. External catalog changes still reconcile and update Projects, OPEN saved
   state, window color, and search results.
7. Mixed configuration events and inconsistent acknowledgements retain a safe
   full-refresh fallback.

## Regression Ownership

Add P0 behavior `PROJECT-INCREMENTAL-REFRESH-001`, owned by:

- the project catalog persistence contract for write-echo handling;
- the Dashboard lifecycle integration test for local, external, and mixed
  configuration routing;
- the Dashboard Webview state integration test for panel/root preservation,
  order acknowledgement, stale messages, and fallback replacement.

The required `quality-linux` check reaches these owners through
`npm run test:ci:linux` → deterministic contract/integration suites.
