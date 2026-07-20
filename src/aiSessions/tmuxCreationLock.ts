'use strict';

import { createHash, randomBytes } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import type { Stats } from 'fs';
import * as path from 'path';

const LOCK_DIRECTORY = 'ai-session-tmux-locks';
const HELD_DIRECTORY = 'held';
const WAIT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const STALE_AFTER_MS = 30000;
const HEARTBEAT_INTERVAL_MS = Math.floor(STALE_AFTER_MS / 3);
const CLAIM_VERSION = 1;
const MAX_CLAIM_BYTES = 1024;

interface DirectoryIdentity {
    dev: number;
    ino: number;
    birthtimeMs: number;
    mtimeMs: number;
}

interface LockIdentity {
    container: DirectoryIdentity;
    held: DirectoryIdentity;
}

interface LockOwner extends LockIdentity {
    claimPath: string;
}

interface LockClaimRecord {
    version: 1;
    containerDev: number;
    containerIno: number;
    containerBirthtimeMs: number;
    heldDev: number;
    heldIno: number;
    heldBirthtimeMs: number;
}

export async function withTmuxCreationLock<T>(
    root: string,
    key: string,
    operation: () => Promise<T>
): Promise<T> {
    const directory = path.join(root, LOCK_DIRECTORY);
    const digest = createHash('sha256').update(key, 'utf8').digest('hex');
    const lockPath = path.join(directory, `${digest}.lock`);
    const heldPath = path.join(lockPath, HELD_DIRECTORY);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    await fs.mkdir(directory, { recursive: true });

    let owner: LockOwner | null = null;
    while (!owner) {
        const containerIdentity = await ensureCanonicalContainer(lockPath);
        if (!containerIdentity) {
            await waitForRetry(deadline, digest);
            continue;
        }

        try {
            await fs.mkdir(heldPath);
        } catch (error) {
            if (!isNodeError(error, 'EEXIST')) {
                if (isNodeError(error, 'ENOENT')) {
                    await waitForRetry(deadline, digest);
                    continue;
                }
                throw error;
            }
            await recoverStaleHeld(lockPath, heldPath, containerIdentity);
            await waitForRetry(deadline, digest);
            continue;
        }

        const heldIdentity = await readDirectoryIdentity(heldPath);
        if (heldIdentity) {
            owner = await initializeClaim(lockPath, heldPath, { container: containerIdentity, held: heldIdentity });
        }
        if (!owner) {
            await waitForRetry(deadline, digest);
        }
    }

    if (!await hasLockIdentity(lockPath, heldPath, owner)) {
        await removeOwnerClaim(lockPath, heldPath, owner);
        throw new Error(`Tmux creation lock identity changed before entry ${digest}.`);
    }

    const heartbeat = startOwnerHeartbeat(lockPath, heldPath, owner);
    try {
        return await operation();
    } finally {
        let cleanupFailure: unknown;
        try {
            await heartbeat.stop();
        } catch (error) {
            cleanupFailure = error;
        }
        try {
            await removeOwnerClaim(lockPath, heldPath, owner);
        } catch (error) {
            cleanupFailure = cleanupFailure || error;
        }
        if (cleanupFailure) {
            throw cleanupFailure;
        }
    }
}

function startOwnerHeartbeat(
    lockPath: string,
    heldPath: string,
    owner: LockOwner
): { stop: () => Promise<void> } {
    let stopped = false;
    let failure: unknown;
    let inFlight: Promise<void> = Promise.resolve();
    const heartbeat = async (): Promise<void> => {
        if (stopped || failure) {
            return;
        }
        inFlight = inFlight.then(() => renewOwnerClaim(lockPath, heldPath, owner));
        try {
            await inFlight;
        } catch (error) {
            failure = failure || error;
        }
    };
    const timer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return {
        stop: async () => {
            stopped = true;
            clearInterval(timer);
            await inFlight.catch(error => {
                failure = failure || error;
            });
            if (failure) {
                throw failure;
            }
        },
    };
}

async function renewOwnerClaim(
    lockPath: string,
    heldPath: string,
    owner: LockOwner
): Promise<void> {
    if (path.dirname(owner.claimPath) !== heldPath || !await hasLockIdentity(lockPath, heldPath, owner)) {
        throw new Error('Tmux creation lock identity changed during heartbeat.');
    }
    const claim = await readClaim(owner.claimPath);
    if (!claim || !claimMatchesIdentity(claim.record, owner)) {
        throw new Error('Tmux creation lock claim changed during heartbeat.');
    }

    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(owner.claimPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== claim.stat.dev || stat.ino !== claim.stat.ino
            || stat.birthtimeMs !== claim.stat.birthtimeMs
            || !await hasLockIdentity(lockPath, heldPath, owner)) {
            throw new Error('Tmux creation lock claim identity changed during heartbeat.');
        }
        const now = new Date();
        await handle.utimes(now, now);
    } finally {
        await handle?.close();
    }
    if (!await hasLockIdentity(lockPath, heldPath, owner)) {
        throw new Error('Tmux creation lock identity changed after heartbeat.');
    }
}

async function ensureCanonicalContainer(lockPath: string): Promise<DirectoryIdentity | null> {
    try {
        await fs.mkdir(lockPath);
    } catch (error) {
        if (!isNodeError(error, 'EEXIST')) {
            throw error;
        }
    }
    return readDirectoryIdentity(lockPath);
}

async function initializeClaim(
    lockPath: string,
    heldPath: string,
    identity: LockIdentity
): Promise<LockOwner | null> {
    if (!await hasLockIdentity(lockPath, heldPath, identity)) {
        return null;
    }

    const claimPath = path.join(heldPath, `${randomBytes(32).toString('hex')}.claim`);
    const record = createClaimRecord(identity);
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
            await removeClaimIfOwned(lockPath, heldPath, claimPath, identity);
        }
        await removeHeldIfOwned(lockPath, heldPath, identity);
        if (isNodeError(failure, 'ENOENT')) {
            return null;
        }
        throw failure;
    }
    if (!await hasLockIdentity(lockPath, heldPath, identity)) {
        await removeClaimIfOwned(lockPath, heldPath, claimPath, identity);
        return null;
    }
    return { ...identity, claimPath };
}

async function recoverStaleHeld(
    lockPath: string,
    heldPath: string,
    containerIdentity: DirectoryIdentity
): Promise<void> {
    if (!await hasDirectoryIdentity(lockPath, containerIdentity)) {
        return;
    }
    const heldIdentity = await readDirectoryIdentity(heldPath);
    if (!heldIdentity) {
        return;
    }
    const identity: LockIdentity = { container: containerIdentity, held: heldIdentity };
    if (!await hasLockIdentity(lockPath, heldPath, identity)) {
        return;
    }

    let names: string[];
    try {
        names = await fs.readdir(heldPath);
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return;
        }
        throw error;
    }
    if (!await hasLockIdentity(lockPath, heldPath, identity)) {
        return;
    }

    if (names.length === 0) {
        if (Date.now() - heldIdentity.mtimeMs > STALE_AFTER_MS) {
            await removeHeldIfOwned(lockPath, heldPath, identity);
        }
        return;
    }

    const staleClaims: string[] = [];
    for (const name of names) {
        if (!isClaimName(name)) {
            return;
        }
        const claimPath = path.join(heldPath, name);
        const claim = await readClaim(claimPath);
        if (!claim || !claimMatchesIdentity(claim.record, identity)
            || Date.now() - claim.stat.mtimeMs <= STALE_AFTER_MS) {
            return;
        }
        staleClaims.push(claimPath);
    }

    for (const claimPath of staleClaims) {
        await removeClaimIfOwned(lockPath, heldPath, claimPath, identity);
    }
    await removeHeldIfOwned(lockPath, heldPath, identity);
}

async function readClaim(claimPath: string): Promise<{ record: LockClaimRecord; stat: Stats } | null> {
    try {
        const stat = await fs.lstat(claimPath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CLAIM_BYTES) {
            return null;
        }
        const value = JSON.parse(await fs.readFile(claimPath, 'utf8')) as Record<string, unknown>;
        if (value.version !== CLAIM_VERSION
            || !isFiniteNonNegative(value.containerDev) || !isFiniteNonNegative(value.containerIno)
            || !isFiniteNonNegative(value.containerBirthtimeMs) || !isFiniteNonNegative(value.heldDev)
            || !isFiniteNonNegative(value.heldIno) || !isFiniteNonNegative(value.heldBirthtimeMs)) {
            return null;
        }
        return {
            record: {
                version: CLAIM_VERSION,
                containerDev: value.containerDev,
                containerIno: value.containerIno,
                containerBirthtimeMs: value.containerBirthtimeMs,
                heldDev: value.heldDev,
                heldIno: value.heldIno,
                heldBirthtimeMs: value.heldBirthtimeMs,
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

async function removeOwnerClaim(lockPath: string, heldPath: string, owner: LockOwner): Promise<void> {
    let failure: unknown;
    try {
        await removeClaimIfOwned(lockPath, heldPath, owner.claimPath, owner);
    } catch (error) {
        failure = error;
    }
    try {
        await removeHeldIfOwned(lockPath, heldPath, owner);
    } catch (error) {
        failure = failure || error;
    }
    if (failure) {
        throw failure;
    }
}

async function removeClaimIfOwned(
    lockPath: string,
    heldPath: string,
    claimPath: string,
    identity: LockIdentity
): Promise<void> {
    if (path.dirname(claimPath) !== heldPath || !await hasLockIdentity(lockPath, heldPath, identity)) {
        return;
    }
    try {
        await fs.unlink(claimPath);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
}

async function removeHeldIfOwned(
    lockPath: string,
    heldPath: string,
    identity: LockIdentity
): Promise<void> {
    if (!await hasLockIdentity(lockPath, heldPath, identity)) {
        return;
    }
    try {
        await fs.rmdir(heldPath);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY') && !isNodeError(error, 'EEXIST')) {
            throw error;
        }
    }
}

async function readDirectoryIdentity(directory: string): Promise<DirectoryIdentity | null> {
    try {
        const stat = await fs.lstat(directory);
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

async function hasDirectoryIdentity(directory: string, identity: DirectoryIdentity): Promise<boolean> {
    const current = await readDirectoryIdentity(directory);
    return !!current && current.dev === identity.dev && current.ino === identity.ino
        && current.birthtimeMs === identity.birthtimeMs;
}

async function hasLockIdentity(lockPath: string, heldPath: string, identity: LockIdentity): Promise<boolean> {
    return await hasDirectoryIdentity(lockPath, identity.container)
        && await hasDirectoryIdentity(heldPath, identity.held);
}

function createClaimRecord(identity: LockIdentity): LockClaimRecord {
    return {
        version: CLAIM_VERSION,
        containerDev: identity.container.dev,
        containerIno: identity.container.ino,
        containerBirthtimeMs: identity.container.birthtimeMs,
        heldDev: identity.held.dev,
        heldIno: identity.held.ino,
        heldBirthtimeMs: identity.held.birthtimeMs,
    };
}

function claimMatchesIdentity(record: LockClaimRecord, identity: LockIdentity): boolean {
    return record.containerDev === identity.container.dev
        && record.containerIno === identity.container.ino
        && record.containerBirthtimeMs === identity.container.birthtimeMs
        && record.heldDev === identity.held.dev
        && record.heldIno === identity.held.ino
        && record.heldBirthtimeMs === identity.held.birthtimeMs;
}

async function waitForRetry(deadline: number, digest: string): Promise<void> {
    if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for tmux creation lock ${digest}.`);
    }
    await delay(POLL_INTERVAL_MS);
}

function isClaimName(name: string): boolean {
    return /^[0-9a-f]{64}\.claim$/.test(name);
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
