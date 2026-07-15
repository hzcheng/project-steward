import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
    AttentionOwnerSnapshot,
    validateAttentionOwnerSnapshot,
} from '../../../src/aiSessions/attentionPayload';

const INSTANCE_FILE_PATTERN = /^[a-f0-9]{32}\.json$/;
const LEASE_MS = 90_000;
const MAX_FILE_BYTES = 256 * 1024;

interface StoredAttentionEnvelope {
    storageVersion: 1;
    receivedAtMs: number;
    bridgeVersion: string;
    snapshot: AttentionOwnerSnapshot;
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
        || !Number.isFinite(record.receivedAtMs) || record.receivedAtMs < 0) {
        throw new Error('attention envelope header is invalid');
    }
    if (typeof record.bridgeVersion !== 'string' || !record.bridgeVersion || record.bridgeVersion.length > 64) throw new Error('attention bridge version is invalid');
    return {
        storageVersion: 1,
        receivedAtMs: record.receivedAtMs,
        bridgeVersion: record.bridgeVersion,
        snapshot: validateAttentionOwnerSnapshot(record.snapshot),
    };
}

export class ProductionAttentionStore {
    private readonly instancesDirectory: string;
    private readonly highWater = new Map<string, number>();

    public constructor(rootDirectory: string, private readonly bridgeProcessId: string) {
        this.instancesDirectory = path.join(rootDirectory, 'instances');
    }

    public async write(snapshot: AttentionOwnerSnapshot, receivedAtMs = Date.now(), bridgeVersion = '0.1.1'): Promise<void> {
        const validated = validateAttentionOwnerSnapshot(snapshot);
        if (!Number.isFinite(receivedAtMs) || receivedAtMs < 0) throw new Error('attention receipt time is invalid');
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
            await fs.promises.rename(temporaryPath, finalPath);
            this.highWater.set(validated.instanceId, validated.sequence);
        } finally {
            try {
                await fs.promises.unlink(temporaryPath);
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) throw error;
            }
        }
    }

    public async scan(nowMs = Date.now()): Promise<{ snapshots: AttentionOwnerSnapshot[] }> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this.instancesDirectory, { withFileTypes: true });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return { snapshots: [] };
            throw error;
        }
        const snapshots: AttentionOwnerSnapshot[] = [];
        for (const entry of entries.slice(0, 2000)) {
            if (!INSTANCE_FILE_PATTERN.test(entry.name)) continue;
            const filePath = path.join(this.instancesDirectory, entry.name);
            try {
                const stats = await fs.promises.lstat(filePath);
                if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES) continue;
                const envelope = validateEnvelope(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
                if (`${envelope.snapshot.instanceId}.json` !== entry.name) continue;
                const previous = this.highWater.get(envelope.snapshot.instanceId) ?? -1;
                if (envelope.snapshot.sequence < previous) continue;
                this.highWater.set(envelope.snapshot.instanceId, envelope.snapshot.sequence);
                if (nowMs - envelope.receivedAtMs <= LEASE_MS) snapshots.push(envelope.snapshot);
            } catch (_error) {
                // Isolate the invalid owner file.
            }
        }
        return { snapshots: snapshots.sort((left, right) => left.instanceId.localeCompare(right.instanceId)) };
    }
}
