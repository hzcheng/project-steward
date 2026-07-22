# Regression testing and behavior contracts

`behavior-contracts.json` is the repository’s inventory of regression behaviors. Each entry records a stable behavior ID, its domain, priority, implementation evidence, and the automated or manual owner responsible for protecting it.

Use Node.js 22.12 or newer and install dependencies with `npm ci` before running the complete gates.

## Entry fields

- `id` follows `PREFIX-BEHAVIOR-001`, uses uppercase letters, digits, and hyphens, ends in a three-digit sequence, and is unique. Keep an existing ID stable when its implementation moves.
- `domain` is one of `project`, `todo`, `open-project`, `webview`, `session`, `runtime`, `attention`, `persistence`, `error`, `release`, or `architecture`.
- `title` describes the protected behavior.
- `priority` is `P0`, `P1`, or `P2`.
- `status` is `automated`, `scheduled`, or `manual`.
- `owners` contains repository-relative test or manual-document paths. Automated owner files must include the entry ID.
- `evidence` contains one or more repository-relative source or test paths.
- Manual entries also include a non-empty `manualReason`.

Run `npm run test:behavior-contracts` to validate the catalog and its owner references. Focused `node:test` suites own ordinary behavior; the remaining source-level checks are limited to documented architecture risks.

## Test workflow

Run the narrowest owner while developing. Compile first when the test imports generated `out/` modules:

```bash
npm run test-compile
node --test tests/unit/projects/projectPathUtils.test.js
node --test --test-concurrency=1 tests/contract/openProjects/protocol.test.js
node --test --test-concurrency=1 tests/integration/dashboard/messageRouter.test.js
```

The standard layered commands are:

```bash
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:deterministic
```

`test:deterministic` covers the full unit, contract, and integration suite with controlled fakes and temporary data. It does not replace the isolated real-environment smoke:

```bash
PROJECT_STEWARD_TMUX_PATH=/usr/bin/tmux npm run test:tmux:smoke
```

The Linux CI-equivalent command compiles once and runs behavior-catalog validation, the lint and coverage ratchets, deterministic and compatibility suites, architecture guards, production bundling, and release-package checks:

```bash
npm run test:ci:linux
```

Windows path, URI, workspace, and shell-quoting contracts run with `npm run test:ci:windows` on a Windows host. The stable CI checks intended for branch protection are `quality-linux`, `platform-windows`, and `tmux-smoke-linux`.

## Adding a regression

Use RED-before-fix for every discovered regression:

1. Add or select a stable behavior ID and assign it to the correct domain and priority.
2. Add the ID to a focused test name and make that test the catalog owner.
3. Run the focused test against the unfixed code and record that it fails for the expected behavior.
4. Apply the smallest behavior-preserving fix and rerun the focused test to green.
5. Run the relevant layered suite, `npm run test:behavior-contracts`, and the platform or environment gate affected by the change.

Do not turn a manual scenario into `automated` merely because a fake covers part of it. Multi-window focus, remote-host lifecycle, sleep/disconnect behavior, and visual accessibility remain owned by the versioned [`cross-platform-remote-matrix.md`](../manual-tests/cross-platform-remote-matrix.md) until their actual environments are exercised. Record environment versions, date, result, and redacted evidence there; an unexecuted row is not a pass.
