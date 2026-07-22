'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TmuxClient, TmuxClientError } = require('../../../out/aiSessions/tmuxClient');
const { TMUX_METADATA_OPTIONS } = require('../../../out/aiSessions/tmuxLayout');

const REQUIRED_COMMANDS = [
    'new-session', 'new-window', 'list-windows', 'set-option', 'show-options',
    'select-window', 'attach-session', 'has-session', 'rename-session', 'rename-window',
];

function availabilityResult(args) {
    if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
    if (args[0] === 'list-commands') {
        return { exitCode: 0, stdout: REQUIRED_COMMANDS.map(name => `${name} [-flags]`).join('\n'), stderr: '' };
    }
    return null;
}

test('RUNTIME-TMUX-CLIENT-001 caches availability and sends exact argv without shell interpolation', async () => {
    const calls = [];
    const runner = {
        run: async (file, args) => {
            calls.push({ file, args });
            return availabilityResult(args) || { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const client = new TmuxClient('  /opt/tmux tools/tmux  ', runner);
    assert.deepEqual(await client.checkAvailability(), { available: true, version: '3.4' });
    assert.deepEqual(await client.checkAvailability(), { available: true, version: '3.4' });
    assert.equal(calls.filter(call => call.args[0] === '-V').length, 1);

    await client.createSession('session-a', 'window-a', '/work/space here', 'exec provider --token inert');
    await client.createWindow('session-a', 'window-b', '/work/space here', 'exec provider --token inert');
    await client.renameSession('session-a', 'session-b');
    await client.renameWindow('session-b', 'window-b', 'window-c');
    await client.selectWindow({ layout: 'project', sessionName: 'session-b', windowName: 'window-c' });
    assert.deepEqual(calls.slice(-5), [
        { file: '/opt/tmux tools/tmux', args: [
            'new-session', '-d', '-s', 'session-a', '-n', 'window-a', '-c', '/work/space here',
            'exec provider --token inert',
        ] },
        { file: '/opt/tmux tools/tmux', args: [
            'new-window', '-d', '-t', 'session-a', '-n', 'window-b', '-c', '/work/space here',
            'exec provider --token inert',
        ] },
        { file: '/opt/tmux tools/tmux', args: ['rename-session', '-t', 'session-a', 'session-b'] },
        { file: '/opt/tmux tools/tmux', args: ['rename-window', '-t', 'session-b:window-b', 'window-c'] },
        { file: '/opt/tmux tools/tmux', args: ['select-window', '-t', 'session-b:window-c'] },
    ]);
    assert.ok(calls.every(call => Array.isArray(call.args)));

    client.setExecutablePath(' /new path/tmux ');
    assert.equal(client.getExecutablePath(), '/new path/tmux');
    await client.hasSession('session-b');
    assert.equal(calls.filter(call => call.args[0] === '-V').length, 2);
    assert.ok(calls.slice(-3).every(call => call.file === '/new path/tmux'));
    assert.throws(() => client.setExecutablePath('   '), /executable/);

    const missingCapability = new TmuxClient('tmux', {
        run: async (_file, args) => args[0] === '-V'
            ? { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' }
            : { exitCode: 0, stdout: REQUIRED_COMMANDS.filter(name => name !== 'attach-session').join('\n'), stderr: '' },
    });
    assert.deepEqual(await missingCapability.checkAvailability(), {
        available: false,
        category: 'missing-capability',
        message: 'The configured tmux does not provide all required commands.',
    });
});

test('RUNTIME-TMUX-CLIENT-001 parses one active window and rejects malformed, foreign, or secret output', async () => {
    const calls = [];
    let result = {
        exitCode: 0,
        stdout: [
            'project-session\u001fbase\u001f@1\u001f0',
            'project-session\u001fai-codex-a\u001f@2\u001f1',
        ].join('\n') + '\n',
        stderr: '',
    };
    const client = new TmuxClient('/private/tmux', {
        run: async (_file, args) => {
            calls.push(args);
            return availabilityResult(args) || result;
        },
    });
    assert.deepEqual(await client.getActiveWindow('project-session'), {
        sessionName: 'project-session', windowName: 'ai-codex-a', windowId: '@2',
    });
    assert.deepEqual(calls.at(-1), [
        'list-windows', '-t', 'project-session', '-F',
        '#{session_name}\u001f#{window_name}\u001f#{window_id}\u001f#{window_active}',
    ]);

    result = { exitCode: 0, stdout: '', stderr: '' };
    assert.equal(await client.getActiveWindow('project-session'), null);
    for (const stdout of [
        'project-session\u001fa\u001f@1\u001f1\nproject-session\u001fb\u001f@2\u001f1\n',
        'foreign-session\u001fa\u001f@1\u001f1\n',
        'x'.repeat(1024 * 1024 + 1),
    ]) {
        result = { exitCode: 0, stdout, stderr: '' };
        await assert.rejects(client.getActiveWindow('project-session'), error =>
            error instanceof TmuxClientError
            && error.operation === 'get-active-window'
            && error.category === 'invalid-output');
    }
    result = { exitCode: 1, stdout: '', stderr: "can't find session: project-session" };
    assert.equal(await client.getActiveWindow('project-session'), null);
    result = { exitCode: 2, stdout: 'secret stdout', stderr: 'secret stderr project-session' };
    await assert.rejects(client.getActiveWindow('project-session'), error => {
        assert.equal(error.operation, 'get-active-window');
        assert.equal(error.category, 'nonzero-exit');
        for (const secret of ['project-session', 'secret stdout', 'secret stderr', '/private/tmux']) {
            assert.equal(error.message.includes(secret), false);
        }
        return true;
    });
    await assert.rejects(client.getActiveWindow('bad\nsession'), TypeError);
});

test('RUNTIME-TMUX-CLIENT-001 reads and writes metadata options and maps runner failures safely', async () => {
    const calls = [];
    const values = {
        'session-a|managed': '1',
        'session-a|version': '1',
        'session-a|layout': 'project',
        'session-a|projectKey': 'project-key',
        'session-a:window-a|provider': 'codex',
        'session-a:window-a|sessionId': 'session-id',
    };
    const runner = {
        run: async (file, args) => {
            calls.push({ file, args });
            const available = availabilityResult(args);
            if (available) return available;
            if (args[0] === 'show-options') {
                const target = args[args.indexOf('-t') + 1];
                const option = args.at(-1);
                const key = Object.keys(TMUX_METADATA_OPTIONS).find(name => TMUX_METADATA_OPTIONS[name] === option);
                const value = values[`${target}|${key}`];
                return { exitCode: 0, stdout: value === undefined ? '' : `${value}\n`, stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const client = new TmuxClient('tmux', runner);
    assert.deepEqual(await client.getSessionOptions('session-a'), {
        managed: '1', version: '1', layout: 'project', projectKey: 'project-key',
    });
    assert.deepEqual(await client.getWindowOptions('session-a', 'window-a'), {
        provider: 'codex', sessionId: 'session-id',
    });
    await client.setSessionOptions('session-a', { managed: '1', version: '1' });
    await client.setWindowOptions('session-a', 'window-a', { provider: 'codex', sessionId: 'session-id' });
    await client.configureManagedWindow('session-a', 'window-a');
    await client.clearPendingMetadata({
        layout: 'project', sessionName: 'session-a', windowName: 'window-a',
    });
    assert.ok(calls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-t', 'session-a', '@project-steward-managed', '1',
    ])));
    assert.ok(calls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-w', '-t', 'session-a:window-a', '@project-steward-session-id', 'session-id',
    ])));
    assert.deepEqual(calls.slice(-4).map(call => call.args), [
        ['set-option', '-w', '-t', 'session-a:window-a', 'automatic-rename', 'off'],
        ['set-option', '-w', '-t', 'session-a:window-a', 'allow-rename', 'off'],
        ['set-option', '-w', '-t', 'session-a:window-a', 'remain-on-exit', 'off'],
        ['set-option', '-uw', '-t', 'session-a:window-a', '@project-steward-pending-id'],
    ]);
    await assert.rejects(client.setSessionOptions('session-a', { status: 'not-allowed' }), /metadata option/);
    await assert.rejects(client.clearPendingMetadata({ layout: 'project', sessionName: 'session-a' }), TypeError);

    const e2big = new TmuxClient('tmux', {
        run: async (_file, args) => {
            const available = availabilityResult(args);
            if (available) return available;
            const error = new Error('argument list too long: secret');
            error.code = 'E2BIG';
            throw error;
        },
    });
    await assert.rejects(e2big.createSession('s', 'w', '/work', 'secret'), error =>
        error instanceof TmuxClientError && error.category === 'argument-list-too-long');

    const failing = new TmuxClient('/secret/tmux', {
        run: async (_file, args) => availabilityResult(args) || {
            exitCode: 42, stdout: 'stdout token=secret', stderr: 'stderr token=secret',
        },
    });
    await assert.rejects(failing.createSession('secret-session', 'secret-window', '/secret/cwd', 'token=secret'), error => {
        assert.equal(error.operation, 'create-session');
        assert.equal(error.category, 'nonzero-exit');
        const publicError = `${error.message} ${JSON.stringify(error)}`;
        for (const secret of ['token=secret', '/secret/tmux', 'secret-session', 'secret-window', '/secret/cwd']) {
            assert.equal(publicError.includes(secret), false);
        }
        return true;
    });
});
