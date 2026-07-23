# Regression-fix Skill Pressure Scenarios

## Method

Each control used a fresh, read-only agent in
`/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count`.
The baseline controls were not given `fixing-regressions-with-ci`; the follow-up
controls were explicitly given its local `SKILL.md`. No control edited the
worktree.

## Baseline results

| Scenario | Result | Observed omission / rationalization |
| --- | --- | --- |
| Time pressure: alias disappears after a Codex thread switch | Fails the control | The response proposed immediate production changes to `tmuxRuntimeDiscovery.ts`, `aliasController.ts`, and `dashboard.ts`, explicitly said automated coverage would be deferred, and offered only compile/webpack/manual checks for the urgent patch. It neither selected a behavior ID nor observed a focused RED result before implementation. |
| Orphan local test | Inconclusive control | The agent inspected the repository instead of accepting the hypothetical premise and found the existing attention test is already reached by `quality-linux -> test:ci:linux -> test:deterministic:run`. Its conditional conclusion still correctly stated that a genuinely orphan test is not automated coverage and must be wired to a required suite before production work. |
| Non-deterministic two-window remote regression | Fails the control | The response correctly refused to label a fake as complete automation, but then proposed landing the production fix without pausing, relying on partial coverage plus manual/release-note risk disclosure. It omitted the required explicit user approval for scheduled/manual ownership. |

The time-pressure and non-automatable controls demonstrate repository-specific
gaps in the pre-existing Skills. They justify adding this dedicated discipline
Skill.

## Follow-up results with `fixing-regressions-with-ci`

| Scenario | Result | Required behavior observed |
| --- | --- | --- |
| Time pressure | Pass | Refused a production-first patch; identified a behavior contract and focused contract tests; required the test to be traced through `package.json` to `quality-linux`, then to fail RED before source changes; listed focused, behavior-contract, layered, tmux, and Linux gates for GREEN. |
| Orphan local test | Pass | Explained that an actually orphan test cannot qualify as automated coverage even if it passes locally; it must be wired into an existing required suite before production work, or be recorded as scheduled/manual only with explicit approval, reason, and owner. |
| Non-deterministic two-window remote regression | Pass | Classified the real behavior as an automation gap, refused to label partial/fake coverage as complete, and stopped for explicit user approval before any manual/scheduled exception or production fix. |

## Conclusion

The follow-up controls close the observed baseline loopholes. The final Skill
uses the plan's approved minimal contract without additional, unvalidated rules.
