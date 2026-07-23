'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const commands = require('../../../out/aiSessions/commandBuilders');

// SESSION-COMMAND-BUILDER-001

const cwd = 'C:\\fixtures\\project folder & 100%';
const quotedCwd = 'C:\\fixtures\\project folder & 100% O\'Brien "quoted"';
const sessionId = 'session "quoted" & 100%';
const value = 'Owner\'s "quoted" & 100%';
const markerPath = 'C:\\fixtures\\marker\'s & 100%.done';

function directoryScope(primaryCwd) {
    return Object.freeze({
        workspaceNavigationIdentity: `navigation:${primaryCwd || 'empty'}`,
        workspaceScopeIdentity: `scope:${primaryCwd || 'empty'}`,
        workspaceRootHostPaths: Object.freeze(primaryCwd ? [primaryCwd] : []),
        primaryRootId: `root:${primaryCwd || 'empty'}`,
        primaryCwd,
        additionalDirectories: Object.freeze([]),
    });
}

function decodePowerShellPayload(command) {
    const prefix = 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ';
    assert.ok(command.startsWith(prefix));
    return Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
}

const providers = [{
    id: 'codex',
    resumeCommand: commands.buildCodexResumeCommand,
    newCommand: commands.buildCodexNewSessionCommand,
    resumeSpec: commands.buildCodexResumeLaunchSpec,
    newSpec: commands.buildCodexNewSessionLaunchSpec,
    currentShellResume: 'codex resume --cd "C:\\fixtures\\project folder & 100%" "session \\"quoted\\" & 100%"',
    emptyResume: 'codex resume ""',
    emptyNew: 'codex',
    markedResume: "codex resume --cd 'C:\\fixtures\\project folder & 100% O''Brien \"quoted\"' 'Owner''s \"quoted\" & 100%'",
    markedNew: "codex --cd 'C:\\fixtures\\project folder & 100% O''Brien \"quoted\"' 'Owner''s \"quoted\" & 100%'",
}, {
    id: 'kimi',
    resumeCommand: commands.buildKimiResumeCommand,
    newCommand: commands.buildKimiNewSessionCommand,
    resumeSpec: commands.buildKimiResumeLaunchSpec,
    newSpec: commands.buildKimiNewSessionLaunchSpec,
    currentShellResume: 'kimi --work-dir "C:\\fixtures\\project folder & 100%" --resume "session \\"quoted\\" & 100%"',
    emptyResume: 'kimi --resume ""',
    emptyNew: 'kimi',
    markedResume: "kimi --work-dir 'C:\\fixtures\\project folder & 100% O''Brien \"quoted\"' --resume 'Owner''s \"quoted\" & 100%'",
    markedNew: "kimi --work-dir 'C:\\fixtures\\project folder & 100% O''Brien \"quoted\"' --prompt 'Owner''s \"quoted\" & 100%'",
}, {
    id: 'claude',
    resumeCommand: commands.buildClaudeResumeCommand,
    newCommand: commands.buildClaudeNewSessionCommand,
    resumeSpec: commands.buildClaudeResumeLaunchSpec,
    newSpec: commands.buildClaudeNewSessionLaunchSpec,
    currentShellResume: 'cd "C:\\fixtures\\project folder & 100%" && claude --resume "session \\"quoted\\" & 100%"',
    emptyResume: 'claude --resume ""',
    emptyNew: 'claude',
    markedResume: "claude --resume 'Owner''s \"quoted\" & 100%'",
    markedNew: "claude --name 'Owner''s \"quoted\" & 100%'",
    usesSpecCwd: true,
}];

for (const provider of providers) {
    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] quotes Windows current-shell resume values`, () => {
        assert.equal(
            provider.resumeCommand(sessionId, directoryScope(cwd), null, 'win32'),
            provider.currentShellResume
        );
    });

    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] preserves special values in marked PowerShell commands`, () => {
        const resumePayload = decodePowerShellPayload(
            provider.resumeCommand(value, directoryScope(quotedCwd), markerPath, 'win32')
        );
        const newPayload = decodePowerShellPayload(
            provider.newCommand(directoryScope(quotedCwd), value, markerPath, 'win32')
        );
        const markerLiteral = "'C:\\fixtures\\marker''s & 100%.done'";

        for (const payload of [resumePayload, newPayload]) {
            assert.ok(payload.includes(`Remove-Item -LiteralPath ${markerLiteral}`));
            assert.ok(payload.includes(`New-Item -ItemType File -Force -Path ${markerLiteral}`));
        }
        if (provider.usesSpecCwd) {
            const cwdLiteral = "'C:\\fixtures\\project folder & 100% O''Brien \"quoted\"'";
            assert.ok(resumePayload.includes(`Set-Location -LiteralPath ${cwdLiteral}`));
            assert.ok(newPayload.includes(`Set-Location -LiteralPath ${cwdLiteral}`));
        }
        assert.ok(resumePayload.includes(provider.markedResume));
        assert.ok(newPayload.includes(provider.markedNew));
    });

    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] serializes empty Windows command values`, () => {
        const emptyScope = directoryScope('');
        const resumeSpec = provider.resumeSpec('', emptyScope, null);
        const newSpec = provider.newSpec(emptyScope, '', null);
        assert.equal(resumeSpec.args[resumeSpec.args.length - 1], '');
        assert.equal(resumeSpec.cwd, undefined);
        assert.equal(newSpec.cwd, undefined);
        assert.equal(newSpec.args.includes(''), false);
        assert.equal(provider.resumeCommand('', emptyScope, null, 'win32'), provider.emptyResume);
        assert.equal(
            decodePowerShellPayload(provider.newCommand(emptyScope, '', null, 'win32')),
            provider.emptyNew
        );
    });
}

test('SESSION-COMMAND-BUILDER-001 doubles PowerShell single quotes alongside ampersands and percents', () => {
    assert.equal(commands.quotePowerShellArg(value), "'Owner''s \"quoted\" & 100%'");
});
