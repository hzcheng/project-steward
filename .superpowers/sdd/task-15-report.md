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
- Made `package:release` run the production main build before bundling and
  packaging both extensions.
- Tightened the main VSIX allow-list. It retains only production bundle/media
  files plus JavaScript from `out/workspaces` and `out/openWorkspaces`; it
  excludes sourcemaps, repository workflows, all docs/design/reports,
  `.superpowers`, sources, scripts, spikes, disposable probes, and test data.
- Added release-note, production-artifact, v2 bridge-bundle, ignore-rule, and
  acceptance-matrix assertions.
- Generated the complete acceptance report with machine-checked marker blocks:
  12 unique navigation cells, 108 unique launch cells, and 12 unique
  environment/workspace-kind lifecycle cells. Every manual cell is explicitly
  `BLOCKED` with a concrete environment reason.
- Added a checked-in saved-project fixture with member paths, descriptions,
  colors, favorite state, and favorite order. The safety suite proves identical
  serialization before activation, after ordinary use, and after appending one
  encompassing workspace project.
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

The renderer now rejects that invalid snapshot. The checked-in preservation
fixture initially failed with `ENOENT`; after adding the fixture, the open
workspace safety suite passed its before/ordinary-use/after-save byte checks.

### Acceptance and archive RED

The acceptance report assertion first failed because the report did not exist.
The generated report now has the exact required columns and unique Cartesian
keys. The checker rejects missing, extra, duplicated, or non-BLOCKED manual
cells.

The first real VSIX listing exposed 19 `.map` files under the newly included
workspace output. A packaging assertion first failed on the missing map ignore;
the broad output negation was then replaced with JavaScript-only reinclusion.
A second listing showed unrelated workflows, PRDs, and manual-test docs; new
RED assertions required `.github/**` and `docs/**` exclusion before the final
package audit passed.

## Fresh automated verification

The final combined verification chain exited 0:

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
| `artifacts/project-steward-2.1.3.vsix` | `hzcheng.project-steward@2.1.3` | `1d3e7f674f3444f8d6fadf7b03219c7a394693715673fc733c223f7053b1e273` | 36 files; 217.12 KB |
| `artifacts/project-steward-attention-ui-bridge-0.1.3.vsix` | `hzcheng.project-steward-attention-ui-bridge@0.1.3` | `207f8f7a83a5239f8e6b5cb09511c94605e40587dd2629e999061777a35d8830` | 6 files; 14.38 KB |

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
- Verified the save fixture covers unchanged member entries and the existing
  real ProjectService migration coverage separately preserves group storage.
- Verified the manual blocker is visible in the heading, summary, every cell,
  and release decision; there is no overall-complete claim.
