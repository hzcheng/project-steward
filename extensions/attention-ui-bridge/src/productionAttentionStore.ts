import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { AttentionOwnerSnapshot, validateAttentionOwnerSnapshot } from '../../../src/aiSessions/attentionPayload';

const INSTANCE_FILE_PATTERN = /^[a-f0-9]{32}\.json$/;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;
const LEASE_MS = 90_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILENAMES = 10_000;
const MAX_ACTIVE_OWNERS = 1_000;

interface StoredAttentionEnvelope {
    storageVersion: 1;
    receivedAtMs: number;
    bridgeVersion: string;
    snapshot: AttentionOwnerSnapshot;
}

interface StoredAttentionRemoval {
    storageVersion: 1;
    instanceId: string;
    removedAtMs: number;
}

export interface ProductionAttentionStoreOptions {
    beforeCommit?: (snapshot: AttentionOwnerSnapshot) => Promise<void>;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: unknown }).code === code;
}

function validateEnvelope(value: unknown): StoredAttentionEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attention envelope must be an object');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join('\n') !== ['bridgeVersion', 'receivedAtMs', 'snapshot', 'storageVersion'].join('\n')) {
        throw new Error('attention envelope has unexpected fields');
    }
    if (record.storageVersion !== 1 || typeof record.receivedAtMs !== 'number'
        || !Number.isFinite(record.receivedAtMs) || record.receivedAtMs < 0) throw new Error('attention envelope header is invalid');
    if (typeof record.bridgeVersion !== 'string' || !record.bridgeVersion || record.bridgeVersion.length > 64) throw new Error('attention bridge version is invalid');
    return {
        storageVersion: 1,
        receivedAtMs: record.receivedAtMs,
        bridgeVersion: record.bridgeVersion,
        snapshot: validateAttentionOwnerSnapshot(record.snapshot),
    };
}

function validateRemoval(value: unknown): StoredAttentionRemoval {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attention removal must be an object');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join('\n') !== ['instanceId', 'removedAtMs', 'storageVersion'].join('\n')) {
        throw new Error('attention removal has unexpected fields');
    }
    if (record.storageVersion !== 1 || typeof record.instanceId !== 'string'
        || !INSTANCE_ID_PATTERN.test(record.instanceId)) throw new Error('attention removal identity is invalid');
    if (typeof record.removedAtMs !== 'number' || !Number.isFinite(record.removedAtMs) || record.removedAtMs < 0) {
        throw new Error('attention removal time is invalid');
    }
    return { storageVersion: 1, instanceId: record.instanceId, removedAtMs: record.removedAtMs };
}

export class ProductionAttentionStore {
    private readonly instancesDirectory: string;
    private readonly removalsDirectory: string;
    private readonly highWater = new Map<string, number>();
    private readonly cache = new Map<string, StoredAttentionEnvelope>();
    private readonly appliedRemovals = new Map<string, number>();
    private mutationQueue: Promise<void> = Promise.resolve();

    public constructor(
        rootDirectory: string,
        private readonly bridgeProcessId: string,
        private readonly options: ProductionAttentionStoreOptions = {},
    ) {
        this.instancesDirectory = path.join(rootDirectory, 'instances');
        this.removalsDirectory = path.join(rootDirectory, 'removals');
    }

    public write(snapshot: AttentionOwnerSnapshot, receivedAtMs = Date.now(), bridgeVersion = 'unknown'): Promise<void> {
        const validated = validateAttentionOwnerSnapshot(snapshot);
        if (!Number.isFinite(receivedAtMs) || receivedAtMs < 0) return Promise.reject(new Error('attention receipt time is invalid'));
        return this.enqueueOperation(async () => {
            const previousRemoval = await this.readRemoval(validated.instanceId);
            if (previousRemoval && receivedAtMs > previousRemoval.removedAtMs) {
                this.applyRemoval(previousRemoval);
            }
            const previous = this.highWater.get(validated.instanceId) ?? -1;
            if (validated.sequence < previous) throw new Error('attention snapshot sequence decreased');
            const envelope = validateEnvelope({ storageVersion: 1, receivedAtMs, bridgeVersion, snapshot: validated });
            const contents = `${JSON.stringify(envelope)}\n`;
            if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) throw new Error('attention snapshot file is too large');
            await fs.promises.mkdir(this.instancesDirectory, { recursive: true, mode: 0o700 });
            const finalPath = path.join(this.instancesDirectory, `${validated.instanceId}.json`);
            const temporaryPath = path.join(this.instancesDirectory, `${validated.instanceId}.${this.bridgeProcessId}.${crypto.randomBytes(8).toString('hex')}.tmp`);
            try {
                await fs.promises.writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                if (this.options.beforeCommit) await this.options.beforeCommit(validated);
                const latest = this.highWater.get(validated.instanceId) ?? -1;
                if (validated.sequence < latest) throw new Error('attention snapshot sequence decreased');
                await fs.promises.rename(temporaryPath, finalPath);
                const latestRemoval = await this.readRemoval(validated.instanceId);
                if (latestRemoval && latestRemoval.removedAtMs >= receivedAtMs) {
                    await fs.promises.unlink(finalPath).catch(error => {
                        if (!hasErrorCode(error, 'ENOENT')) throw error;
                    });
                    this.applyRemoval(latestRemoval);
                    return;
                }
                this.highWater.set(validated.instanceId, validated.sequence);
                this.cache.set(validated.instanceId, envelope);
            } finally {
                try {
                    await fs.promises.unlink(temporaryPath);
                } catch (error) {
                    if (!hasErrorCode(error, 'ENOENT')) throw error;
                }
            }
        });
    }

    public remove(instanceId: string, removedAtMs = Date.now()): Promise<void> {
        if (!INSTANCE_ID_PATTERN.test(instanceId)) return Promise.reject(new Error('attention unregister instanceId is invalid'));
        if (!Number.isFinite(removedAtMs) || removedAtMs < 0) return Promise.reject(new Error('attention unregister time is invalid'));
        return this.enqueueOperation(async () => {
            const removal = validateRemoval({ storageVersion: 1, instanceId, removedAtMs });
            const contents = `${JSON.stringify(removal)}\n`;
            if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) throw new Error('attention removal file is too large');
            await fs.promises.mkdir(this.removalsDirectory, { recursive: true, mode: 0o700 });
            const finalRemovalPath = this.removalPath(instanceId);
            const temporaryRemovalPath = path.join(
                this.removalsDirectory,
                `${instanceId}.${this.bridgeProcessId}.${crypto.randomBytes(8).toString('hex')}.tmp`,
            );
            try {
                await fs.promises.writeFile(temporaryRemovalPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                await fs.promises.rename(temporaryRemovalPath, finalRemovalPath);
            } finally {
                await fs.promises.unlink(temporaryRemovalPath).catch(error => {
                    if (!hasErrorCode(error, 'ENOENT')) throw error;
                });
            }
            try {
                await fs.promises.unlink(path.join(this.instancesDirectory, `${instanceId}.json`));
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) throw error;
            }
            this.applyRemoval(removal);
        });
    }

    public scan(nowMs = Date.now()): Promise<{ snapshots: AttentionOwnerSnapshot[] }> {
        return this.enqueueOperation(() => this.scanNow(nowMs));
    }

    private async scanNow(nowMs: number): Promise<{ snapshots: AttentionOwnerSnapshot[] }> {
        const removals = await this.scanRemovals(nowMs);
        let entries: fs.Dirent[] = [];
        try {
            entries = await fs.promises.readdir(this.instancesDirectory, { withFileTypes: true });
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
        }
        const candidates = entries
            .filter(entry => INSTANCE_FILE_PATTERN.test(entry.name))
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_FILENAMES);
        for (const entry of candidates) {
            const instanceId = entry.name.slice(0, -5);
            const filePath = path.join(this.instancesDirectory, entry.name);
            let stats: fs.Stats | undefined;
            try {
                stats = await fs.promises.lstat(filePath);
                if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES) throw new Error('invalid attention owner file');
                const envelope = validateEnvelope(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
                if (envelope.snapshot.instanceId !== instanceId) throw new Error('attention owner filename mismatch');
                const removal = removals.get(instanceId);
                if (removal && envelope.receivedAtMs <= removal.removedAtMs) {
                    await fs.promises.unlink(filePath).catch(() => undefined);
                    continue;
                }
                const previous = this.highWater.get(instanceId) ?? -1;
                if (envelope.snapshot.sequence < previous) throw new Error('attention snapshot sequence decreased');
                this.highWater.set(instanceId, envelope.snapshot.sequence);
                this.cache.set(instanceId, envelope);
                if (nowMs - envelope.receivedAtMs > RETENTION_MS) await fs.promises.unlink(filePath).catch(() => undefined);
            } catch (_error) {
                if (stats && nowMs - stats.mtimeMs > RETENTION_MS) await fs.promises.unlink(filePath).catch(() => undefined);
            }
        }
        for (const [instanceId, envelope] of this.cache) {
            if (nowMs - envelope.receivedAtMs > LEASE_MS) this.cache.delete(instanceId);
        }
        const snapshots = Array.from(this.cache.values())
            .filter(envelope => nowMs - envelope.receivedAtMs <= LEASE_MS)
            .sort((left, right) => left.snapshot.instanceId.localeCompare(right.snapshot.instanceId))
            .slice(0, MAX_ACTIVE_OWNERS)
            .map(envelope => envelope.snapshot);
        return { snapshots };
    }

    private async scanRemovals(nowMs: number): Promise<Map<string, StoredAttentionRemoval>> {
        const removals = new Map<string, StoredAttentionRemoval>();
        let entries: fs.Dirent[] = [];
        try {
            entries = await fs.promises.readdir(this.removalsDirectory, { withFileTypes: true });
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
        }
        const candidates = entries
            .filter(entry => INSTANCE_FILE_PATTERN.test(entry.name))
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_FILENAMES);
        for (const entry of candidates) {
            const instanceId = entry.name.slice(0, -5);
            const filePath = path.join(this.removalsDirectory, entry.name);
            let stats: fs.Stats | undefined;
            try {
                stats = await fs.promises.lstat(filePath);
                if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES) throw new Error('invalid attention removal file');
                const removal = validateRemoval(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
                if (removal.instanceId !== instanceId) throw new Error('attention removal filename mismatch');
                if (nowMs - removal.removedAtMs > RETENTION_MS) {
                    await fs.promises.unlink(filePath).catch(() => undefined);
                    continue;
                }
                removals.set(instanceId, removal);
                this.applyRemoval(removal);
            } catch (_error) {
                if (stats && nowMs - stats.mtimeMs > RETENTION_MS) await fs.promises.unlink(filePath).catch(() => undefined);
            }
        }
        return removals;
    }

    private applyRemoval(removal: StoredAttentionRemoval): void {
        const appliedRemovedAtMs = this.appliedRemovals.get(removal.instanceId);
        if (appliedRemovedAtMs !== undefined && removal.removedAtMs <= appliedRemovedAtMs) return;
        this.cache.delete(removal.instanceId);
        this.highWater.delete(removal.instanceId);
        this.appliedRemovals.set(removal.instanceId, removal.removedAtMs);
    }

    private async readRemoval(instanceId: string): Promise<StoredAttentionRemoval | undefined> {
        try {
            const stats = await fs.promises.lstat(this.removalPath(instanceId));
            if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES) return undefined;
            const removal = validateRemoval(JSON.parse(await fs.promises.readFile(this.removalPath(instanceId), 'utf8')));
            return removal.instanceId === instanceId ? removal : undefined;
        } catch (_error) {
            return undefined;
        }
    }

    private removalPath(instanceId: string): string {
        return path.join(this.removalsDirectory, `${instanceId}.json`);
    }

    private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation, operation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}
