'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const commands = require('../out/aiSessions/commandBuilders');
const helpers = require('../out/aiSessions/sessionHelpers');
const providers = require('../out/aiSessions/providers');
const ClaudeSessionService = require('../out/services/claudeSessionService').default;
const GitRepositoryDetector = require('../out/projects/gitRepositoryDetector').default;
const projectPathUtils = require('../out/projects/projectPathUtils');

function runPathChecks() {
    assert.strictEqual(helpers.normalizeAiSessionComparablePath('/work/app/'), '/work/app');
    assert.strictEqual(helpers.normalizeAiSessionComparablePath('/work/My%20App/'), '/work/My App');
    assert.strictEqual(helpers.normalizeAiSessionComparablePath('C:\\work\\app\\'), 'C:/work/app');
    assert.strictEqual(helpers.aiSessionPathContains('/work/app', '/work/app/src'), true);
    assert.strictEqual(helpers.aiSessionPathContains('/work/My App', '/work/My%20App/src'), true);
    assert.strictEqual(helpers.aiSessionPathContains('/work/app', '/work/application'), false);
    assert.strictEqual(helpers.aiSessionPathContains('', '/work/app'), false);
    assert.strictEqual(projectPathUtils.normalizeRemoteAuthority('ssh-remote%2Bserver'), 'ssh-remote+server');
    assert.strictEqual(projectPathUtils.normalizeRemoteAuthority('dev-container+abc'), 'dev-container+abc');
    assert.strictEqual(projectPathUtils.normalizePosixPath('/work/app/../app/src/'), '/work/app/src');
    assert.strictEqual(projectPathUtils.normalizePosixPath('/'), '/');
    assert.strictEqual(projectPathUtils.isPathInside('/work/app/src', '/work/app'), true);
    assert.strictEqual(projectPathUtils.isPathInside('/work/application', '/work/app'), false);
    assert.strictEqual(projectPathUtils.isPathInside('/work/app', '/work/app'), false);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app', '/work/app', true), 100);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app/src', '/work/app', true), 80);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app', '/work/app/src', true), 70);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app', '/work/app/file.ts', false), 40);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app', '/other/app', false), 10);
    assert.strictEqual(projectPathUtils.ensureLeadingSlash('work/app'), '/work/app');
    assert.strictEqual(projectPathUtils.ensureLeadingSlash('/work/app'), '/work/app');
    assert.strictEqual(projectPathUtils.encodeRemoteAuthority('ssh-remote+user@host'), 'ssh-remote%2Buser@host');
}

function runAssignmentChecks() {
    const candidates = [
        { project: { id: 'root' }, path: '/work' },
        { project: { id: 'app' }, path: '/work/app' },
    ];
    const sessions = [
        { id: 's1', name: 'One', cwd: '/work/app/src' },
        { id: 's2', name: 'Two', cwd: '/elsewhere' },
    ];
    const assignments = helpers.assignAiSessionsToProjects(candidates, sessions, session => session.cwd);

    assert.deepStrictEqual((assignments.get('app') || []).map(session => session.id), ['s1']);
    assert.strictEqual(assignments.has('root'), false);
}

function runCandidateFilterChecks() {
    const result = {
        available: true,
        sessions: [
            { id: 's1', name: 'One', cwd: '/work/app/src' },
            { id: 's2', name: 'Two', cwd: '/elsewhere' },
        ],
    };
    const filtered = helpers.filterAiSessionsByCandidatePaths(result, ['/work/app'], session => session.cwd);

    assert.deepStrictEqual(filtered.sessions.map(session => session.id), ['s1']);
    assert.strictEqual(helpers.filterAiSessionsByCandidatePaths(result, [], session => session.cwd), result);
    assert.deepStrictEqual(helpers.normalizeAiSessionCandidatePaths(['/work/app/', '/work/app', '']).map(item => item), ['/work/app']);
}

function runDisplayChecks() {
    const prepared = helpers.prepareAiSessionsForDisplay(
        [
            { id: 'old', name: 'Old', updatedAt: '2024-01-01T00:00:00Z' },
            { id: 'pinned', name: 'Pinned', updatedAt: '2020-01-01T00:00:00Z' },
            { id: 'new', name: 'New', updatedAt: '2025-01-01T00:00:00Z' },
        ],
        'codex',
        new Set(['codex:pinned']),
        { 'codex:new': 'Alias New' },
        2
    );

    assert.deepStrictEqual(prepared.map(session => session.id), ['pinned', 'new']);
    assert.strictEqual(prepared[0].provider, 'codex');
    assert.strictEqual(prepared[0].pinned, true);
    assert.strictEqual(prepared[1].name, 'Alias New');
}

function runKeyChecks() {
    const isProviderId = value => value === 'codex' || value === 'kimi' || value === 'claude';

    assert.strictEqual(helpers.getAiSessionKey('kimi', 'abc'), 'kimi:abc');
    assert.strictEqual(helpers.getAiSessionProviderIdFromKey('claude:xyz', isProviderId), 'claude');
    assert.strictEqual(helpers.getAiSessionProviderIdFromKey('unknown:xyz', isProviderId), null);
    assert.strictEqual(helpers.getAiSessionProviderIdFromKey(':missing', isProviderId), null);
}

function runWebviewContentChecks() {
    const webviewContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewContent.ts'), 'utf8');
    const webviewProjectScripts = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewProjectScripts.js'), 'utf8');
    const webviewIcons = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewIcons.ts'), 'utf8');
    const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.scss'), 'utf8');
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const settingsFunction = extractFunctionBody(dashboard, 'showProjectStewardSettings');

    assert.ok(webviewContent.includes('data-action="add" title="Add Project"'));
    assert.ok(webviewContent.includes('class="project no-projects" data-action="add-project" data-nodrag'));
    assert.ok(!webviewContent.includes('getAddProjectDiv(group.id)'));
    assert.ok(!webviewContent.includes('function getAddProjectDiv'));
    assert.ok(webviewContent.includes('class="settings-button" data-action="open-settings"'));
    assert.ok(webviewProjectScripts.includes("type: 'open-settings'"));
    assert.ok(dashboard.includes("case 'open-settings':"));
    assert.ok(settingsFunction.includes("executeCommand('workbench.action.openSettings', '@ext:hzcheng.project-steward')"));
    assert.ok(!settingsFunction.includes('showQuickPick'));
    assert.ok(!settingsFunction.includes('ai-session-terminal-mode-planned'));
    assert.ok(webviewContent.includes('.settings-button,'));
    assert.ok(styles.includes('max-width: calc(100% - 76px);'));
    assert.ok(styles.includes('margin-left: 4px;'));
    assert.ok(styles.includes('width: 18px;'));
    assert.ok(styles.includes('height: 18px;'));
    assert.ok(styles.includes('width: 17px;'));
    assert.ok(styles.includes('height: 17px;'));
    assert.ok(styles.includes('fill: currentColor;'));
    assert.ok(styles.includes('.codex-session-pin {'));
    assert.ok(styles.includes('stroke: currentColor;'));
    assert.ok(styles.includes('opacity: 1;'));
    assert.ok(!styles.includes('opacity: 0.86;'));
    assert.ok(webviewContent.includes('width: 18px;'));
    assert.ok(webviewContent.includes('height: 18px;'));
    assert.ok(webviewIcons.includes('<svg viewBox="0 0 448 512">'));
    assert.ok(webviewIcons.includes('M19.43 12.98'));
    assert.ok(webviewIcons.includes('stroke-linecap="round"'));
    assert.ok(webviewContent.includes('class="codex-session-actions"'));
    assert.ok(webviewContent.includes('<button type="button" class="codex-session-pin'));
    assert.ok(webviewContent.includes('<button type="button" class="codex-session-archive"'));
    assert.ok(styles.includes('.codex-session-actions'));
    assert.ok(styles.includes('[data-session-pinned] .codex-session-actions'));
    assert.ok(!packageJson.contributes.configuration.properties['projectSteward.aiSessionTerminalMode']);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.storeProjectsInSettings'].default, true);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.maxVisibleAiSessions'].default, 5);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.maxVisibleAiSessions'].minimum, 1);
    assert.ok(webviewContent.includes('--steward-ai-session-list-max-height: ${getAiSessionListMaxHeight(config)}px;'));
    assert.ok(webviewContent.includes('Number.isFinite(visibleRows)'));
    assert.ok(styles.includes('max-height: var(--steward-ai-session-list-max-height, calc(5 * 40px + 4 * 2px));'));
}

function extractFunctionBody(source, functionName) {
    const signature = `function ${functionName}(`;
    const signatureIndex = source.indexOf(signature);
    assert.notStrictEqual(signatureIndex, -1);

    const openingBraceIndex = source.indexOf('{', signatureIndex);
    assert.notStrictEqual(openingBraceIndex, -1);

    let depth = 0;
    for (let i = openingBraceIndex; i < source.length; i++) {
        if (source[i] === '{') {
            depth++;
        } else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(openingBraceIndex + 1, i);
            }
        }
    }

    assert.fail(`Could not extract ${functionName}`);
}

function runGitRepositoryDetectorChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-git-'));
    try {
        const repoRoot = path.join(tempRoot, 'repo');
        const nestedDir = path.join(repoRoot, 'src');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.git'));

        const detector = new GitRepositoryDetector();
        assert.strictEqual(detector.isGitRepositoryPath(nestedDir), true);
        assert.strictEqual(detector.isGitRepositoryPath('vscode-remote://ssh-remote+host/work/repo'), false);
        assert.strictEqual(detector.isGitRepositoryPath(path.join(tempRoot, 'missing')), false);

        const worktreeRoot = path.join(tempRoot, 'worktree');
        fs.mkdirSync(worktreeRoot, { recursive: true });
        fs.writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: /tmp/git/worktrees/worktree\n');
        assert.strictEqual(detector.isGitRepositoryPath(worktreeRoot), true);

        const initializedLaterBase = createTempRootWithoutGitAncestor();
        if (initializedLaterBase) {
            try {
                const initializedLaterRoot = path.join(initializedLaterBase, 'initialized-later');
                fs.mkdirSync(initializedLaterRoot, { recursive: true });
                assert.strictEqual(detector.isGitRepositoryPath(initializedLaterRoot), false);
                fs.mkdirSync(path.join(initializedLaterRoot, '.git'));
                assert.strictEqual(detector.isGitRepositoryPath(initializedLaterRoot), true);
            } finally {
                fs.rmSync(initializedLaterBase, { recursive: true, force: true });
            }
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function createTempRootWithoutGitAncestor() {
    for (const base of [os.tmpdir(), os.homedir()]) {
        if (!hasGitAncestor(base)) {
            return fs.mkdtempSync(path.join(base, 'project-steward-nongit-'));
        }
    }

    return null;
}

function hasGitAncestor(directory) {
    let currentDir = path.resolve(directory);
    while (currentDir) {
        if (fs.existsSync(path.join(currentDir, '.git'))) {
            return true;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            return false;
        }

        currentDir = parentDir;
    }

    return false;
}

function runClaudeSessionChecks() {
    const previousClaudeHome = process.env.CLAUDE_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-claude-'));
    const sessionId = '11111111-1111-4111-8111-111111111111';
    try {
        process.env.CLAUDE_HOME = tempRoot;
        const sessionDir = path.join(tempRoot, 'projects', '-work-app');
        fs.mkdirSync(sessionDir, { recursive: true });
        const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
        const fillerLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(4096) } }) + '\n';
        const cwdLine = JSON.stringify({ sessionId, cwd: '/work/app', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n';

        fs.writeFileSync(
            sessionFile,
            fillerLine.repeat(40) + cwdLine + fillerLine.repeat(40),
            'utf8'
        );

        const result = new ClaudeSessionService().getSessions({ candidatePaths: ['/work/app'] });
        assert.strictEqual(result.available, true);
        assert.deepStrictEqual(result.sessions.map(session => session.id), [sessionId]);
        assert.strictEqual(result.sessions[0].cwd, '/work/app');
    } finally {
        if (previousClaudeHome === undefined) {
            delete process.env.CLAUDE_HOME;
        } else {
            process.env.CLAUDE_HOME = previousClaudeHome;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runProviderChecks() {
    assert.deepStrictEqual(providers.AI_SESSION_PROVIDER_IDS, ['codex', 'kimi', 'claude']);
    assert.strictEqual(providers.getAiSessionProviderLabel('codex'), 'Codex');
    assert.strictEqual(providers.getAiSessionProviderLabel('kimi'), 'Kimi');
    assert.strictEqual(providers.getAiSessionProviderLabel('claude'), 'Claude');
    assert.strictEqual(providers.getAiSessionProviderDefinition('codex').terminalEnvKey, 'PROJECT_STEWARD_CODEX_SESSION_ID');
    assert.strictEqual(providers.getAiSessionProviderDefinition('kimi').markerDirName, 'kimi-session-terminals');
    assert.strictEqual(providers.getAiSessionProviderDefinition('codex').projectSessionsKey, 'codexSessions');
    assert.strictEqual(providers.getAiSessionProviderDefinition('kimi').projectSessionsUnavailableKey, 'kimiSessionsUnavailable');
    assert.strictEqual(providers.getAiSessionProviderDefinition('claude').terminalEnvKey, 'PROJECT_STEWARD_CLAUDE_SESSION_ID');
    assert.deepStrictEqual(providers.getAiSessionProviderDefinition('codex').terminalCwdFields, ['cwd']);
    assert.deepStrictEqual(providers.getAiSessionProviderDefinition('kimi').terminalCwdFields, ['workDir', 'cwd']);
    assert.deepStrictEqual(providers.getAiSessionProviderDefinition('claude').terminalCwdFields, ['workDir', 'cwd']);
    assert.strictEqual(
        providers.getAiSessionProviderDefinition('codex').buildNewSessionCommand('/work/app', 'Ignored Title', null),
        "codex --cd '/work/app'"
    );
    assert.strictEqual(
        providers.getAiSessionProviderDefinition('claude').buildNewSessionCommand('/work/app', 'Useful Title', null),
        "cd '/work/app' && claude --name 'Useful Title'"
    );
}

function runCommandBuilderChecks() {
    assert.strictEqual(
        commands.buildCodexResumeCommand('abc123', '/work/My App', null, 'linux'),
        "codex resume --cd '/work/My App' 'abc123'"
    );
    assert.strictEqual(
        commands.buildKimiNewSessionCommand('/work/app', "owner's task", null, 'linux'),
        "kimi --work-dir '/work/app' --prompt 'owner'\\''s task'"
    );
    let markedCommand = commands.buildClaudeResumeCommand('session-1', '/work/app', '/tmp/session.done', 'linux');
    assert.ok(markedCommand.startsWith('sh -lc '));
    assert.ok(markedCommand.includes('claude --resume'));
    assert.ok(markedCommand.includes('rm -f'));
    assert.ok(markedCommand.includes(': >'));
    assert.ok(markedCommand.includes('/tmp/session.done'));

    let markedCodexNewCommand = commands.buildCodexNewSessionCommand('/work/app', null, '/tmp/new-codex.done', 'linux');
    assert.ok(markedCodexNewCommand.startsWith('sh -lc '));
    assert.ok(markedCodexNewCommand.includes("codex --cd"));
    assert.ok(markedCodexNewCommand.includes('/tmp/new-codex.done'));

    let windowsCommand = commands.buildClaudeResumeCommand('session-1', 'C:\\Repo', 'C:\\Temp\\session.done', 'win32');
    assert.ok(windowsCommand.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -Command '));
    assert.ok(windowsCommand.includes("Set-Location -LiteralPath 'C:\\Repo'"));
    assert.ok(windowsCommand.includes("Remove-Item -LiteralPath 'C:\\Temp\\session.done'"));
    assert.ok(windowsCommand.includes("New-Item -ItemType File -Force -Path 'C:\\Temp\\session.done'"));
    let windowsNewCommand = commands.buildCodexNewSessionCommand('C:\\Repo', null, 'C:\\Temp\\new-codex.done', 'win32');
    assert.ok(windowsNewCommand.includes("codex --cd 'C:\\Repo'"));
    assert.ok(windowsNewCommand.includes("New-Item -ItemType File -Force -Path 'C:\\Temp\\new-codex.done'"));
    assert.strictEqual(commands.quotePowerShellArg("O'Brien"), "'O''Brien'");
}

runPathChecks();
runAssignmentChecks();
runCandidateFilterChecks();
runDisplayChecks();
runKeyChecks();
runWebviewContentChecks();
runGitRepositoryDetectorChecks();
runClaudeSessionChecks();
runProviderChecks();
runCommandBuilderChecks();

console.log('AI session safety checks passed.');
