import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
    createSnapshotFileName,
    LEASE_MS,
    MAX_FILE_BYTES,
    parseSnapshotText,
    ProbeSnapshot,
    StoreCounters,
    validateSnapshot,
} from '../../../shared/attention-bridge/storeProtocol';

const INSTANCE_FILE_PATTERN = /^[a-f0-9]{32}\.json$/;
const ACKNOWLEDGEMENT_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const ACKNOWLEDGEMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ACKNOWLEDGEMENT_BYTES = 4096;

interface CachedSnapshot {
    snapshot: ProbeSnapshot;
    seenAtMs: number;
}

export interface StoreScanResult {
    snapshots: ProbeSnapshot[];
    counters: StoreCounters;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

export class LocalStore {
    private readonly instancesDirectory: string;
    private readonly acknowledgementsDirectory: string;
    private readonly cache = new Map<string, CachedSnapshot>();
    private lastWrittenSequence = -1;
    private readonly foreignSequences = new Map<string, number>();

    public constructor(
        private readonly rootDirectory: string,
        private readonly ownInstanceId: string,
        private readonly bridgeProcessId: string,
    ) {
        this.instancesDirectory = path.join(rootDirectory, 'instances');
        this.acknowledgementsDirectory = path.join(rootDirectory, 'acknowledgements');
    }

    public async write(snapshot: ProbeSnapshot): Promise<void> {
        const validated = validateSnapshot(snapshot);
        if (validated.instanceId !== this.ownInstanceId) {
            throw new Error('snapshot instanceId does not belong to this store');
        }
        if (validated.sequence < this.lastWrittenSequence) {
            throw new Error('snapshot sequence decreased');
        }
        await this.writeValidated(validated);
        this.lastWrittenSequence = validated.sequence;
    }

    public async writeForeign(snapshot: ProbeSnapshot): Promise<void> {
        const validated = validateSnapshot(snapshot);
        const previous = this.foreignSequences.get(validated.instanceId) ?? -1;
        if (validated.sequence < previous) throw new Error('snapshot sequence decreased');
        await this.writeValidated(validated);
        this.foreignSequences.set(validated.instanceId, validated.sequence);
    }

    private async writeValidated(validated: ProbeSnapshot): Promise<void> {
        await fs.promises.mkdir(this.instancesDirectory, { recursive: true, mode: 0o700 });
        const finalPath = path.join(this.instancesDirectory, createSnapshotFileName(validated.instanceId));
        const temporaryPath = path.join(
            this.instancesDirectory,
            `${validated.instanceId}.${this.bridgeProcessId}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        try {
            await fs.promises.writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await fs.promises.rename(temporaryPath, finalPath);
            this.cache.set(validated.instanceId, { snapshot: validated, seenAtMs: validated.sentAtMs });
        } catch (error) {
            try {
                await fs.promises.unlink(temporaryPath);
            } catch (cleanupError) {
                if (!hasErrorCode(cleanupError, 'ENOENT')) {
                    // Preserve the original write error.
                }
            }
            throw error;
        }
    }

    public async scan(nowMs: number): Promise<StoreScanResult> {
        const counters: StoreCounters = {
            activeInstances: 0,
            parseErrors: 0,
            oversizedFiles: 0,
            symlinkFiles: 0,
            readErrors: 0,
            rollbackCount: 0,
            disappearedInstances: 0,
        };
        const seen = new Set<string>();
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this.instancesDirectory, { withFileTypes: true });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return this.activeCachedSnapshots(nowMs, seen, counters);
            }
            throw error;
        }
        for (const entry of entries) {
            if (!INSTANCE_FILE_PATTERN.test(entry.name)) {
                continue;
            }
            const instanceId = entry.name.slice(0, -'.json'.length);
            const filePath = path.join(this.instancesDirectory, entry.name);
            let stats: fs.Stats;
            try {
                stats = await fs.promises.lstat(filePath);
            } catch (_error) {
                counters.readErrors += 1;
                continue;
            }
            if (stats.isSymbolicLink()) {
                counters.symlinkFiles += 1;
                continue;
            }
            if (!stats.isFile()) {
                continue;
            }
            if (stats.size > MAX_FILE_BYTES) {
                counters.oversizedFiles += 1;
                continue;
            }
            try {
                const snapshot = parseSnapshotText(await fs.promises.readFile(filePath, 'utf8'));
                if (snapshot.instanceId !== instanceId) {
                    throw new Error('snapshot instanceId does not match file name');
                }
                const cached = this.cache.get(instanceId);
                if (cached && snapshot.sequence < cached.snapshot.sequence) {
                    counters.rollbackCount += 1;
                    continue;
                }
                this.cache.set(instanceId, { snapshot, seenAtMs: nowMs });
                if (nowMs - snapshot.sentAtMs <= LEASE_MS) {
                    seen.add(instanceId);
                }
            } catch (_error) {
                counters.parseErrors += 1;
            }
        }
        return this.activeCachedSnapshots(nowMs, seen, counters);
    }

    public async removeOwnSnapshot(): Promise<void> {
        try {
            await fs.promises.unlink(path.join(this.instancesDirectory, createSnapshotFileName(this.ownInstanceId)));
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
        this.cache.delete(this.ownInstanceId);
    }

    public async writeAcknowledgements(eventIds: string[], acknowledgedAtMs = Date.now()): Promise<void> {
        if (!Array.isArray(eventIds) || eventIds.length > 1000) {
            throw new Error('too many attention acknowledgements');
        }
        await fs.promises.mkdir(this.acknowledgementsDirectory, { recursive: true, mode: 0o700 });
        for (const eventId of eventIds) {
            if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 1024) {
                throw new Error('attention acknowledgement eventId is invalid');
            }
            const hash = crypto.createHash('sha256').update(eventId).digest('hex');
            const finalPath = path.join(this.acknowledgementsDirectory, `${hash}.json`);
            const temporaryPath = path.join(this.acknowledgementsDirectory, `${hash}.${this.bridgeProcessId}.${crypto.randomBytes(8).toString('hex')}.tmp`);
            const contents = `${JSON.stringify({ eventId, acknowledgedAtMs })}\n`;
            try {
                await fs.promises.writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                await fs.promises.rename(temporaryPath, finalPath);
            } finally {
                try {
                    await fs.promises.unlink(temporaryPath);
                } catch (error) {
                    if (!hasErrorCode(error, 'ENOENT')) throw error;
                }
            }
        }
    }

    public async readAcknowledgements(nowMs = Date.now()): Promise<Set<string>> {
        const result = new Set<string>();
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this.acknowledgementsDirectory, { withFileTypes: true });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return result;
            throw error;
        }
        for (const entry of entries.slice(0, 2000)) {
            if (!ACKNOWLEDGEMENT_FILE_PATTERN.test(entry.name)) continue;
            const filePath = path.join(this.acknowledgementsDirectory, entry.name);
            try {
                const stats = await fs.promises.lstat(filePath);
                if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_ACKNOWLEDGEMENT_BYTES) continue;
                const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as { eventId?: unknown; acknowledgedAtMs?: unknown };
                if (typeof value.eventId !== 'string' || value.eventId.length === 0 || value.eventId.length > 1024
                    || typeof value.acknowledgedAtMs !== 'number' || !Number.isFinite(value.acknowledgedAtMs)) continue;
                if (nowMs - value.acknowledgedAtMs > ACKNOWLEDGEMENT_RETENTION_MS) {
                    await fs.promises.unlink(filePath);
                    continue;
                }
                const expectedName = `${crypto.createHash('sha256').update(value.eventId).digest('hex')}.json`;
                if (entry.name === expectedName) result.add(value.eventId);
            } catch (_error) {
                // Ignore only the invalid acknowledgement file.
            }
        }
        return result;
    }

    private activeCachedSnapshots(nowMs: number, seen: Set<string>, counters: StoreCounters): StoreScanResult {
        for (const [instanceId, cached] of this.cache) {
            if (!seen.has(instanceId) && nowMs - cached.snapshot.sentAtMs > LEASE_MS) {
                this.cache.delete(instanceId);
                counters.disappearedInstances += 1;
                continue;
            }
            if (nowMs - cached.snapshot.sentAtMs <= LEASE_MS) {
                seen.add(instanceId);
            }
        }
        const snapshots = Array.from(seen)
            .map(instanceId => this.cache.get(instanceId)?.snapshot)
            .filter((snapshot): snapshot is ProbeSnapshot => snapshot !== undefined)
            .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
        counters.activeInstances = snapshots.length;
        return { snapshots, counters };
    }
}
