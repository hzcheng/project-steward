# OPEN PROJECT Stability Diagnostics and Incremental Rendering Design

Date: 2026-07-15
Status: Approved for immediate implementation

## Problem

Live project cards still fluctuate below the number of open VS Code windows. The
current pipeline hides important failures: coordinator watcher/timer errors are
discarded, scan counters are not exposed, and Workspace publication success is
not observable. Every aggregate change also assigns a new `webview.html`, which
recreates the whole dashboard and causes visible flashing.

## Decision

Add structured diagnostics at every OPEN PROJECT boundary and keep all normal
aggregate rendering inside the existing Webview. Full HTML refresh remains only
an initialization and explicit recovery path.

## Diagnostics

The Workspace extension writes `[OpenProjects]` JSON lines to the existing
`Project Steward` output channel for activation, publish success/failure,
aggregate receipt, incremental render delivery, and Webview acknowledgement.

The UI Bridge creates a `Project Steward UI Bridge` output channel. It records
publication, local lease renewal, unregister, scan membership changes, non-zero
scan counters, aggregate delivery, and every previously swallowed watcher or
timer error. Registration summaries contain instance ID, sequence, focus time,
lease age, and project count. Repeated healthy scans are suppressed; a complete
snapshot is emitted at least once every 30 seconds.

The Bridge also forwards each bounded diagnostic event to its paired Workspace
extension. The Workspace appends both components to
`open-project-diagnostics.jsonl` under its VS Code global storage directory.
The file is capped at 2 MiB and starts a fresh log when the cap is exceeded, so
the active development environment can be inspected without manually copying
Output-channel text from the local UI host.

Logs are always available during this pre-release development phase. They are
not shown as notifications and do not include session content or credentials.

## Incremental Rendering

The sticky OPEN PROJECT wrapper always exists. On a new semantic aggregate, the
extension host renders only the OPEN PROJECT group fragment and posts an
`open-projects-updated` message containing protocol version, semantic revision,
project count, and trusted HTML. The Webview replaces only the wrapper contents,
reapplies the existing filter, updates the sticky header offset, and replies
with `open-projects-rendered`.

Existing document-level click/change/context-menu delegation continues to work
for replaced cards. If postMessage fails, the view is hidden, or the Webview
rejects the message, the next visibility resolution/full-refresh path recovers.
Normal aggregate updates never call `provider.refresh()`.

## Lease Independence

Registry persistence and local lease renewal must never wait for aggregate
delivery to a Workspace extension host. A background or disconnected Workspace
can leave `executeCommand` pending even though its VS Code window and local UI
Bridge are still alive. Mutation serialization therefore covers only local
registration writes/removals. Scanning and aggregate delivery run after that
queue has been released, so a stalled delivery cannot starve later lease
renewals and make another healthy Bridge expire the open window.

## Testing

Automated checks prove:

- coordinator timer/watcher errors reach diagnostics instead of being dropped;
- scan diagnostics identify membership loss and non-zero expiry/error counters;
- Workspace diagnostics record publication and aggregate membership;
- Bridge diagnostics are forwarded, size-checked, and persisted by Workspace;
- semantic aggregate changes post an OPEN PROJECT update rather than refresh the
  entire Webview;
- a permanently stalled aggregate delivery does not block subsequent local
  lease renewal;
- the Webview replaces only the sticky OPEN PROJECT wrapper and acknowledges the
  revision;
- full safety tests, TypeScript compilation, lint, bundles, and VSIX packaging
  still succeed.

No commits are made until user review.
