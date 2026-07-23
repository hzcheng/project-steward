'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TmuxClient, TmuxClientError } = require('../../../out/aiSessions/tmuxClient');
const { TMUX_METADATA_OPTIONS } = require('../../../out/aiSessions/tmuxLayout');

const REQUIRED_COMMANDS = [
    'new-session', 'new-window', 'list-windows', 'set-option', 'show-options',
    'select-window', 'attach-session', 'has-session', 'rename-session', 'rename-window',
    'display-message',
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

    for (const omitted of ['attach-session', 'has-session', 'rename-session', 'rename-window']) {
        const missingCapability = new TmuxClient('tmux', {
            run: async (_file, args) => args[0] === '-V'
                ? { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' }
                : { exitCode: 0, stdout: REQUIRED_COMMANDS.filter(name => name !== omitted).join('\n'), stderr: '' },
        });
        assert.deepEqual(await missingCapability.checkAvailability(), {
            available: false,
            category: 'missing-capability',
            message: 'The configured tmux does not provide all required commands.',
        }, omitted);
    }
    for (const stdout of ['tmux   \n', 'tmux 3.4 token=secret\n']) {
        const invalidVersion = new TmuxClient('tmux', {
            run: async () => ({ exitCode: 0, stdout, stderr: 'credential=never-report' }),
        });
        assert.deepEqual(await invalidVersion.checkAvailability(), {
            available: false,
            category: 'invalid-version',
            message: 'The configured tmux returned an unrecognized version.',
        });
    }
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
        'session-a|version': '2',
        'session-a|layout': 'project',
        'session-a|workspaceScopeIdentity': 'scope-identity',
        'session-a|workspaceNavigationIdentity': 'navigation-identity',
        'session-a|workspaceRootHostPaths': '["/work/app"]',
        'session-a|cwd': '/work/app',
        'session-a:window-a|provider': 'codex',
        'session-a:window-a|sessionId': 'session-id',
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
    };
    const runner = {
        run: async (file, args) => {
            calls.push({ file, args });
            const available = availabilityResult(args);
            if (available) return available;
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
                const option = args.at(-1);
                const key = Object.keys(TMUX_METADATA_OPTIONS).find(name => TMUX_METADATA_OPTIONS[name] === option);
                const value = values[`${target}|${key}`];
                return { exitCode: 0, stdout: value === undefined ? '' : `${value}\n`, stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const client = new TmuxClient('tmux', runner);
    const windows = await client.listWindows();
    assert.deepEqual(windows.map(window => ({
        windowId: window.windowId,
        active: window.active,
        provider: window.metadata.provider,
        sessionId: window.metadata.sessionId,
        marker: window.metadata.marker,
        workspaceScopeIdentity: window.metadata.workspaceScopeIdentity,
    })), [
        {
            windowId: '@12', active: true, provider: 'codex', sessionId: 'session-id-12',
            marker: '/tmp/done-12 marker', workspaceScopeIdentity: 'scope-identity',
        },
        {
            windowId: '@13', active: false, provider: 'kimi', sessionId: 'session-id-13',
            marker: '/tmp/done-13 marker', workspaceScopeIdentity: 'scope-identity',
        },
    ]);
    for (const windowId of ['@12', '@13']) {
        assert.ok(calls.some(call => JSON.stringify(call.args) === JSON.stringify([
            'show-options', '-qvw', '-t', windowId, '@project-steward-provider',
        ])));
    }
    assert.deepEqual(await client.getSessionOptions('session-a'), {
        managed: '1',
        version: '2',
        layout: 'project',
        workspaceScopeIdentity: 'scope-identity',
        workspaceNavigationIdentity: 'navigation-identity',
        workspaceRootHostPaths: '["/work/app"]',
        cwd: '/work/app',
    });
    assert.deepEqual(await client.getWindowOptions('session-a', 'window-a'), {
        provider: 'codex', sessionId: 'session-id',
    });
    await client.setSessionOptions('session-a', { managed: '1', version: '2' });
    await client.setWindowOptions('session-a', 'window-a', { provider: 'codex', sessionId: 'session-id' });
    await client.configureManagedWindow('session-a', 'window-a');
    await client.clearPendingMetadata({
        layout: 'project', sessionName: 'session-a', windowName: 'window-a',
    });
    await client.clearPendingMetadata({ layout: 'session', sessionName: 'session-a' });
    assert.ok(calls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-t', 'session-a', '@project-steward-managed', '1',
    ])));
    assert.ok(calls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-w', '-t', 'session-a:window-a', '@project-steward-session-id', 'session-id',
    ])));
    assert.deepEqual(calls.slice(-5).map(call => call.args), [
        ['set-option', '-w', '-t', 'session-a:window-a', 'automatic-rename', 'off'],
        ['set-option', '-w', '-t', 'session-a:window-a', 'allow-rename', 'off'],
        ['set-option', '-w', '-t', 'session-a:window-a', 'remain-on-exit', 'off'],
        ['set-option', '-uw', '-t', 'session-a:window-a', '@project-steward-pending-id'],
        ['set-option', '-u', '-t', 'session-a', '@project-steward-pending-id'],
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

test('RUNTIME-TMUX-FOCUS-TARGET-001 reads one exact atomic target snapshot and fails closed', async () => {
    const calls = [];
    const metadata = {
        managed: '1',
        version: '2',
        layout: 'project',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: '["/work"]',
        cwd: '/work',
        provider: 'codex',
        sessionId: 'session',
        createdAt: '2026-07-18T10:00:00.000Z',
        marker: '/tmp/runtime.done',
    };
    const metadataKeys = Object.keys(TMUX_METADATA_OPTIONS);
    let result = {
        exitCode: 0,
        stdout: [
            'managed-session',
            'codex-session',
            '@42',
            ...metadataKeys.map(key => metadata[key] || ''),
        ].join('\u001f') + '\n',
        stderr: '',
    };
    const client = new TmuxClient('/private/tmux', {
        run: async (_file, args) => {
            calls.push(args);
            return availabilityResult(args) || result;
        },
    });
    const locator = {
        layout: 'project',
        sessionName: 'managed-session',
        windowName: 'codex-session',
    };

    assert.deepEqual(await client.getTargetWindow(locator), {
        sessionName: 'managed-session',
        windowName: 'codex-session',
        windowId: '@42',
        metadata,
    });
    const snapshots = calls.filter(args => args[0] === 'display-message');
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0].slice(0, 4), [
        'display-message', '-p', '-t', 'managed-session:codex-session',
    ]);
    for (const option of Object.values(TMUX_METADATA_OPTIONS)) {
        assert.ok(snapshots[0][4].includes(`#{${option}}`), option);
    }
    assert.equal(calls.some(args => args[0] === 'list-windows'), false);
    assert.equal(calls.some(args => args[0] === 'show-options'), false);

    result = {
        exitCode: 1,
        stdout: '',
        stderr: "can't find window: codex-session",
    };
    assert.equal(await client.getTargetWindow(locator), null);

    for (const stdout of [
        '',
        'managed-session\u001fcodex-session\u001fnot-a-window-id',
        'managed-session\u001fcodex-session\u001f@42\nsecond-row',
        `${'x'.repeat(1024 * 1024 + 1)}`,
    ]) {
        result = { exitCode: 0, stdout, stderr: '' };
        await assert.rejects(
            client.getTargetWindow(locator),
            error => error instanceof TmuxClientError
                && error.operation === 'get-target-window'
                && error.category === 'invalid-output'
        );
    }

    result = {
        exitCode: 2,
        stdout: 'secret stdout',
        stderr: 'secret stderr managed-session /private/tmux',
    };
    await assert.rejects(client.getTargetWindow(locator), error => {
        const publicError = `${error.message} ${JSON.stringify(error)}`;
        for (const secret of [
            'secret stdout', 'secret stderr', 'managed-session', '/private/tmux',
        ]) {
            assert.equal(publicError.includes(secret), false);
        }
        return error instanceof TmuxClientError
            && error.operation === 'get-target-window'
            && error.category === 'nonzero-exit';
    });
});

test('RUNTIME-TMUX-CLIENT-001 rejects malformed runner results and sanitizes forged error objects', async () => {
    const missingSession = new TmuxClient('tmux', {
        run: async (_file, args) => availabilityResult(args) || {
            exitCode: 1, stdout: '', stderr: "can't find session: absent",
        },
    });
    assert.equal(await missingSession.hasSession('absent'), false);

    const malformedCategory = 'category=do-not-report';
    const malformed = new TmuxClient('tmux', {
        run: async (_file, args) => availabilityResult(args) || {
            exitCode: null, stdout: '', stderr: '', failureCategory: malformedCategory,
        },
    });
    await assert.rejects(malformed.hasSession('s'), error => {
        assert.equal(error.operation, 'has-session');
        assert.equal(error.category, 'invalid-output');
        assert.equal(error.message.includes(malformedCategory), false);
        return true;
    });

    const forgedSecrets = {
        message: 'message=forged-secret', operation: 'operation=forged-secret',
        category: 'category=forged-secret', name: 'name=forged-secret',
        stack: 'stack=forged-secret', code: 'code=forged-secret',
    };
    const forged = new TmuxClientError(forgedSecrets.operation, forgedSecrets.category);
    Object.assign(forged, forgedSecrets);
    const sanitized = new TmuxClient('tmux', {
        run: async (_file, args) => {
            const available = availabilityResult(args);
            if (available) return available;
            throw forged;
        },
    });
    await assert.rejects(sanitized.hasSession('s'), error => {
        assert.ok(error instanceof TmuxClientError);
        assert.notEqual(error, forged);
        assert.equal(error.operation, 'has-session');
        assert.equal(error.category, 'unsupported');
        const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
        for (const secret of Object.values(forgedSecrets)) assert.equal(publicError.includes(secret), false);
        return true;
    });

    for (const rejected of [
        {
            secret: 'rejected-code-getter-secret',
            value: new Proxy({}, {
                get: (_target, property) => {
                    if (property === 'code') throw new Error('rejected-code-getter-secret');
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
    ]) {
        const client = new TmuxClient('tmux', {
            run: async (_file, args) => {
                const available = availabilityResult(args);
                if (available) return available;
                throw rejected.value;
            },
        });
        await assert.rejects(client.hasSession('s'), error => {
            assert.ok(error instanceof TmuxClientError);
            assert.notEqual(error, rejected.value);
            assert.equal(error.operation, 'has-session');
            assert.equal(error.category, 'unsupported');
            const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
            assert.equal(publicError.includes(rejected.secret), false);
            return true;
        });
    }

    const fulfilledSecrets = {
        message: 'fulfilled-getter-message-secret', operation: 'fulfilled-getter-operation-secret',
        category: 'fulfilled-getter-category-secret',
    };
    const fulfilledError = new TmuxClientError(fulfilledSecrets.operation, fulfilledSecrets.category);
    fulfilledError.message = fulfilledSecrets.message;
    const fulfilledProxy = new Proxy({}, {
        get: (_target, property) => {
            if (property === 'exitCode') throw fulfilledError;
            return '';
        },
    });
    const fulfilledClient = new TmuxClient('tmux', {
        run: async (_file, args) => availabilityResult(args) || fulfilledProxy,
    });
    await assert.rejects(fulfilledClient.hasSession('s'), error => {
        assert.ok(error instanceof TmuxClientError);
        assert.notEqual(error, fulfilledError);
        assert.equal(error.operation, 'has-session');
        assert.equal(error.category, 'invalid-output');
        const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
        for (const secret of Object.values(fulfilledSecrets)) assert.equal(publicError.includes(secret), false);
        return true;
    });

    const availabilitySecret = 'availability-getter-secret';
    const availabilityProxy = new TmuxClient('tmux', {
        run: async () => new Proxy({}, {
            get: () => { throw new Error(availabilitySecret); },
        }),
    });
    const availability = await availabilityProxy.checkAvailability();
    assert.deepEqual(availability, {
        available: false,
        category: 'command-failed',
        message: 'The configured tmux could not complete an availability check.',
    });
    assert.equal(JSON.stringify(availability).includes(availabilitySecret), false);
});
