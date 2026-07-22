'use strict';

import { execFile } from 'child_process';
import type { AiSessionTmuxLocator } from './runtimeTypes';
import { TMUX_METADATA_OPTIONS } from './tmuxLayout';

const COMMAND_TIMEOUT_MS = 5000;
const COMMAND_MAX_BUFFER = 1024 * 1024;
const FIELD_SEPARATOR = '\u001f';
const LIST_WINDOWS_FORMAT = [
    '#{session_name}', '#{window_name}', '#{window_id}', '#{window_active}',
].join(FIELD_SEPARATOR);
const TARGET_WINDOW_FORMAT = [
    '#{session_name}', '#{window_name}', '#{window_id}',
    ...Object.values(TMUX_METADATA_OPTIONS).map(option => `#{${option}}`),
].join(FIELD_SEPARATOR);
const MAX_LIST_OUTPUT_LENGTH = COMMAND_MAX_BUFFER;
const MAX_LIST_ROWS = 10000;
const MAX_TARGET_FIELD_LENGTH = 512;
const MAX_METADATA_VALUE_LENGTH = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const REQUIRED_COMMANDS = [
    'new-session',
    'new-window',
    'list-windows',
    'set-option',
    'show-options',
    'select-window',
    'attach-session',
    'has-session',
    'rename-session',
    'rename-window',
    'display-message',
] as const;

export type TmuxUnavailableCategory =
    | 'not-found'
    | 'permission-denied'
    | 'timeout'
    | 'invalid-version'
    | 'missing-capability'
    | 'command-failed';

export type TmuxAvailability =
    | { available: true; version: string }
    | { available: false; category: TmuxUnavailableCategory; message: string };

export type TmuxClientErrorCategory =
    | 'not-found'
    | 'permission-denied'
    | 'timeout'
    | 'argument-list-too-long'
    | 'nonzero-exit'
    | 'invalid-output'
    | 'unsupported';

export type TmuxCommandFailureCategory =
    | 'not-found'
    | 'permission-denied'
    | 'timeout'
    | 'argument-list-too-long'
    | 'unsupported';

export interface TmuxCommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    failureCategory?: TmuxCommandFailureCategory;
}

export interface TmuxCommandRunner {
    run(file: string, args: string[]): Promise<TmuxCommandResult>;
}

export interface TmuxWindowRecord {
    sessionName: string;
    windowName: string;
    windowId: string;
    active: boolean;
    sessionMetadata: Record<string, string>;
    windowMetadata: Record<string, string>;
    metadata: Record<string, string>;
}

export interface TmuxActiveWindowRecord {
    sessionName: string;
    windowName: string;
    windowId: string;
}

export interface TmuxTargetWindowRecord {
    sessionName: string;
    windowName: string;
    windowId: string;
    metadata: Record<string, string>;
}

type TmuxOperation =
    | 'check-version'
    | 'list-commands'
    | 'list-windows'
    | 'get-active-window'
    | 'get-target-window'
    | 'has-session'
    | 'create-session'
    | 'create-window'
    | 'rename-session'
    | 'rename-window'
    | 'select-window'
    | 'get-session-options'
    | 'get-window-options'
    | 'set-session-options'
    | 'set-window-options'
    | 'configure-managed-window'
    | 'clear-pending-metadata';

type MetadataOptionKey = keyof typeof TMUX_METADATA_OPTIONS;

const AVAILABILITY_MESSAGES: Record<TmuxUnavailableCategory, string> = {
    'not-found': 'The configured tmux executable was not found on this extension host.',
    'permission-denied': 'The configured tmux executable cannot be run on this extension host.',
    'timeout': 'The configured tmux did not respond within five seconds.',
    'invalid-version': 'The configured tmux returned an unrecognized version.',
    'missing-capability': 'The configured tmux does not provide all required commands.',
    'command-failed': 'The configured tmux could not complete an availability check.',
};

export class TmuxClientError extends Error {
    constructor(
        public readonly operation: TmuxOperation,
        public readonly category: TmuxClientErrorCategory
    ) {
        super(`The tmux ${operation} operation failed (${category}).`);
        this.name = 'TmuxClientError';
        Object.setPrototypeOf(this, TmuxClientError.prototype);
    }
}

class ExecFileTmuxCommandRunner implements TmuxCommandRunner {
    run(file: string, args: string[]): Promise<TmuxCommandResult> {
        if (process.platform === 'win32') {
            return Promise.resolve({
                exitCode: null,
                stdout: '',
                stderr: '',
                failureCategory: 'unsupported',
            });
        }

        return new Promise(resolve => {
            execFile(file, args, {
                shell: false,
                encoding: 'utf8',
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: COMMAND_MAX_BUFFER,
            }, (error, stdout, stderr) => {
                const output = {
                    stdout: typeof stdout === 'string' ? stdout : String(stdout || ''),
                    stderr: typeof stderr === 'string' ? stderr : String(stderr || ''),
                };
                if (!error) {
                    resolve({ exitCode: 0, ...output });
                    return;
                }
                const errorSnapshot = snapshotProcessError(error);
                if (errorSnapshot && typeof errorSnapshot.code === 'number') {
                    resolve({ exitCode: errorSnapshot.code, ...output });
                    return;
                }
                resolve({
                    exitCode: null,
                    ...output,
                    failureCategory: classifyProcessErrorSnapshot(errorSnapshot),
                });
            });
        });
    }
}

export class TmuxClient {
    private executablePath: string;
    private availabilityPromise: Promise<TmuxAvailability> | null = null;

    constructor(executablePath: string = 'tmux', private readonly runner: TmuxCommandRunner = new ExecFileTmuxCommandRunner()) {
        this.executablePath = normalizeExecutablePath(executablePath);
    }

    checkAvailability(): Promise<TmuxAvailability> {
        if (!this.availabilityPromise) {
            this.availabilityPromise = this.probeAvailability();
        }
        return this.availabilityPromise;
    }

    getExecutablePath(): string {
        return this.executablePath;
    }

    setExecutablePath(executablePath: string): void {
        const normalized = normalizeExecutablePath(executablePath);
        this.executablePath = normalized;
        this.availabilityPromise = null;
    }

    async listWindows(): Promise<TmuxWindowRecord[]> {
        await this.requireAvailable();
        const result = await this.invoke('list-windows', [
            'list-windows', '-a', '-F', LIST_WINDOWS_FORMAT,
        ]);
        if (result.exitCode !== 0) {
            if (isNoServerResult(result)) {
                return [];
            }
            throw resultError('list-windows', result);
        }

        const rows = parseWindowRows(result.stdout);
        const sessionMetadata = new Map<string, Record<string, string>>();
        const records: TmuxWindowRecord[] = [];
        for (const row of rows) {
            let sessionOptions = sessionMetadata.get(row.sessionName);
            if (!sessionOptions) {
                sessionOptions = await this.readMetadataOptions(
                    'get-session-options', ['show-options', '-qv', '-t', row.sessionName]
                );
                sessionMetadata.set(row.sessionName, sessionOptions);
            }
            const windowOptions = await this.readMetadataOptions(
                'get-window-options', ['show-options', '-qvw', '-t', row.windowId]
            );
            records.push({
                ...row,
                sessionMetadata: { ...sessionOptions },
                windowMetadata: { ...windowOptions },
                metadata: { ...sessionOptions, ...windowOptions },
            });
        }
        return records;
    }

    async getActiveWindow(sessionName: string): Promise<TmuxActiveWindowRecord | null> {
        if (typeof sessionName !== 'string' || !isTargetField(sessionName)) {
            throw new TypeError('The tmux session name is invalid.');
        }
        await this.requireAvailable();
        const result = await this.invoke('get-active-window', [
            'list-windows', '-t', sessionName, '-F', LIST_WINDOWS_FORMAT,
        ]);
        if (result.exitCode !== 0) {
            if (isMissingSessionResult(result)) {
                return null;
            }
            throw resultError('get-active-window', result);
        }
        const rows = parseWindowRows(result.stdout, 'get-active-window');
        if (rows.some(row => row.sessionName !== sessionName)) {
            throw new TmuxClientError('get-active-window', 'invalid-output');
        }
        const active = rows.filter(row => row.active);
        if (active.length > 1) {
            throw new TmuxClientError('get-active-window', 'invalid-output');
        }
        return active.length ? {
            sessionName: active[0].sessionName,
            windowName: active[0].windowName,
            windowId: active[0].windowId,
        } : null;
    }

    async getTargetWindow(locator: AiSessionTmuxLocator): Promise<TmuxTargetWindowRecord | null> {
        const target = validatedLocatorTarget(locator);
        await this.requireAvailable();
        const result = await this.invoke('get-target-window', [
            'display-message', '-p', '-t', target, TARGET_WINDOW_FORMAT,
        ]);
        if (result.exitCode !== 0) {
            if (isMissingTargetResult(result)) {
                return null;
            }
            throw resultError('get-target-window', result);
        }
        return parseTargetWindow(result.stdout);
    }

    async hasSession(sessionName: string): Promise<boolean> {
        await this.requireAvailable();
        const result = await this.invoke('has-session', ['has-session', '-t', sessionName]);
        if (result.exitCode === 0) {
            return true;
        }
        if (isMissingSessionResult(result)) {
            return false;
        }
        throw resultError('has-session', result);
    }

    async createSession(
        sessionName: string,
        windowName: string,
        cwd: string,
        command: string
    ): Promise<void> {
        await this.runChecked('create-session', [
            'new-session', '-d', '-s', sessionName, '-n', windowName, '-c', cwd, command,
        ]);
    }

    async createWindow(
        sessionName: string,
        windowName: string,
        cwd: string,
        command: string
    ): Promise<void> {
        await this.runChecked('create-window', [
            'new-window', '-d', '-t', sessionName, '-n', windowName, '-c', cwd, command,
        ]);
    }

    async renameSession(sessionName: string, newName: string): Promise<void> {
        await this.runChecked('rename-session', ['rename-session', '-t', sessionName, newName]);
    }

    async renameWindow(sessionName: string, windowName: string, newName: string): Promise<void> {
        await this.runChecked('rename-window', [
            'rename-window', '-t', windowTarget(sessionName, windowName), newName,
        ]);
    }

    async selectWindow(locator: AiSessionTmuxLocator): Promise<void> {
        const target = locator.windowName
            ? windowTarget(locator.sessionName, locator.windowName)
            : locator.sessionName;
        await this.runChecked('select-window', ['select-window', '-t', target]);
    }

    async getSessionOptions(sessionName: string): Promise<Record<string, string>> {
        await this.requireAvailable();
        return this.readMetadataOptions(
            'get-session-options', ['show-options', '-qv', '-t', sessionName]
        );
    }

    async getWindowOptions(sessionName: string, windowName: string): Promise<Record<string, string>> {
        await this.requireAvailable();
        return this.readMetadataOptions(
            'get-window-options', ['show-options', '-qvw', '-t', windowTarget(sessionName, windowName)]
        );
    }

    async setSessionOptions(sessionName: string, values: Record<string, string>): Promise<void> {
        const entries = validateMetadataEntries(values);
        await this.requireAvailable();
        for (const [key, value] of entries) {
            await this.runResultChecked('set-session-options', [
                'set-option', '-t', sessionName, TMUX_METADATA_OPTIONS[key], value,
            ]);
        }
    }

    async setWindowOptions(
        sessionName: string,
        windowName: string,
        values: Record<string, string>
    ): Promise<void> {
        const entries = validateMetadataEntries(values);
        await this.requireAvailable();
        const target = windowTarget(sessionName, windowName);
        for (const [key, value] of entries) {
            await this.runResultChecked('set-window-options', [
                'set-option', '-w', '-t', target, TMUX_METADATA_OPTIONS[key], value,
            ]);
        }
    }

    async configureManagedWindow(sessionName: string, windowName: string): Promise<void> {
        await this.requireAvailable();
        const target = windowTarget(sessionName, windowName);
        for (const option of ['automatic-rename', 'allow-rename', 'remain-on-exit']) {
            await this.runResultChecked('configure-managed-window', [
                'set-option', '-w', '-t', target, option, 'off',
            ]);
        }
    }

    async clearPendingMetadata(locator: AiSessionTmuxLocator): Promise<void> {
        await this.requireAvailable();
        if (locator.layout === 'project') {
            if (!locator.windowName) {
                throw new TypeError('A project tmux locator must identify a window.');
            }
            await this.runResultChecked('clear-pending-metadata', [
                'set-option', '-uw', '-t', windowTarget(locator.sessionName, locator.windowName),
                TMUX_METADATA_OPTIONS.pendingId,
            ]);
            return;
        }
        if (locator.windowName) {
            throw new TypeError('A session tmux locator must not identify a window.');
        }
        await this.runResultChecked('clear-pending-metadata', [
            'set-option', '-u', '-t', locator.sessionName, TMUX_METADATA_OPTIONS.pendingId,
        ]);
    }

    private async probeAvailability(): Promise<TmuxAvailability> {
        const versionResult = await this.invokeForAvailability(['-V']);
        const versionFailure = availabilityFailure(versionResult);
        if (versionFailure) {
            return versionFailure;
        }
        const version = parseVersion(versionResult.stdout);
        if (!version) {
            return unavailable('invalid-version');
        }

        const commandsResult = await this.invokeForAvailability(['list-commands']);
        const commandsFailure = availabilityFailure(commandsResult);
        if (commandsFailure) {
            return commandsFailure;
        }
        const commands = parseCommandNames(commandsResult.stdout);
        if (REQUIRED_COMMANDS.some(command => !commands.has(command))) {
            return unavailable('missing-capability');
        }
        return { available: true, version };
    }

    private async requireAvailable(): Promise<void> {
        const availability = await this.checkAvailability();
        if ('version' in availability) {
            return;
        }
        throw new TmuxClientError('check-version', availabilityErrorCategory(availability.category));
    }

    private async runChecked(operation: TmuxOperation, args: string[]): Promise<void> {
        await this.requireAvailable();
        await this.runResultChecked(operation, args);
    }

    private async runResultChecked(operation: TmuxOperation, args: string[]): Promise<void> {
        const result = await this.invoke(operation, args);
        if (result.exitCode !== 0) {
            throw resultError(operation, result);
        }
    }

    private async readMetadataOptions(
        operation: TmuxOperation,
        baseArgs: string[]
    ): Promise<Record<string, string>> {
        const values: Record<string, string> = {};
        for (const key of metadataOptionKeys()) {
            const result = await this.invoke(operation, [...baseArgs, TMUX_METADATA_OPTIONS[key]]);
            if (result.exitCode !== 0) {
                throw resultError(operation, result);
            }
            const value = parseMetadataOptionValue(result.stdout, operation);
            if (value !== null) {
                values[key] = value;
            }
        }
        return values;
    }

    private async invokeForAvailability(args: string[]): Promise<TmuxCommandResult> {
        let result: TmuxCommandResult;
        try {
            result = await this.runner.run(this.executablePath, args);
        } catch (error) {
            return {
                exitCode: null,
                stdout: '',
                stderr: '',
                failureCategory: classifyUnknownRunnerError(error),
            };
        }
        try {
            return normalizeCommandResult(result, 'check-version');
        } catch (_error) {
            return {
                exitCode: null,
                stdout: '',
                stderr: '',
                failureCategory: 'unsupported',
            };
        }
    }

    private async invoke(operation: TmuxOperation, args: string[]): Promise<TmuxCommandResult> {
        let result: TmuxCommandResult;
        try {
            result = await this.runner.run(this.executablePath, args);
        } catch (error) {
            throw new TmuxClientError(operation, classifyUnknownRunnerError(error));
        }
        try {
            return normalizeCommandResult(result, operation);
        } catch (_error) {
            throw new TmuxClientError(operation, 'invalid-output');
        }
    }
}

function normalizeExecutablePath(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError('The tmux executable must be a non-empty name or path.');
    }
    const normalized = value.trim();
    if (CONTROL_CHARACTERS.test(normalized)) {
        throw new TypeError('The tmux executable must not contain control characters.');
    }
    return normalized;
}

function normalizeCommandResult(result: TmuxCommandResult, operation: TmuxOperation): TmuxCommandResult {
    let exitCode: unknown;
    let stdout: unknown;
    let stderr: unknown;
    let failureCategory: unknown;
    try {
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
        failureCategory = result.failureCategory;
    } catch (_error) {
        throw new TmuxClientError(operation, 'invalid-output');
    }
    const validExitCode = exitCode === null
        || (typeof exitCode === 'number' && Number.isInteger(exitCode));
    if (!validExitCode || typeof stdout !== 'string' || typeof stderr !== 'string'
        || (exitCode === null && !isCommandFailureCategory(failureCategory))
        || (exitCode !== null && failureCategory !== undefined)) {
        throw new TmuxClientError(operation, 'invalid-output');
    }
    return {
        exitCode: exitCode as number | null,
        stdout,
        stderr,
        ...(failureCategory !== undefined
            ? { failureCategory: failureCategory as TmuxCommandFailureCategory }
            : {}),
    };
}

function isCommandFailureCategory(value: unknown): value is TmuxCommandFailureCategory {
    return value === 'not-found'
        || value === 'permission-denied'
        || value === 'timeout'
        || value === 'argument-list-too-long'
        || value === 'unsupported';
}

interface ProcessErrorSnapshot {
    code?: string | number;
    killed: boolean;
}

function snapshotProcessError(error: unknown): ProcessErrorSnapshot | null {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
        return null;
    }
    try {
        const code = (error as { code?: unknown }).code;
        const killed = (error as { killed?: unknown }).killed;
        return {
            ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
            killed: killed === true,
        };
    } catch (_error) {
        return null;
    }
}

function classifyProcessErrorSnapshot(snapshot: ProcessErrorSnapshot | null): TmuxCommandFailureCategory {
    if (!snapshot) {
        return 'unsupported';
    }
    if (snapshot.code === 'ENOENT') {
        return 'not-found';
    }
    if (snapshot.code === 'EACCES' || snapshot.code === 'EPERM') {
        return 'permission-denied';
    }
    if (snapshot.killed || snapshot.code === 'ETIMEDOUT') {
        return 'timeout';
    }
    if (snapshot.code === 'E2BIG') {
        return 'argument-list-too-long';
    }
    return 'unsupported';
}

function classifyUnknownRunnerError(error: unknown): TmuxCommandFailureCategory {
    return classifyProcessErrorSnapshot(snapshotProcessError(error));
}

function unavailable(category: TmuxUnavailableCategory): TmuxAvailability {
    return { available: false, category, message: AVAILABILITY_MESSAGES[category] };
}

function availabilityFailure(result: TmuxCommandResult): TmuxAvailability | null {
    if (result.failureCategory === 'not-found') {
        return unavailable('not-found');
    }
    if (result.failureCategory === 'permission-denied') {
        return unavailable('permission-denied');
    }
    if (result.failureCategory === 'timeout') {
        return unavailable('timeout');
    }
    if (result.failureCategory || result.exitCode !== 0) {
        return unavailable('command-failed');
    }
    return null;
}

function availabilityErrorCategory(category: TmuxUnavailableCategory): TmuxClientErrorCategory {
    if (category === 'not-found' || category === 'permission-denied' || category === 'timeout') {
        return category;
    }
    return 'unsupported';
}

function parseVersion(stdout: string): string | null {
    const match = /^tmux[ \t]+([A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/.exec(stdout.trim());
    return match ? match[1] : null;
}

function parseCommandNames(stdout: string): Set<string> {
    const names = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^([a-z][a-z-]*)(?:\s|$)/.exec(line);
        if (match) {
            names.add(match[1]);
        }
    }
    return names;
}

function parseWindowRows(
    stdout: string,
    operation: TmuxOperation = 'list-windows'
): Array<Omit<TmuxWindowRecord, 'metadata' | 'sessionMetadata' | 'windowMetadata'>> {
    if (stdout.length > MAX_LIST_OUTPUT_LENGTH) {
        throw new TmuxClientError(operation, 'invalid-output');
    }
    if (!stdout) {
        return [];
    }
    const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
    if (lines.length > MAX_LIST_ROWS || lines.some(line => !line)) {
        throw new TmuxClientError(operation, 'invalid-output');
    }
    return lines.map(line => {
        const fields = line.split(FIELD_SEPARATOR);
        if (fields.length !== 4) {
            throw new TmuxClientError(operation, 'invalid-output');
        }
        const [sessionName, windowName, windowId, active] = fields;
        if (!isTargetField(sessionName) || !isTargetField(windowName)
            || !/^@[0-9]+$/.test(windowId) || (active !== '0' && active !== '1')) {
            throw new TmuxClientError(operation, 'invalid-output');
        }
        return { sessionName, windowName, windowId, active: active === '1' };
    });
}

function parseMetadataOptionValue(stdout: string, operation: TmuxOperation): string | null {
    if (!stdout) {
        return null;
    }
    const value = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    if (!value || value.length > MAX_METADATA_VALUE_LENGTH || CONTROL_CHARACTERS.test(value)) {
        throw new TmuxClientError(operation, 'invalid-output');
    }
    return value;
}

function parseTargetWindow(stdout: string): TmuxTargetWindowRecord {
    if (stdout.length > MAX_LIST_OUTPUT_LENGTH || !stdout) {
        throw new TmuxClientError('get-target-window', 'invalid-output');
    }
    const value = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    if (!value || value.includes('\n') || value.includes('\r')) {
        throw new TmuxClientError('get-target-window', 'invalid-output');
    }
    const fields = value.split(FIELD_SEPARATOR);
    const keys = metadataOptionKeys();
    if (fields.length !== 3 + keys.length) {
        throw new TmuxClientError('get-target-window', 'invalid-output');
    }
    const [sessionName, windowName, windowId, ...metadataValues] = fields;
    if (!isTargetField(sessionName) || !isTargetField(windowName) || !/^@[0-9]+$/.test(windowId)) {
        throw new TmuxClientError('get-target-window', 'invalid-output');
    }
    const metadata: Record<string, string> = {};
    for (let index = 0; index < keys.length; index++) {
        const metadataValue = metadataValues[index];
        if (!metadataValue) {
            continue;
        }
        if (metadataValue.length > metadataValueLimit(keys[index])
            || CONTROL_CHARACTERS.test(metadataValue)) {
            throw new TmuxClientError('get-target-window', 'invalid-output');
        }
        metadata[keys[index]] = metadataValue;
    }
    return { sessionName, windowName, windowId, metadata };
}

function metadataOptionKeys(): MetadataOptionKey[] {
    return Object.keys(TMUX_METADATA_OPTIONS) as MetadataOptionKey[];
}

function validateMetadataEntries(values: Record<string, string>): Array<[MetadataOptionKey, string]> {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new TypeError('tmux metadata options must be an object.');
    }
    const allowed = new Set<string>(metadataOptionKeys());
    const entries = Object.keys(values).map(key => {
        const value = values[key];
        if (!allowed.has(key) || typeof value !== 'string' || !value
            || value.length > metadataValueLimit(key as MetadataOptionKey)
            || CONTROL_CHARACTERS.test(value)) {
            throw new TypeError('Only valid Project Steward tmux metadata options may be set.');
        }
        return [key as MetadataOptionKey, value] as [MetadataOptionKey, string];
    });
    return entries;
}

function metadataValueLimit(key: MetadataOptionKey): number {
    if (key === 'marker') {
        return 4096;
    }
    if (key === 'createdAt') {
        return 200;
    }
    return 512;
}

function isTargetField(value: string): boolean {
    return value.length > 0
        && value.length <= MAX_TARGET_FIELD_LENGTH
        && !CONTROL_CHARACTERS.test(value);
}

function isNoServerResult(result: TmuxCommandResult): boolean {
    return result.exitCode === 1
        && result.stdout === ''
        && /^no server running on \S.*$/.test(result.stderr.trim());
}

function isMissingSessionResult(result: TmuxCommandResult): boolean {
    if (result.exitCode !== 1 || result.stdout !== '') {
        return false;
    }
    const stderr = result.stderr.trim();
    return /^can't find session: .+$/.test(stderr)
        || /^no server running on \S.*$/.test(stderr)
        || stderr === 'no sessions';
}

function isMissingTargetResult(result: TmuxCommandResult): boolean {
    return isMissingSessionResult(result)
        || (result.exitCode === 1 && result.stdout === ''
            && /^can't find window: .+$/.test(result.stderr.trim()));
}

function resultError(operation: TmuxOperation, result: TmuxCommandResult): TmuxClientError {
    return new TmuxClientError(operation, result.failureCategory || 'nonzero-exit');
}

function windowTarget(sessionName: string, windowName: string): string {
    return `${sessionName}:${windowName}`;
}

function validatedLocatorTarget(locator: AiSessionTmuxLocator): string {
    if (!locator || typeof locator !== 'object' || !isTargetField(locator.sessionName)) {
        throw new TypeError('The tmux runtime locator is invalid.');
    }
    if (locator.layout === 'project' && locator.windowName && isTargetField(locator.windowName)) {
        return windowTarget(locator.sessionName, locator.windowName);
    }
    if (locator.layout === 'session' && locator.windowName === undefined) {
        return locator.sessionName;
    }
    throw new TypeError('The tmux runtime locator is invalid.');
}
