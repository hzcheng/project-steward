'use strict';

import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import type { Stats } from 'fs';
import * as path from 'path';

const LOCK_DIRECTORY = 'ai-session-tmux-locks';
const WAIT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const STALE_AFTER_MS = 30000;
const CLAIM_VERSION = 1;
const MAX_CLAIM_BYTES = 1024;

interface LockDirectoryIdentity {
    dev: number;
    ino: number;
    birthtimeMs: number;
    mtimeMs: number;
}

interface LockOwner {
    claimPath: string;
    directoryIdentity: LockDirectoryIdentity;
}

interface LockClaimRecord {
    version: 1;
    dev: number;
    ino: number;
    birthtimeMs: number;
}

export async function withTmuxCreationLock<T>(
    root: string,
    key: string,
    operation: () => Promise<T>
): Promise<T> {
    const directory = path.join(root, LOCK_DIRECTORY);
    const digest = createHash('sha256').update(key, 'utf8').digest('hex');
    const lockPath = path.join(directory, `${digest}.lock`);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    await fs.mkdir(directory, { recursive: true });

    let owner: LockOwner | null = null;
    while (!owner) {
        try {
            await fs.mkdir(lockPath);
        } catch (error) {
            if (!isNodeError(error, 'EEXIST')) {
                throw error;
            }
            await recoverStaleLock(directory, lockPath, digest);
            await waitForRetry(deadline, digest);
            continue;
        }

        const directoryIdentity = await readDirectoryIdentity(lockPath);
        if (directoryIdentity) {
            owner = await initializeClaim(directory, lockPath, digest, directoryIdentity);
        }
        if (!owner) {
            await waitForRetry(deadline, digest);
        }
    }

    if (!await hasDirectoryIdentity(lockPath, owner.directoryIdentity)) {
        await removeOwnerClaim(directory, lockPath, owner);
        throw new Error(`Tmux creation lock identity changed before entry ${digest}.`);
    }

    try {
        return await operation();
    } finally {
        await removeOwnerClaim(directory, lockPath, owner);
    }
}

async function initializeClaim(
    directory: string,
    lockPath: string,
    digest: string,
    directoryIdentity: LockDirectoryIdentity
): Promise<LockOwner | null> {
    if (!await hasDirectoryIdentity(lockPath, directoryIdentity)) {
        return null;
    }

    const token = randomBytes(32).toString('hex');
    const claimPath = path.join(directory, `${digest}.${token}.claim`);
    const record: LockClaimRecord = {
        version: CLAIM_VERSION,
        dev: directoryIdentity.dev,
        ino: directoryIdentity.ino,
        birthtimeMs: directoryIdentity.birthtimeMs,
    };
    let handle: fs.FileHandle | undefined;
    let failure: unknown;
    let claimCreated = false;
    try {
        handle = await fs.open(claimPath, 'wx');
        claimCreated = true;
        await handle.writeFile(JSON.stringify(record), { encoding: 'utf8' });
        await handle.sync();
    } catch (error) {
        failure = error;
    }
    if (handle) {
        try {
            await handle.close();
        } catch (error) {
            failure = failure || error;
        }
    }
    if (failure) {
        if (claimCreated) {
            await removeExactFile(claimPath);
        }
        await removeOwnedDirectory(directory, lockPath, directoryIdentity);
        throw failure;
    }
    if (!await hasDirectoryIdentity(lockPath, directoryIdentity)) {
        await removeExactFile(claimPath);
        return null;
    }
    return { claimPath, directoryIdentity };
}

async function recoverStaleLock(directory: string, lockPath: string, digest: string): Promise<void> {
    const directoryIdentity = await readDirectoryIdentity(lockPath);
    if (!directoryIdentity) {
        return;
    }

    let names: string[];
    try {
        names = await fs.readdir(directory);
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return;
        }
        throw error;
    }
    if (!await hasDirectoryIdentity(lockPath, directoryIdentity)) {
        return;
    }

    const staleClaimPaths: string[] = [];
    let foundMatchingClaim = false;
    let foundFreshOrMalformedClaim = false;
    for (const name of names) {
        if (!isClaimName(name, digest)) {
            continue;
        }
        const claimPath = path.join(directory, name);
        const claim = await readClaim(claimPath);
        if (!claim) {
            foundFreshOrMalformedClaim = true;
            continue;
        }
        if (!claimMatchesDirectory(claim.record, directoryIdentity)) {
            continue;
        }
        foundMatchingClaim = true;
        if (Date.now() - claim.stat.mtimeMs > STALE_AFTER_MS) {
            staleClaimPaths.push(claimPath);
        } else {
            foundFreshOrMalformedClaim = true;
        }
    }

    if (foundFreshOrMalformedClaim) {
        return;
    }
    if (!foundMatchingClaim && Date.now() - directoryIdentity.mtimeMs <= STALE_AFTER_MS) {
        return;
    }
    const quarantinePath = await quarantineOwnedDirectory(directory, lockPath, directoryIdentity);
    if (!quarantinePath) {
        return;
    }
    for (const claimPath of staleClaimPaths) {
        await removeExactFile(claimPath);
    }
    await removeEmptyDirectory(quarantinePath);
}

async function readClaim(claimPath: string): Promise<{ record: LockClaimRecord; stat: Stats } | null> {
    try {
        const stat = await fs.lstat(claimPath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CLAIM_BYTES) {
            return null;
        }
        const value = JSON.parse(await fs.readFile(claimPath, 'utf8')) as Record<string, unknown>;
        if (value.version !== CLAIM_VERSION || !isFiniteNonNegative(value.dev)
            || !isFiniteNonNegative(value.ino) || !isFiniteNonNegative(value.birthtimeMs)) {
            return null;
        }
        return {
            record: {
                version: CLAIM_VERSION,
                dev: value.dev,
                ino: value.ino,
                birthtimeMs: value.birthtimeMs,
            },
            stat,
        };
    } catch (error) {
        if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) {
            return null;
        }
        throw error;
    }
}

async function removeOwnerClaim(directory: string, lockPath: string, owner: LockOwner): Promise<void> {
    let failure: unknown;
    if (path.dirname(owner.claimPath) !== directory) {
        return;
    }
    try {
        await removeExactFile(owner.claimPath);
    } catch (error) {
        failure = error;
    }
    try {
        await removeOwnedDirectory(directory, lockPath, owner.directoryIdentity);
    } catch (error) {
        failure = failure || error;
    }
    if (failure) {
        throw failure;
    }
}

async function removeOwnedDirectory(
    directory: string,
    lockPath: string,
    identity: LockDirectoryIdentity
): Promise<void> {
    const quarantinePath = await quarantineOwnedDirectory(directory, lockPath, identity);
    if (quarantinePath) {
        await removeEmptyDirectory(quarantinePath);
    }
}

async function quarantineOwnedDirectory(
    directory: string,
    lockPath: string,
    identity: LockDirectoryIdentity
): Promise<string | null> {
    if (!await hasDirectoryIdentity(lockPath, identity)) {
        return null;
    }
    const quarantinePath = path.join(
        directory,
        `.${path.basename(lockPath)}.${randomBytes(32).toString('hex')}.quarantine`
    );
    try {
        await fs.rename(lockPath, quarantinePath);
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return null;
        }
        throw error;
    }
    if (await hasDirectoryIdentity(quarantinePath, identity)) {
        return quarantinePath;
    }
    try {
        await fs.rename(quarantinePath, lockPath);
    } catch (error) {
        if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) {
            throw error;
        }
    }
    return null;
}

async function removeEmptyDirectory(directory: string): Promise<void> {
    try {
        await fs.rmdir(directory);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY') && !isNodeError(error, 'EEXIST')) {
            throw error;
        }
    }
}

async function readDirectoryIdentity(lockPath: string): Promise<LockDirectoryIdentity | null> {
    try {
        const stat = await fs.lstat(lockPath);
        return stat.isDirectory()
            ? { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs }
            : null;
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return null;
        }
        throw error;
    }
}

async function hasDirectoryIdentity(lockPath: string, identity: LockDirectoryIdentity): Promise<boolean> {
    const current = await readDirectoryIdentity(lockPath);
    return !!current && current.dev === identity.dev && current.ino === identity.ino
        && current.birthtimeMs === identity.birthtimeMs;
}

async function removeExactFile(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
}

async function waitForRetry(deadline: number, digest: string): Promise<void> {
    if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for tmux creation lock ${digest}.`);
    }
    await delay(POLL_INTERVAL_MS);
}

function isClaimName(name: string, digest: string): boolean {
    return name.length === digest.length + 1 + 64 + '.claim'.length
        && name.startsWith(`${digest}.`) && /^[0-9a-f]{64}\.claim$/.test(name.slice(digest.length + 1));
}

function claimMatchesDirectory(record: LockClaimRecord, identity: LockDirectoryIdentity): boolean {
    return record.dev === identity.dev && record.ino === identity.ino
        && record.birthtimeMs === identity.birthtimeMs;
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}
