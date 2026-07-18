'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const launchSpec = require('../out/aiSessions/launchSpec');
const commandBuilders = require('../out/aiSessions/commandBuilders');
const runtimeConfiguration = require('../out/aiSessions/runtimeConfiguration');

function config(values) {
    return { get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback };
}

function runRuntimeConfigurationChecks() {
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({})), {
        mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux',
    });
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({
        aiSessionTerminalMode: 'tmux', aiSessionTmuxLayout: 'session', aiSessionTmuxPath: '/opt/bin/tmux',
    })), { mode: 'tmux', tmuxLayout: 'session', tmuxPath: '/opt/bin/tmux' });
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({
        aiSessionTerminalMode: 'bad', aiSessionTmuxLayout: 'bad', aiSessionTmuxPath: '   ',
    })), { mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' });
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({
        aiSessionTerminalMode: null, aiSessionTmuxLayout: 1, aiSessionTmuxPath: false,
    })), { mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' });

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    assert.deepStrictEqual(properties['projectSteward.aiSessionTerminalMode'].enum, ['vscode', 'tmux']);
    assert.strictEqual(properties['projectSteward.aiSessionTerminalMode'].scope, 'machine');
    assert.strictEqual(properties['projectSteward.aiSessionTmuxLayout'].default, 'project');
    assert.strictEqual(properties['projectSteward.aiSessionTmuxPath'].scope, 'machine');
}

function runLaunchSpecChecks() {
    const spec = commandBuilders.buildCodexResumeLaunchSpec(
        `session'; touch /tmp/nope; '`,
        `/work/it's app`,
        `/tmp/done marker`
    );
    assert.strictEqual(spec.executable, 'codex');
    assert.deepStrictEqual(spec.args, ['resume', '--cd', `/work/it's app`, `session'; touch /tmp/nope; '`]);
    assert.strictEqual(spec.cwd, undefined);
    assert.strictEqual(spec.markerPath, '/tmp/done marker');

    const tmuxCommand = launchSpec.serializeTmuxLaunchCommand(spec);
    assert.ok(tmuxCommand.startsWith('exec /bin/sh -lc '));
    assert.ok(tmuxCommand.includes("'\\''"));
    assert.ok(tmuxCommand.includes('rm -f'));
    assert.ok(tmuxCommand.includes(': >'));
    assert.ok(tmuxCommand.includes('exit'));

    assert.deepStrictEqual(
        commandBuilders.buildKimiResumeLaunchSpec('kimi; nope', '/work/Kimi App', '/tmp/kimi.done').args,
        ['--work-dir', '/work/Kimi App', '--resume', 'kimi; nope']
    );
    assert.deepStrictEqual(
        commandBuilders.buildKimiNewSessionLaunchSpec('/work/Kimi App', "owner's task", '/tmp/kimi-new.done').args,
        ['--work-dir', '/work/Kimi App', '--prompt', "owner's task"]
    );
    assert.strictEqual(
        commandBuilders.buildClaudeResumeLaunchSpec('claude-session', '/work/claude', '/tmp/claude.done').cwd,
        '/work/claude'
    );
    assert.strictEqual(
        commandBuilders.buildClaudeNewSessionLaunchSpec('/work/app', 'Title', '/tmp/claude-new.done').cwd,
        '/work/app'
    );
    assert.deepStrictEqual(
        commandBuilders.buildCodexNewSessionLaunchSpec('/work/app', 'Prompt', '/tmp/codex-new.done').args,
        ['--cd', '/work/app', 'Prompt']
    );

    const windowsCommand = launchSpec.serializeDirectLaunchCommand(spec, 'win32');
    assert.ok(windowsCommand.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -Command '));
    assert.ok(windowsCommand.includes("Remove-Item -LiteralPath '/tmp/done marker'"));
    assert.ok(windowsCommand.includes("New-Item -ItemType File -Force -Path '/tmp/done marker'"));
    assert.ok(windowsCommand.includes("'session''; touch /tmp/nope; '''"));
}

runRuntimeConfigurationChecks();
runLaunchSpecChecks();
console.log('AI session tmux checks passed.');
