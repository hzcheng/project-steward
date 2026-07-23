import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
    OPEN_WORKSPACE_LEASE_MS,
    OpenWorkspaceRegistration,
    validateOpenWorkspaceRegistration,
} from '../../../src/openWorkspaces/protocol';

const INSTANCE_FILE_PATTERN = /^[a-f0-9]{32}\.json$/;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_FILE_BYTES = 256 * 1024;

export interface OpenWorkspaceStoreScan {
    registrations: OpenWorkspaceRegistration[];
    counters: {
        active: number;
        parseErrors: number;
        oversizedFiles: number;
        symlinkFiles: number;
        readErrors: number;
        rollbackCount: number;
        expired: number;
    };
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

function requireInstanceId(instanceId: string): void {
    if (!INSTANCE_ID_PATTERN.test(instanceId)) {
        throw new Error('instanceId must be 32 lowercase hexadecimal characters');
    }
}

export class OpenWorkspaceStore {
    private readonly instancesDirectory: string;
    private readonly cache = new Map<string, OpenWorkspaceRegistration>();
    private readonly highestSequences = new Map<string, number>();
    private mutationQueue: Promise<void> = Promise.resolve();

    public constructor(rootDirectory: string, private readonly ownInstanceId: string) {
        requireInstanceId(ownInstanceId);
        this.instancesDirectory = path.join(rootDirectory, 'open-workspaces', 'v3', 'instances');
    }

    public async write(registration: OpenWorkspaceRegistration): Promise<void> {
        const validated = validateOpenWorkspaceRegistration(registration);
        if (validated.instanceId !== this.ownInstanceId) {
            throw new Error('registration instanceId does not belong to this store');
        }
        const contents = `${JSON.stringify(validated)}\n`;
        if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) {
            throw new Error('registration exceeds the 256 KiB file limit');
        }

        await this.enqueueMutation(async () => {
            const previousSequence = this.highestSequences.get(validated.instanceId) ?? -1;
            if (validated.sequence < previousSequence) {
                throw new Error('registration sequence decreased');
            }
            await fs.promises.mkdir(this.instancesDirectory, { recursive: true, mode: 0o700 });
            const finalPath = this.instancePath(validated.instanceId);
            const temporaryPath = path.join(
                this.instancesDirectory,
                `${validated.instanceId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
            );
            try {
                await fs.promises.writeFile(temporaryPath, contents, {
                    encoding: 'utf8',
                    mode: 0o600,
                    flag: 'wx',
                });
                await fs.promises.rename(temporaryPath, finalPath);
                this.cache.set(validated.instanceId, validated);
                this.highestSequences.set(validated.instanceId, validated.sequence);
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
        });
    }

    public async remove(instanceId: string): Promise<void> {
        requireInstanceId(instanceId);
        if (instanceId !== this.ownInstanceId) {
            throw new Error('registration instanceId does not belong to this store');
        }
        await this.enqueueMutation(async () => {
            try {
                await fs.promises.unlink(this.instancePath(instanceId));
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) {
                    throw error;
                }
            }
            this.cache.delete(instanceId);
        });
    }

    public async read(instanceId: string, nowMs: number): Promise<OpenWorkspaceRegistration | undefined> {
        requireInstanceId(instanceId);
        const scan = await this.scan(nowMs);
        return scan.registrations.find(registration => registration.instanceId === instanceId);
    }

    public async scan(nowMs: number): Promise<OpenWorkspaceStoreScan> {
        const counters: OpenWorkspaceStoreScan['counters'] = {
            active: 0,
            parseErrors: 0,
            oversizedFiles: 0,
            symlinkFiles: 0,
            readErrors: 0,
            rollbackCount: 0,
            expired: 0,
        };
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this.instancesDirectory, { withFileTypes: true });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                this.reconcileCache(new Set<string>());
                return this.activeCachedRegistrations(nowMs, counters);
            }
            throw error;
        }

        const seenInstanceIds = new Set<string>();
        for (const entry of entries) {
            if (!INSTANCE_FILE_PATTERN.test(entry.name)) {
                continue;
            }
            const instanceId = entry.name.slice(0, -'.json'.length);
            seenInstanceIds.add(instanceId);
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
                counters.readErrors += 1;
                continue;
            }
            if (stats.size > MAX_FILE_BYTES) {
                counters.oversizedFiles += 1;
                continue;
            }
            try {
                const registration = validateOpenWorkspaceRegistration(
                    JSON.parse(await fs.promises.readFile(filePath, 'utf8')),
                );
                if (registration.instanceId !== instanceId) {
                    throw new Error('registration instanceId does not match file name');
                }
                const highestSequence = this.highestSequences.get(instanceId) ?? -1;
                if (registration.sequence < highestSequence) {
                    counters.rollbackCount += 1;
                    continue;
                }
                this.highestSequences.set(instanceId, registration.sequence);
                if (nowMs - registration.leaseUpdatedAtMs > OPEN_WORKSPACE_LEASE_MS) {
                    this.cache.delete(instanceId);
                    counters.expired += 1;
                    continue;
                }
                this.cache.set(instanceId, registration);
            } catch (_error) {
                counters.parseErrors += 1;
            }
        }
        this.reconcileCache(seenInstanceIds);
        return this.activeCachedRegistrations(nowMs, counters);
    }

    private activeCachedRegistrations(
        nowMs: number,
        counters: OpenWorkspaceStoreScan['counters'],
    ): OpenWorkspaceStoreScan {
        for (const [instanceId, registration] of this.cache) {
            if (nowMs - registration.leaseUpdatedAtMs > OPEN_WORKSPACE_LEASE_MS) {
                this.cache.delete(instanceId);
                counters.expired += 1;
            }
        }
        const registrations = Array.from(this.cache.values())
            .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
        counters.active = registrations.length;
        return { registrations, counters };
    }

    private instancePath(instanceId: string): string {
        return path.join(this.instancesDirectory, `${instanceId}.json`);
    }

    private reconcileCache(seenInstanceIds: Set<string>): void {
        for (const instanceId of this.cache.keys()) {
            if (!seenInstanceIds.has(instanceId)) {
                this.cache.delete(instanceId);
            }
        }
    }

    private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(mutation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}
