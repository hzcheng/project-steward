'use strict';

export interface AiSessionLaunchSpec {
    executable: string;
    args: string[];
    cwd?: string;
    markerPath?: string;
}

export function serializeDirectLaunchCommand(
    spec: AiSessionLaunchSpec,
    platform: NodeJS.Platform = process.platform
): string {
    if (platform === 'win32') {
        return serializePowerShellLaunchCommand(spec);
    }

    let command = serializePosixCommand(spec);
    if (spec.cwd) {
        command = `cd ${quotePosixShellArg(spec.cwd)} && ${command}`;
    }
    if (!spec.markerPath) {
        return command;
    }

    const markerArg = quotePosixShellArg(spec.markerPath);
    const lifecycleBody = `rm -f ${markerArg}; ${command}; : > ${markerArg}`;
    return `sh -lc ${quotePosixShellArg(lifecycleBody)}`;
}

export function serializeTmuxLaunchCommand(spec: AiSessionLaunchSpec): string {
    let command = serializePosixCommand(spec, true);
    if (spec.cwd) {
        command = `cd ${quotePosixShellArg(spec.cwd)} && ${command}`;
    }

    const lifecycleParts: string[] = [];
    if (spec.markerPath) {
        lifecycleParts.push(`rm -f ${quotePosixShellArg(spec.markerPath)}`);
    }
    lifecycleParts.push(command, 'exit_code=$?');
    if (spec.markerPath) {
        lifecycleParts.push(`: > ${quotePosixShellArg(spec.markerPath)}`);
    }
    lifecycleParts.push('exit $exit_code');

    return `exec /bin/sh -lc ${quotePosixShellArg(lifecycleParts.join('; '))}`;
}

export function quotePosixShellArg(value: string): string {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function serializePosixCommand(spec: AiSessionLaunchSpec, quoteExecutable = false): string {
    return [
        quoteExecutable ? quotePosixShellArg(spec.executable) : spec.executable,
        ...spec.args.map(arg => quoteExecutable || !isCliSyntaxArg(arg) ? quotePosixShellArg(arg) : arg),
    ].join(' ');
}

function serializePowerShellLaunchCommand(spec: AiSessionLaunchSpec): string {
    const commands: string[] = [];
    if (spec.markerPath) {
        commands.push(`Remove-Item -LiteralPath ${quotePowerShellArg(spec.markerPath)} -ErrorAction SilentlyContinue`);
    }
    if (spec.cwd) {
        commands.push(`Set-Location -LiteralPath ${quotePowerShellArg(spec.cwd)}`);
    }
    commands.push([
        spec.executable,
        ...spec.args.map(arg => isCliSyntaxArg(arg) ? arg : quotePowerShellArg(arg)),
    ].join(' '));
    if (spec.markerPath) {
        commands.push(`New-Item -ItemType File -Force -Path ${quotePowerShellArg(spec.markerPath)} | Out-Null`);
    }
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsCommandArg(commands.join('; '))}`;
}

function quotePowerShellArg(value: string): string {
    return `'${String(value).replace(/'/g, `''`)}'`;
}

function quoteWindowsCommandArg(value: string): string {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function isCliSyntaxArg(value: string): boolean {
    return value === 'resume' || /^--[A-Za-z][A-Za-z0-9-]*$/.test(value);
}
