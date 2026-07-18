'use strict';

import {
    AiSessionLaunchSpec,
    quotePosixShellArg,
    serializeDirectLaunchCommand,
} from './launchSpec';

export type AiSessionCommandPlatform = NodeJS.Platform;

export function buildCodexResumeLaunchSpec(sessionId: string, cwd: string, markerPath: string = null): AiSessionLaunchSpec {
    return {
        executable: 'codex',
        args: ['resume', ...(cwd ? ['--cd', cwd] : []), sessionId],
        markerPath,
    };
}

export function buildCodexNewSessionLaunchSpec(cwd: string, prompt: string = null, markerPath: string = null): AiSessionLaunchSpec {
    return {
        executable: 'codex',
        args: [...(cwd ? ['--cd', cwd] : []), ...(prompt ? [prompt] : [])],
        markerPath,
    };
}

export function buildKimiResumeLaunchSpec(sessionId: string, cwd: string, markerPath: string = null): AiSessionLaunchSpec {
    return {
        executable: 'kimi',
        args: [...(cwd ? ['--work-dir', cwd] : []), '--resume', sessionId],
        markerPath,
    };
}

export function buildKimiNewSessionLaunchSpec(cwd: string, prompt: string = null, markerPath: string = null): AiSessionLaunchSpec {
    return {
        executable: 'kimi',
        args: [...(cwd ? ['--work-dir', cwd] : []), ...(prompt ? ['--prompt', prompt] : [])],
        markerPath,
    };
}

export function buildClaudeResumeLaunchSpec(sessionId: string, cwd: string, markerPath: string = null): AiSessionLaunchSpec {
    return {
        executable: 'claude',
        args: ['--resume', sessionId],
        cwd: cwd || undefined,
        markerPath,
    };
}

export function buildClaudeNewSessionLaunchSpec(cwd: string, title: string = null, markerPath: string = null): AiSessionLaunchSpec {
    return {
        executable: 'claude',
        args: title ? ['--name', title] : [],
        cwd: cwd || undefined,
        markerPath,
    };
}

export function buildCodexResumeCommand(sessionId: string, cwd: string, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildCodexResumeLaunchSpec(sessionId, cwd, markerPath), platform);
}

export function buildCodexNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildCodexNewSessionLaunchSpec(cwd, prompt, markerPath), platform);
}

export function buildKimiResumeCommand(sessionId: string, cwd: string, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildKimiResumeLaunchSpec(sessionId, cwd, markerPath), platform);
}

export function buildKimiNewSessionCommand(cwd: string, prompt: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildKimiNewSessionLaunchSpec(cwd, prompt, markerPath), platform);
}

export function buildClaudeResumeCommand(sessionId: string, cwd: string, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildClaudeResumeLaunchSpec(sessionId, cwd, markerPath), platform);
}

export function buildClaudeNewSessionCommand(cwd: string, title: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildClaudeNewSessionLaunchSpec(cwd, title, markerPath), platform);
}

export function quoteShellArg(value: string, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32') {
        return quoteWindowsCommandArg(value);
    }
    return quotePosixShellArg(value);
}

export function quotePowerShellArg(value: string): string {
    return `'${String(value).replace(/'/g, `''`)}'`;
}

export function quoteWindowsCommandArg(value: string): string {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}
