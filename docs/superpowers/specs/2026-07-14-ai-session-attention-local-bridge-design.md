# AI Session Attention Monitor — Local Bridge Design

Date: 2026-07-14
Status: Approved for feasibility planning

> **Lifecycle update (2026-07-15):** The provider activity token, quiet-time
> inference, and related state-machine/timing rules in this document are
> superseded by
> `2026-07-15-ai-session-explicit-lifecycle-attention-design.md`. The bridge,
> aggregation, lease, acknowledgement, and rendering architecture below remains
> in force.

## Decision

Project Steward will monitor AI sessions that it creates or resumes and will
show attention indicators in every VS Code window opened by the same desktop
client and VS Code Profile.

The current Project Steward extension remains a Workspace Extension. A second,
UI-only extension named **Project Steward Local Bridge** runs on the user's
desktop. The two extensions communicate through private VS Code commands. Each
Local Bridge instance writes one owner-specific snapshot file into a shared
local directory. Other Local Bridge instances aggregate those files and return
the complete result to their Project Steward window.

This design does not use `ExtensionContext.globalState` for coordination. The
rejected approach and measurements are retained in
`docs/superpowers/reports/2026-07-13-ai-session-attention-global-state-feasibility.md`.

## Goals

- Monitor sessions created or resumed through Project Steward.
- Continue monitoring when the Project Steward sidebar is hidden.
- Cover local, Remote SSH, WSL, and Dev Container windows opened by one desktop
  VS Code client.
- Let every Project Steward window show which repositories and sessions need
  attention.
- Flash new attention three times, then retain a repository count and session
  dot until the event is acknowledged.
- Keep installation, update, diagnostics, and recovery close to a single-
  extension experience.
- Keep all coordination data on the user's desktop machine.

## Non-goals

- Monitoring AI sessions started outside Project Steward.
- Sharing attention between different physical desktop machines.
- Sharing attention between different VS Code Profiles.
- Synchronizing attention through Settings Sync or a cloud service.
- Parsing terminal screen contents or provider-specific prompt text.
- Providing millisecond-level notification delivery.
- Supporting VS Code for the Web in the first release.

## Product Scope

The coordination boundary is one desktop VS Code client and one VS Code
Profile. Windows inside that boundary may use different workspace execution
locations:

- local filesystem;
- Remote SSH;
- WSL;
- Dev Container or attached container.

Other desktop machines and other Profiles maintain independent attention
registries.

## Extension Topology

### Project Steward Workspace Extension

The existing `hzcheng.project-steward` extension remains responsible for:

- discovering provider sessions;
- creating and resuming AI terminals;
- mapping sessions to Project Steward projects;
- observing provider activity and completion markers;
- owning the local attention state machine;
- deciding when an event is acknowledged;
- rendering repository and session indicators.

It continues to prefer the Workspace Extension Host so direct Node filesystem
access and provider tools execute in the same local, SSH, WSL, or container
environment as the session.

### Project Steward Local Bridge UI Extension

A new extension, `hzcheng.project-steward-local-bridge`, is declared as an
`extensionDependency` of the main extension. Its manifest uses:

```json
{
  "extensionKind": ["ui"],
  "api": "none"
}
```

The bridge:

- runs only in the desktop UI Extension Host;
- contributes no view, settings, keybindings, or public user commands;
- receives owner snapshots through private VS Code commands;
- writes and reads the Profile-local snapshot directory;
- aggregates all live owner snapshots;
- sends complete aggregate snapshots back to its window's Workspace Extension;
- records immutable acknowledgement events;
- performs stale-file cleanup.

VS Code private commands are the only Workspace-to-UI Extension Host transport.
No extension API object is exported across hosts. VS Code documents command
routing across Extension Hosts, but does not document how duplicate command
registrations in multiple desktop windows are selected. Window-local routing is
therefore an unproven assumption until the mandatory spike passes.

### Local Snapshot Directory

Every bridge instance in the same Profile uses:

```text
<local-bridge-globalStorageUri>/attention/v1/
  instances/
    <instanceId>.json
  acknowledgements/
    <eventIdHash>.json
```

The directory is local to the desktop and Profile. It is not located in a
workspace, remote home directory, repository, or synchronized setting.

Every active instance owns exactly one file. No other instance writes that
file. Acknowledgement files are immutable and idempotent: multiple writers may
attempt to create the same acknowledgement, but its content is identical.

## Activation and Handshake

The main extension already activates for each Project Steward window. During
activation it generates a cryptographically random `instanceId` and calls the
bridge handshake command.

The handshake request contains:

```ts
interface AttentionBridgeHandshakeRequest {
  protocolVersion: 1;
  mainExtensionVersion: string;
  instanceId: string;
}
```

The response contains:

```ts
interface AttentionBridgeHandshakeResponse {
  accepted: boolean;
  protocolVersion: 1;
  bridgeExtensionVersion: string;
  capabilities: {
    snapshots: true;
    acknowledgements: true;
    atomicReplace: true;
  };
  errorCode?: 'protocol-mismatch' | 'storage-unavailable';
}
```

After a successful handshake, the main extension publishes an immediate full
snapshot. The bridge returns the current aggregate immediately rather than
waiting for the next filesystem event.

The bridge supports the current protocol and the immediately previous protocol
when their schemas are safely convertible. An incompatible handshake disables
only cross-window attention.

## Session Ownership

The Workspace Extension instance that creates or resumes a terminal owns that
monitored run. Ownership contains:

- `instanceId`;
- provider and session ID;
- stable privacy-safe `projectKey`, computed as SHA-256 of the normalized
  Project Steward project path/URI (the version 1 wire field remains named
  `projectId` for compatibility, but carries this key rather than a card ID);
- the owning `vscode.Terminal`;
- the provider session's last observed activity token;
- the existing command-completion marker;
- the current attention generation and event ID.

New sessions begin as pending because their provider session ID may not exist
immediately. The existing pending-terminal resolver attaches the ID after the
provider creates the session. Discovering a historical provider session never
enrolls it automatically.

On extension activation, recovery may enroll an already open Project Steward
terminal only when the existing provider, terminal-name, session, and marker
rules produce a unique match. Ambiguous terminals remain unmonitored.

Ownership ends when:

- the session is archived or deleted;
- the terminal closes before completion;
- the owning Workspace Extension is disposed and its lease later expires.

If completion was observed before terminal close, unread attention remains
until acknowledgement.

## Provider Activity Signal

Quiet detection does not assume that the display model's `updatedAt` is a
real-time activity signal. Each provider service exposes an opaque activity
token for an owned session. The token must change whenever the provider appends
observable session output.

The provider-facing interface is bulk-oriented so one evaluation does not scan
the same provider once per session:

```ts
interface AiSessionActivitySource {
  getActivityTokens(sessionIds: readonly string[]): Record<string, string>;
}
```

The first implementation derives tokens from the provider's actual transcript
or wire file signature, such as normalized path identity plus size and
`mtimeMs`. In particular, Codex must not rely only on
`session_index.jsonl.updated_at`, because that index may update less frequently
than the underlying session JSONL file. Claude and Kimi may reuse their existing
transcript/wire file signatures when tests prove that they advance during
output.

Activity tokens are local implementation values. They are never written to the
Local Bridge snapshot, because aggregation needs attention state rather than
remote filesystem metadata.

Before production implementation, real provider fixtures and manual CLI runs
must prove that each token advances during streamed output and remains stable
after output stops. A provider without a reliable token may support completion
attention but must not enable Quiet attention.

## Local Attention State Machine

Each owned session follows:

```text
pending -> running -> needsAttention -> acknowledged
              ^             |
              +-------------+  new provider activity

pending/running/needsAttention -> removed
```

### Pending

The terminal exists but the provider session ID has not been resolved. Pending
sessions do not create attention.

### Running

The session ID is resolved and the monitor has established an activity-token
baseline. A quiet timer starts only after a token change newer than that
baseline has been observed. Historical files never trigger attention.

### Needs Attention

An event is raised for either:

1. **Completed** — the existing completion marker appears, proving that the AI
   CLI command exited.
2. **Quiet** — after observed activity, the provider activity token stops
   advancing for 30 seconds while the terminal remains open.

Before raising an unread event, the owner checks:

```text
vscode.window.state.focused
    && vscode.window.activeTerminal === owningTerminal
```

If true, the event is treated as already seen. Otherwise the owner increments
its local generation, assigns a unique `eventId`, and publishes unread
attention.

Repeated evaluations of the same condition do not create new event IDs. If a
quiet session resumes output before acknowledgement, its current quiet event is
removed. A later quiet transition creates a new event. Completed events are not
re-raised.

### Acknowledged

An attention event is acknowledged when:

- its owning window gains focus and the owning terminal becomes active; or
- the user resumes, archives, or deletes the session through Project Steward in
  any window.

The owner-window case clears the owner snapshot directly. Cross-window actions
write an immutable acknowledgement file for every currently visible event ID of
that provider/session. All bridges aggregate these acknowledgements; the owner
clears only the exact matching event ID. An acknowledgement therefore cannot
silence a later generation accidentally.

Pinning, renaming, expanding a card, changing provider tabs, or clicking unused
card space does not acknowledge attention.

## Evaluation Scheduling

`AiSessionAttentionMonitor` owns an independent 10-second interval. It does not
depend on the provider watcher or sidebar visibility.

The interval runs while monitoring is enabled and at least one owned session is
pending, running, or unread. Each tick:

1. checks completion markers;
2. groups owned sessions by provider;
3. reads each relevant provider and its activity tokens at most once;
4. evaluates all owned sessions from that shared result;
5. publishes only when the full snapshot changes.

Provider file watchers, focus changes, active-terminal changes, terminal close,
resume, archive, and delete may request an immediate evaluation. They are
optimizations, not the clock required for quiet detection.

With a 30-second quiet threshold, quiet attention appears 30–40 seconds after
the last observed activity.

## Workspace Snapshot Protocol

The main extension sends a complete snapshot:

```ts
type OwnedSessionState = 'pending' | 'running' | 'needsAttention';
type AttentionReason = 'quiet' | 'completed';

interface WorkspaceAttentionSession {
  provider: 'codex' | 'kimi' | 'claude';
  sessionId: string;
  projectKey: string;
  state: OwnedSessionState;
  attentionGeneration: number;
  eventId?: string;
  reason?: AttentionReason;
  terminalOpen: boolean;
}

interface WorkspaceAttentionSnapshot {
  protocolVersion: 1;
  instanceId: string;
  sequence: number;
  heartbeat: number;
  source: {
    remoteType: 'local' | 'ssh' | 'wsl' | 'dev-container' | 'remote';
  };
  sessions: WorkspaceAttentionSession[];
}
```

Snapshots contain no prompts, output text, remote authority, repository path, or
hostname.

The sequence increments on semantic state changes. The heartbeat increments at
most once every 30 seconds when no semantic change occurs. Full snapshots make
the protocol self-healing after missed commands or file events.

## Local File Envelope and Atomic Writes

The bridge validates the command payload, adds its local receipt data, and
writes:

```ts
interface LocalAttentionEnvelope {
  storageVersion: 1;
  receivedAt: number;
  bridgeVersion: string;
  snapshot: WorkspaceAttentionSnapshot;
}
```

`receivedAt` is generated in the local UI Extension Host. Remote clock skew
does not affect leases.

Writes use a temporary file in the same directory, close the file completely,
and atomically replace `<instanceId>.json`. Replacement sharing violations are
retried with bounded backoff. The previously valid destination remains readable
until the replacement is ready.

The bridge coalesces rapid publications and guarantees that an older sequence
cannot replace a newer local sequence. It writes immediately for semantic
changes and no more than once per 30-second heartbeat while idle.

## Leases and Cleanup

Every bridge scans the instances directory after a filesystem event and at
least once every two seconds as a fallback.

An instance is live when:

- its schema and protocol are valid;
- its `instanceId` matches its filename;
- its snapshot sequence/heartbeat has advanced within the last 90 seconds;
- its file is within the configured size limit.

Readers use the bridge-written `receivedAt` and local filesystem observations,
never a remote timestamp. A temporarily unreadable or missing file retains its
last valid in-memory value until the 90-second lease expires.

Normal deactivation deletes the owner's file after stopping publications. A
crash, killed remote connection, or power loss relies on lease expiry. Invalid
or expired files older than 24 hours are removed by any bridge instance.

Acknowledgement files expire after 24 hours. They remain long enough for a
temporarily disconnected owner to receive the exact event acknowledgement after
reconnecting.

## Aggregation and Deduplication

The bridge derives a complete aggregate from all live envelopes plus live
acknowledgements.

The logical session key is:

```text
provider + sessionId
```

If the same session is accidentally owned by multiple windows:

- it contributes one repository count;
- it remains unread while any unacknowledged event ID remains;
- every underlying event ID is retained for correct acknowledgement;
- a previously unseen event ID may flash once even when the session was already
  unread from another owner.

The aggregate returned to the main extension contains:

```ts
interface AggregatedAttentionSession {
  provider: 'codex' | 'kimi' | 'claude';
  sessionId: string;
  projectKey: string;
  reasons: AttentionReason[];
  eventIds: string[];
}

interface AggregatedAttentionSnapshot {
  protocolVersion: 1;
  aggregateRevision: string;
  generatedAt: number;
  sessions: AggregatedAttentionSession[];
}
```

`aggregateRevision` is a deterministic hash of the sorted semantic aggregate,
not a process-local counter. Re-reading unchanged files produces the same
revision and cannot replay UI animation.

## UI Behavior

The main extension maps aggregate project keys to
`.project[data-attention-project-key]` cards. A dashboard-local `data-id` is not
used for cross-window identity because open-project IDs such as
`open-projects-0` are reused independently by every window. The key exposes no
raw path, hostname, or remote authority. Session rows use the existing
`.codex-session-row[data-session-id][data-session-provider]` attributes. An
unknown project key is ignored; it is applied automatically if that project
later appears in the dashboard.

For a newly observed event ID:

- each visible matching repository card flashes three times;
- each visible matching session row flashes three times;
- the animation stops permanently after the finite sequence.

Persistent state:

- a repository badge displays the number of distinct unread logical sessions;
- a visible unread session row displays a red dot;
- active-terminal highlighting remains independent from attention styling.

### Webview Recovery Protocol

`provider.refresh()` replaces the complete Webview HTML, so Webview JavaScript
memory cannot own animation replay suppression. `AttentionViewState` lives in
the Workspace Extension Host and retains the latest aggregate plus the set of
event IDs already delivered as new during that extension activation.

After installing its `message` listener, every new Webview posts:

```ts
{ type: 'request-ai-session-attention-state' }
```

The extension responds with:

```ts
interface AiSessionAttentionStateMessage {
  type: 'ai-session-attention-state';
  aggregate: AggregatedAttentionSnapshot;
  animateEventIds: string[];
}
```

For a recovery request, `animateEventIds` is always empty. The Webview restores
badges and dots from the full aggregate without animation. For a live aggregate
change, the Extension Host includes only event IDs not already present in its
delivered-event set. It records those IDs before posting, so a failed post
followed by full HTML refresh restores persistent state but does not replay a
possibly duplicated animation.

On a new Workspace Extension activation, all event IDs in the first aggregate
are established as the historical baseline. Later event IDs may animate. This
matches the existing `request-active-ai-session-terminal` recovery pattern while
keeping replay state outside disposable Webview JavaScript.

## Configuration

The main extension contributes:

```json
{
  "projectSteward.aiSessionAttention.enabled": {
    "type": "boolean",
    "default": true,
    "description": "Show attention indicators when Project Steward AI sessions finish or may need input."
  }
}
```

Disabling the setting stops the monitor, removes the owner's snapshot, and
clears attention UI in that window. It does not uninstall or stop the bridge,
because other Project Steward windows may still use it.

The 10-second evaluation interval, 30-second quiet threshold, 30-second
heartbeat, 90-second lease, two-second fallback scan, 24-hour cleanup period,
and 256 KiB per-instance file limit are implementation constants in the first
release.

## Installation and Release Operations

Marketplace users install only Project Steward. VS Code resolves the declared
Local Bridge dependency and installs it in the local UI Extension Host. The
bridge has no normal user-facing contributions.

Release order is:

1. publish a backward-compatible Local Bridge version;
2. verify Marketplace availability;
3. publish the compatible Project Steward version.

Development builds produce two VSIX files. A repository script packages and
installs the bridge locally before installing the main extension into the
selected local or remote Extension Host. Manual pre-release instructions must
name both artifacts explicitly when the CLI is unavailable.

If the bridge remains installed after Project Steward is removed, it stays
inactive and can be removed normally from the Extensions view. Stale-file
cleanup runs only when a remaining compatible Project Steward instance
activates the bridge.

## Failure Handling and Degraded Mode

### Bridge Missing or Incompatible

The main extension shows one actionable warning and continues with local-window
attention only. Existing project, session, terminal, pin, archive, and batch
features remain available.

### Command Failure

Handshake and publication retry with bounded exponential backoff. Repeated
errors are rate-limited in the Project Steward output channel. A later complete
snapshot repairs missed state.

### Write Failure

The bridge retains the last valid file and retries the newest snapshot. The main
window continues showing its own attention even if cross-window publication is
unavailable.

### Corrupt, Oversized, or Unsupported File

The reader ignores only that file and logs a rate-limited diagnostic. It never
discards the last valid in-memory value before lease expiry solely because a
replacement is temporarily unreadable.

### Filesystem Watcher Failure

The two-second scan remains active. Watcher failure affects latency, not
correctness.

### Remote Disconnect

The remote Workspace Extension stops heartbeats. The local bridge retains its
last snapshot until the 90-second lease expires. A reconnect with a new
`instanceId` publishes a new file; the old file expires independently.

## Security and Privacy

- The bridge global-storage directory is restricted to the current OS user.
- Instance filenames accept only generated lowercase hexadecimal IDs.
- Acknowledgement filenames use a fixed-length hash of the event ID.
- All command payloads and files undergo schema, enum, length, count, and size
  validation.
- Symlinks and non-regular instance files are ignored.
- A single instance file is limited to 256 KiB and a bounded number of sessions.
- Snapshot files contain no conversation content, prompt, response, hostname,
  remote authority, or absolute project path.
- No listener port, network socket, cloud endpoint, or Settings Sync key is
  created.

## Component Boundaries

New logic is split into focused modules rather than added directly to the large
`dashboard.ts` file:

- `AiSessionAttentionMonitor` — owner state machine and scheduling in the main
  extension.
- `AttentionBridgeClient` — handshake, publish, acknowledgement, aggregate
  reception, retry, and degraded mode in the main extension.
- `AttentionProtocol` — serializable schemas, validators, version conversion,
  canonical sorting, and semantic hashes shared by both builds.
- `LocalAttentionStore` — atomic instance writes, acknowledgement writes,
  scans, leases, and cleanup in the bridge.
- `LocalAttentionAggregator` — validation, deduplication, acknowledgement
  application, and aggregate derivation in the bridge.
- `AttentionViewState` — maps aggregate snapshots to repository counts, session
  dots, and one-time animation event IDs.

Each module exposes plain-data interfaces and has no dependency on webview DOM
internals.

## Mandatory Feasibility Spike

Before production implementation, build minimal Workspace Probe and UI Bridge
Probe extensions. The spike must validate:

```text
Workspace A -> Bridge A -> local file -> Bridge B -> Workspace B
```

The first spike phase tests command routing before implementing the file store.
Open windows on distinct fixture workspaces. Each Workspace Probe and UI Bridge
Probe computes a canonical identity from the sorted `Uri.path` values of the
workspace folders and generates its own random process ID. Scheme, authority,
`fsPath`, and remote name do not participate: the same remote workspace appears
as `file:` in its Workspace Host and `vscode-remote:` in its local UI Host, but
has the same URI path in both. For at least 1,000 concurrent challenge round
trips per window:

1. the Workspace Probe calls the bridge command with its process ID, workspace
   identity, and challenge nonce;
2. the receiving bridge verifies that its own workspace identity matches and
   returns its bridge process ID plus the nonce;
3. the bridge invokes the reverse Workspace Probe command;
4. the originating Workspace Probe verifies the reverse response returns to
   its own process ID.

The path identity is a host-independent routing precheck, not an authoritative
workspace identifier. The random Workspace process ID and reverse-command echo
remain authoritative because distinct workspaces can theoretically share the
same ordered paths and only the reverse round trip proves which Workspace
Extension Host handled the challenge.

Any workspace-identity mismatch, nonce mismatch, response from another
Workspace Probe, unstable bridge process mapping, missing response, or command
collision fails the architecture immediately. Repeat a smaller manual matrix
with two windows on the same workspace to catch behavior hidden by distinct
workspace identities.

Required observations:

- the window-local command challenge passes in local, Remote SSH, WSL, and Dev
  Container windows;
- all bridge instances in one Profile resolve the same local storage root;
- another Profile resolves an isolated root;
- three windows can publish at least 300 states each without sequence rollback,
  overwrite, disappearance, parse error, or command error;
- P95 end-to-end propagation is at most three seconds;
- maximum end-to-end propagation is at most five seconds;
- watcher suppression still converges through the two-second scan;
- normal close removes state promptly;
- forced close becomes inactive within 90 seconds;
- bridge reload and version handshake recover without manual state editing.

Run the concurrent matrix for at least ten minutes. Record actual versions,
environment types, sample counts, P95/max latency, errors, and file sizes in a
retained report. Any unavailable environment is `NOT RUN`, never PASS.

If command routing is not window-local, bridge storage is not shared inside a
Profile, state disappears or rolls back, or latency exceeds the gate, stop and
return to architecture design.

### Disposable Routing Automation Harness

The routing probe may use a marker-gated automation harness to remove repeated
manual Command Palette work. This harness is test infrastructure, not part of
the Local Bridge architecture and not a file-coordination channel.

The Workspace Probe reads the fixed local marker
`/tmp/project-steward-attention-routing-control.json` after activation. It does
nothing when the marker is absent, invalid, expired, or does not list its
canonical workspace identity. A matching marker supplies a random run ID, a
strictly validated routing mode, the expected fixture identities, and the
challenge count. Distinct-workspace mode requires fixture A and B with 1,000
challenges. Same-workspace mode requires fixture A alone with 200 challenges.
After the normal command-routing challenge settles, the Workspace Probe writes
its complete status atomically under
`/tmp/project-steward-attention-routing-results/<runId>/`. Same-workspace
result names include the random Workspace process ID in their hash input, so
two hosts with the same canonical workspace identity cannot overwrite one
another. Results are never read by either probe and cannot influence routing,
command validation, or the PASS/FAIL outcome.

The harness allows the controller to install the Workspace Probe through the
remote `code-server`, restart only the target remote Extension Hosts, and read
the resulting evidence. The UI Bridge still requires one local desktop install
because the remote environment cannot access the local UI Extension Host.

## Production Test Plan

### Unit Tests

- pending resolution and historical baseline suppression;
- provider-specific activity-token baselines and token advancement;
- running, quiet, completed, acknowledged, resumed, and removed transitions;
- focused owner terminal suppresses unread generation;
- new provider activity removes only quiet events;
- exact event-ID acknowledgement cannot silence a later generation;
- provider/session deduplication and repository counts;
- complete snapshot sequencing and semantic hash stability;
- atomic replacement, bounded retry, corrupt-file retention, and cleanup;
- lease expiry and reconnect with a new instance ID;
- schema validation, size limits, symlink rejection, and protocol conversion;
- bridge-missing local-only degraded mode;
- Webview recovery request/response, exact existing DOM attributes, and
  animation replay suppression across full HTML rerenders.

### Integration Matrix

- two local windows;
- two windows attached to the same Dev Container;
- local plus Dev Container;
- local plus Remote SSH;
- two different Remote SSH hosts;
- Windows local plus WSL;
- local plus Dev Container plus SSH concurrently;
- bridge update skew and bridge disable/re-enable;
- real Codex, Claude, and Kimi activity tokens during streaming and quiet
  periods;
- owner window focus/terminal acknowledgement propagation to every other window;
- resume, archive, and delete acknowledgements initiated from a non-owner window.

### UI Acceptance

- every visible matching repository flashes exactly three times for a new event;
- all windows converge on the same distinct-session badge count within three
  seconds;
- visible unread session rows display a dot and flash once per event ID;
- hidden/reopened sidebars restore persistent indicators without replay;
- active-terminal highlighting and attention indicators coexist;
- bridge failure does not break existing Project Steward operations.

## Performance Budget

- One provider read per relevant provider per 10-second evaluation, not per
  session.
- No local file write for unchanged semantic state except one heartbeat per 30
  seconds.
- One owner file per active window and bounded acknowledgement files.
- Two-second scans inspect only the bridge-owned directory and enforce file and
  entry limits.
- The bridge performs no network I/O and starts no child daemon.

## Rollout

1. Complete and review the mandatory feasibility report.
2. Publish the inert, backward-compatible Local Bridge dependency.
3. Implement the owner monitor and local-only attention UI behind the disabled
   cross-window integration flag.
4. Implement bridge publication, aggregation, and acknowledgements.
5. Run the full environment and UI matrix.
6. Enable the feature by default only after all required gates pass.

The failed `globalState` spike remains part of the project record so future
changes do not reintroduce multi-window coordination through that mechanism.
