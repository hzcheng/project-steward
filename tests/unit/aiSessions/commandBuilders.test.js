'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const commands = require('../../../out/aiSessions/commandBuilders');
const { serializeDirectLaunchCommand } = require('../../../out/aiSessions/launchSpec');

// SESSION-COMMAND-BUILDER-001

const cwd = '/fixtures/project';
const markerPath = '/fixtures/markers/session.done';
const sessionId = '11111111-1111-4111-8111-111111111111';
const title = "Fixture owner's request";
const providers = [{
    id: 'codex',
    resumeSpec: commands.buildCodexResumeLaunchSpec,
    newSpec: commands.buildCodexNewSessionLaunchSpec,
    expectedResume: {
        executable: 'codex', args: ['resume', '--cd', cwd, sessionId], markerPath,
        windowsDirectShell: 'current',
    },
    expectedNew: {
        executable: 'codex', args: ['--cd', cwd, title], markerPath,
        windowsDirectShell: 'powershell',
    },
    resumeCommand: `codex resume --cd '${cwd}' '${sessionId}'`,
    newCommand: `codex --cd '${cwd}' 'Fixture owner'\\''s request'`,
}, {
    id: 'kimi',
    resumeSpec: commands.buildKimiResumeLaunchSpec,
    newSpec: commands.buildKimiNewSessionLaunchSpec,
    expectedResume: {
        executable: 'kimi', args: ['--work-dir', cwd, '--resume', sessionId], markerPath,
        windowsDirectShell: 'current',
    },
    expectedNew: {
        executable: 'kimi', args: ['--work-dir', cwd, '--prompt', title], markerPath,
        windowsDirectShell: 'powershell',
    },
    resumeCommand: `kimi --work-dir '${cwd}' --resume '${sessionId}'`,
    newCommand: `kimi --work-dir '${cwd}' --prompt 'Fixture owner'\\''s request'`,
}, {
    id: 'claude',
    resumeSpec: commands.buildClaudeResumeLaunchSpec,
    newSpec: commands.buildClaudeNewSessionLaunchSpec,
    expectedResume: {
        executable: 'claude', args: ['--resume', sessionId], cwd, markerPath,
        windowsDirectShell: 'current',
    },
    expectedNew: {
        executable: 'claude', args: ['--name', title], cwd, markerPath,
        windowsDirectShell: 'powershell',
    },
    resumeCommand: `cd '${cwd}' && claude --resume '${sessionId}'`,
    newCommand: `cd '${cwd}' && claude --name 'Fixture owner'\\''s request'`,
}];

for (const provider of providers) {
    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] builds resume and new launch specs`, () => {
        assert.deepEqual(provider.resumeSpec(sessionId, cwd, markerPath), provider.expectedResume);
        assert.deepEqual(provider.newSpec(cwd, title, markerPath), provider.expectedNew);
    });

    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] serializes quoted POSIX commands`, () => {
        const resume = provider.resumeSpec(sessionId, cwd, null);
        const create = provider.newSpec(cwd, title, null);
        assert.equal(serializeDirectLaunchCommand(resume, 'linux'), provider.resumeCommand);
        assert.equal(serializeDirectLaunchCommand(create, 'linux'), provider.newCommand);
    });

    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] wraps terminal marker lifecycle commands`, () => {
        for (const spec of [
            provider.resumeSpec(sessionId, cwd, markerPath),
            provider.newSpec(cwd, title, markerPath),
        ]) {
            const command = serializeDirectLaunchCommand(spec, 'linux');
            assert.ok(command.startsWith('sh -lc '));
            assert.ok(command.includes('rm -f'));
            assert.ok(command.includes(': >'));
            assert.ok(command.includes('/fixtures/markers/session.done'));
        }
    });
}

test('SESSION-COMMAND-BUILDER-001 quotes PowerShell single quotes without interpolation', () => {
    assert.equal(commands.quotePowerShellArg("O'Brien & 100%"), "'O''Brien & 100%'");
});
