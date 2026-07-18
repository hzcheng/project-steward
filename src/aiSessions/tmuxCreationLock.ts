'use strict';

import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

const LOCK_DIRECTORY = 'ai-session-tmux-locks';
const WAIT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const STALE_AFTER_MS = 30000;
const CLAIM_SUFFIX = '.claim';

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

    let claimPath: string | null = null;
    while (!claimPath) {
        try {
            await fs.mkdir(lockPath);
        } catch (error) {
            if (!isNodeError(error, 'EEXIST')) {
                throw error;
            }
            await recoverStaleLock(lockPath);
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for tmux creation lock ${digest}.`);
            }
            await delay(POLL_INTERVAL_MS);
            continue;
        }
        claimPath = await initializeClaim(lockPath);
    }

    try {
        return await operation();
    } finally {
        await removeOwnerClaim(lockPath, claimPath);
    }
}

async function initializeClaim(lockPath: string): Promise<string> {
    const claimPath = path.join(lockPath, `${randomBytes(32).toString('hex')}${CLAIM_SUFFIX}`);
    let handle: fs.FileHandle | undefined;
    let failure: unknown;
    let claimCreated = false;
    try {
        handle = await fs.open(claimPath, 'wx');
        claimCreated = true;
        await handle.writeFile(path.basename(claimPath), { encoding: 'utf8' });
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
        await removeEmptyDirectory(lockPath);
        throw failure;
    }
    return claimPath;
}

async function recoverStaleLock(lockPath: string): Promise<void> {
    let names: string[];
    try {
        names = await fs.readdir(lockPath);
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return;
        }
        throw error;
    }

    if (names.length === 0) {
        try {
            const stat = await fs.stat(lockPath);
            if (stat.isDirectory() && Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
                await removeEmptyDirectory(lockPath);
            }
        } catch (error) {
            if (!isNodeError(error, 'ENOENT')) {
                throw error;
            }
        }
        return;
    }

    for (const name of names) {
        if (!isClaimName(name)) {
            continue;
        }
        const claimPath = path.join(lockPath, name);
        try {
            const stat = await fs.lstat(claimPath);
            if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
                await removeExactFile(claimPath);
            }
        } catch (error) {
            if (!isNodeError(error, 'ENOENT')) {
                throw error;
            }
        }
    }
    await removeEmptyDirectory(lockPath);
}

async function removeOwnerClaim(lockPath: string, claimPath: string): Promise<void> {
    let failure: unknown;
    try {
        await removeExactFile(claimPath);
    } catch (error) {
        failure = error;
    }
    try {
        await removeEmptyDirectory(lockPath);
    } catch (error) {
        failure = failure || error;
    }
    if (failure) {
        throw failure;
    }
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

async function removeEmptyDirectory(directory: string): Promise<void> {
    try {
        await fs.rmdir(directory);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY') && !isNodeError(error, 'EEXIST')) {
            throw error;
        }
    }
}

function isClaimName(name: string): boolean {
    return /^[0-9a-f]{64}\.claim$/.test(name);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}
