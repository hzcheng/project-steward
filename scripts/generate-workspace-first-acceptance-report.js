'use strict';

const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const outputPath = path.join(
    repositoryRoot,
    'docs',
    'superpowers',
    'reports',
    '2026-07-20-workspace-first-acceptance.md',
);

const environments = ['Local', 'SSH', 'WSL', 'Dev Container'];
const workspaceKinds = ['single-folder', 'saved multi-root', 'untitled multi-root'];
const providers = ['Codex', 'Kimi', 'Claude'];
const runtimeLayouts = ['Direct Terminal', 'project-layout tmux', 'session-layout tmux'];

function environmentReason(environment, activity) {
    switch (environment) {
        case 'Local':
            return `NOT-RUN: this execution is inside a Dev Container; no Local/UI Extension Host, controlled ${activity}, or authoritative UI automation channel is available.`;
        case 'SSH':
            return `NOT-RUN: SSH_CONNECTION is unset; no Remote SSH Extension Host, controlled ${activity}, or authoritative UI automation channel is available.`;
        case 'WSL':
            return `NOT-RUN: WSL_DISTRO_NAME is unset; no WSL Extension Host, controlled ${activity}, or authoritative UI automation channel is available.`;
        case 'Dev Container':
            return `NOT-RUN: the Dev Container workspace Extension Host is available, but there is no controlled ${activity} and no authoritative UI automation channel for the interactive VS Code/provider flow.`;
        default:
            throw new Error(`Unknown environment: ${environment}`);
    }
}

function escapeCell(value) {
    return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderMatrix(marker, rows) {
    const columns = [
        'Environment',
        'Workspace kind',
        'Provider',
        'Runtime layout',
        'Action',
        'Expected result',
        'Observed result',
        'Evidence',
        'Status',
    ];
    const lines = [
        `<!-- ${marker}:start -->`,
        `| ${columns.join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${columns.map(column => escapeCell(row[column])).join(' | ')} |`),
        `<!-- ${marker}:end -->`,
    ];
    return lines.join('\n');
}

const navigationRows = environments.flatMap(environment => workspaceKinds.map(workspaceKind => ({
    Environment: environment,
    'Workspace kind': workspaceKind,
    Provider: 'N/A',
    'Runtime layout': 'OTHER WINDOWS',
    Action: 'Select another-window workspace card',
    'Expected result': workspaceKind === 'untitled multi-root'
        ? 'Ask the user to save first; never open a member root.'
        : 'Use the native Switch Window fallback when direct focus is unproven; never open a member root.',
    'Observed result': environmentReason(environment, `${workspaceKind} source and target window pair`),
    Evidence: 'Navigation feasibility report records this cell as not-runnable and production capability as false; automated fallback checks are not manual evidence.',
    Status: 'BLOCKED',
})));

const launchRows = environments.flatMap(environment => workspaceKinds.flatMap(workspaceKind =>
    providers.flatMap(provider => runtimeLayouts.map(runtimeLayout => ({
        Environment: environment,
        'Workspace kind': workspaceKind,
        Provider: provider,
        'Runtime layout': runtimeLayout,
        Action: 'Create new session and resume historical session',
        'Expected result': 'One correct primary cwd; every other valid current root is granted with the provider-native --add-dir shape; immutable launch ownership; no partial launch.',
        'Observed result': environmentReason(
            environment,
            `${workspaceKind} fixture with interactive ${provider} ${runtimeLayout} new/resume sessions`,
        ),
        Evidence: 'Automated launch-spec, preflight, runtime-ownership, and fake/real-tmux checks passed; automation is not counted as this manual cell.',
        Status: 'BLOCKED',
    })))
));

const supplementalRows = environments.flatMap(environment => workspaceKinds.map(workspaceKind => ({
    Environment: environment,
    'Workspace kind': workspaceKind,
    Provider: 'Codex / Kimi / Claude',
    'Runtime layout': 'Direct / project tmux / session tmux',
    Action: 'Current card; focus/attach; attention; archive; root add/remove; workspace save; close/unregister; navigation; Restricted Mode; missing capability',
    'Expected result': 'One workspace card and workspace-scoped behavior; blocked launches have no side effects; save preserves existing projects; close unregisters exactly once.',
    'Observed result': environmentReason(environment, `${workspaceKind} end-to-end workspace lifecycle`),
    Evidence: 'Behavioral automation covers the controller/store boundaries, but no interactive environment lifecycle was executed for this cell.',
    Status: 'BLOCKED',
})));

const manualStatuses = [...navigationRows, ...launchRows, ...supplementalRows]
    .map(row => row.Status);
const overallStatus = manualStatuses.some(status => status === 'FAIL' || status === 'BLOCKED')
    ? 'BLOCKED'
    : 'PASS';

const productCriteria = [
    ['1', 'Zero cards for empty; one current card for every non-empty supported workspace kind.', 'Dashboard and open-workspace safety suites, including the explicit non-null zero-root rejection fixture.'],
    ['2', 'Roots are metadata only and never sibling live cards.', 'Workspace projection/render/search/source-gate checks.'],
    ['3', 'OTHER WINDOWS de-duplicates by navigation identity, excludes self, and exposes no session/provider details.', 'Protocol/projection/privacy checks.'],
    ['4', 'Navigation uses exact navigationUri or documented fallback and never a member root.', 'Navigation controller and 12-cell fail-closed feasibility gate.'],
    ['5', 'All providers receive the complete multi-root scope for new and resume.', 'Exact structured launch-spec checks for Codex, Kimi, and Claude.'],
    ['6', 'Primary-root ordering, longest nested match, and root chips are correct.', 'Session-scope, assignment, hydration, and Dashboard checks.'],
    ['7', 'Invalid root, Restricted Mode, unavailable provider, or missing capability creates no partial launch.', 'Creation/resume preflight and side-effect ledger checks.'],
    ['8', 'Runtime ownership is immutable and removed-root continuity alone yields Outside workspace.', 'Runtime v2/Tmux/Direct hydration and explicit Outside workspace rendering checks.'],
    ['9', 'Strict v3 publication is zero-or-one per instance and bridge failure degrades only OTHER WINDOWS.', 'Bridge client/store/coordinator/degradation checks.'],
    ['10', 'Workspace saving adds one project while preserving every existing saved-project field and member entry.', 'Checked-in Group[] fixture through real ProjectService startup migration, ordinary reads, ProjectMutationController, saved adapter, and serialized-prefix equivalence checks.'],
    ['11', 'Attention de-duplicates workspace evidence and search headings/targets are workspace-native.', 'Attention projection and exact Dashboard search-catalog checks.'],
    ['12', 'Production retains no v1 live-project/runtime compatibility path.', 'Architecture source gate and final forbidden-vocabulary scan.'],
];

const automatedCommands = [
    ['npm run vscode:prepublish', 'PASS', 'Production main bundle, Webview copy, and styles build completed; webpack emitted deprecation warnings only.'],
    ['npm run attention:bridge:bundle', 'PASS', 'Production UI Bridge v3 bundle completed; webpack emitted deprecation warnings only.'],
    ['npm run lint', 'PASS', 'Exited 0 with the repository established warning baseline and no errors.'],
    ['npm run test:safety', 'PASS', 'AI session, open workspace, bridge, save, and fake-tmux safety suites passed.'],
    ['npm run test:dashboard', 'PASS', 'Dashboard Webview checks passed.'],
    ['npm run test:tmux:smoke', 'PASS', 'Real isolated tmux smoke checks passed in the Dev Container POSIX host.'],
    ['npm run test:architecture-baseline', 'PASS', 'Performance and architecture baseline checks passed.'],
    ['npm run test:release-notes', 'PASS', 'Release notes and workspace-first documentation checks passed.'],
    ['npm run test:release-packaging', 'PASS', 'Seeded stale outputs were cleaned; both extensions rebuilt; real VSIX entries/manifests/bundles and exact matrix domains passed inspection.'],
    ['git diff --check', 'PASS', 'No whitespace errors.'],
];

const report = `# Workspace-First Acceptance Report

Date: 2026-07-21

**Overall status: ${overallStatus}**

Automated acceptance and the real isolated tmux smoke test pass in the current
Dev Container. Manual acceptance remains release-blocking: all 12 navigation
cells and all 108 launch-ownership cells are explicitly NOT-RUN/BLOCKED. No
support-matrix cell has been removed or approved for removal.

## Product acceptance criteria

| Criterion | Required behavior | Automated evidence | Acceptance status |
| --- | --- | --- | --- |
${productCriteria.map(row => `| ${row.join(' | ')} | AUTOMATED PASS / MANUAL BLOCKED |`).join('\n')}

## Automated verification

| Command | Status | Observed evidence |
| --- | --- | --- |
${automatedCommands.map(row => `| \`${row[0]}\` | ${row[1]} | ${row[2]} |`).join('\n')}

The production package command built
\`artifacts/project-steward-2.1.3.vsix\` and
\`artifacts/project-steward-attention-ui-bridge-0.1.4.vsix\`. The main archive
contains \`dist/dashboard.js\`, generated Webview/style assets, and only the
required JavaScript under \`out/workspaces\` and \`out/openWorkspaces\`; the
bridge archive contains its v3 \`dist/extension.js\`. Archive listing checks
found no spike, disposable probe, \`.superpowers\`, design/report, source, or
test-only files.

## Navigation matrix (12 cells)

${renderMatrix('workspace-navigation-matrix', navigationRows)}

Result: 0 direct-navigation capabilities enabled, 12 blocked cells. There were
**0 violations observed across 0 runnable manual navigation trials**. That zero
is not positive navigation evidence and does not clear the gate. Automated
tests prove only that the fail-closed policy selects native Switch Window/save
fallbacks and never substitutes a member-root URI.

## Launch ownership matrix (108 cells)

Each row requires both new and resume. The matrix is the Cartesian product of
4 environments × 3 workspace kinds × 3 providers × 3 runtime layouts.

${renderMatrix('workspace-launch-matrix', launchRows)}

Result: 108 blocked cells. Provider command builders and runtime boundaries
are automated, but no automated result is promoted to manual PASS.

## Supplemental lifecycle matrix (12 environment/workspace-kind cells)

${renderMatrix('workspace-supplemental-matrix', supplementalRows)}

## Saved-project preservation evidence

The checked-in representative fixture is
\`scripts/fixtures/workspace-first-saved-projects.json\`. It uses the real
serialized \`Group[]\` store shape and includes group name/collapse state plus
member paths, remote types, descriptions, colors, favorite state, favorite
order, and Git metadata. The open-workspace safety suite seeds that JSON into a
real \`ProjectService\` global-state store. Production startup migrates it to
settings, ordinary production reads leave the persisted serialization
unchanged, and a second startup consumes the pending save through
\`SavedWorkspaceProjectAdapter\`, \`ProjectMutationController\`, and
\`ProjectService.addProject\`. The test proves byte-for-byte equality at the
serialized JSON boundary for every original group/member prefix and source
store, while exactly one workspace record is appended. It does not claim raw
VS Code storage-file byte identity outside that controlled serialization
boundary.

## Release decision

Do not release workspace-first support as fully accepted. The implementation,
automated suite, production artifacts, safe navigation fallback, and saved-data
preservation evidence are ready for review, but the documented support matrix
still requires controlled Local, SSH, WSL, and Dev Container manual runs. Any
future PASS must cite the exact interactive observation; any FAIL remains
release-blocking, and a BLOCKED cell may clear only through real evidence or an
explicitly narrowed, approved support matrix.
`;

fs.writeFileSync(outputPath, report, 'utf8');
console.log(`Generated ${path.relative(repositoryRoot, outputPath)} (${navigationRows.length} navigation, ${launchRows.length} launch, ${supplementalRows.length} supplemental cells).`);
