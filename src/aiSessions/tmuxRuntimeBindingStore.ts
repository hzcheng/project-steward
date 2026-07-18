'use strict';

import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { AiSessionProviderId } from '../models';
import type {
    AiSessionRuntimeSnapshot,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
} from './runtimeTypes';

const RECORD_VERSION = 1;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 200;
const MAX_EXCLUDED_SESSION_IDS = 1000;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_KNOWN_RECORDS = 512;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const KNOWN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface TmuxPendingRuntimeBinding {
    version: 1;
    state: 'pending';
    pendingId: string;
    provider: AiSessionProviderId;
    projectKey: string;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
    layout: AiSessionTmuxLayout;
    locator: AiSessionTmuxLocator;
}

export interface TmuxKnownRuntimeBinding {
    version: 1;
    state: 'known';
    provider: AiSessionProviderId;
    sessionId: string;
    projectKey: string;
    layout: AiSessionTmuxLayout;
    locator: AiSessionTmuxLocator;
    lastSeenAtMs: number;
}

type TmuxRuntimeBinding = TmuxPendingRuntimeBinding | TmuxKnownRuntimeBinding;

export class TmuxRuntimeBindingStore {
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly root: string,
        private readonly now: () => number = () => Date.now()
    ) { }

    async listPending(): Promise<TmuxPendingRuntimeBinding[]> {
        await this.writeQueue;
        return this.listPendingUnlocked();
    }

    async listKnown(): Promise<TmuxKnownRuntimeBinding[]> {
        await this.writeQueue;
        return this.listKnownUnlocked(true);
    }

    async getKnown(provider: AiSessionProviderId, sessionId: string): Promise<TmuxKnownRuntimeBinding | null> {
        await this.writeQueue;
        if (!isProviderId(provider) || !isBoundedString(sessionId, MAX_ID_LENGTH)) {
            return null;
        }
        const filePath = this.recordPath('known', provider, sessionId);
        const record = validateKnownRecord(await readJsonRegularFile(filePath));
        if (!record || isKnownExpired(record, this.now())) {
            if (record) {
                await removeFile(filePath);
            }
            return null;
        }
        return cloneKnown(record);
    }

    setPending(record: TmuxPendingRuntimeBinding): Promise<void> {
        const validated = validatePendingRecord(record);
        if (!validated || isPendingExpired(validated, this.now())) {
            return Promise.resolve();
        }
        return this.enqueue(async () => {
            await this.writeRecord(this.recordPath('pending', validated.pendingId), validated);
        });
    }

    removePending(pendingId: string): Promise<void> {
        if (!isBoundedString(pendingId, MAX_ID_LENGTH)) {
            return Promise.resolve();
        }
        return this.enqueue(() => removeFile(this.recordPath('pending', pendingId)));
    }

    setKnown(record: TmuxKnownRuntimeBinding): Promise<void> {
        const validated = validateKnownRecord(record);
        if (!validated || isKnownExpired(validated, this.now())) {
            return Promise.resolve();
        }
        return this.enqueue(async () => {
            await this.writeRecord(this.recordPath('known', validated.provider, validated.sessionId), validated);
            await this.listKnownUnlocked(true);
        });
    }

    removeKnown(provider: AiSessionProviderId, sessionId: string): Promise<void> {
        if (!isProviderId(provider) || !isBoundedString(sessionId, MAX_ID_LENGTH)) {
            return Promise.resolve();
        }
        return this.enqueue(() => removeFile(this.recordPath('known', provider, sessionId)));
    }

    reconcileKnown(live: readonly AiSessionRuntimeSnapshot[]): Promise<void> {
        return this.enqueue(async () => {
            for (const runtime of live) {
                const sessionId = runtime.identity && runtime.identity.sessionId;
                if (runtime.backend !== 'tmux' || !runtime.tmux || !sessionId) {
                    continue;
                }
                const record = validateKnownRecord({
                    version: 1,
                    state: 'known',
                    provider: runtime.identity.provider,
                    sessionId,
                    projectKey: runtime.identity.projectKey,
                    layout: runtime.tmux.layout,
                    locator: runtime.tmux,
                    lastSeenAtMs: this.now(),
                });
                if (record) {
                    await this.writeRecord(this.recordPath('known', record.provider, record.sessionId), record);
                }
            }
            await this.listKnownUnlocked(true);
        });
    }

    private enqueue(operation: () => Promise<void>): Promise<void> {
        const result = this.writeQueue.then(operation);
        this.writeQueue = result.catch(() => undefined);
        return result;
    }

    private async listPendingUnlocked(): Promise<TmuxPendingRuntimeBinding[]> {
        const records: TmuxPendingRuntimeBinding[] = [];
        for (const filePath of await listJsonRegularFiles(this.root)) {
            const record = validatePendingRecord(await readJsonRegularFile(filePath));
            if (!record) {
                continue;
            }
            if (isPendingExpired(record, this.now())) {
                await removeFile(filePath);
            } else {
                records.push(record);
            }
        }
        records.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
            || left.pendingId.localeCompare(right.pendingId));
        return records.map(clonePending);
    }

    private async listKnownUnlocked(pruneToCap: boolean): Promise<TmuxKnownRuntimeBinding[]> {
        const entries: Array<{ filePath: string; record: TmuxKnownRuntimeBinding }> = [];
        for (const filePath of await listJsonRegularFiles(this.root)) {
            const record = validateKnownRecord(await readJsonRegularFile(filePath));
            if (!record) {
                continue;
            }
            if (isKnownExpired(record, this.now())) {
                await removeFile(filePath);
            } else {
                entries.push({ filePath, record });
            }
        }
        entries.sort((left, right) => right.record.lastSeenAtMs - left.record.lastSeenAtMs
            || left.record.provider.localeCompare(right.record.provider)
            || left.record.sessionId.localeCompare(right.record.sessionId));
        if (pruneToCap && entries.length > MAX_KNOWN_RECORDS) {
            for (const entry of entries.slice(MAX_KNOWN_RECORDS)) {
                await removeFile(entry.filePath);
            }
            entries.length = MAX_KNOWN_RECORDS;
        }
        return entries.map(entry => cloneKnown(entry.record));
    }

    private recordPath(kind: 'pending' | 'known', ...identity: string[]): string {
        const digest = createHash('sha256')
            .update(JSON.stringify([RECORD_VERSION, kind, ...identity]), 'utf8')
            .digest('hex');
        return path.join(this.root, `${kind}-${digest}.json`);
    }

    private async writeRecord(filePath: string, record: TmuxRuntimeBinding): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
        const temporaryPath = path.join(
            this.root,
            `.${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`
        );
        let handle: fs.FileHandle | undefined;
        try {
            handle = await fs.open(temporaryPath, 'wx');
            await handle.writeFile(JSON.stringify(record), { encoding: 'utf8' });
            await handle.sync();
            await handle.close();
            handle = undefined;
            await fs.rename(temporaryPath, filePath);
        } finally {
            if (handle) {
                await handle.close().catch(() => undefined);
            }
            await removeFile(temporaryPath);
        }
    }
}

async function listJsonRegularFiles(root: string): Promise<string[]> {
    let names: string[];
    try {
        names = await fs.readdir(root);
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return [];
        }
        throw error;
    }
    const files: string[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) {
            continue;
        }
        const filePath = path.join(root, name);
        try {
            const stat = await fs.lstat(filePath);
            if (stat.isFile() && stat.size > 0 && stat.size <= MAX_RECORD_BYTES) {
                files.push(filePath);
            }
        } catch (error) {
            if (!isNodeError(error, 'ENOENT')) {
                throw error;
            }
        }
    }
    return files;
}

async function readJsonRegularFile(filePath: string): Promise<unknown> {
    try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
            return null;
        }
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) {
            return null;
        }
        throw error;
    }
}

async function removeFile(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
}

function validatePendingRecord(value: unknown): TmuxPendingRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    if (record.version !== RECORD_VERSION || record.state !== 'pending'
        || !isBoundedString(record.pendingId, MAX_ID_LENGTH) || !isProviderId(record.provider)
        || !isBoundedString(record.projectKey, MAX_ID_LENGTH) || !isBoundedString(record.cwd, MAX_PATH_LENGTH)
        || !isDateString(record.createdAt) || !isLayout(record.layout) || !locator
        || locator.layout !== record.layout || !Array.isArray(record.excludedSessionIds)
        || record.excludedSessionIds.length > MAX_EXCLUDED_SESSION_IDS
        || record.excludedSessionIds.some(id => !isBoundedString(id, MAX_ID_LENGTH))
        || (record.title !== undefined && !isOptionalTitle(record.title))) {
        return null;
    }
    return {
        version: 1,
        state: 'pending',
        pendingId: record.pendingId,
        provider: record.provider,
        projectKey: record.projectKey,
        cwd: record.cwd,
        createdAt: record.createdAt,
        excludedSessionIds: [...record.excludedSessionIds] as string[],
        ...(record.title === undefined ? {} : { title: record.title as string }),
        layout: record.layout,
        locator,
    };
}

function validateKnownRecord(value: unknown): TmuxKnownRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    if (record.version !== RECORD_VERSION || record.state !== 'known' || !isProviderId(record.provider)
        || !isBoundedString(record.sessionId, MAX_ID_LENGTH) || !isBoundedString(record.projectKey, MAX_ID_LENGTH)
        || !isLayout(record.layout) || !locator || locator.layout !== record.layout
        || !isFiniteNonNegative(record.lastSeenAtMs)) {
        return null;
    }
    return {
        version: 1,
        state: 'known',
        provider: record.provider,
        sessionId: record.sessionId,
        projectKey: record.projectKey,
        layout: record.layout,
        locator,
        lastSeenAtMs: record.lastSeenAtMs,
    };
}

function validateLocator(value: unknown): AiSessionTmuxLocator | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (!isLayout(record.layout) || !isBoundedString(record.sessionName, MAX_ID_LENGTH)) {
        return null;
    }
    if (record.layout === 'project') {
        return isBoundedString(record.windowName, MAX_ID_LENGTH)
            ? { layout: 'project', sessionName: record.sessionName, windowName: record.windowName }
            : null;
    }
    return record.windowName === undefined
        ? { layout: 'session', sessionName: record.sessionName }
        : null;
}

function clonePending(record: TmuxPendingRuntimeBinding): TmuxPendingRuntimeBinding {
    return { ...record, excludedSessionIds: [...record.excludedSessionIds], locator: { ...record.locator } };
}

function cloneKnown(record: TmuxKnownRuntimeBinding): TmuxKnownRuntimeBinding {
    return { ...record, locator: { ...record.locator } };
}

function isPendingExpired(record: TmuxPendingRuntimeBinding, now: number): boolean {
    return now - Date.parse(record.createdAt) >= PENDING_TTL_MS;
}

function isKnownExpired(record: TmuxKnownRuntimeBinding, now: number): boolean {
    return now - record.lastSeenAtMs >= KNOWN_TTL_MS;
}

function isObject(value: unknown): value is object {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isProviderId(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isLayout(value: unknown): value is AiSessionTmuxLayout {
    return value === 'project' || value === 'session';
}

function isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength
        && !CONTROL_CHARACTERS.test(value);
}

function isOptionalTitle(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_TITLE_LENGTH && !CONTROL_CHARACTERS.test(value);
}

function isDateString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TITLE_LENGTH
        && Number.isFinite(Date.parse(value));
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNodeError(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}
