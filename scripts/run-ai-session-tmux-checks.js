'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const launchSpec = require('../out/aiSessions/launchSpec');
const commandBuilders = require('../out/aiSessions/commandBuilders');
const runtimeConfiguration = require('../out/aiSessions/runtimeConfiguration');
const tmuxLayout = require('../out/aiSessions/tmuxLayout');
const tmuxClientModule = require('../out/aiSessions/tmuxClient');
const discoveryModule = require('../out/aiSessions/tmuxRuntimeDiscovery');
const runtimeStoreModule = require('../out/aiSessions/tmuxRuntimeBindingStore');
const attachStoreModule = require('../out/aiSessions/tmuxAttachBindingStore');
const creationLock = require('../out/aiSessions/tmuxCreationLock');

function config(values) {
    return { get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback };
}

function decodePowerShellPayload(command) {
    const prefix = 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ';
    assert.ok(command.startsWith(prefix));
    return Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
}

function quotePowerShellLiteral(value) {
    return `'${String(value).replace(/'/g, `''`)}'`;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function runtimeRecordFilename(record) {
    const identity = record.state === 'pending'
        ? [record.pendingId]
        : [record.provider, record.sessionId];
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify([1, record.state, ...identity]), 'utf8')
        .digest('hex');
    return `${record.state}-${digest}.json`;
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
    const windowsPayload = decodePowerShellPayload(windowsCommand);
    assert.ok(windowsPayload.includes("Remove-Item -LiteralPath '/tmp/done marker'"));
    assert.ok(windowsPayload.includes("New-Item -ItemType File -Force -Path '/tmp/done marker'"));
    assert.ok(windowsPayload.includes("'session''; touch /tmp/nope; '''"));

    const adversarialValues = {
        prompt: `Prompt "quoted"; Set-Content C:\\tmp\\prompt-pwned 1; #`,
        title: `Title "quoted"; Set-Content C:\\tmp\\title-pwned 1; #`,
        session: `Session "quoted"; Set-Content C:\\tmp\\session-pwned 1; #`,
        cwd: `C:\\work\\O'Brien "quoted"; Set-Content C:\\tmp\\cwd-pwned 1; #`,
        marker: `C:\\tmp\\done "quoted"; Set-Content C:\\tmp\\marker-pwned 1; #`,
    };
    const windowsSpecs = [
        commandBuilders.buildCodexNewSessionLaunchSpec(adversarialValues.cwd, adversarialValues.prompt, adversarialValues.marker),
        commandBuilders.buildClaudeNewSessionLaunchSpec(adversarialValues.cwd, adversarialValues.title, adversarialValues.marker),
        commandBuilders.buildCodexResumeLaunchSpec(adversarialValues.session, adversarialValues.cwd, adversarialValues.marker),
    ];
    for (const windowsSpec of windowsSpecs) {
        const command = launchSpec.serializeDirectLaunchCommand(windowsSpec, 'win32');
        assert.strictEqual(command.includes('Set-Content'), false);
        const payload = decodePowerShellPayload(command);
        assert.ok(payload.includes(quotePowerShellLiteral(adversarialValues.marker)));
        for (const value of Object.values(adversarialValues)) {
            if (windowsSpec.args.includes(value)) {
                assert.ok(payload.includes(quotePowerShellLiteral(value)));
            }
        }
        if (windowsSpec.cwd) {
            assert.ok(payload.includes(`Set-Location -LiteralPath ${quotePowerShellLiteral(windowsSpec.cwd)}`));
        }
    }

    assert.strictEqual(
        commandBuilders.buildCodexResumeCommand('session-1', 'C:\\Repo App', null, 'win32'),
        'codex resume --cd "C:\\Repo App" "session-1"'
    );
    assert.strictEqual(
        commandBuilders.buildKimiResumeCommand('session-1', 'C:\\Repo App', null, 'win32'),
        'kimi --work-dir "C:\\Repo App" --resume "session-1"'
    );
    assert.strictEqual(
        commandBuilders.buildClaudeResumeCommand('session-1', 'C:\\Repo App', null, 'win32'),
        'cd "C:\\Repo App" && claude --resume "session-1"'
    );

    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildCodexNewSessionCommand('C:\\Repo App', 'Prompt', null, 'win32')),
        "codex --cd 'C:\\Repo App' 'Prompt'"
    );
    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildKimiNewSessionCommand('C:\\Repo App', 'Prompt', null, 'win32')),
        "kimi --work-dir 'C:\\Repo App' --prompt 'Prompt'"
    );
    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildClaudeNewSessionCommand('C:\\Repo App', 'Title', null, 'win32')),
        "Set-Location -LiteralPath 'C:\\Repo App'; claude --name 'Title'"
    );

    assert.strictEqual(
        launchSpec.serializeDirectLaunchCommand({ executable: 'tool', args: ['deploy', '--target', 'value'] }, 'linux'),
        "tool deploy --target 'value'"
    );
    assert.strictEqual(
        launchSpec.serializeDirectLaunchCommand({
            executable: 'tool', args: ['resume'], windowsDirectShell: 'current',
        }, 'win32'),
        'tool "resume"'
    );
}

function runTmuxLayoutChecks() {
    const identity = { provider: 'codex', projectKey: 'project-key', cwd: '/work/app', sessionId: 'session-1' };
    const project = new tmuxLayout.ProjectTmuxLayout().getLocator(identity);
    const session = new tmuxLayout.SessionTmuxLayout().getLocator(identity);
    assert.deepStrictEqual(project, {
        layout: 'project',
        sessionName: 'project-steward-p-857b61585ca6ee92',
        windowName: 'ai-codex-391f442b59834258',
    });
    assert.deepStrictEqual(session, {
        layout: 'session',
        sessionName: 'project-steward-s-codex-391f442b59834258',
    });
    assert.strictEqual(new tmuxLayout.ProjectTmuxLayout().getLocator(identity).sessionName, project.sessionName);
    const pendingIdentity = { ...identity, sessionId: undefined, pendingId: 'p1' };
    assert.deepStrictEqual(new tmuxLayout.ProjectTmuxLayout().getPendingLocator(pendingIdentity), {
        layout: 'project',
        sessionName: 'project-steward-p-857b61585ca6ee92',
        windowName: 'pending-codex-20634e8befb9ebc9',
    });
    assert.deepStrictEqual(new tmuxLayout.SessionTmuxLayout().getPendingLocator(pendingIdentity), {
        layout: 'session',
        sessionName: 'project-steward-pending-codex-20634e8befb9ebc9',
    });
    assert.deepStrictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'project', projectKey: 'project-key', provider: 'codex', sessionId: 'session-1'
    }), {
        version: 1, layout: 'project', projectKey: 'project-key', provider: 'codex', sessionId: 'session-1'
    });
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({ managed: '1', version: '99' }), null);

    assert.deepStrictEqual(tmuxLayout.TMUX_METADATA_OPTIONS, {
        managed: '@project-steward-managed',
        version: '@project-steward-version',
        layout: '@project-steward-layout',
        projectKey: '@project-steward-project-key',
        provider: '@project-steward-provider',
        sessionId: '@project-steward-session-id',
        pendingId: '@project-steward-pending-id',
        createdAt: '@project-steward-created-at',
        marker: '@project-steward-marker',
    });
    assert.strictEqual(tmuxLayout.getTmuxRuntimeKey(identity), '[1,"codex","project-key","session","session-1"]');
    assert.strictEqual(tmuxLayout.getTmuxRuntimeKey({ ...identity, sessionId: undefined, pendingId: 'p1' }), '[1,"codex","project-key","pending","p1"]');
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, sessionId: '' }));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, provider: 'other' }));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, projectKey: 'x'.repeat(513) }));
    assert.throws(() => new tmuxLayout.SessionTmuxLayout().getLocator({ ...identity, sessionId: 'session\u001f1' }));
    assert.throws(() => new tmuxLayout.SessionTmuxLayout().getPendingLocator({ ...identity, sessionId: undefined, pendingId: '' }));
    assert.throws(() => tmuxLayout.getTmuxRuntimeKey({ ...identity, sessionId: undefined, pendingId: undefined }));
    assert.throws(() => tmuxLayout.getTmuxRuntimeKey({ ...identity, pendingId: 'p1' }));
    assert.deepStrictEqual(new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, pendingId: 'ignored' }), project);
    assert.deepStrictEqual(new tmuxLayout.SessionTmuxLayout().getPendingLocator({ ...pendingIdentity, sessionId: 'ignored' }), {
        layout: 'session', sessionName: 'project-steward-pending-codex-20634e8befb9ebc9'
    });
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'other', projectKey: 'project-key', provider: 'codex', sessionId: 'session-1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'other', sessionId: 'session-1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 'session\n1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex',
        sessionId: 'session-1', pendingId: 'p1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex',
        pendingId: 'p1', createdAt: '2026-07-18T01:02:03.000Z', marker: '/tmp/p1.done'
    }).pendingId, 'p1');
    for (const invalidField of [
        { projectKey: 'x'.repeat(513) },
        { sessionId: 'x'.repeat(513) },
        { createdAt: 'x'.repeat(201) },
        { createdAt: 'not-a-date' },
        { marker: 'x'.repeat(4097) },
        { marker: '' },
        { marker: '/tmp/control\u007f' },
    ]) {
        assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
            managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex',
            sessionId: 'session-1', ...invalidField
        }), null);
    }
}

async function runTmuxClientChecks() {
    const requiredCommands = [
        'new-session', 'new-window', 'list-windows', 'set-option', 'show-options',
        'select-window', 'attach-session',
    ];
    const calls = [];
    const runner = {
        run: async (file, args) => {
            calls.push({ file, args });
            if (args[0] === '-V') {
                return { exitCode: 0, stdout: 'tmux 3.2a\n', stderr: '' };
            }
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: `${requiredCommands.join('\n')}\n`, stderr: '' };
            }
            if (args[0] === 'list-windows') {
                return { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/tmux' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const client = new tmuxClientModule.TmuxClient('/opt/bin/tmux', runner);
    assert.deepStrictEqual(await client.checkAvailability(), { available: true, version: '3.2a' });
    assert.deepStrictEqual(await client.checkAvailability(), { available: true, version: '3.2a' });
    assert.strictEqual(calls.filter(call => call.args[0] === '-V').length, 1);
    assert.deepStrictEqual(await client.listWindows(), []);
    await client.selectWindow({
        layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-b',
    });
    assert.deepStrictEqual(calls[calls.length - 1], {
        file: '/opt/bin/tmux', args: ['select-window', '-t', 'project-steward-p-a:ai-codex-b'],
    });
    assert.ok(calls.every(call => Array.isArray(call.args)));

    const metadataCalls = [];
    const optionValues = {
        'session-a|managed': '1',
        'session-a|version': '1',
        'session-a|layout': 'project',
        'session-a|projectKey': 'project-key',
        '@12|managed': '1',
        '@12|version': '1',
        '@12|layout': 'project',
        '@12|provider': 'codex',
        '@12|sessionId': 'session-id-12',
        '@12|marker': '/tmp/done-12 marker',
        '@13|managed': '1',
        '@13|version': '1',
        '@13|layout': 'project',
        '@13|provider': 'kimi',
        '@13|sessionId': 'session-id-13',
        '@13|marker': '/tmp/done-13 marker',
        'session-a:window-a|provider': 'claude',
        'session-a:window-a|sessionId': 'public-window-lookup',
    };
    const metadataRunner = {
        run: async (file, args) => {
            metadataCalls.push({ file, args });
            if (args[0] === '-V') {
                return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
            }
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.map(name => `${name} [-flags]`).join('\n'), stderr: '' };
            }
            if (args[0] === 'list-windows') {
                return {
                    exitCode: 0,
                    stdout: [
                        'session-a\u001fwindow-a\u001f@12\u001f1',
                        'session-a\u001fwindow-a\u001f@13\u001f0',
                    ].join('\n') + '\n',
                    stderr: '',
                };
            }
            if (args[0] === 'show-options') {
                const target = args[args.indexOf('-t') + 1];
                const optionName = args[args.length - 1];
                const key = Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS)
                    .find(name => tmuxLayout.TMUX_METADATA_OPTIONS[name] === optionName);
                const value = optionValues[`${target}|${key}`];
                return { exitCode: 0, stdout: value === undefined ? '' : `${value}\n`, stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const metadataClient = new tmuxClientModule.TmuxClient('  /opt/tmux tools/tmux  ', metadataRunner);
    assert.strictEqual(metadataClient.getExecutablePath(), '/opt/tmux tools/tmux');
    assert.deepStrictEqual(await metadataClient.listWindows(), [
        {
            sessionName: 'session-a',
            windowName: 'window-a',
            windowId: '@12',
            active: true,
            sessionMetadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                projectKey: 'project-key',
            },
            windowMetadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                provider: 'codex',
                sessionId: 'session-id-12',
                marker: '/tmp/done-12 marker',
            },
            metadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                projectKey: 'project-key',
                provider: 'codex',
                sessionId: 'session-id-12',
                marker: '/tmp/done-12 marker',
            },
        },
        {
            sessionName: 'session-a',
            windowName: 'window-a',
            windowId: '@13',
            active: false,
            sessionMetadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                projectKey: 'project-key',
            },
            windowMetadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                provider: 'kimi',
                sessionId: 'session-id-13',
                marker: '/tmp/done-13 marker',
            },
            metadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                projectKey: 'project-key',
                provider: 'kimi',
                sessionId: 'session-id-13',
                marker: '/tmp/done-13 marker',
            },
        },
    ]);
    const listingMetadataCalls = metadataCalls.slice();
    for (const windowId of ['@12', '@13']) {
        assert.ok(listingMetadataCalls.some(call => JSON.stringify(call.args) === JSON.stringify([
            'show-options', '-qvw', '-t', windowId, '@project-steward-provider',
        ])));
    }
    assert.deepStrictEqual(await metadataClient.getSessionOptions('session-a'), {
        managed: '1', version: '1', layout: 'project', projectKey: 'project-key',
    });
    assert.deepStrictEqual(await metadataClient.getWindowOptions('session-a', 'window-a'), {
        provider: 'claude', sessionId: 'public-window-lookup',
    });
    await metadataClient.setSessionOptions('session-a', { managed: '1', version: '1' });
    await metadataClient.setWindowOptions('session-a', 'window-a', {
        provider: 'codex', sessionId: 'session-id',
    });
    assert.ok(metadataCalls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-t', 'session-a', '@project-steward-managed', '1',
    ])));
    assert.ok(metadataCalls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-w', '-t', 'session-a:window-a', '@project-steward-session-id', 'session-id',
    ])));
    await assert.rejects(
        metadataClient.setSessionOptions('session-a', { status: 'global-option-not-allowed' }),
        /metadata option/
    );

    await metadataClient.createSession('s', 'w', '/work/space here', 'exec secret-tool --token credential');
    await metadataClient.createWindow('s', 'w2', '/work/space here', 'exec secret-tool --token credential');
    await metadataClient.renameSession('s', 's2');
    await metadataClient.renameWindow('s2', 'w2', 'w3');
    await metadataClient.selectWindow({ layout: 'session', sessionName: 's2' });
    assert.deepStrictEqual(metadataCalls.slice(-5).map(call => call.args), [
        ['new-session', '-d', '-s', 's', '-n', 'w', '-c', '/work/space here', 'exec secret-tool --token credential'],
        ['new-window', '-d', '-t', 's', '-n', 'w2', '-c', '/work/space here', 'exec secret-tool --token credential'],
        ['rename-session', '-t', 's', 's2'],
        ['rename-window', '-t', 's2:w2', 'w3'],
        ['select-window', '-t', 's2'],
    ]);

    const hasSessionRunner = {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            if (args[0] === 'has-session') {
                return { exitCode: 1, stdout: '', stderr: "can't find session: absent" };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    assert.strictEqual(await new tmuxClientModule.TmuxClient('tmux', hasSessionRunner).hasSession('absent'), false);

    const pathCalls = [];
    const pathRunner = {
        run: async (file, args) => {
            pathCalls.push({ file, args });
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const pathClient = new tmuxClientModule.TmuxClient('tmux', pathRunner);
    await pathClient.checkAvailability();
    pathClient.setExecutablePath('  /new path/tmux  ');
    assert.strictEqual(pathClient.getExecutablePath(), '/new path/tmux');
    await pathClient.hasSession('s');
    assert.strictEqual(pathCalls.filter(call => call.args[0] === '-V').length, 2);
    assert.ok(pathCalls.slice(-3).every(call => call.file === '/new path/tmux'));
    pathClient.setExecutablePath('/new path/tmux');
    await pathClient.checkAvailability();
    assert.strictEqual(pathCalls.filter(call => call.args[0] === '-V').length, 3);
    assert.throws(() => pathClient.setExecutablePath('   '), /executable/);

    const missingCapabilityClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => args[0] === '-V'
            ? { exitCode: 0, stdout: 'tmux 3.2\n', stderr: '' }
            : { exitCode: 0, stdout: requiredCommands.filter(name => name !== 'attach-session').join('\n'), stderr: '' },
    });
    assert.deepStrictEqual(await missingCapabilityClient.checkAvailability(), {
        available: false,
        category: 'missing-capability',
        message: 'The configured tmux does not provide all required commands.',
    });

    const invalidVersionClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async () => ({ exitCode: 0, stdout: 'tmux   \n', stderr: 'credential=never-report' }),
    });
    assert.deepStrictEqual(await invalidVersionClient.checkAvailability(), {
        available: false,
        category: 'invalid-version',
        message: 'The configured tmux returned an unrecognized version.',
    });
    const unsafeVersionClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async () => ({
            exitCode: 0,
            stdout: 'tmux 3.3 token=credential\n',
            stderr: '',
        }),
    });
    assert.deepStrictEqual(await unsafeVersionClient.checkAvailability(), {
        available: false,
        category: 'invalid-version',
        message: 'The configured tmux returned an unrecognized version.',
    });

    const secret = 'prompt=do-not-report token=credential';
    const failingRunner = {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return { exitCode: 42, stdout: `stdout ${secret}`, stderr: `stderr ${secret}` };
        },
    };
    const failingClient = new tmuxClientModule.TmuxClient('/secret/path/tmux', failingRunner);
    await assert.rejects(
        failingClient.createSession('secret-session', 'secret-window', '/secret/cwd', secret),
        error => {
            assert.ok(error instanceof tmuxClientModule.TmuxClientError);
            assert.strictEqual(error.operation, 'create-session');
            assert.strictEqual(error.category, 'nonzero-exit');
            const publicError = `${error.message} ${JSON.stringify(error)}`;
            for (const sensitive of [secret, '/secret/path/tmux', 'secret-session', 'secret-window', '/secret/cwd']) {
                assert.strictEqual(publicError.includes(sensitive), false);
            }
            assert.strictEqual(publicError.includes('stdout'), false);
            assert.strictEqual(publicError.includes('stderr'), false);
            return true;
        }
    );

    const notFoundClient = new tmuxClientModule.TmuxClient('/secret/missing-tmux', {
        run: async () => {
            const error = new Error(`spawn /secret/missing-tmux ENOENT ${secret}`);
            error.code = 'ENOENT';
            throw error;
        },
    });
    const notFoundAvailability = await notFoundClient.checkAvailability();
    assert.strictEqual(notFoundAvailability.category, 'not-found');
    assert.strictEqual(JSON.stringify(notFoundAvailability).includes('/secret'), false);
    assert.strictEqual(JSON.stringify(notFoundAvailability).includes(secret), false);

    const malformedClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return { exitCode: 0, stdout: `session\u001fwindow\u001f@1\u001f1\u001f${secret}\n`, stderr: '' };
        },
    });
    await assert.rejects(malformedClient.listWindows(), error => {
        assert.ok(error instanceof tmuxClientModule.TmuxClientError);
        assert.strictEqual(error.operation, 'list-windows');
        assert.strictEqual(error.category, 'invalid-output');
        assert.strictEqual(error.message.includes(secret), false);
        return true;
    });

    const malformedFailureCategory = 'prompt=do-not-report';
    const malformedResultClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return {
                exitCode: null, stdout: '', stderr: '', failureCategory: malformedFailureCategory,
            };
        },
    });
    await assert.rejects(malformedResultClient.hasSession('s'), error => {
        assert.strictEqual(error.operation, 'has-session');
        assert.strictEqual(error.category, 'invalid-output');
        assert.strictEqual(error.message.includes(malformedFailureCategory), false);
        return true;
    });

    const forgedSecrets = {
        message: 'message=forged-secret',
        operation: 'operation=forged-secret',
        category: 'category=forged-secret',
        name: 'name=forged-secret',
        stack: 'stack=forged-secret',
        code: 'code=forged-secret',
    };
    const forgedError = new tmuxClientModule.TmuxClientError(
        forgedSecrets.operation, forgedSecrets.category
    );
    Object.assign(forgedError, forgedSecrets);
    const forgedErrorClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            throw forgedError;
        },
    });
    await assert.rejects(forgedErrorClient.hasSession('s'), error => {
        assert.ok(error instanceof tmuxClientModule.TmuxClientError);
        assert.notStrictEqual(error, forgedError);
        assert.strictEqual(error.operation, 'has-session');
        assert.strictEqual(error.category, 'unsupported');
        const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
        for (const value of Object.values(forgedSecrets)) {
            assert.strictEqual(publicError.includes(value), false);
        }
        return true;
    });

    const rejectedGetterCases = [
        {
            secret: 'rejected-code-getter-secret',
            value: new Proxy({}, {
                get: (_target, property) => {
                    if (property === 'code') {
                        throw new Error('rejected-code-getter-secret');
                    }
                    return undefined;
                },
            }),
        },
        {
            secret: 'rejected-killed-getter-secret',
            value: Object.defineProperties({}, {
                code: { value: 'UNKNOWN', enumerable: true },
                killed: {
                    enumerable: true,
                    get: () => { throw new Error('rejected-killed-getter-secret'); },
                },
            }),
        },
    ];
    for (const rejectedCase of rejectedGetterCases) {
        const rejectedGetterClient = new tmuxClientModule.TmuxClient('tmux', {
            run: async (_file, args) => {
                if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
                if (args[0] === 'list-commands') {
                    return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
                }
                throw rejectedCase.value;
            },
        });
        await assert.rejects(rejectedGetterClient.hasSession('s'), error => {
            assert.ok(error instanceof tmuxClientModule.TmuxClientError);
            assert.notStrictEqual(error, rejectedCase.value);
            assert.strictEqual(error.operation, 'has-session');
            assert.strictEqual(error.category, 'unsupported');
            const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
            assert.strictEqual(publicError.includes(rejectedCase.secret), false);
            return true;
        });
    }

    const fulfilledGetterSecrets = {
        message: 'fulfilled-getter-message-secret',
        operation: 'fulfilled-getter-operation-secret',
        category: 'fulfilled-getter-category-secret',
    };
    const fulfilledGetterError = new tmuxClientModule.TmuxClientError(
        fulfilledGetterSecrets.operation, fulfilledGetterSecrets.category
    );
    fulfilledGetterError.message = fulfilledGetterSecrets.message;
    const fulfilledResultProxy = new Proxy({}, {
        get: (_target, property) => {
            if (property === 'exitCode') {
                throw fulfilledGetterError;
            }
            return '';
        },
    });
    const fulfilledGetterClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return fulfilledResultProxy;
        },
    });
    await assert.rejects(fulfilledGetterClient.hasSession('s'), error => {
        assert.ok(error instanceof tmuxClientModule.TmuxClientError);
        assert.notStrictEqual(error, fulfilledGetterError);
        assert.strictEqual(error.operation, 'has-session');
        assert.strictEqual(error.category, 'invalid-output');
        const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
        for (const value of Object.values(fulfilledGetterSecrets)) {
            assert.strictEqual(publicError.includes(value), false);
        }
        return true;
    });

    const availabilityGetterSecret = 'availability-getter-secret';
    const availabilityGetterClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async () => new Proxy({}, {
            get: () => { throw new Error(availabilityGetterSecret); },
        }),
    });
    const getterAvailability = await availabilityGetterClient.checkAvailability();
    assert.deepStrictEqual(getterAvailability, {
        available: false,
        category: 'command-failed',
        message: 'The configured tmux could not complete an availability check.',
    });
    assert.strictEqual(JSON.stringify(getterAvailability).includes(availabilityGetterSecret), false);
}

async function runTmuxDiscoveryChecks() {
    const finalIdentity = {
        provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1',
    };
    const finalLocator = new tmuxLayout.ProjectTmuxLayout().getLocator(finalIdentity);
    const finalSessionMetadata = {
        managed: '1', version: '1', layout: 'project', projectKey: 'pk',
    };
    const finalWindowMetadata = {
        managed: '1', version: '1', layout: 'project',
        provider: 'codex', sessionId: 's1', marker: '/tmp/s1.done',
        createdAt: '2026-07-18T10:00:00Z',
    };
    const finalRow = {
        ...finalLocator, windowId: '@1', active: false,
        sessionMetadata: finalSessionMetadata,
        windowMetadata: finalWindowMetadata,
        metadata: { ...finalSessionMetadata, ...finalWindowMetadata },
    };
    let now = 1000;
    let lists = 0;
    const reconciled = [];
    const discovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            lists++;
            return [finalRow, { ...finalRow, windowId: '@1-duplicate' }];
        } },
        bindingStore: {
            listPending: async () => [],
            listKnown: async () => [],
            reconcileKnown: async runtimes => { reconciled.push(runtimes); },
        },
        markerIsCurrent: () => false,
        nowMs: () => now,
        cacheTtlMs: 500,
    });
    await discovery.refresh();
    await discovery.refresh();
    assert.strictEqual(lists, 1);
    assert.deepStrictEqual(discovery.getActive(), [{
        identity: { provider: 'codex', projectKey: 'pk', cwd: '', sessionId: 's1' },
        backend: 'tmux',
        state: 'active',
        markerPath: '/tmp/s1.done',
        runStartedAtMs: Date.parse('2026-07-18T10:00:00Z'),
        attached: false,
        tmux: finalLocator,
    }]);
    assert.strictEqual(reconciled.length, 1);
    assert.strictEqual(reconciled[0].length, 1);
    await discovery.refresh(true);
    assert.strictEqual(lists, 2);
    assert.strictEqual(discovery.find(finalIdentity).length, 1);
    const activeCopy = discovery.getActive();
    activeCopy[0].identity.sessionId = 'mutated';
    activeCopy[0].tmux.sessionName = 'mutated';
    assert.strictEqual(discovery.getActive()[0].identity.sessionId, 's1');
    assert.strictEqual(discovery.getActive()[0].tmux.sessionName, finalLocator.sessionName);

    discovery.invalidate();
    await discovery.refresh();
    assert.strictEqual(lists, 3);

    const inFlightGate = deferred();
    let inFlightLists = 0;
    const inFlightDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => { inFlightLists++; return inFlightGate.promise; } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
        nowMs: () => 1000,
        cacheTtlMs: 500,
    });
    const ordinaryRefresh = inFlightDiscovery.refresh();
    const forcedRefresh = inFlightDiscovery.refresh(true);
    assert.strictEqual(inFlightLists, 1);
    inFlightGate.resolve([finalRow]);
    await Promise.all([ordinaryRefresh, forcedRefresh]);
    assert.strictEqual(inFlightLists, 1);

    const invalidatedGate = deferred();
    let invalidatedLists = 0;
    const invalidatedDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            invalidatedLists++;
            return invalidatedLists === 1 ? invalidatedGate.promise : [finalRow];
        } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
        nowMs: () => 1000,
        cacheTtlMs: 500,
    });
    const invalidatedRefresh = invalidatedDiscovery.refresh();
    invalidatedDiscovery.invalidate();
    const invalidatedJoinedRefresh = invalidatedDiscovery.refresh(true);
    assert.strictEqual(invalidatedLists, 1);
    invalidatedGate.resolve([finalRow]);
    await Promise.all([invalidatedRefresh, invalidatedJoinedRefresh]);
    assert.strictEqual(invalidatedLists, 1);
    await invalidatedDiscovery.refresh();
    assert.strictEqual(invalidatedLists, 2);
    await invalidatedDiscovery.refresh();
    assert.strictEqual(invalidatedLists, 2);

    let failedCacheLists = 0;
    const failedCacheDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            failedCacheLists++;
            if (failedCacheLists === 1) throw new Error('uncached list failure');
            return [finalRow];
        } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
        nowMs: () => 1000,
        cacheTtlMs: 500,
    });
    await assert.rejects(failedCacheDiscovery.refresh(), /uncached list failure/);
    await failedCacheDiscovery.refresh();
    await failedCacheDiscovery.refresh();
    assert.strictEqual(failedCacheLists, 2);

    const pendingIdentity = {
        provider: 'kimi', projectKey: 'pending-project', cwd: '/work/pending', pendingId: 'p1',
    };
    const pendingLocator = new tmuxLayout.ProjectTmuxLayout().getPendingLocator(pendingIdentity);
    const pendingBinding = {
        version: 1, state: 'pending', pendingId: 'p1', provider: 'kimi',
        projectKey: 'pending-project', cwd: '/work/pending',
        createdAt: '2026-07-18T11:00:00Z', excludedSessionIds: ['old-session'],
        title: 'Pending title', layout: 'project', locator: pendingLocator,
    };
    const pendingWindowMetadata = {
        managed: '1', version: '1', layout: 'project', provider: 'kimi', pendingId: 'p1',
        createdAt: pendingBinding.createdAt, marker: '/tmp/p1.done',
    };
    const pendingDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...pendingLocator, windowId: '@2', active: true,
            sessionMetadata: {
                managed: '1', version: '1', layout: 'project', projectKey: 'pending-project',
            },
            windowMetadata: pendingWindowMetadata,
            metadata: { projectKey: 'pending-project', ...pendingWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [pendingBinding], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await pendingDiscovery.refresh();
    assert.deepStrictEqual(pendingDiscovery.getPending(), [{
        identity: pendingIdentity,
        backend: 'tmux', state: 'pending', markerPath: '/tmp/p1.done',
        runStartedAtMs: Date.parse(pendingBinding.createdAt), attached: false,
        tmux: pendingLocator, createdAt: pendingBinding.createdAt,
        excludedSessionIds: ['old-session'], title: 'Pending title',
    }]);
    assert.strictEqual(pendingDiscovery.find(pendingIdentity).length, 1);
    assert.strictEqual(pendingDiscovery.find({ ...pendingIdentity, cwd: '/other' }).length, 0);
    const pendingCopy = pendingDiscovery.getPending();
    pendingCopy[0].excludedSessionIds.push('mutated');
    assert.deepStrictEqual(pendingDiscovery.getPending()[0].excludedSessionIds, ['old-session']);

    const collisionIdentity = {
        provider: 'claude', projectKey: 'collision-project', cwd: '', sessionId: 'collision-session',
    };
    const collisionExpected = new tmuxLayout.ProjectTmuxLayout().getLocator(collisionIdentity);
    const collisionActual = {
        layout: 'project', sessionName: collisionExpected.sessionName,
        windowName: `${collisionExpected.windowName}-occupied`,
    };
    const collisionMetadata = {
        managed: '1', version: '1', layout: 'project', provider: 'claude',
        sessionId: 'collision-session', marker: '/tmp/collision.done',
    };
    const collisionKnown = {
        version: 1, state: 'known', provider: 'claude', sessionId: 'collision-session',
        projectKey: 'collision-project', layout: 'project', locator: collisionExpected,
        lastSeenAtMs: 900,
    };
    const collisionReconciled = [];
    const collisionRemoved = [];
    const collisionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [
            {
                ...collisionActual, windowId: '@3', active: true,
                sessionMetadata: {
                    managed: '1', version: '1', layout: 'project', projectKey: 'collision-project',
                },
                windowMetadata: collisionMetadata,
                metadata: { projectKey: 'collision-project', ...collisionMetadata },
            },
            {
                ...collisionActual, windowId: '@3-duplicate', active: false,
                sessionMetadata: {
                    managed: '1', version: '1', layout: 'project', projectKey: 'collision-project',
                },
                windowMetadata: collisionMetadata,
                metadata: { projectKey: 'collision-project', ...collisionMetadata },
            },
            {
                ...collisionExpected, windowId: '@4', active: true,
                sessionMetadata: {
                    managed: '1', version: '1', layout: 'project',
                    projectKey: 'collision-project',
                },
                windowMetadata: collisionMetadata,
                metadata: {
                    managed: '1', version: '1', layout: 'project',
                    projectKey: 'collision-project', provider: 'claude', sessionId: 'collision-session',
                },
            },
            {
                ...collisionExpected, windowId: '@5', active: true,
                sessionMetadata: {}, windowMetadata: {}, metadata: {},
            },
        ] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [collisionKnown],
            reconcileKnown: async runtimes => { collisionReconciled.push(runtimes); },
            removeKnown: async (...identity) => { collisionRemoved.push(identity); },
        },
        markerIsCurrent: () => false,
    });
    await collisionDiscovery.refresh();
    assert.deepStrictEqual(collisionDiscovery.getActive(), []);
    assert.deepStrictEqual(collisionDiscovery.getPending(), []);
    assert.deepStrictEqual(collisionDiscovery.find(collisionIdentity), []);
    assert.deepStrictEqual(collisionDiscovery.getInactive(), []);
    assert.deepStrictEqual(collisionReconciled, [[]]);
    assert.deepStrictEqual(collisionRemoved, []);
    assert.deepStrictEqual(collisionDiscovery.getDiagnostics(), [{
        kind: 'tmux-locator-collision', identity: collisionIdentity,
        actual: collisionActual, expected: collisionExpected,
    }]);
    const diagnosticCopy = collisionDiscovery.getDiagnostics();
    diagnosticCopy[0].identity.sessionId = 'mutated';
    diagnosticCopy[0].actual.sessionName = 'mutated';
    assert.deepStrictEqual(collisionDiscovery.getDiagnostics()[0], {
        kind: 'tmux-locator-collision', identity: collisionIdentity,
        actual: collisionActual, expected: collisionExpected,
    });

    const pendingCollisionActual = {
        ...pendingLocator, windowName: `${pendingLocator.windowName}-occupied`,
    };
    const pendingCollisionReconciled = [];
    const pendingCollisionRemoved = [];
    const pendingCollisionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...pendingCollisionActual, windowId: '@pending-collision', active: false,
            sessionMetadata: {
                managed: '1', version: '1', layout: 'project', projectKey: 'pending-project',
            },
            windowMetadata: pendingWindowMetadata,
            metadata: { projectKey: 'pending-project', ...pendingWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [pendingBinding], listKnown: async () => [],
            reconcileKnown: async runtimes => { pendingCollisionReconciled.push(runtimes); },
            removeKnown: async (...identity) => { pendingCollisionRemoved.push(identity); },
        },
        markerIsCurrent: () => false,
    });
    await pendingCollisionDiscovery.refresh();
    assert.deepStrictEqual(pendingCollisionDiscovery.getPending(), []);
    assert.deepStrictEqual(pendingCollisionDiscovery.getInactive(), []);
    assert.deepStrictEqual(pendingCollisionReconciled, [[]]);
    assert.deepStrictEqual(pendingCollisionRemoved, []);
    assert.deepStrictEqual(pendingCollisionDiscovery.getDiagnostics(), [{
        kind: 'tmux-locator-collision',
        identity: { ...pendingIdentity, cwd: '' },
        actual: pendingCollisionActual,
        expected: pendingLocator,
    }]);

    const sessionIdentity = {
        provider: 'codex', projectKey: 'session-project', cwd: '', sessionId: 'session-layout-id',
    };
    const sessionLocator = new tmuxLayout.SessionTmuxLayout().getLocator(sessionIdentity);
    const sessionMetadata = {
        managed: '1', version: '1', layout: 'session', projectKey: 'session-project',
        provider: 'codex', sessionId: 'session-layout-id', marker: '/tmp/session.done',
    };
    const sessionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [
            {
                ...sessionLocator, windowName: 'shell', windowId: '@6', active: false,
                sessionMetadata, windowMetadata: sessionMetadata, metadata: sessionMetadata,
            },
            {
                ...sessionLocator, windowName: 'logs', windowId: '@7', active: true,
                sessionMetadata, windowMetadata: sessionMetadata, metadata: sessionMetadata,
            },
        ] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await sessionDiscovery.refresh();
    assert.strictEqual(sessionDiscovery.getActive().length, 1);
    assert.strictEqual(sessionDiscovery.getActive()[0].attached, false);

    const mergedOnlyDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...finalLocator, windowId: '@merged-only', active: true,
            metadata: { ...finalSessionMetadata, ...finalWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await mergedOnlyDiscovery.refresh();
    assert.deepStrictEqual(mergedOnlyDiscovery.getActive(), []);

    const invalidProjectScopeDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...finalLocator, windowId: '@invalid-project-scope', active: true,
            sessionMetadata: { projectKey: 'pk' },
            windowMetadata: finalWindowMetadata,
            metadata: { ...finalSessionMetadata, ...finalWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await invalidProjectScopeDiscovery.refresh();
    assert.deepStrictEqual(invalidProjectScopeDiscovery.getActive(), []);

    const disagreeingWindowMetadata = {
        ...sessionMetadata, sessionId: 'different-session-layout-id',
    };
    const disagreeingSessionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...sessionLocator, windowName: 'shell', windowId: '@disagreeing-session', active: true,
            sessionMetadata,
            windowMetadata: disagreeingWindowMetadata,
            metadata: { ...sessionMetadata, ...disagreeingWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await disagreeingSessionDiscovery.refresh();
    assert.deepStrictEqual(disagreeingSessionDiscovery.getActive(), []);

    const known = {
        version: 1, state: 'known', provider: 'codex', sessionId: 's1', projectKey: 'pk',
        layout: 'project', locator: finalLocator, lastSeenAtMs: 900,
    };
    const removedKnown = [];
    const markerChecks = [];
    let lifecycleRows = [finalRow];
    const lifecycleDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => lifecycleRows },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [known, known],
            reconcileKnown: async () => undefined,
            removeKnown: async (provider, sessionId) => { removedKnown.push([provider, sessionId]); },
        },
        markerIsCurrent: (markerPath, runStartedAtMs) => {
            markerChecks.push([markerPath, runStartedAtMs]);
            return true;
        },
    });
    await lifecycleDiscovery.refresh();
    lifecycleRows = [];
    await lifecycleDiscovery.refresh(true);
    assert.deepStrictEqual(lifecycleDiscovery.getActive(), []);
    assert.deepStrictEqual(lifecycleDiscovery.find(finalIdentity), []);
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].state, 'completed');
    const inactiveCopy = lifecycleDiscovery.getInactive();
    inactiveCopy[0].identity.sessionId = 'mutated';
    inactiveCopy[0].tmux.sessionName = 'mutated';
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].identity.sessionId, 's1');
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].tmux.sessionName, finalLocator.sessionName);
    assert.deepStrictEqual(markerChecks, [[
        '/tmp/s1.done', Date.parse('2026-07-18T10:00:00Z'),
    ]]);
    assert.deepStrictEqual(removedKnown, [['codex', 's1']]);

    const stoppedRemoved = [];
    let stoppedRows = [finalRow];
    const stoppedDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => stoppedRows },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [known],
            reconcileKnown: async () => undefined,
            removeKnown: async (provider, sessionId) => { stoppedRemoved.push([provider, sessionId]); },
        },
        markerIsCurrent: () => false,
    });
    await stoppedDiscovery.refresh();
    stoppedRows = [];
    await stoppedDiscovery.refresh(true);
    assert.deepStrictEqual(stoppedDiscovery.getActive(), []);
    assert.strictEqual(stoppedDiscovery.getInactive()[0].state, 'stopped');
    assert.deepStrictEqual(stoppedRemoved, [['codex', 's1']]);

    let failList = false;
    let failureReconciles = 0;
    let failureRemovals = 0;
    let failedLists = 0;
    const failureDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            failedLists++;
            if (failList) throw new Error('ambiguous list failure');
            return [finalRow];
        } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [known],
            reconcileKnown: async () => { failureReconciles++; },
            removeKnown: async () => { failureRemovals++; },
        },
        markerIsCurrent: () => true,
        nowMs: () => now,
        cacheTtlMs: 500,
    });
    await failureDiscovery.refresh();
    const beforeFailure = failureDiscovery.getActive();
    failList = true;
    now += 501;
    await assert.rejects(failureDiscovery.refresh(), /ambiguous list failure/);
    assert.deepStrictEqual(failureDiscovery.getActive(), beforeFailure);
    assert.strictEqual(failureReconciles, 1);
    assert.strictEqual(failureRemovals, 0);
    await assert.rejects(failureDiscovery.refresh(), /ambiguous list failure/);
    assert.strictEqual(failedLists, 3);

    const listFailureMutations = [];
    const listFailureDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => { throw new Error('list failure before reads'); } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async runtimes => { listFailureMutations.push(['reconcile', runtimes]); },
            removeKnown: async (...identity) => { listFailureMutations.push(['remove', identity]); },
        },
        markerIsCurrent: () => false,
    });
    await assert.rejects(listFailureDiscovery.refresh(), /list failure before reads/);
    assert.deepStrictEqual(listFailureMutations, []);

    const readFailureMutations = [];
    const readFailureDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [finalRow] },
        bindingStore: {
            listPending: async () => { throw new Error('binding read failure'); },
            listKnown: async () => [known],
            reconcileKnown: async runtimes => { readFailureMutations.push(['reconcile', runtimes]); },
            removeKnown: async (...identity) => { readFailureMutations.push(['remove', identity]); },
        },
        markerIsCurrent: () => false,
    });
    await assert.rejects(readFailureDiscovery.refresh(), /binding read failure/);
    assert.deepStrictEqual(readFailureMutations, []);

    let markerFailureRows = [finalRow];
    const markerFailureMutations = [];
    const markerFailureDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => markerFailureRows },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [known],
            reconcileKnown: async runtimes => { markerFailureMutations.push(['reconcile', runtimes]); },
            removeKnown: async (...identity) => { markerFailureMutations.push(['remove', identity]); },
        },
        markerIsCurrent: () => { throw new Error('marker read failure'); },
    });
    await markerFailureDiscovery.refresh();
    const markerFailureActive = markerFailureDiscovery.getActive();
    const markerMutationsBeforeFailure = markerFailureMutations.slice();
    markerFailureRows = [];
    await assert.rejects(markerFailureDiscovery.refresh(true), /marker read failure/);
    assert.deepStrictEqual(markerFailureMutations, markerMutationsBeforeFailure);
    assert.deepStrictEqual(markerFailureDiscovery.getActive(), markerFailureActive);
    assert.deepStrictEqual(markerFailureDiscovery.getInactive(), []);
}

async function runTmuxStoreChecks() {
    const now = Date.parse('2026-07-18T10:00:00Z');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-tmux-store-'));
    try {
        const store = new runtimeStoreModule.TmuxRuntimeBindingStore(root, () => now);
        const pending = (pendingId, createdAt, overrides = {}) => ({
            version: 1,
            state: 'pending',
            pendingId,
            provider: 'codex',
            projectKey: 'pk',
            cwd: '/work',
            createdAt,
            excludedSessionIds: [],
            layout: 'project',
            locator: {
                layout: 'project',
                sessionName: 'project-steward-p-a',
                windowName: `pending-codex-${pendingId}`,
            },
            ...overrides,
        });
        const known = (sessionId, lastSeenAtMs, overrides = {}) => ({
            version: 1,
            state: 'known',
            provider: 'codex',
            sessionId,
            projectKey: 'pk',
            layout: 'project',
            locator: {
                layout: 'project',
                sessionName: 'project-steward-p-a',
                windowName: `ai-codex-${sessionId}`,
            },
            lastSeenAtMs,
            ...overrides,
        });

        await store.setPending(pending('p-new', '2026-07-18T09:59:00Z'));
        await store.setPending(pending('p-old', '2026-07-18T09:58:00Z'));
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-old', 'p-new']);
        assert.ok(fs.readdirSync(root).every(name => !name.includes('p-old') && !name.includes('p-new')));

        fs.writeFileSync(path.join(root, 'bad.json'), '{bad');
        fs.writeFileSync(path.join(root, 'unsupported.json'), JSON.stringify({ version: 99 }));
        fs.writeFileSync(path.join(root, 'oversize.json'), ' '.repeat(1024 * 1024 + 1));
        fs.symlinkSync('/etc/passwd', path.join(root, 'ignored.json'));
        fs.mkdirSync(path.join(root, 'directory.json'));
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-old', 'p-new']);

        await store.setPending(pending('expired', '2026-07-17T09:59:59Z'));
        await store.setPending(pending('expired-at-boundary', '2026-07-17T10:00:00Z'));
        await store.setPending(pending('too-many-exclusions', '2026-07-18T09:59:30Z', {
            excludedSessionIds: Array.from({ length: 1001 }, (_, index) => `s${index}`),
        }));
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-old', 'p-new']);

        await store.setKnown(known('s-old', now - 2));
        await store.setKnown(known('s-new', now - 1));
        await store.setKnown(known('expired', now - (30 * 24 * 60 * 60 * 1000) - 1));
        await store.setKnown(known('expired-at-boundary', now - (30 * 24 * 60 * 60 * 1000)));
        assert.deepStrictEqual((await store.listKnown()).map(record => record.sessionId), ['s-new', 's-old']);
        assert.strictEqual((await store.getKnown('codex', 's-old')).locator.windowName, 'ai-codex-s-old');
        assert.strictEqual(await store.getKnown('codex', 'expired'), null);
        assert.strictEqual(await store.getKnown('codex', 'expired-at-boundary'), null);

        const delayedRecordPath = path.join(root, runtimeRecordFilename(known('s-old', now - 2)));
        const originalReadFile = fs.promises.readFile;
        const originalStoreOpen = fs.promises.open;
        const readStarted = deferred();
        const releaseRead = deferred();
        let readDelayed = false;
        const delayTargetRead = async filePath => {
            if (!readDelayed && path.resolve(String(filePath)) === path.resolve(delayedRecordPath)) {
                readDelayed = true;
                readStarted.resolve();
                await releaseRead.promise;
            }
        };
        fs.promises.readFile = async (filePath, ...args) => {
            await delayTargetRead(filePath);
            return originalReadFile.call(fs.promises, filePath, ...args);
        };
        fs.promises.open = async (filePath, flags, ...args) => {
            const handle = await originalStoreOpen.call(fs.promises, filePath, flags, ...args);
            if (path.resolve(String(filePath)) === path.resolve(delayedRecordPath)) {
                const handleReadFile = handle.readFile.bind(handle);
                handle.readFile = async (...readArgs) => {
                    await delayTargetRead(filePath);
                    return handleReadFile(...readArgs);
                };
            }
            return handle;
        };
        const queuedSetRecord = known('queued-set', now);
        const queuedLiveIdentity = {
            identity: { provider: 'kimi', projectKey: 'pk-queued', cwd: '/queued', sessionId: 'queued-live' },
            backend: 'tmux',
            state: 'active',
            markerPath: '/tmp/queued.done',
            runStartedAtMs: now - 100,
            attached: false,
            tmux: { layout: 'session', sessionName: 'project-steward-s-kimi-queued' },
        };
        let queuedSetSettled = false;
        let queuedReconcileSettled = false;
        try {
            const delayedList = store.listKnown();
            await readStarted.promise;
            const queuedSet = store.setKnown(queuedSetRecord).then(() => { queuedSetSettled = true; });
            const queuedReconcile = store.reconcileKnown([queuedLiveIdentity]).then(() => {
                queuedReconcileSettled = true;
            });
            await new Promise(resolve => setTimeout(resolve, 50));
            const setSettledDuringRead = queuedSetSettled;
            const reconcileSettledDuringRead = queuedReconcileSettled;
            releaseRead.resolve();
            await Promise.all([delayedList, queuedSet, queuedReconcile]);
            assert.strictEqual(setSettledDuringRead, false);
            assert.strictEqual(reconcileSettledDuringRead, false);
        } finally {
            releaseRead.resolve();
            fs.promises.readFile = originalReadFile;
            fs.promises.open = originalStoreOpen;
        }
        assert.ok(await store.getKnown('codex', 'queued-set'));
        assert.ok(await store.getKnown('kimi', 'queued-live'));

        const queueRecoveryRoot = path.join(root, 'queue-recovery');
        fs.writeFileSync(queueRecoveryRoot, 'not a directory');
        const queueRecoveryStore = new runtimeStoreModule.TmuxRuntimeBindingStore(queueRecoveryRoot, () => now);
        await assert.rejects(queueRecoveryStore.listKnown(), error => error && error.code === 'ENOTDIR');
        fs.unlinkSync(queueRecoveryRoot);
        await queueRecoveryStore.setKnown(known('after-read-error', now));
        assert.ok(await queueRecoveryStore.getKnown('codex', 'after-read-error'));

        const noncanonicalPath = path.join(root, 'arbitrary-valid-name.json');
        fs.writeFileSync(noncanonicalPath, JSON.stringify(known('noncanonical', now)));
        assert.strictEqual((await store.listKnown()).some(record => record.sessionId === 'noncanonical'), false);
        assert.strictEqual(fs.existsSync(noncanonicalPath), true);

        const directMismatchRoot = path.join(root, 'direct-identity-mismatch');
        fs.mkdirSync(directMismatchRoot);
        const requestedDirectRecord = known('s1', now);
        const mismatchedDirectRecord = known('s2', now, { provider: 'kimi' });
        const requestedDirectPath = path.join(
            directMismatchRoot, runtimeRecordFilename(requestedDirectRecord)
        );
        fs.writeFileSync(requestedDirectPath, JSON.stringify(mismatchedDirectRecord));
        const directMismatchStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            directMismatchRoot, () => now
        );
        assert.strictEqual(await directMismatchStore.getKnown('codex', 's1'), null);
        assert.strictEqual(await directMismatchStore.getKnown('kimi', 's2'), null);
        assert.strictEqual(fs.existsSync(requestedDirectPath), true);

        const fifoRoot = path.join(root, 'fifo-records');
        fs.mkdirSync(fifoRoot);
        const fifoPath = path.join(fifoRoot, 'blocked.json');
        const mkfifo = childProcess.spawnSync('mkfifo', [fifoPath]);
        if (mkfifo.status === 0) {
            let fifoWriterError;
            const writerTimer = setTimeout(() => {
                try {
                    const descriptor = fs.openSync(fifoPath, 'w');
                    fs.closeSync(descriptor);
                } catch (error) {
                    fifoWriterError = error;
                }
            }, 200);
            const fifoStore = new runtimeStoreModule.TmuxRuntimeBindingStore(fifoRoot, () => now);
            const startedAt = Date.now();
            assert.deepStrictEqual(await fifoStore.listKnown(), []);
            const elapsedMs = Date.now() - startedAt;
            clearTimeout(writerTimer);
            assert.strictEqual(fifoWriterError, undefined);
            assert.ok(elapsedMs < 150, `FIFO enumeration blocked for ${elapsedMs}ms`);
        }

        if (fs.constants.O_NOFOLLOW) {
            const unsupportedRoot = path.join(root, 'unsupported-no-follow');
            const unsupportedStore = new runtimeStoreModule.TmuxRuntimeBindingStore(unsupportedRoot, () => now);
            const unsupportedRecord = known('unsupported-no-follow', now);
            await unsupportedStore.setKnown(unsupportedRecord);
            const unsupportedPath = path.join(unsupportedRoot, runtimeRecordFilename(unsupportedRecord));
            const unsupportedOriginalOpen = fs.promises.open;
            let noFollowRejected = false;
            let fallbackFlags;
            fs.promises.open = async (filePath, flags, ...args) => {
                if (path.resolve(String(filePath)) === path.resolve(unsupportedPath)) {
                    if (!noFollowRejected) {
                        noFollowRejected = true;
                        const error = new Error('injected unsupported O_NOFOLLOW');
                        error.code = 'EINVAL';
                        throw error;
                    }
                    fallbackFlags = flags;
                }
                return unsupportedOriginalOpen.call(fs.promises, filePath, flags, ...args);
            };
            let unsupportedRecords;
            try {
                unsupportedRecords = await unsupportedStore.listKnown();
            } finally {
                fs.promises.open = unsupportedOriginalOpen;
            }
            assert.strictEqual(noFollowRejected, true);
            assert.strictEqual(unsupportedRecords.length, 1);
            assert.strictEqual(unsupportedRecords[0].sessionId, 'unsupported-no-follow');
            if (fs.constants.O_NONBLOCK) {
                assert.strictEqual((fallbackFlags & fs.constants.O_NONBLOCK) !== 0, true);
            }
            assert.strictEqual((fallbackFlags & fs.constants.O_NOFOLLOW) === 0, true);
        }

        const mismatchRoot = path.join(root, 'fallback-mismatch');
        const mismatchStore = new runtimeStoreModule.TmuxRuntimeBindingStore(mismatchRoot, () => now);
        const mismatchRecord = known('fallback-mismatch', now);
        await mismatchStore.setKnown(mismatchRecord);
        const mismatchPath = path.join(mismatchRoot, runtimeRecordFilename(mismatchRecord));
        const mismatchReplacementPath = path.join(root, 'fallback-mismatch-replacement');
        fs.writeFileSync(mismatchReplacementPath, JSON.stringify(known('fallback-mismatch', now - 456)));
        const mismatchOriginalOpen = fs.promises.open;
        let mismatchNoFollowRejected = false;
        let mismatchHandleClosed = false;
        fs.promises.open = async (filePath, flags, ...args) => {
            if (path.resolve(String(filePath)) === path.resolve(mismatchPath)) {
                if (!mismatchNoFollowRejected && fs.constants.O_NOFOLLOW) {
                    mismatchNoFollowRejected = true;
                    const error = new Error('injected unsupported O_NOFOLLOW before mismatch');
                    error.code = 'EOPNOTSUPP';
                    throw error;
                }
                const handle = await mismatchOriginalOpen.call(
                    fs.promises, mismatchReplacementPath, flags, ...args
                );
                const close = handle.close.bind(handle);
                handle.close = async () => {
                    mismatchHandleClosed = true;
                    return close();
                };
                return handle;
            }
            return mismatchOriginalOpen.call(fs.promises, filePath, flags, ...args);
        };
        let mismatchRecords;
        try {
            mismatchRecords = await mismatchStore.listKnown();
        } finally {
            fs.promises.open = mismatchOriginalOpen;
        }
        assert.strictEqual(mismatchNoFollowRejected, Boolean(fs.constants.O_NOFOLLOW));
        assert.strictEqual(mismatchHandleClosed, true);
        assert.deepStrictEqual(mismatchRecords, []);

        const permissionRoot = path.join(root, 'permission-error');
        const permissionStore = new runtimeStoreModule.TmuxRuntimeBindingStore(permissionRoot, () => now);
        const permissionRecord = known('permission-error', now);
        await permissionStore.setKnown(permissionRecord);
        const permissionPath = path.join(permissionRoot, runtimeRecordFilename(permissionRecord));
        const permissionOriginalOpen = fs.promises.open;
        let permissionOpenAttempts = 0;
        fs.promises.open = async (filePath, flags, ...args) => {
            if (path.resolve(String(filePath)) === path.resolve(permissionPath)) {
                permissionOpenAttempts++;
                const error = new Error('injected permission failure');
                error.code = 'EACCES';
                throw error;
            }
            return permissionOriginalOpen.call(fs.promises, filePath, flags, ...args);
        };
        try {
            await assert.rejects(permissionStore.listKnown(), error => error && error.code === 'EACCES');
        } finally {
            fs.promises.open = permissionOriginalOpen;
        }
        assert.strictEqual(permissionOpenAttempts, 1);

        const raceRoot = path.join(root, 'read-race');
        const raceStore = new runtimeStoreModule.TmuxRuntimeBindingStore(raceRoot, () => now);
        const originalRaceRecord = known('read-race', now);
        await raceStore.setKnown(originalRaceRecord);
        const raceRecordPath = path.join(raceRoot, runtimeRecordFilename(originalRaceRecord));
        const replacementRecordPath = path.join(root, 'read-race-replacement');
        fs.writeFileSync(replacementRecordPath, JSON.stringify(known('read-race', now - 123)));
        const originalLstat = fs.promises.lstat;
        let targetLstatCount = 0;
        fs.promises.lstat = async (filePath, ...args) => {
            const stat = await originalLstat.call(fs.promises, filePath, ...args);
            if (path.resolve(String(filePath)) === path.resolve(raceRecordPath)
                && ++targetLstatCount === 1) {
                fs.unlinkSync(raceRecordPath);
                fs.symlinkSync(replacementRecordPath, raceRecordPath);
            }
            return stat;
        };
        let raceRecords;
        try {
            raceRecords = await raceStore.listKnown();
        } finally {
            fs.promises.lstat = originalLstat;
            fs.rmSync(raceRoot, { recursive: true, force: true });
            fs.rmSync(replacementRecordPath, { force: true });
        }
        assert.deepStrictEqual(raceRecords, []);

        for (let index = 0; index < 513; index++) {
            const capRecord = known(`cap-${index}`, now - 1000 + index);
            fs.writeFileSync(path.join(root, runtimeRecordFilename(capRecord)), JSON.stringify(capRecord));
        }
        const cappedKnown = await store.listKnown();
        assert.strictEqual(cappedKnown.length, 512);
        assert.strictEqual(cappedKnown[0].sessionId, 'queued-set');
        assert.ok(cappedKnown.some(record => record.sessionId === 'cap-512'));
        assert.strictEqual(cappedKnown.some(record => record.sessionId === 'cap-0'), false);

        await store.reconcileKnown([{
            identity: { provider: 'kimi', projectKey: 'pk-live', cwd: '/live', sessionId: 'live' },
            backend: 'tmux',
            state: 'active',
            markerPath: '/tmp/live.done',
            runStartedAtMs: now - 100,
            attached: false,
            tmux: { layout: 'session', sessionName: 'project-steward-s-kimi-live' },
        }, {
            identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 'ignored-vscode' },
            backend: 'vscode',
            state: 'active',
            markerPath: '/tmp/vscode.done',
            runStartedAtMs: now - 100,
            attached: true,
        }]);
        const live = await store.getKnown('kimi', 'live');
        assert.strictEqual(live.lastSeenAtMs, now);
        assert.strictEqual(live.layout, 'session');
        assert.strictEqual(await store.getKnown('codex', 'ignored-vscode'), null);

        await store.removePending('p-old');
        await store.removeKnown('kimi', 'live');
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-new']);
        assert.strictEqual(await store.getKnown('kimi', 'live'), null);
        assert.ok(fs.readdirSync(root).every(name => !name.endsWith('.tmp')));

        const state = new Map();
        const bindingState = {
            get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
            update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value),
        };
        const attach = new attachStoreModule.TmuxAttachBindingStore(bindingState);
        const binding = {
            version: 1,
            layout: 'project',
            projectKey: 'pk',
            sessionName: 'project-steward-p-a',
            windowName: 'ai-codex-a',
            provider: 'codex',
            sessionId: 's1',
            terminalNamePrefix: 'Project Steward:',
        };
        attach.set(Promise.resolve(41), binding);
        await attach.flush();
        assert.deepStrictEqual(attach.get(41), binding);
        assert.deepStrictEqual([...state.keys()], ['aiSessionTmuxAttachProcessBinding.v1.41']);
        const minimalBinding = {
            version: 1,
            layout: 'project',
            projectKey: 'pk',
            sessionName: 'project-steward-p-a',
            terminalNamePrefix: 'Project Steward:',
        };
        attach.set(Promise.resolve(44), minimalBinding);
        await attach.flush();
        assert.deepStrictEqual(attach.get(44), minimalBinding);
        attach.remove(Promise.resolve(44));
        attach.set(Promise.resolve(0), binding);
        attach.set(Promise.resolve(42), { ...binding, layout: 'session' });
        attach.set(Promise.resolve(43), { ...binding, windowName: undefined, terminalNamePrefix: '' });
        await attach.flush();
        assert.strictEqual(state.size, 1);
        attach.remove(Promise.resolve(41));
        await attach.flush();
        assert.strictEqual(state.size, 0);

        let inside = 0;
        let highestInside = 0;
        await Promise.all([1, 2].map(() => creationLock.withTmuxCreationLock(root, 'same-key', async () => {
            inside++;
            highestInside = Math.max(highestInside, inside);
            await new Promise(resolve => setTimeout(resolve, 10));
            inside--;
        })));
        assert.strictEqual(highestInside, 1);
        const lockDirectory = path.join(root, 'ai-session-tmux-locks');
        const sameDigest = crypto.createHash('sha256').update('same-key', 'utf8').digest('hex');
        const sameLockPath = path.join(lockDirectory, `${sameDigest}.lock`);
        assert.strictEqual(fs.lstatSync(sameLockPath).isDirectory(), true);
        assert.deepStrictEqual(fs.readdirSync(sameLockPath), []);

        const raceKey = 'owner-cleanup-race';
        const raceDigest = crypto.createHash('sha256').update(raceKey, 'utf8').digest('hex');
        const raceLockPath = path.join(lockDirectory, `${raceDigest}.lock`);
        const raceHeldPath = path.join(raceLockPath, 'held');
        const oldEntered = deferred();
        const releaseOld = deferred();
        const oldLock = creationLock.withTmuxCreationLock(root, raceKey, async () => {
            oldEntered.resolve();
            await releaseOld.promise;
        });
        await oldEntered.promise;
        assert.strictEqual(fs.lstatSync(raceHeldPath).isDirectory(), true);
        const originalRmdir = fs.promises.rmdir;
        const originalRaceOpen = fs.promises.open;
        const cleanupPaused = deferred();
        const allowCleanup = deferred();
        const replacementClaimPaused = deferred();
        const allowReplacementClaim = deferred();
        let cleanupIntercepted = false;
        let pauseNextReplacementClaim = false;
        let replacementClaimIntercepted = false;
        fs.promises.rmdir = async target => {
            if (!cleanupIntercepted && path.resolve(String(target)) === path.resolve(raceHeldPath)) {
                cleanupIntercepted = true;
                cleanupPaused.resolve();
                await allowCleanup.promise;
            }
            return originalRmdir.call(fs.promises, target);
        };
        fs.promises.open = async (filePath, flags, ...args) => {
            if (pauseNextReplacementClaim && !replacementClaimIntercepted && flags === 'wx'
                && path.dirname(String(filePath)) === raceHeldPath) {
                replacementClaimIntercepted = true;
                replacementClaimPaused.resolve();
                await allowReplacementClaim.promise;
            }
            return originalRaceOpen.call(fs.promises, filePath, flags, ...args);
        };
        let replacementLock;
        let replacementEntries = 0;
        try {
            releaseOld.resolve();
            await cleanupPaused.promise;
            await originalRmdir.call(fs.promises, raceHeldPath);
            pauseNextReplacementClaim = true;
            replacementLock = creationLock.withTmuxCreationLock(root, raceKey, async () => {
                replacementEntries++;
            });
            await replacementClaimPaused.promise;
            allowCleanup.resolve();
            await oldLock;
            allowReplacementClaim.resolve();
            await replacementLock;
            assert.strictEqual(replacementEntries, 1);
            assert.strictEqual(fs.lstatSync(raceLockPath).isDirectory(), true);
            assert.strictEqual(fs.existsSync(raceHeldPath), false);
        } finally {
            fs.promises.rmdir = originalRmdir;
            fs.promises.open = originalRaceOpen;
            releaseOld.resolve();
            allowCleanup.resolve();
            allowReplacementClaim.resolve();
        }

        const originalOpen = fs.promises.open;
        let injectedHandleClosed = false;
        let injected = false;
        fs.promises.open = async (filePath, flags, ...args) => {
            const handle = await originalOpen.call(fs.promises, filePath, flags, ...args);
            if (!injected && flags === 'wx' && String(filePath).startsWith(lockDirectory)) {
                injected = true;
                const originalClose = handle.close.bind(handle);
                handle.writeFile = async () => { throw new Error('injected lock initialization failure'); };
                handle.close = async () => {
                    injectedHandleClosed = true;
                    return originalClose();
                };
            }
            return handle;
        };
        try {
            await assert.rejects(
                creationLock.withTmuxCreationLock(root, 'initialization-failure', async () => undefined),
                /injected lock initialization failure/
            );
        } finally {
            fs.promises.open = originalOpen;
        }
        assert.strictEqual(injectedHandleClosed, true);
        const initializationDigest = crypto.createHash('sha256')
            .update('initialization-failure', 'utf8').digest('hex');
        const initializationLockPath = path.join(lockDirectory, `${initializationDigest}.lock`);
        assert.strictEqual(fs.lstatSync(initializationLockPath).isDirectory(), true);
        assert.deepStrictEqual(fs.readdirSync(initializationLockPath), []);

        const symlinkKey = 'symlinked-lock-container';
        const symlinkDigest = crypto.createHash('sha256').update(symlinkKey, 'utf8').digest('hex');
        const symlinkLockPath = path.join(lockDirectory, `${symlinkDigest}.lock`);
        const externalLockDirectory = path.join(root, 'external-lock-target');
        fs.mkdirSync(externalLockDirectory);
        const externalClaimPath = path.join(externalLockDirectory, `${'a'.repeat(64)}.claim`);
        fs.writeFileSync(externalClaimPath, 'external claim must survive');
        const externalClaimBefore = fs.readFileSync(externalClaimPath, 'utf8');
        const oldExternalTime = new Date(Date.now() - 31000);
        fs.utimesSync(externalClaimPath, oldExternalTime, oldExternalTime);
        fs.symlinkSync(externalLockDirectory, symlinkLockPath, 'dir');
        let symlinkOperationRan = false;
        await assert.rejects(creationLock.withTmuxCreationLock(root, symlinkKey, async () => {
            symlinkOperationRan = true;
        }));
        assert.strictEqual(symlinkOperationRan, false);
        assert.strictEqual(fs.readFileSync(externalClaimPath, 'utf8'), externalClaimBefore);
        assert.deepStrictEqual(fs.readdirSync(externalLockDirectory), [path.basename(externalClaimPath)]);
        fs.unlinkSync(symlinkLockPath);
        fs.rmSync(externalLockDirectory, { recursive: true, force: true });

        const staleDigest = crypto.createHash('sha256').update('stale-key', 'utf8').digest('hex');
        const lockName = `${staleDigest}.lock`;
        const staleLockPath = path.join(lockDirectory, lockName);
        fs.mkdirSync(staleLockPath);
        const staleHeldPath = path.join(staleLockPath, 'held');
        fs.mkdirSync(staleHeldPath);
        const staleContainerIdentity = fs.lstatSync(staleLockPath);
        const staleHeldIdentity = fs.lstatSync(staleHeldPath);
        const staleClaimPath = path.join(staleHeldPath, `${'0'.repeat(64)}.claim`);
        fs.writeFileSync(staleClaimPath, JSON.stringify({
            version: 1,
            containerDev: staleContainerIdentity.dev,
            containerIno: staleContainerIdentity.ino,
            containerBirthtimeMs: staleContainerIdentity.birthtimeMs,
            heldDev: staleHeldIdentity.dev,
            heldIno: staleHeldIdentity.ino,
            heldBirthtimeMs: staleHeldIdentity.birthtimeMs,
        }));
        const staleTime = new Date(Date.now() - 31000);
        fs.utimesSync(staleClaimPath, staleTime, staleTime);
        fs.utimesSync(staleHeldPath, staleTime, staleTime);
        let recovered = false;
        await creationLock.withTmuxCreationLock(root, 'stale-key', async () => { recovered = true; });
        assert.strictEqual(recovered, true);
        assert.strictEqual(fs.lstatSync(staleLockPath).isDirectory(), true);
        assert.strictEqual(fs.existsSync(staleHeldPath), false);
        assert.strictEqual(fs.existsSync(staleClaimPath), false);

        const emptyStaleKey = 'empty-stale-key';
        const emptyStaleDigest = crypto.createHash('sha256').update(emptyStaleKey, 'utf8').digest('hex');
        const emptyStaleLockPath = path.join(lockDirectory, `${emptyStaleDigest}.lock`);
        const emptyStaleHeldPath = path.join(emptyStaleLockPath, 'held');
        fs.mkdirSync(emptyStaleLockPath);
        fs.mkdirSync(emptyStaleHeldPath);
        fs.utimesSync(emptyStaleHeldPath, staleTime, staleTime);
        let emptyStaleRecovered = false;
        await creationLock.withTmuxCreationLock(root, emptyStaleKey, async () => {
            emptyStaleRecovered = true;
        });
        assert.strictEqual(emptyStaleRecovered, true);
        assert.strictEqual(fs.existsSync(emptyStaleHeldPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function main() {
    runRuntimeConfigurationChecks();
    runLaunchSpecChecks();
    runTmuxLayoutChecks();
    await runTmuxClientChecks();
    await runTmuxDiscoveryChecks();
    await runTmuxStoreChecks();
    console.log('AI session tmux checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
