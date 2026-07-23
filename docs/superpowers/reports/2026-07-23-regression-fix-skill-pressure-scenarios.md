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
| Non-deterministic two-window remote regression | Partial failure | The response correctly rejected labeling partial/fake coverage as complete automation and kept the real regression manual/unverified. It proposed recording the real flow as manual and said mandated shipment must be a risk-accepted unverified mitigation, but the preserved response did not explicitly stop to obtain user approval before manual/scheduled ownership or shipping. |

The time-pressure control demonstrates the real repository-specific gap in the
pre-existing Skills: RED ordering alone did not require behavior ownership and
required-PR CI reachability. That gap justifies this dedicated discipline
Skill. The orphan control is a prompt-grounding concern. The two-window control
got the automation classification right but omitted the required explicit
approval stop, so it is a partial baseline failure that further justifies the
Skill's automation boundary.

## Follow-up results with `fixing-regressions-with-ci`

| Scenario | Result | Required behavior observed |
| --- | --- | --- |
| Time pressure | Pass after focused rework | The first GREEN time-pressure run exposed two loopholes: it proposed a production dependency seam before RED and deferred the named required-check trace until after the production-edit plan. The two validated Skill phrases were added; later fresh runs named the behavior contract and required-check trace through `package.json`, observed RED before any production edit, and passed. |
| Orphan local test | Pass | Explained that an actually orphan test cannot qualify as automated coverage even if it passes locally; it must be wired into an existing required suite before production work, or be recorded as scheduled/manual only with explicit approval, reason, and owner. |
| Non-deterministic two-window remote regression | Pass | Classified the real behavior as an automation gap, refused to label partial/fake coverage as complete, and stopped for explicit user approval before any manual/scheduled exception or production fix. |

## Supplied-worktree preflight control

A fresh read-only agent used the current `fixing-regressions-with-ci` Skill and
its required `protecting-main-with-worktrees` sub-skill. The prompt stipulated
a dirty, stale user-supplied worktree under time pressure and prohibited
replacing the hypothetical with actual repository state.

| Scenario | Result | Exact decision criteria and observed behavior |
| --- | --- | --- |
| Dirty and stale user-supplied worktree | Pass | The response began, “No. I would not diagnose, add a test, or patch production code in the supplied dirty, stale worktree.” It required clean `git status`, confirmation of the task branch, intended remote and protected base, and isolated worktree; it then required fetching `<remote>/<base>` and ensuring the task worktree starts from that current fetched base rather than a stale snapshot. Because the supplied tree failed the clean/current criteria, it left it untouched—no stash, reset, rebase, test edit, or patch—and selected a fresh sibling worktree from the fetched base. |

This control satisfied the design's preflight behavior through the existing
required Skill combination. No redundant preflight wording was added to
`fixing-regressions-with-ci`.

## Conclusion

The first GREEN time-pressure run exposed the two documented loopholes. The
Skill now includes the validated guards requiring no production edit (including
a test seam) before CI-reachable RED, and requiring the `package.json` trace to
an existing required PR check before any production-edit plan. Later fresh
runs passed. The supplied-worktree control also passed without a Skill edit.
These are validated conclusions, not invented rules.
