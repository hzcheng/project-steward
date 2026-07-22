'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const commandBuilders = require('../../../out/aiSessions/commandBuilders');
const launchSpec = require('../../../out/aiSessions/launchSpec');
const runtimeConfiguration = require('../../../out/aiSessions/runtimeConfiguration');
const runtimeTypes = require('../../../out/aiSessions/runtimeTypes');
const tmuxLayout = require('../../../out/aiSessions/tmuxLayout');

function configuration(values) {
    return { get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback };
}

function decodePowerShellPayload(command) {
    const prefix = 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ';
    assert.ok(command.startsWith(prefix));
    return Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
}

test('RUNTIME-RUNTIME-CONFIGURATION-001 reads supported settings and fails closed to manifest defaults', () => {
    assert.deepEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(configuration({})), {
        mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux',
    });
    assert.deepEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(configuration({
        aiSessionTerminalMode: 'tmux',
        aiSessionTmuxLayout: 'session',
        aiSessionTmuxPath: '  /opt/bin/tmux  ',
    })), { mode: 'tmux', tmuxLayout: 'session', tmuxPath: '/opt/bin/tmux' });

    for (const invalid of [
        { aiSessionTerminalMode: 'remote', aiSessionTmuxLayout: 'window', aiSessionTmuxPath: '   ' },
        { aiSessionTerminalMode: null, aiSessionTmuxLayout: 1, aiSessionTmuxPath: false },
    ]) {
        assert.deepEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(configuration(invalid)), {
            mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux',
        });
    }

    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    const mode = properties['projectSteward.aiSessionTerminalMode'];
    const layout = properties['projectSteward.aiSessionTmuxLayout'];
    const executable = properties['projectSteward.aiSessionTmuxPath'];
    assert.deepEqual(mode.enum, ['vscode', 'tmux']);
    assert.equal(mode.scope, 'machine');
    assert.equal(layout.default, 'project');
    assert.equal(layout.scope, 'machine');
    assert.equal(executable.scope, 'machine');
    assert.equal(mode.enum.includes('remote'), false);
});

test('RUNTIME-LAUNCH-SPEC-001 preserves argv boundaries and renders hostile values as inert shell data', () => {
    const resume = commandBuilders.buildCodexResumeLaunchSpec(
        `session'; touch /tmp/nope; '`, `/work/it's app`, '/tmp/done marker'
    );
    assert.deepEqual(resume, {
        executable: 'codex',
        args: ['resume', '--cd', `/work/it's app`, `session'; touch /tmp/nope; '`],
        markerPath: '/tmp/done marker',
        windowsDirectShell: 'current',
    });
    const tmuxCommand = launchSpec.serializeTmuxLaunchCommand(resume);
    assert.ok(tmuxCommand.startsWith('exec /bin/sh -lc '));
    assert.ok(tmuxCommand.includes("'\\''"));
    assert.ok(tmuxCommand.includes('rm -f'));
    assert.ok(tmuxCommand.includes(': >'));
    assert.ok(tmuxCommand.includes('exit'));

    const windowsResumePayload = decodePowerShellPayload(
        launchSpec.serializeDirectLaunchCommand(resume, 'win32')
    );
    assert.ok(windowsResumePayload.includes("Remove-Item -LiteralPath '/tmp/done marker'"));
    assert.ok(windowsResumePayload.includes("New-Item -ItemType File -Force -Path '/tmp/done marker'"));
    assert.ok(windowsResumePayload.includes("'session''; touch /tmp/nope; '''"));

    assert.deepEqual(commandBuilders.buildKimiResumeLaunchSpec(
        'kimi; nope', '/work/Kimi App', '/tmp/kimi.done'
    ), {
        executable: 'kimi', args: ['--work-dir', '/work/Kimi App', '--resume', 'kimi; nope'],
        markerPath: '/tmp/kimi.done', windowsDirectShell: 'current',
    });
    assert.deepEqual(commandBuilders.buildKimiNewSessionLaunchSpec(
        '/work/Kimi App', "owner's task", '/tmp/kimi-new.done'
    ), {
        executable: 'kimi', args: ['--work-dir', '/work/Kimi App', '--prompt', "owner's task"],
        markerPath: '/tmp/kimi-new.done', windowsDirectShell: 'powershell',
    });
    assert.deepEqual(commandBuilders.buildClaudeResumeLaunchSpec(
        'claude-session', '/work/claude', '/tmp/claude.done'
    ), {
        executable: 'claude', args: ['--resume', 'claude-session'], cwd: '/work/claude',
        markerPath: '/tmp/claude.done', windowsDirectShell: 'current',
    });
    assert.deepEqual(commandBuilders.buildClaudeNewSessionLaunchSpec(
        '/work/app', 'Title', '/tmp/claude-new.done'
    ), {
        executable: 'claude', args: ['--name', 'Title'], cwd: '/work/app',
        markerPath: '/tmp/claude-new.done', windowsDirectShell: 'powershell',
    });

    const hostile = `Prompt "quoted"; Set-Content C:\\tmp\\pwned 1; #`;
    const windows = launchSpec.serializeDirectLaunchCommand(
        commandBuilders.buildCodexNewSessionLaunchSpec(`C:\\work\\O'Brien`, hostile, `C:\\tmp\\done`),
        'win32'
    );
    assert.equal(windows.includes('Set-Content'), false);
    const payload = decodePowerShellPayload(windows);
    assert.ok(payload.includes("'Prompt \"quoted\"; Set-Content C:\\tmp\\pwned 1; #'"));
    assert.ok(payload.includes("codex --cd 'C:\\work\\O''Brien'"));
    for (const hostileSpec of [
        commandBuilders.buildKimiNewSessionLaunchSpec(`C:\\work\\O'Brien`, hostile, `C:\\tmp\\done`),
        commandBuilders.buildClaudeNewSessionLaunchSpec(`C:\\work\\O'Brien`, hostile, `C:\\tmp\\done`),
    ]) {
        const hostileCommand = launchSpec.serializeDirectLaunchCommand(hostileSpec, 'win32');
        assert.equal(hostileCommand.includes('Set-Content'), false);
        const hostilePayload = decodePowerShellPayload(hostileCommand);
        assert.ok(hostilePayload.includes("'Prompt \"quoted\"; Set-Content C:\\tmp\\pwned 1; #'"));
        assert.ok(hostileSpec.cwd
            ? hostilePayload.includes("Set-Location -LiteralPath 'C:\\work\\O''Brien'")
            : hostilePayload.includes("'C:\\work\\O''Brien'"));
    }
    assert.equal(commandBuilders.buildCodexResumeCommand(
        'session-1', 'C:\\Repo App', null, 'win32'
    ), 'codex resume --cd "C:\\Repo App" "session-1"');
    assert.equal(commandBuilders.buildKimiResumeCommand(
        'session-1', 'C:\\Repo App', null, 'win32'
    ), 'kimi --work-dir "C:\\Repo App" --resume "session-1"');
    assert.equal(commandBuilders.buildClaudeResumeCommand(
        'session-1', 'C:\\Repo App', null, 'win32'
    ), 'cd "C:\\Repo App" && claude --resume "session-1"');
    assert.equal(decodePowerShellPayload(commandBuilders.buildCodexNewSessionCommand(
        'C:\\Repo App', 'Prompt', null, 'win32'
    )), "codex --cd 'C:\\Repo App' 'Prompt'");
    assert.equal(decodePowerShellPayload(commandBuilders.buildKimiNewSessionCommand(
        'C:\\Repo App', 'Prompt', null, 'win32'
    )), "kimi --work-dir 'C:\\Repo App' --prompt 'Prompt'");
    assert.equal(decodePowerShellPayload(commandBuilders.buildClaudeNewSessionCommand(
        'C:\\Repo App', 'Title', null, 'win32'
    )), "Set-Location -LiteralPath 'C:\\Repo App'; claude --name 'Title'");
    assert.equal(launchSpec.serializeDirectLaunchCommand({
        executable: 'tool', args: ['deploy', '--target', 'value'],
    }, 'linux'), "tool deploy --target 'value'");
    assert.equal(launchSpec.serializeDirectLaunchCommand({
        executable: 'tool', args: ['resume'], windowsDirectShell: 'current',
    }, 'win32'), 'tool "resume"');
});

test('RUNTIME-TMUX-LAYOUT-001 creates stable bounded locators and rejects ambiguous or unsafe metadata', () => {
    assert.equal(runtimeTypes.isValidAiSessionRuntimeIdentityId('pending-codex_1.2:3'), true);
    assert.equal(runtimeTypes.isValidAiSessionRuntimeIdentityId('x'.repeat(512)), true);
    for (const invalidId of ['', '   ', 'pending id', 'pending\ncontrol', '../unsafe', 'x'.repeat(513)]) {
        assert.equal(runtimeTypes.isValidAiSessionRuntimeIdentityId(invalidId), false);
    }

    const identity = { provider: 'codex', projectKey: 'project-key', cwd: '/work/app', sessionId: 'session-1' };
    const project = new tmuxLayout.ProjectTmuxLayout().getLocator(identity);
    const session = new tmuxLayout.SessionTmuxLayout().getLocator(identity);
    assert.deepEqual(project, {
        layout: 'project', sessionName: 'project-steward-p-857b61585ca6ee92',
        windowName: 'ai-codex-391f442b59834258',
    });
    assert.deepEqual(session, {
        layout: 'session', sessionName: 'project-steward-s-codex-391f442b59834258',
    });
    assert.deepEqual(new tmuxLayout.ProjectTmuxLayout().getLocator(identity), project);

    const pending = { ...identity, sessionId: undefined, pendingId: 'p1' };
    assert.deepEqual(new tmuxLayout.ProjectTmuxLayout().getPendingLocator(pending), {
        layout: 'project', sessionName: 'project-steward-p-857b61585ca6ee92',
        windowName: 'pending-codex-20634e8befb9ebc9',
    });
    assert.deepEqual(new tmuxLayout.SessionTmuxLayout().getPendingLocator(pending), {
        layout: 'session', sessionName: 'project-steward-pending-codex-20634e8befb9ebc9',
    });
    assert.equal(tmuxLayout.getTmuxRuntimeKey(identity), '[1,"codex","project-key","session","session-1"]');
    assert.equal(tmuxLayout.getTmuxRuntimeKey(pending), '[1,"codex","project-key","pending","p1"]');

    assert.deepEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'project', projectKey: 'project-key',
        provider: 'codex', sessionId: 'session-1', marker: '/tmp/done',
    }), {
        version: 1, layout: 'project', projectKey: 'project-key', provider: 'codex',
        sessionId: 'session-1', marker: '/tmp/done',
    });
    assert.deepEqual(tmuxLayout.TMUX_METADATA_OPTIONS, {
        managed: '@project-steward-managed', version: '@project-steward-version',
        layout: '@project-steward-layout', projectKey: '@project-steward-project-key',
        provider: '@project-steward-provider', sessionId: '@project-steward-session-id',
        pendingId: '@project-steward-pending-id', createdAt: '@project-steward-created-at',
        marker: '@project-steward-marker',
    });

    for (const invalidIdentity of [
        { ...identity, sessionId: '' },
        { ...identity, provider: 'other' },
        { ...identity, projectKey: 'x'.repeat(513) },
        { ...identity, sessionId: 'session\u001f1' },
    ]) {
        assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator(invalidIdentity));
    }
    assert.throws(() => tmuxLayout.getTmuxRuntimeKey({ ...identity, sessionId: undefined }));
    assert.throws(() => tmuxLayout.getTmuxRuntimeKey({ ...identity, pendingId: 'p1' }));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getPendingLocator({
        ...identity, sessionId: undefined, pendingId: '',
    }));
    assert.deepEqual(new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, pendingId: 'ignored' }), project);
    assert.deepEqual(new tmuxLayout.SessionTmuxLayout().getPendingLocator({
        ...pending, sessionId: 'ignored',
    }), { layout: 'session', sessionName: 'project-steward-pending-codex-20634e8befb9ebc9' });

    assert.equal(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex',
        pendingId: 'p1', createdAt: '2026-07-18T01:02:03.000Z', marker: '/tmp/p1.done',
    }).pendingId, 'p1');

    for (const invalidMetadata of [
        { managed: '1', version: '99' },
        { managed: '1', version: '1', layout: 'other', projectKey: 'project-key', provider: 'codex', sessionId: 's' },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'other', sessionId: 's' },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 's\n1' },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex' },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 's', pendingId: 'p' },
        { managed: '1', version: '1', layout: 'session', projectKey: 'x'.repeat(513), provider: 'codex', sessionId: 's' },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 'x'.repeat(513) },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 's', createdAt: 'x'.repeat(201) },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 's', createdAt: 'not-a-date' },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 's', marker: 'x'.repeat(4097) },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 's', marker: '' },
        { managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 's', marker: '/tmp/control\u007f' },
    ]) {
        assert.equal(tmuxLayout.parseManagedTmuxMetadata(invalidMetadata), null);
    }
});
