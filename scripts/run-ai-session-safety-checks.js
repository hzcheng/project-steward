'use strict';

const assert = require('assert');
const commands = require('../out/aiSessions/commandBuilders');
const helpers = require('../out/aiSessions/sessionHelpers');
const providers = require('../out/aiSessions/providers');
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
runDisplayChecks();
runKeyChecks();
runProviderChecks();
runCommandBuilderChecks();

console.log('AI session safety checks passed.');
