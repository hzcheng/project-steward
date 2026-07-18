'use strict';

import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

const LOCK_DIRECTORY = 'ai-session-tmux-locks';
const WAIT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const STALE_AFTER_MS = 30000;

export async function withTmuxCreationLock<T>(
    root: string,
    key: string,
    operation: () => Promise<T>
): Promise<T> {
    const directory = path.join(root, LOCK_DIRECTORY);
    const digest = createHash('sha256').update(key, 'utf8').digest('hex');
    const lockPath = path.join(directory, `${digest}.lock`);
    const token = randomBytes(32).toString('hex');
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    await fs.mkdir(directory, { recursive: true });

    while (true) {
        try {
            const handle = await fs.open(lockPath, 'wx');
            try {
                await handle.writeFile(token, { encoding: 'utf8' });
                await handle.sync();
            } finally {
                await handle.close();
            }
            break;
        } catch (error) {
            if (!isNodeError(error, 'EEXIST')) {
                throw error;
            }
            await removeStaleLock(lockPath);
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for tmux creation lock ${digest}.`);
            }
            await delay(POLL_INTERVAL_MS);
        }
    }

    try {
        return await operation();
    } finally {
        await removeOwnedLock(lockPath, token);
    }
}

async function removeStaleLock(lockPath: string): Promise<void> {
    try {
        const stat = await fs.lstat(lockPath);
        if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
            await fs.unlink(lockPath);
        }
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
    try {
        const stat = await fs.lstat(lockPath);
        if (!stat.isFile()) {
            return;
        }
        const storedToken = await fs.readFile(lockPath, 'utf8');
        if (storedToken === token) {
            await fs.unlink(lockPath);
        }
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}
