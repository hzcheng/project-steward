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
| Time pressure: alias disappears after a Codex thread switch | Fails the complete repository-specific control | The response preserved test-first/RED ordering, but omitted the stable behavior ID and the required-PR reachability trace through `package.json`. It still proposed a complete edit-and-verify workflow without those protections. |
| Orphan local test | Inconclusive control | The agent substituted the repository's currently tracked attention test for the stipulated orphan-test premise. Its conditional conclusion correctly rejected genuinely orphan local coverage, but the premise substitution prevents this baseline from proving the control independently. |
| Non-deterministic two-window remote regression | Pass | The response rejected labeling partial/fake coverage as complete automation and preserved the regression's manual/unverified status; any shipment was explicitly a risk-accepted, unverified mitigation. |

The time-pressure control demonstrates the real repository-specific gap in the
pre-existing Skills: RED ordering alone did not require behavior ownership and
required-PR CI reachability. That gap justifies this dedicated discipline
Skill. The orphan control is a prompt-grounding concern, while the two-window
control correctly preserved manual/unverified status.

## Follow-up results with `fixing-regressions-with-ci`

| Scenario | Result | Required behavior observed |
| --- | --- | --- |
| Time pressure | Pass after focused rework | The first GREEN time-pressure run exposed two loopholes: it proposed a production dependency seam before RED and deferred the named required-check trace until after the production-edit plan. The two validated Skill phrases were added; later fresh runs named the behavior contract and required-check trace through `package.json`, observed RED before any production edit, and passed. |
| Orphan local test | Pass | Explained that an actually orphan test cannot qualify as automated coverage even if it passes locally; it must be wired into an existing required suite before production work, or be recorded as scheduled/manual only with explicit approval, reason, and owner. |
| Non-deterministic two-window remote regression | Pass | Classified the real behavior as an automation gap, refused to label partial/fake coverage as complete, and stopped for explicit user approval before any manual/scheduled exception or production fix. |

## Conclusion

The first GREEN time-pressure run exposed the two documented loopholes. The
Skill now includes the validated guards requiring no production edit (including
a test seam) before CI-reachable RED, and requiring the `package.json` trace to
an existing required PR check before any production-edit plan. Later fresh
runs passed. These are validated additions, not unvalidated rules.
