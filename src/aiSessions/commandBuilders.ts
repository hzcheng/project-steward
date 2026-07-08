'use strict';

export type AiSessionCommandPlatform = NodeJS.Platform;

export function buildCodexResumeCommand(sessionId: string, cwd: string, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32' && markerPath) {
        return buildWindowsCodexResumeCommand(sessionId, cwd, markerPath);
    }

    let quotedSessionId = quoteShellArg(sessionId, platform);
    let resumeCommand = cwd
        ? `codex resume --cd ${quoteShellArg(cwd, platform)} ${quotedSessionId}`
        : `codex resume ${quotedSessionId}`;

    return wrapShellCommandWithMarker(resumeCommand, markerPath, platform);
}

export function buildCodexNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32') {
        return buildWindowsCodexNewSessionCommand(cwd, prompt, markerPath);
    }

    let promptArg = prompt ? ` ${quoteShellArg(prompt, platform)}` : '';
    let newSessionCommand = cwd
        ? `codex --cd ${quoteShellArg(cwd, platform)}${promptArg}`
        : `codex${promptArg}`;

    return wrapShellCommandWithMarker(newSessionCommand, markerPath, platform);
}

export function buildKimiResumeCommand(sessionId: string, cwd: string, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32' && markerPath) {
        return buildWindowsKimiResumeCommand(sessionId, cwd, markerPath);
    }

    let resumeCommand = cwd
        ? `kimi --work-dir ${quoteShellArg(cwd, platform)} --resume ${quoteShellArg(sessionId, platform)}`
        : `kimi --resume ${quoteShellArg(sessionId, platform)}`;

    return wrapShellCommandWithMarker(resumeCommand, markerPath, platform);
}

export function buildKimiNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32') {
        return buildWindowsKimiNewSessionCommand(cwd, prompt, markerPath);
    }

    let promptArg = prompt ? ` --prompt ${quoteShellArg(prompt, platform)}` : '';
    let newSessionCommand = cwd
        ? `kimi --work-dir ${quoteShellArg(cwd, platform)}${promptArg}`
        : `kimi${promptArg}`;

    return wrapShellCommandWithMarker(newSessionCommand, markerPath, platform);
}

export function buildClaudeResumeCommand(sessionId: string, cwd: string, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32' && markerPath) {
        return buildWindowsClaudeResumeCommand(sessionId, cwd, markerPath);
    }

    let resumeCommand = cwd
        ? `cd ${quoteShellArg(cwd, platform)} && claude --resume ${quoteShellArg(sessionId, platform)}`
        : `claude --resume ${quoteShellArg(sessionId, platform)}`;

    return wrapShellCommandWithMarker(resumeCommand, markerPath, platform);
}

export function buildClaudeNewSessionCommand(cwd: string, title: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32') {
        return buildWindowsClaudeNewSessionCommand(cwd, title, markerPath);
    }

    let titleArg = title ? ` --name ${quoteShellArg(title, platform)}` : '';
    let newSessionCommand = cwd
        ? `cd ${quoteShellArg(cwd, platform)} && claude${titleArg}`
        : `claude${titleArg}`;

    return wrapShellCommandWithMarker(newSessionCommand, markerPath, platform);
}

export function quoteShellArg(value: string, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32') {
        return `"${String(value).replace(/"/g, '\\"')}"`;
    }

    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function quotePowerShellArg(value: string): string {
    return `'${String(value).replace(/'/g, `''`)}'`;
}

export function quoteWindowsCommandArg(value: string): string {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function wrapShellCommandWithMarker(command: string, markerPath: string, platform: AiSessionCommandPlatform): string {
    if (!markerPath) {
        return command;
    }

    let markerArg = quoteShellArg(markerPath, platform);
    return `sh -lc ${quoteShellArg(`rm -f ${markerArg}; ${command}; : > ${markerArg}`, platform)}`;
}

function buildWindowsCodexResumeCommand(sessionId: string, cwd: string, markerPath: string): string {
    let resumeCommand = cwd
        ? `codex resume --cd ${quotePowerShellArg(cwd)} ${quotePowerShellArg(sessionId)}`
        : `codex resume ${quotePowerShellArg(sessionId)}`;
    return wrapPowerShellCommandWithMarker(resumeCommand, markerPath);
}

function buildWindowsCodexNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null): string {
    let promptArg = prompt ? ` ${quotePowerShellArg(prompt)}` : '';
    let command = cwd
        ? `codex --cd ${quotePowerShellArg(cwd)}${promptArg}`
        : `codex${promptArg}`;

    return markerPath ? wrapPowerShellCommandWithMarker(command, markerPath) : wrapPowerShellCommand(command);
}

function buildWindowsKimiResumeCommand(sessionId: string, cwd: string, markerPath: string): string {
    let resumeCommand = cwd
        ? `kimi --work-dir ${quotePowerShellArg(cwd)} --resume ${quotePowerShellArg(sessionId)}`
        : `kimi --resume ${quotePowerShellArg(sessionId)}`;
    return wrapPowerShellCommandWithMarker(resumeCommand, markerPath);
}

function buildWindowsKimiNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null): string {
    let promptArg = prompt ? ` --prompt ${quotePowerShellArg(prompt)}` : '';
    let command = cwd
        ? `kimi --work-dir ${quotePowerShellArg(cwd)}${promptArg}`
        : `kimi${promptArg}`;

    return markerPath ? wrapPowerShellCommandWithMarker(command, markerPath) : wrapPowerShellCommand(command);
}

function buildWindowsClaudeResumeCommand(sessionId: string, cwd: string, markerPath: string): string {
    let resumeCommand = cwd
        ? `Set-Location -LiteralPath ${quotePowerShellArg(cwd)}; claude --resume ${quotePowerShellArg(sessionId)}`
        : `claude --resume ${quotePowerShellArg(sessionId)}`;
    return wrapPowerShellCommandWithMarker(resumeCommand, markerPath);
}

function buildWindowsClaudeNewSessionCommand(cwd: string, title: string = null, markerPath: string = null): string {
    let titleArg = title ? ` --name ${quotePowerShellArg(title)}` : '';
    let command = cwd
        ? `Set-Location -LiteralPath ${quotePowerShellArg(cwd)}; claude${titleArg}`
        : `claude${titleArg}`;

    return markerPath ? wrapPowerShellCommandWithMarker(command, markerPath) : wrapPowerShellCommand(command);
}

function wrapPowerShellCommandWithMarker(command: string, markerPath: string): string {
    return wrapPowerShellCommand([
        `Remove-Item -LiteralPath ${quotePowerShellArg(markerPath)} -ErrorAction SilentlyContinue`,
        command,
        `New-Item -ItemType File -Force -Path ${quotePowerShellArg(markerPath)} | Out-Null`,
    ].join('; '));
}

function wrapPowerShellCommand(command: string): string {
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsCommandArg(command)}`;
}
