'use strict';

import { createHash, randomBytes } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import type { Stats } from 'fs';
import * as path from 'path';
import type { AiSessionProviderId } from '../models';
import type {
    AiSessionRuntimeIdentity,
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
const MAX_PENDING_LIFECYCLE_DIRECTORY_FILES = 4096;
const MAX_PENDING_LIFECYCLE_LOOKUP_RECORDS = 512;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const KNOWN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const NO_FOLLOW_FLAG = (fsConstants as Record<string, number>).O_NOFOLLOW || 0;
const NON_BLOCKING_FLAG = (fsConstants as Record<string, number>).O_NONBLOCK || 0;
const READ_ONLY_FALLBACK = fsConstants.O_RDONLY | NON_BLOCKING_FLAG;
const READ_ONLY_NO_FOLLOW = READ_ONLY_FALLBACK | NO_FOLLOW_FLAG;

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
    acceptedAtMs: number;
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

export interface TmuxInactiveRuntimeBinding {
    version: 1;
    state: 'completed' | 'stopped';
    provider: AiSessionProviderId;
    sessionId: string;
    projectKey: string;
    cwd: string;
    layout: AiSessionTmuxLayout;
    locator: AiSessionTmuxLocator;
    markerPath: string;
    runStartedAtMs: number;
    detectedAtMs: number;
}

export type TmuxInactiveAcknowledgementResult = 'acknowledged' | 'stale' | 'missing';

export interface TmuxConsumedPendingBinding {
    version: 1;
    state: 'consumed';
    pendingId: string;
    provider: AiSessionProviderId;
    projectKey: string;
    cwd?: string;
    finalSessionId: string;
    layout: AiSessionTmuxLayout;
    finalLocator: AiSessionTmuxLocator;
    consumedAtMs: number;
}

export interface TmuxPromotingRuntimeBinding {
    version: 1;
    state: 'promoting';
    pendingId: string;
    provider: AiSessionProviderId;
    projectKey: string;
    cwd: string;
    createdAt: string;
    markerPath: string;
    pendingBinding: TmuxPendingRuntimeBinding;
    finalSessionId: string;
    layout: AiSessionTmuxLayout;
    sourceLocator: AiSessionTmuxLocator;
    finalLocator: AiSessionTmuxLocator;
    requestFingerprint: string;
    recordedAtMs: number;
}

interface TmuxAmbiguousRuntimeBindingBase {
    version: 1;
    state: 'ambiguous';
    provider: AiSessionProviderId;
    projectKey: string;
    layout: AiSessionTmuxLayout;
    locator: AiSessionTmuxLocator;
    acceptedAtMs: number;
}

export type TmuxAmbiguousRuntimeBinding = TmuxAmbiguousRuntimeBindingBase & (
    { sessionId: string; pendingId?: never }
    | {
        pendingId: string;
        sessionId?: never;
        cwd: string;
        createdAt: string;
        excludedSessionIds: string[];
        title?: string;
        markerPath?: string;
        requestFingerprint: string;
    }
);

type TmuxFinalRuntimeBinding = TmuxKnownRuntimeBinding | TmuxInactiveRuntimeBinding;

type TmuxRuntimeBinding = TmuxPendingRuntimeBinding | TmuxFinalRuntimeBinding
    | TmuxAmbiguousRuntimeBinding | TmuxConsumedPendingBinding | TmuxPromotingRuntimeBinding;

export type TmuxFinalRecordLock = <T>(operation: () => Promise<T>) => Promise<T>;

const runWithoutFinalRecordLock: TmuxFinalRecordLock = operation => operation();

export class TmuxRuntimeBindingStore {
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly root: string,
        private readonly now: () => number = () => Date.now(),
        private readonly withFinalRecordLock: TmuxFinalRecordLock = runWithoutFinalRecordLock
    ) { }

    listPending(): Promise<TmuxPendingRuntimeBinding[]> {
        return this.serialize(() => this.listPendingUnlocked());
    }

    listKnown(): Promise<TmuxKnownRuntimeBinding[]> {
        return this.serializeFinal(() => this.listKnownUnlocked(true));
    }

    listInactive(): Promise<TmuxInactiveRuntimeBinding[]> {
        return this.serializeFinal(() => this.listInactiveUnlocked(true));
    }

    getPending(pendingId: string): Promise<TmuxPendingRuntimeBinding | null> {
        return this.serialize(async () => {
            if (!isBoundedString(pendingId, MAX_ID_LENGTH)) {
                return null;
            }
            const filePath = this.recordPath('pending', pendingId);
            const record = validatePersistedPendingRecord(await readJsonRegularFile(filePath), this.now());
            if (!record || record.pendingId !== pendingId || !isCanonicalRecordPath(filePath, record)) {
                return null;
            }
            return clonePending(record);
        });
    }

    getKnown(provider: AiSessionProviderId, sessionId: string): Promise<TmuxKnownRuntimeBinding | null> {
        return this.serializeFinal(async () => {
            if (!isProviderId(provider) || !isBoundedString(sessionId, MAX_ID_LENGTH)) {
                return null;
            }
            const filePath = this.recordPath('known', provider, sessionId);
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!record || record.provider !== provider || record.sessionId !== sessionId
                || !isCanonicalRecordPath(filePath, record)) {
                return null;
            }
            if (isFinalRuntimeExpired(record, this.now())) {
                await removeFile(filePath);
                return null;
            }
            return record.state === 'known' ? cloneKnown(record) : null;
        });
    }

    getInactive(provider: AiSessionProviderId, sessionId: string): Promise<TmuxInactiveRuntimeBinding | null> {
        return this.serializeFinal(async () => {
            if (!isProviderId(provider) || !isBoundedString(sessionId, MAX_ID_LENGTH)) {
                return null;
            }
            const filePath = this.recordPath('known', provider, sessionId);
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!record || record.provider !== provider || record.sessionId !== sessionId
                || !isCanonicalRecordPath(filePath, record)) {
                return null;
            }
            if (isFinalRuntimeExpired(record, this.now())) {
                await removeFile(filePath);
                return null;
            }
            return record.state === 'completed' || record.state === 'stopped'
                ? cloneInactive(record) : null;
        });
    }

    getAmbiguous(identity: AiSessionRuntimeIdentity): Promise<TmuxAmbiguousRuntimeBinding | null> {
        return this.serialize(async () => {
            const identityParts = ambiguousIdentityParts(identity);
            if (!identityParts) {
                return null;
            }
            const filePath = this.recordPath('ambiguous', ...identityParts);
            const record = validateAmbiguousRecord(await readJsonRegularFile(filePath));
            if (!record || !ambiguousRecordMatchesIdentity(record, identity)
                || !isCanonicalRecordPath(filePath, record)) {
                return null;
            }
            return cloneAmbiguous(record);
        });
    }

    getAmbiguousByPendingId(pendingId: string): Promise<TmuxAmbiguousRuntimeBinding | null> {
        return this.serialize(() => this.getPendingLifecycleByIdUnlocked(
            'ambiguous', pendingId, validateAmbiguousRecord, cloneAmbiguous
        ));
    }

    setPending(record: TmuxPendingRuntimeBinding): Promise<boolean> {
        const validated = validatePersistedPendingRecord(record, this.now());
        if (!validated) {
            return Promise.reject(new Error('The pending tmux binding is invalid or expired.'));
        }
        return this.serialize(async () => {
            await this.writeRecord(this.recordPath('pending', validated.pendingId), validated);
            return true;
        });
    }

    getConsumed(identity: AiSessionRuntimeIdentity): Promise<TmuxConsumedPendingBinding | null> {
        return this.serialize(async () => {
            if (!identity || identity.sessionId !== undefined || !isProviderId(identity.provider)
                || !isBoundedString(identity.projectKey, MAX_ID_LENGTH)
                || !isBoundedString(identity.pendingId, MAX_ID_LENGTH)) {
                return null;
            }
            const filePath = this.recordPath('consumed', identity.provider, identity.projectKey, identity.pendingId);
            const record = validateConsumedRecord(await readJsonRegularFile(filePath));
            return record && consumedRecordMatchesIdentity(record, identity)
                && isCanonicalRecordPath(filePath, record) ? cloneConsumed(record) : null;
        });
    }

    getConsumedByPendingId(pendingId: string): Promise<TmuxConsumedPendingBinding | null> {
        return this.serialize(() => this.getPendingLifecycleByIdUnlocked(
            'consumed', pendingId, validateConsumedRecord, cloneConsumed
        ));
    }

    setConsumed(record: TmuxConsumedPendingBinding): Promise<boolean> {
        const validated = validateConsumedRecord(record);
        if (!validated || validated.cwd === undefined) {
            return Promise.reject(new Error('The consumed tmux binding is invalid.'));
        }
        return this.serialize(async () => {
            await this.writeRecord(this.recordPath('consumed', validated.provider,
                validated.projectKey, validated.pendingId), validated);
            return true;
        });
    }

    getPromoting(identity: AiSessionRuntimeIdentity): Promise<TmuxPromotingRuntimeBinding | null> {
        return this.serialize(async () => {
            const identityParts = pendingIdentityParts(identity);
            if (!identityParts) {
                return null;
            }
            const filePath = this.recordPath('promoting', ...identityParts);
            const record = validatePromotingRecord(await readJsonRegularFile(filePath));
            return record && promotingRecordMatchesIdentity(record, identity)
                && isCanonicalRecordPath(filePath, record) ? clonePromoting(record) : null;
        });
    }

    getPromotingByPendingId(pendingId: string): Promise<TmuxPromotingRuntimeBinding | null> {
        return this.serialize(() => this.getPendingLifecycleByIdUnlocked(
            'promoting', pendingId, validatePromotingRecord, clonePromoting
        ));
    }

    setPromoting(record: TmuxPromotingRuntimeBinding): Promise<boolean> {
        const validated = validatePromotingRecord(record);
        if (!validated) {
            return Promise.reject(new Error('The promoting tmux binding is invalid.'));
        }
        return this.serialize(async () => {
            await this.writeRecord(this.recordPath('promoting', validated.provider,
                validated.projectKey, validated.pendingId), validated);
            return true;
        });
    }

    removePromoting(identity: AiSessionRuntimeIdentity): Promise<void> {
        const identityParts = pendingIdentityParts(identity);
        return identityParts
            ? this.serialize(() => removeFile(this.recordPath('promoting', ...identityParts)))
            : Promise.resolve();
    }

    setAmbiguous(record: TmuxAmbiguousRuntimeBinding): Promise<boolean> {
        const validated = validateAmbiguousRecord(record);
        if (!validated) {
            return Promise.reject(new Error('The ambiguous tmux binding is invalid.'));
        }
        const identityParts = ambiguousRecordIdentityParts(validated);
        return this.serialize(async () => {
            await this.writeRecord(this.recordPath('ambiguous', ...identityParts), validated);
            return true;
        });
    }

    removeAmbiguous(identity: AiSessionRuntimeIdentity): Promise<void> {
        const identityParts = ambiguousIdentityParts(identity);
        if (!identityParts) {
            return Promise.resolve();
        }
        return this.serialize(() => removeFile(this.recordPath('ambiguous', ...identityParts)));
    }

    removePending(pendingId: string): Promise<void> {
        if (!isBoundedString(pendingId, MAX_ID_LENGTH)) {
            return Promise.resolve();
        }
        return this.serialize(() => removeFile(this.recordPath('pending', pendingId)));
    }

    setKnown(record: TmuxKnownRuntimeBinding): Promise<void> {
        const validated = validateKnownRecord(record);
        if (!validated || isKnownExpired(validated, this.now())) {
            return Promise.resolve();
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', validated.provider, validated.sessionId);
            const current = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (current && current.provider === validated.provider
                && current.sessionId === validated.sessionId
                && (current.state === 'completed' || current.state === 'stopped')) {
                return;
            }
            await this.writeRecord(filePath, validated);
            await this.listKnownUnlocked(true);
        });
    }

    setInactive(record: TmuxInactiveRuntimeBinding): Promise<void> {
        const validated = validateInactiveRecord(record, this.now());
        if (!validated || isInactiveExpired(validated, this.now())) {
            return Promise.reject(new Error('The inactive tmux binding is invalid or expired.'));
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', validated.provider, validated.sessionId);
            const current = validateFinalRuntimeRecord(
                await readJsonRegularFile(filePath), this.now()
            );
            if (current) {
                if (current.state === 'known') {
                    return;
                }
                if (!inactiveBindingsMatchRun(current, validated)
                    || validated.detectedAtMs < current.detectedAtMs
                    || (current.state === 'completed' && validated.state === 'stopped')) {
                    return;
                }
            }
            await this.writeRecord(filePath, validated);
            await this.listInactiveUnlocked(true);
        });
    }

    transitionKnownToInactive(
        record: TmuxInactiveRuntimeBinding,
        expectedLastSeenAtMs: number
    ): Promise<boolean> {
        const validated = validateInactiveRecord(record, this.now());
        if (!validated || isInactiveExpired(validated, this.now())
            || !isFiniteNonNegative(expectedLastSeenAtMs)) {
            return Promise.reject(new Error('The inactive tmux binding transition is invalid or expired.'));
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', validated.provider, validated.sessionId);
            const current = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!current || current.state !== 'known'
                || current.provider !== validated.provider
                || current.sessionId !== validated.sessionId
                || current.projectKey !== validated.projectKey
                || current.layout !== validated.layout
                || !locatorsEqual(current.locator, validated.locator)
                || current.lastSeenAtMs !== expectedLastSeenAtMs
                || !isCanonicalRecordPath(filePath, current)) {
                return false;
            }
            await this.writeRecord(filePath, validated);
            await this.listInactiveUnlocked(true);
            return true;
        });
    }

    acknowledgeInactive(
        expected: TmuxInactiveRuntimeBinding
    ): Promise<TmuxInactiveAcknowledgementResult> {
        const validated = validateInactiveRecord(expected, this.now());
        if (!validated) {
            return Promise.reject(new Error('The expected inactive tmux binding is invalid.'));
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', validated.provider, validated.sessionId);
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!record) {
                return await pathEntryExists(filePath) ? 'stale' : 'missing';
            }
            if (record.provider !== validated.provider || record.sessionId !== validated.sessionId
                || !isCanonicalRecordPath(filePath, record)
                || record.state === 'known'
                || !inactiveBindingsEqual(record, validated)) {
                return 'stale';
            }
            await removeFileDurably(filePath);
            return 'acknowledged';
        });
    }

    removeKnown(provider: AiSessionProviderId, sessionId: string): Promise<void> {
        if (!isProviderId(provider) || !isBoundedString(sessionId, MAX_ID_LENGTH)) {
            return Promise.resolve();
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', provider, sessionId);
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (record?.state === 'known' && record.provider === provider
                && record.sessionId === sessionId && isCanonicalRecordPath(filePath, record)) {
                await removeFile(filePath);
            }
        });
    }

    reconcileKnown(live: readonly AiSessionRuntimeSnapshot[]): Promise<void> {
        return this.serializeFinal(async () => {
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
                    const filePath = this.recordPath('known', record.provider, record.sessionId);
                    const current = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
                    if (!current || current.state === 'known') {
                        await this.writeRecord(filePath, record);
                    }
                }
            }
            await this.listKnownUnlocked(true);
        });
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private serializeFinal<T>(operation: () => Promise<T>): Promise<T> {
        return this.serialize(() => this.withFinalRecordLock(operation));
    }

    private async listPendingUnlocked(): Promise<TmuxPendingRuntimeBinding[]> {
        const records: TmuxPendingRuntimeBinding[] = [];
        const now = this.now();
        if (!Number.isFinite(now)) {
            return records;
        }
        for (const filePath of await listJsonFiles(this.root)) {
            const record = validatePersistedPendingRecord(await readJsonRegularFile(filePath), now);
            if (!record || !isCanonicalRecordPath(filePath, record)) {
                continue;
            }
            records.push(record);
        }
        records.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
            || left.pendingId.localeCompare(right.pendingId));
        return records.map(clonePending);
    }

    private async listKnownUnlocked(pruneToCap: boolean): Promise<TmuxKnownRuntimeBinding[]> {
        const entries = await this.listFinalRuntimeUnlocked(pruneToCap);
        return entries.filter((entry): entry is { filePath: string; record: TmuxKnownRuntimeBinding } =>
            entry.record.state === 'known').map(entry => cloneKnown(entry.record));
    }

    private async listInactiveUnlocked(pruneToCap: boolean): Promise<TmuxInactiveRuntimeBinding[]> {
        const entries = await this.listFinalRuntimeUnlocked(pruneToCap);
        return entries.filter((entry): entry is { filePath: string; record: TmuxInactiveRuntimeBinding } =>
            entry.record.state === 'completed' || entry.record.state === 'stopped')
            .map(entry => cloneInactive(entry.record));
    }

    private async listFinalRuntimeUnlocked(
        pruneToCap: boolean
    ): Promise<Array<{ filePath: string; record: TmuxFinalRuntimeBinding }>> {
        const entries: Array<{ filePath: string; record: TmuxFinalRuntimeBinding }> = [];
        for (const filePath of await listJsonFiles(this.root)) {
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!record || !isCanonicalRecordPath(filePath, record)) {
                continue;
            }
            if (isFinalRuntimeExpired(record, this.now())) {
                await removeFile(filePath);
            } else {
                entries.push({ filePath, record });
            }
        }
        entries.sort((left, right) => finalRuntimePriority(left.record) - finalRuntimePriority(right.record)
            || finalRuntimeTimestamp(right.record) - finalRuntimeTimestamp(left.record)
            || left.record.provider.localeCompare(right.record.provider)
            || left.record.sessionId.localeCompare(right.record.sessionId));
        if (pruneToCap && entries.length > MAX_KNOWN_RECORDS) {
            for (const entry of entries.slice(MAX_KNOWN_RECORDS)) {
                await removeFile(entry.filePath);
            }
            entries.length = MAX_KNOWN_RECORDS;
        }
        return entries;
    }

    private async getPendingLifecycleByIdUnlocked<T extends TmuxAmbiguousRuntimeBinding
        | TmuxConsumedPendingBinding | TmuxPromotingRuntimeBinding>(
        kind: 'ambiguous' | 'consumed' | 'promoting',
        pendingId: string,
        validate: (value: unknown) => T | null,
        clone: (record: T) => T
    ): Promise<T | null> {
        if (!isBoundedString(pendingId, MAX_ID_LENGTH)) {
            return null;
        }
        const files = await listJsonFiles(this.root);
        if (files.length > MAX_PENDING_LIFECYCLE_DIRECTORY_FILES) {
            throw new Error('Too many tmux lifecycle files exist for bounded pending ID lookup.');
        }
        const candidates = files.filter(filePath => path.basename(filePath).startsWith(`${kind}-`));
        if (candidates.length > MAX_PENDING_LIFECYCLE_LOOKUP_RECORDS) {
            throw new Error('Too many tmux lifecycle records exist for bounded pending ID lookup.');
        }
        const matches: T[] = [];
        for (const filePath of candidates) {
            const record = validate(await readJsonRegularFile(filePath));
            if (record && record.pendingId === pendingId && isCanonicalRecordPath(filePath, record)) {
                matches.push(record);
            }
        }
        if (matches.length > 1) {
            throw new Error(`Multiple tmux ${kind} records use the same pending ID.`);
        }
        return matches.length === 1 ? clone(matches[0]) : null;
    }

    private recordPath(
        kind: 'pending' | 'known' | 'ambiguous' | 'consumed' | 'promoting',
        ...identity: string[]
    ): string {
        return path.join(this.root, getRecordFilename(kind, ...identity));
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

async function listJsonFiles(root: string): Promise<string[]> {
    let names: string[];
    try {
        names = await fs.readdir(root);
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return [];
        }
        throw error;
    }
    return names.filter(name => name.endsWith('.json')).map(name => path.join(root, name));
}

async function readJsonRegularFile(filePath: string): Promise<unknown> {
    let handle: fs.FileHandle | undefined;
    try {
        const pathStat = await fs.lstat(filePath);
        if (!pathStat.isFile() || pathStat.size <= 0 || pathStat.size > MAX_RECORD_BYTES) {
            return null;
        }
        handle = await openRecordFile(filePath);
        const handleStat = await handle.stat();
        if (!handleStat.isFile() || handleStat.size <= 0 || handleStat.size > MAX_RECORD_BYTES) {
            return null;
        }
        const openedPathStat = await fs.lstat(filePath);
        if (!openedPathStat.isFile() || openedPathStat.size <= 0 || openedPathStat.size > MAX_RECORD_BYTES
            || !isSameFile(pathStat, handleStat) || !isSameFile(openedPathStat, handleStat)) {
            return null;
        }
        return JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    } catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ELOOP') || error instanceof SyntaxError) {
            return null;
        }
        throw error;
    } finally {
        if (handle) {
            await handle.close();
        }
    }
}

async function pathEntryExists(filePath: string): Promise<boolean> {
    try {
        await fs.lstat(filePath);
        return true;
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return false;
        }
        throw error;
    }
}

function isSameFile(pathStat: Stats, handleStat: Stats): boolean {
    return pathStat.dev === handleStat.dev && pathStat.ino === handleStat.ino;
}

async function openRecordFile(filePath: string): Promise<fs.FileHandle> {
    if (NO_FOLLOW_FLAG) {
        try {
            return await fs.open(filePath, READ_ONLY_NO_FOLLOW);
        } catch (error) {
            if (!isUnsupportedNoFollowError(error)) {
                throw error;
            }
        }
    }
    return fs.open(filePath, READ_ONLY_FALLBACK);
}

function isUnsupportedNoFollowError(error: unknown): boolean {
    return isNodeError(error, 'EINVAL') || isNodeError(error, 'ENOTSUP') || isNodeError(error, 'EOPNOTSUPP');
}

function isCanonicalRecordPath(filePath: string, record: TmuxRuntimeBinding): boolean {
    let identity: string[];
    if (record.state === 'pending') {
        identity = [record.pendingId];
    } else if (record.state === 'known' || record.state === 'completed' || record.state === 'stopped') {
        identity = [record.provider, record.sessionId];
    } else if (record.state === 'consumed' || record.state === 'promoting') {
        identity = [record.provider, record.projectKey, record.pendingId];
    } else {
        identity = ambiguousRecordIdentityParts(record as TmuxAmbiguousRuntimeBinding);
    }
    const canonicalState = record.state === 'completed' || record.state === 'stopped'
        ? 'known' : record.state;
    return path.basename(filePath) === getRecordFilename(canonicalState, ...identity);
}

function getRecordFilename(
    kind: 'pending' | 'known' | 'ambiguous' | 'consumed' | 'promoting',
    ...identity: string[]
): string {
    const digest = createHash('sha256')
        .update(JSON.stringify([RECORD_VERSION, kind, ...identity]), 'utf8')
        .digest('hex');
    return `${kind}-${digest}.json`;
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

async function removeFileDurably(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
    let directory: fs.FileHandle | undefined;
    try {
        directory = await fs.open(path.dirname(filePath), 'r');
        await directory.sync();
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    } finally {
        if (directory) {
            await directory.close();
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
        acceptedAtMs: isFiniteNonNegative(record.acceptedAtMs)
            ? record.acceptedAtMs
            : Date.parse(record.createdAt as string),
        layout: record.layout,
        locator,
    };
}

export function validateTmuxPendingRuntimeBinding(
    value: unknown,
    nowMs: number = Date.now()
): TmuxPendingRuntimeBinding | null {
    const record = validatePersistedPendingRecord(value, nowMs);
    const createdAtMs = record ? Date.parse(record.createdAt) : NaN;
    return record && nowMs - createdAtMs < PENDING_TTL_MS
        ? record
        : null;
}

function validatePersistedPendingRecord(
    value: unknown,
    nowMs: number
): TmuxPendingRuntimeBinding | null {
    const record = validatePendingRecord(value);
    const createdAtMs = record ? Date.parse(record.createdAt) : NaN;
    return record && Number.isFinite(nowMs) && createdAtMs <= nowMs + MAX_FUTURE_SKEW_MS
        && record.acceptedAtMs <= nowMs + MAX_FUTURE_SKEW_MS
        && !isPendingExpired(record, nowMs)
        ? record
        : null;
}

function validateConsumedRecord(value: unknown): TmuxConsumedPendingBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.finalLocator);
    if (record.version !== RECORD_VERSION || record.state !== 'consumed'
        || !isBoundedString(record.pendingId, MAX_ID_LENGTH) || !isProviderId(record.provider)
        || !isBoundedString(record.projectKey, MAX_ID_LENGTH)
        || (record.cwd !== undefined && !isBoundedString(record.cwd, MAX_PATH_LENGTH))
        || !isBoundedString(record.finalSessionId, MAX_ID_LENGTH)
        || !isLayout(record.layout) || !locator || locator.layout !== record.layout
        || !isFiniteNonNegative(record.consumedAtMs)) {
        return null;
    }
    return {
        version: 1,
        state: 'consumed',
        pendingId: record.pendingId,
        provider: record.provider,
        projectKey: record.projectKey,
        ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
        finalSessionId: record.finalSessionId,
        layout: record.layout,
        finalLocator: locator,
        consumedAtMs: record.consumedAtMs,
    };
}

function validatePromotingRecord(value: unknown): TmuxPromotingRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const sourceLocator = validateLocator(record.sourceLocator);
    const finalLocator = validateLocator(record.finalLocator);
    const pendingBinding = validatePendingRecord(record.pendingBinding);
    if (record.version !== RECORD_VERSION || record.state !== 'promoting'
        || !isBoundedString(record.pendingId, MAX_ID_LENGTH) || !isProviderId(record.provider)
        || !isBoundedString(record.projectKey, MAX_ID_LENGTH) || !isBoundedString(record.cwd, MAX_PATH_LENGTH)
        || !isDateString(record.createdAt)
        || (record.markerPath !== '' && !isBoundedString(record.markerPath, MAX_PATH_LENGTH))
        || !isBoundedString(record.finalSessionId, MAX_ID_LENGTH) || !isLayout(record.layout)
        || !sourceLocator || sourceLocator.layout !== record.layout
        || !finalLocator || finalLocator.layout !== record.layout
        || (record.layout === 'project' && sourceLocator.sessionName !== finalLocator.sessionName)
        || locatorsEqual(sourceLocator, finalLocator)
        || !pendingBinding || pendingBinding.pendingId !== record.pendingId
        || pendingBinding.provider !== record.provider || pendingBinding.projectKey !== record.projectKey
        || pendingBinding.cwd !== record.cwd || pendingBinding.createdAt !== record.createdAt
        || pendingBinding.layout !== record.layout || !locatorsEqual(pendingBinding.locator, sourceLocator)
        || typeof record.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.requestFingerprint)
        || !isFiniteNonNegative(record.recordedAtMs)) {
        return null;
    }
    return {
        version: 1,
        state: 'promoting',
        pendingId: record.pendingId,
        provider: record.provider,
        projectKey: record.projectKey,
        cwd: record.cwd,
        createdAt: record.createdAt,
        markerPath: record.markerPath,
        pendingBinding,
        finalSessionId: record.finalSessionId,
        layout: record.layout,
        sourceLocator,
        finalLocator,
        requestFingerprint: record.requestFingerprint,
        recordedAtMs: record.recordedAtMs,
    };
}

function validateAmbiguousRecord(value: unknown): TmuxAmbiguousRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    const hasSessionId = record.sessionId !== undefined;
    const hasPendingId = record.pendingId !== undefined;
    if (record.version !== RECORD_VERSION || record.state !== 'ambiguous'
        || !isProviderId(record.provider) || !isBoundedString(record.projectKey, MAX_ID_LENGTH)
        || hasSessionId === hasPendingId
        || !isBoundedString(hasSessionId ? record.sessionId : record.pendingId, MAX_ID_LENGTH)
        || !isLayout(record.layout) || !locator || locator.layout !== record.layout
        || !isFiniteNonNegative(record.acceptedAtMs)
        || (hasPendingId && (!isBoundedString(record.cwd, MAX_PATH_LENGTH)
            || !isDateString(record.createdAt) || !Array.isArray(record.excludedSessionIds)
            || record.excludedSessionIds.length > MAX_EXCLUDED_SESSION_IDS
            || record.excludedSessionIds.some(id => !isBoundedString(id, MAX_ID_LENGTH))
            || (record.title !== undefined && !isOptionalTitle(record.title))
            || (record.markerPath !== undefined
                && !isBoundedString(record.markerPath, MAX_PATH_LENGTH))
            || typeof record.requestFingerprint !== 'string'
            || !/^[a-f0-9]{64}$/.test(record.requestFingerprint)))) {
        return null;
    }
    return {
        version: 1,
        state: 'ambiguous',
        provider: record.provider,
        projectKey: record.projectKey,
        ...(hasSessionId
            ? { sessionId: record.sessionId as string }
            : {
                pendingId: record.pendingId as string,
                cwd: record.cwd as string,
                createdAt: record.createdAt as string,
                excludedSessionIds: [...record.excludedSessionIds as string[]],
                ...(record.title === undefined ? {} : { title: record.title as string }),
                ...(record.markerPath === undefined ? {} : { markerPath: record.markerPath as string }),
                requestFingerprint: record.requestFingerprint as string,
            }),
        layout: record.layout,
        locator,
        acceptedAtMs: record.acceptedAtMs,
    } as TmuxAmbiguousRuntimeBinding;
}

function validateKnownRecord(value: unknown): TmuxKnownRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    if (record.version !== RECORD_VERSION
        || (record.state !== undefined && record.state !== 'known')
        || !isProviderId(record.provider)
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

function validateInactiveRecord(
    value: unknown,
    nowMs: number = Date.now()
): TmuxInactiveRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    if (record.version !== RECORD_VERSION
        || (record.state !== 'completed' && record.state !== 'stopped')
        || !isProviderId(record.provider) || !isBoundedString(record.sessionId, MAX_ID_LENGTH)
        || !isBoundedString(record.projectKey, MAX_ID_LENGTH)
        || !isBoundedPath(record.cwd) || !isLayout(record.layout)
        || !locator || locator.layout !== record.layout
        || !isBoundedPath(record.markerPath)
        || !isFinitePositive(record.runStartedAtMs)
        || !isFinitePositive(record.detectedAtMs)
        || !Number.isFinite(nowMs) || record.detectedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
        return null;
    }
    return {
        version: 1,
        state: record.state,
        provider: record.provider,
        sessionId: record.sessionId,
        projectKey: record.projectKey,
        cwd: record.cwd,
        layout: record.layout,
        locator,
        markerPath: record.markerPath,
        runStartedAtMs: record.runStartedAtMs,
        detectedAtMs: record.detectedAtMs,
    };
}

function validateFinalRuntimeRecord(
    value: unknown,
    nowMs: number = Date.now()
): TmuxFinalRuntimeBinding | null {
    return validateKnownRecord(value) || validateInactiveRecord(value, nowMs);
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

function locatorsEqual(left: AiSessionTmuxLocator, right: AiSessionTmuxLocator): boolean {
    return left.layout === right.layout && left.sessionName === right.sessionName
        && left.windowName === right.windowName;
}

function inactiveBindingsMatchRun(
    left: TmuxInactiveRuntimeBinding,
    right: TmuxInactiveRuntimeBinding
): boolean {
    return left.provider === right.provider && left.sessionId === right.sessionId
        && left.projectKey === right.projectKey && left.cwd === right.cwd
        && left.layout === right.layout && locatorsEqual(left.locator, right.locator)
        && left.markerPath === right.markerPath
        && left.runStartedAtMs === right.runStartedAtMs;
}

function inactiveBindingsEqual(
    left: TmuxInactiveRuntimeBinding,
    right: TmuxInactiveRuntimeBinding
): boolean {
    return inactiveBindingsMatchRun(left, right)
        && left.state === right.state
        && left.detectedAtMs === right.detectedAtMs;
}

function clonePending(record: TmuxPendingRuntimeBinding): TmuxPendingRuntimeBinding {
    return { ...record, excludedSessionIds: [...record.excludedSessionIds], locator: { ...record.locator } };
}

function cloneKnown(record: TmuxKnownRuntimeBinding): TmuxKnownRuntimeBinding {
    return { ...record, locator: { ...record.locator } };
}

function cloneInactive(record: TmuxInactiveRuntimeBinding): TmuxInactiveRuntimeBinding {
    return { ...record, locator: { ...record.locator } };
}

function cloneAmbiguous(record: TmuxAmbiguousRuntimeBinding): TmuxAmbiguousRuntimeBinding {
    if (record.sessionId !== undefined) {
        return { ...record, locator: { ...record.locator } };
    }
    const pendingRecord = record as TmuxAmbiguousRuntimeBindingBase & {
        pendingId: string;
        cwd: string;
        createdAt: string;
        excludedSessionIds: string[];
        title?: string;
        markerPath?: string;
        requestFingerprint: string;
    };
    return {
        ...pendingRecord,
        locator: { ...pendingRecord.locator },
        excludedSessionIds: [...pendingRecord.excludedSessionIds],
    };
}

function cloneConsumed(record: TmuxConsumedPendingBinding): TmuxConsumedPendingBinding {
    return { ...record, finalLocator: { ...record.finalLocator } };
}

function clonePromoting(record: TmuxPromotingRuntimeBinding): TmuxPromotingRuntimeBinding {
    return {
        ...record,
        sourceLocator: { ...record.sourceLocator },
        finalLocator: { ...record.finalLocator },
        pendingBinding: clonePending(record.pendingBinding),
    };
}

function consumedRecordMatchesIdentity(
    record: TmuxConsumedPendingBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.provider === identity.provider && record.projectKey === identity.projectKey
        && record.pendingId === identity.pendingId
        && (record.cwd === undefined || record.cwd === identity.cwd);
}

function pendingIdentityParts(identity: AiSessionRuntimeIdentity): string[] | null {
    return identity && identity.sessionId === undefined && isProviderId(identity.provider)
        && isBoundedString(identity.projectKey, MAX_ID_LENGTH) && isBoundedString(identity.pendingId, MAX_ID_LENGTH)
        ? [identity.provider, identity.projectKey, identity.pendingId]
        : null;
}

function promotingRecordMatchesIdentity(
    record: TmuxPromotingRuntimeBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.provider === identity.provider && record.projectKey === identity.projectKey
        && record.pendingId === identity.pendingId && record.cwd === identity.cwd;
}

function ambiguousIdentityParts(identity: AiSessionRuntimeIdentity): string[] | null {
    if (!identity || !isProviderId(identity.provider) || !isBoundedString(identity.projectKey, MAX_ID_LENGTH)) {
        return null;
    }
    const hasSessionId = identity.sessionId !== undefined;
    const hasPendingId = identity.pendingId !== undefined;
    if (hasSessionId === hasPendingId) {
        return null;
    }
    const id = hasSessionId ? identity.sessionId : identity.pendingId;
    return isBoundedString(id, MAX_ID_LENGTH)
        ? [identity.provider, identity.projectKey, hasSessionId ? 'session' : 'pending', id]
        : null;
}

function ambiguousRecordIdentityParts(record: TmuxAmbiguousRuntimeBinding): string[] {
    return [
        record.provider,
        record.projectKey,
        record.sessionId !== undefined ? 'session' : 'pending',
        record.sessionId !== undefined ? record.sessionId : record.pendingId,
    ];
}

function ambiguousRecordMatchesIdentity(
    record: TmuxAmbiguousRuntimeBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.provider === identity.provider
        && record.projectKey === identity.projectKey
        && record.sessionId === identity.sessionId
        && record.pendingId === identity.pendingId;
}

function isPendingExpired(record: TmuxPendingRuntimeBinding, now: number): boolean {
    return now - record.acceptedAtMs >= PENDING_TTL_MS;
}

function isKnownExpired(record: TmuxKnownRuntimeBinding, now: number): boolean {
    return now - record.lastSeenAtMs >= KNOWN_TTL_MS;
}

function isInactiveExpired(record: TmuxInactiveRuntimeBinding, now: number): boolean {
    return now - record.detectedAtMs >= KNOWN_TTL_MS;
}

function isFinalRuntimeExpired(record: TmuxFinalRuntimeBinding, now: number): boolean {
    return record.state === 'known' ? isKnownExpired(record, now) : isInactiveExpired(record, now);
}

function finalRuntimePriority(record: TmuxFinalRuntimeBinding): number {
    return record.state === 'completed' ? 0 : record.state === 'known' ? 1 : 2;
}

function finalRuntimeTimestamp(record: TmuxFinalRuntimeBinding): number {
    return record.state === 'known' ? record.lastSeenAtMs : record.detectedAtMs;
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

function isFinitePositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isBoundedPath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_PATH_LENGTH
        && !CONTROL_CHARACTERS.test(value);
}

function isNodeError(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}
