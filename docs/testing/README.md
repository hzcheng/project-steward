# Behavior contract catalog

`behavior-contracts.json` is the repository’s inventory of regression behaviors. Each entry records a stable behavior ID, its domain, priority, implementation evidence, and the automated or manual owner responsible for protecting it.

## Entry fields

- `id` follows `PREFIX-BEHAVIOR-001` and is unique.
- `domain` is one of `project`, `todo`, `open-project`, `webview`, `session`, `runtime`, `attention`, `persistence`, `error`, `release`, or `architecture`.
- `title` describes the protected behavior.
- `priority` is `P0`, `P1`, or `P2`.
- `status` is `automated`, `scheduled`, or `manual`.
- `owners` contains repository-relative test or manual-document paths. Automated owner files must include the entry ID.
- `evidence` contains one or more repository-relative source or test paths.
- Manual entries also include a non-empty `manualReason`.

Run `npm run test:behavior-contracts` to validate the catalog and its owner references. The initial entries retain the legacy check scripts as automated owners; focused node:test suites will replace those owners incrementally.
