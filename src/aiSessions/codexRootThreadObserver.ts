'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_MAX_PROCESSES = 128;
const DEFAULT_MAX_DESCRIPTORS = 1024;
const DEFAULT_MAX_FIRST_LINE_BYTES = 1024 * 1024;
const MAX_PID = 2147483647;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

export interface CodexRootThreadObservationRequest {
    panePid: number;
    currentSessionId: string;
    runStartedAtMs: number;
}

export interface CodexRootThreadObserver {
    observe(request: CodexRootThreadObservationRequest): Promise<string | null>;
}

export interface ProcCodexRootThreadObserverOptions {
    platform?: NodeJS.Platform;
    procRoot?: string;
    codexHome?: string;
    maxProcesses?: number;
    maxDescriptors?: number;
    maxFirstLineBytes?: number;
}

interface SessionMetaRecord {
    timestamp?: unknown;
    type?: unknown;
    payload?: {
        id?: unknown;
        session_id?: unknown;
        originator?: unknown;
        source?: unknown;
    };
}

export class ProcCodexRootThreadObserver implements CodexRootThreadObserver {
    private readonly platform: NodeJS.Platform;
    private readonly procRoot: string;
    private readonly codexHome: string;
    private readonly maxProcesses: number;
    private readonly maxDescriptors: number;
    private readonly maxFirstLineBytes: number;

    constructor(options: ProcCodexRootThreadObserverOptions = {}) {
        this.platform = options.platform || process.platform;
        this.procRoot = options.procRoot || '/proc';
        this.codexHome = options.codexHome
            || process.env.CODEX_HOME
            || path.join(os.homedir(), '.codex');
        this.maxProcesses = positiveLimit(options.maxProcesses, DEFAULT_MAX_PROCESSES);
        this.maxDescriptors = positiveLimit(options.maxDescriptors, DEFAULT_MAX_DESCRIPTORS);
        this.maxFirstLineBytes = positiveLimit(
            options.maxFirstLineBytes, DEFAULT_MAX_FIRST_LINE_BYTES
        );
    }

    async observe(request: CodexRootThreadObservationRequest): Promise<string | null> {
        if (this.platform !== 'linux' || !validRequest(request)) {
            return null;
        }
        try {
            return this.observeLinux(request);
        } catch (e) {
            return null;
        }
    }

    private observeLinux(request: CodexRootThreadObservationRequest): string | null {
        const sessionsRoot = fs.realpathSync(path.join(this.codexHome, 'sessions'));
        if (!fs.statSync(sessionsRoot).isDirectory()) {
            return null;
        }

        const candidates = new Set<string>();
        const queue = [request.panePid];
        const visited = new Set<number>();
        let descriptorCount = 0;

        while (queue.length) {
            const pid = queue.shift() as number;
            if (visited.has(pid)) {
                continue;
            }
            if (visited.size >= this.maxProcesses) {
                return null;
            }
            visited.add(pid);

            for (const child of readChildren(this.procRoot, pid)) {
                if (!visited.has(child)) {
                    queue.push(child);
                }
            }

            const fdRoot = path.join(this.procRoot, String(pid), 'fd');
            let descriptors: string[];
            try {
                descriptors = fs.readdirSync(fdRoot);
            } catch (e) {
                continue;
            }
            descriptorCount += descriptors.length;
            if (descriptorCount > this.maxDescriptors) {
                return null;
            }

            for (const descriptor of descriptors) {
                const sessionId = this.readRootSession(
                    path.join(fdRoot, descriptor), sessionsRoot, request.runStartedAtMs
                );
                if (sessionId && sessionId !== request.currentSessionId) {
                    candidates.add(sessionId);
                    if (candidates.size > 1) {
                        return null;
                    }
                }
            }
        }

        return candidates.size === 1 ? [...candidates][0] : null;
    }

    private readRootSession(
        descriptorPath: string,
        sessionsRoot: string,
        runStartedAtMs: number
    ): string | null {
        try {
            const target = fs.realpathSync(descriptorPath);
            if (path.extname(target) !== '.jsonl' || !isWithin(sessionsRoot, target)) {
                return null;
            }
            const stat = fs.statSync(target);
            if (!stat.isFile() || stat.mtimeMs < runStartedAtMs) {
                return null;
            }
            const record = JSON.parse(readFirstLine(target, this.maxFirstLineBytes)) as SessionMetaRecord;
            const payload = record && record.payload;
            const sessionId = payload && payload.id;
            const recordedAtMs = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
            if (record.type !== 'session_meta'
                || !payload
                || payload.originator !== 'codex-tui'
                || typeof sessionId !== 'string'
                || !SESSION_ID.test(sessionId)
                || payload.session_id !== sessionId
                || isSubagentSource(payload.source)
                || !Number.isFinite(recordedAtMs)
                || recordedAtMs < runStartedAtMs) {
                return null;
            }
            return sessionId;
        } catch (e) {
            return null;
        }
    }
}

function validRequest(request: CodexRootThreadObservationRequest): boolean {
    return !!request
        && Number.isSafeInteger(request.panePid)
        && request.panePid > 0
        && request.panePid <= MAX_PID
        && typeof request.currentSessionId === 'string'
        && SESSION_ID.test(request.currentSessionId)
        && Number.isFinite(request.runStartedAtMs)
        && request.runStartedAtMs > 0;
}

function positiveLimit(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && (value as number) >= 1
        ? Math.floor(value as number)
        : fallback;
}

function readChildren(procRoot: string, pid: number): number[] {
    try {
        const value = fs.readFileSync(
            path.join(procRoot, String(pid), 'task', String(pid), 'children'),
            'utf8'
        ).trim();
        if (!value) {
            return [];
        }
        return value.split(/\s+/)
            .filter(candidate => /^[1-9][0-9]{0,9}$/.test(candidate))
            .map(candidate => Number(candidate))
            .filter(candidate => Number.isSafeInteger(candidate) && candidate <= MAX_PID);
    } catch (e) {
        return [];
    }
}

function readFirstLine(filePath: string, maxBytes: number): string {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(maxBytes + 1);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const newline = buffer.indexOf(0x0a, 0);
        if (newline < 0 && bytesRead > maxBytes) {
            throw new Error('The Codex session metadata line exceeded its bounded limit.');
        }
        return buffer.slice(0, newline >= 0 ? newline : bytesRead).toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== ''
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function isSubagentSource(source: unknown): boolean {
    return !!source
        && typeof source === 'object'
        && Object.prototype.hasOwnProperty.call(source, 'subagent');
}
