# Task 15 Report: Verify workspace-first release

Date: 2026-07-21

Task implementation status: complete and ready for review.

Overall workspace-first acceptance status: **BLOCKED** by the unexecuted manual
support matrix. This task does not claim release acceptance.

## Delivered

- Updated README, current CHANGELOG release, and package metadata for the
  one-card workspace model, all-root provider-native `--add-dir` scope,
  trust/capability preflight, fail-closed navigation fallback, saved-project
  preservation, UI Bridge v2 requirement, and intentional non-adoption of
  legacy runtime bindings.
- Made `package:release` clean only four explicit generated output directories,
  compile both TypeScript projects, build both production bundles/assets, and
  then package both extensions.
- Tightened the main VSIX allow-list. It retains only production bundle/media
  files plus JavaScript from `out/workspaces` and `out/openWorkspaces`; it
  excludes sourcemaps, repository workflows, all docs/design/reports,
  `.superpowers`, sources, scripts, spikes, disposable probes, and test data.
- Added release-note, real VSIX ZIP-entry/manifest/bundle, v2 bridge, exact
  archive allow-list, seeded-stale-output, and acceptance-matrix assertions.
- Generated the complete acceptance report with machine-checked marker blocks:
  12 unique navigation cells, 108 unique launch cells, and 12 unique
  environment/workspace-kind lifecycle cells. Every manual cell is explicitly
  `BLOCKED` with a concrete environment reason.
- Added a checked-in real serialized `Group[]` saved-project fixture. The
  safety suite seeds a real ProjectService store and proves serialized equality
  through production startup migration, ordinary reads, and a save routed
  through the production adapter, mutation controller, and service.
- Closed the Task 7 review minors: a non-null zero-root card renders the empty
  state, a successful current-group update preserves OTHER WINDOWS, and both
  history and active rows render the `Outside workspace` chip.
- Corrected the Task 10 report to describe its main cutover commit and focused
  follow-up fix instead of claiming one atomic commit.

## TDD evidence

### Release and packaging RED

The first release-note run exited 1 with:

```text
AssertionError: README must document one card per non-empty VS Code workspace
```

The first packaging run exited 1 with:

```text
AssertionError: release package script must include vscode:prepublish
```

After the release content/build changes, both checks passed. A generated-bundle
assertion was refined from a slash-joined literal to the actual bundled
`path.join("open-workspaces", "v2", "instances")` representation; the command
namespace and v1 absence remain independently asserted.

### Task 7 and saved-project RED

The explicit zero-root fixture initially observed one card instead of zero:

```text
AssertionError: a non-null invalid zero-root snapshot must render the empty current-workspace state
1 !== 0
```

The renderer now rejects that invalid snapshot. The original checked-in
preservation fixture then failed the new real-store assertion because it was a
flat project list rather than serialized `Group[]`; after correcting the
fixture, the production startup/read/save integration path passed.

### Acceptance and archive RED

The acceptance report assertion first failed because the report did not exist.
The generated report now has the exact required columns and unique Cartesian
keys. The checker rejects missing, extra, duplicated, out-of-domain, or invalid
status cells and derives overall PASS/BLOCKED from those statuses. The current
generated rows all remain BLOCKED because none has been manually run.

The first real VSIX listing exposed 19 `.map` files under the newly included
workspace output. A packaging assertion first failed on the missing map ignore;
the broad output negation was then replaced with JavaScript-only reinclusion.
A second listing showed unrelated workflows, PRDs, and manual-test docs; new
RED assertions required `.github/**` and `docs/**` exclusion before the final
package audit passed.

## Fresh automated verification

The final verification commands exited 0:

```text
npm run lint
npm run test:safety
npm run test:dashboard
npm run test:tmux:smoke
npm run test:architecture-baseline
npm run test:release-notes
npm run test:release-packaging
git diff --check
```

Observed suite summaries:

```text
AI session tmux checks passed.
AI session safety checks passed.
Open workspace safety checks passed.
Dashboard Webview checks passed.
AI session tmux smoke checks passed.
Release notes checks passed.
Release packaging checks passed.
```

Lint exited 0 with the repository's established warnings and no errors. The
production builds completed successfully. Webpack emitted its existing
`Compilation.modules` and `Module.errors` deprecation warnings.

The final forbidden-vocabulary scan returned no production matches for:

```text
OPEN_PROJECT_PROTOCOL_VERSION
_projectStewardOpenProjects
open-projects/v1
openProjectCardKind
runtime.identity.projectKey
```

## Final packages and host limitations

| Artifact | Extension | SHA-256 | Archive result |
| --- | --- | --- | --- |
| `artifacts/project-steward-2.1.3.vsix` | `hzcheng.project-steward@2.1.3` | `c05969e541e0e2e830da7d36d5a4939b2bc6d45b3e79ec40962facd91419cbd3` | 36 files; 217.15 KB; exact entries checked |
| `artifacts/project-steward-attention-ui-bridge-0.1.3.vsix` | `hzcheng.project-steward-attention-ui-bridge@0.1.3` | `07ffbf7746c7cebcd83aca85b0a8424354158fa55527db0257d9abc0bfbe820b` | 6 files; 14.38 KB; exact entries checked |

The final main archive contains exactly seven `out/openWorkspaces/*.js` files,
twelve `out/workspaces/*.js` files, `dist/dashboard.js`, and the generated
Webview/style assets. The bridge archive contains its v2 `dist/extension.js`.
Neither archive contains maps, source, scripts, test fixtures, docs, reports,
workflows, spikes, or probe artifacts.

The current host is a Dev Container (`REMOTE_CONTAINERS=true`). The confirmed
server CLI path reports VS Code `1.127.0`, commit
`4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, x64. The main extension is
workspace-host compatible, but the required bridge is UI-only. `/usr/local/bin/code`
reports that no local `code`/`code-insiders` is installed, and the inherited
Dev Container IPC socket rejected extension-list access with `ECONNREFUSED`.
Therefore neither release artifact was installed: packaging is not reported as
installation success, the known workspace host was not left with a main
extension whose required UI dependency could not be installed, and no
ambiguous UI host was mutated.

VSCE reported only the 56.1 KB bridge bundle as a large file; both package
operations completed successfully.

## Manual acceptance blocker

`docs/superpowers/reports/2026-07-20-workspace-first-acceptance.md` records:

- 12/12 navigation cells BLOCKED;
- 108/108 provider/runtime new+resume cells BLOCKED; and
- 12/12 environment/workspace lifecycle cells BLOCKED.

Local, SSH, and WSL Extension Hosts are absent. The Dev Container host lacks
controlled source/target windows, provider sessions, and authoritative UI
automation for interactive evidence. Automated checks and probe installation
are not promoted to manual PASS. There were zero member-root navigation
violations across zero runnable manual navigation trials; this is explicitly
not positive evidence.

The support matrix has not been narrowed. The feature remains release-blocked
until controlled runs produce evidence for every documented cell or the
support matrix is explicitly narrowed and approved.

## Self-review

- Verified the generated acceptance table has no omitted or duplicate cell and
  that every row uses the required nine columns.
- Verified all output paths are generated by TypeScript/Webpack/Gulp; no
  minified, copied, or compiled asset was edited by hand.
- Verified packaging after each allow-list correction by reading the real VSIX
  archive, not by inferring behavior from `.vscodeignore`.
- Verified the checked fixture itself passes through real ProjectService
  storage/migration/read/write and the real ProjectMutationController save path.
- Verified the manual blocker is visible in the heading, summary, every cell,
  and release decision; there is no overall-complete claim.

## Independent-review follow-up

The first independent review requested four evidence corrections. All are
implemented without changing the BLOCKED manual decision.

1. `test:release-packaging` now seeds stale generated files, calls the
   non-recursive clean production package pipeline, and parses the two actual
   VSIX ZIP central directories. It compares exact entries against current
   source-derived workspace outputs, checks embedded publisher/name/version and
   dependency metadata, inspects packaged main/bridge v2 tokens, compares
   generated Webview/style bytes, and rejects maps, docs, sources, tests,
   scripts, workflows, spikes, probes, `.superpowers`, duplicate ZIP entries,
   or the stale sentinel. The GitHub workflow performs this package-and-verify
   gate only after compile/lint.
2. The fixture now uses the actual `Group[]` persisted shape. A real
   ProjectService is seeded in global state, production startup migrates it to
   settings, ordinary service reads leave its serialized JSON unchanged, and a
   second startup saves through SavedWorkspaceProjectAdapter,
   ProjectMutationController, and ProjectService. Byte equivalence is claimed
   only for the controlled serialized JSON group/member prefix and source
   store, not for VS Code's underlying storage file format.
3. The matrix checker constructs the explicit 4×3 and 4×3×3×3 expected key
   sets, validates every domain value and exact set equality, allows only
   PASS/FAIL/BLOCKED, and derives overall BLOCKED from any FAIL/BLOCKED (PASS
   only when every cell is PASS). It no longer hard-codes every future row to
   BLOCKED; the current generated evidence remains all BLOCKED.
4. The current-group replacement test now mounts fake current and OTHER WINDOWS
   siblings in a real children array. `replaceWith` mutates that array, and the
   assertions re-query the same other group and navigation-card node and verify
   its content survived.

Review RED evidence included the old package check lacking any build, the
checked fixture failing because it was not a real Group store, the missing
exact-domain validator, the old workflow assertions, and the former OTHER
WINDOWS fake lacking children. Each focused gate passed after its correction.
One full safety run hit the existing attention-unregister timing assertion;
the isolated attention suite and the immediately repeated full safety gate both
passed without a code change, so this is recorded as a timing flake rather than
misrepresented as a workspace regression or silently fixed out of scope.
