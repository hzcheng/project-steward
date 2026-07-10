'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const PIN_DIRECTORY_NAME = 'pinned-ai-sessions';
const PIN_FILE_SUFFIX = '.pin';
const LEGACY_MIGRATION_MARKER = '.legacy-global-state-migrated';

export default class AiSessionPinStore {
    private readonly pinDirectoryPath: string;

    constructor(globalStoragePath: string) {
        this.pinDirectoryPath = path.join(globalStoragePath, PIN_DIRECTORY_NAME);
    }

    getAll(): Set<string> {
        if (!fs.existsSync(this.pinDirectoryPath)) {
            return new Set<string>();
        }

        let pinnedSessions = new Set<string>();
        for (let fileName of fs.readdirSync(this.pinDirectoryPath)) {
            if (!fileName.endsWith(PIN_FILE_SUFFIX)) {
                continue;
            }

            try {
                let sessionKey = fs.readFileSync(path.join(this.pinDirectoryPath, fileName), 'utf8').trim();
                if (sessionKey) {
                    pinnedSessions.add(sessionKey);
                }
            } catch (error) {
                if (!this.isFileNotFoundError(error)) {
                    throw error;
                }
            }
        }

        return pinnedSessions;
    }

    has(sessionKey: string): boolean {
        return Boolean(sessionKey) && fs.existsSync(this.getPinPath(sessionKey));
    }

    add(sessionKey: string) {
        if (!sessionKey) {
            return;
        }

        this.ensurePinDirectory();
        try {
            fs.writeFileSync(this.getPinPath(sessionKey), sessionKey, { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
            if (!this.isFileExistsError(error)) {
                throw error;
            }
        }
    }

    remove(sessionKey: string) {
        if (!sessionKey) {
            return;
        }

        try {
            fs.unlinkSync(this.getPinPath(sessionKey));
        } catch (error) {
            if (!this.isFileNotFoundError(error)) {
                throw error;
            }
        }
    }

    toggle(sessionKey: string): boolean {
        if (this.has(sessionKey)) {
            this.remove(sessionKey);
            return false;
        }

        this.add(sessionKey);
        return true;
    }

    migrateLegacy(sessionKeys: string[]) {
        this.ensurePinDirectory();
        let markerPath = path.join(this.pinDirectoryPath, LEGACY_MIGRATION_MARKER);
        if (fs.existsSync(markerPath)) {
            return;
        }

        for (let sessionKey of Array.isArray(sessionKeys) ? sessionKeys : []) {
            this.add(sessionKey);
        }

        try {
            fs.writeFileSync(markerPath, '1', { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
            if (!this.isFileExistsError(error)) {
                throw error;
            }
        }
    }

    private ensurePinDirectory() {
        fs.mkdirSync(this.pinDirectoryPath, { recursive: true });
    }

    private getPinPath(sessionKey: string): string {
        let digest = crypto.createHash('sha256').update(sessionKey).digest('hex');
        return path.join(this.pinDirectoryPath, `${digest}${PIN_FILE_SUFFIX}`);
    }

    private isFileExistsError(error: unknown): boolean {
        return Boolean(error && (error as NodeJS.ErrnoException).code === 'EEXIST');
    }

    private isFileNotFoundError(error: unknown): boolean {
        return Boolean(error && (error as NodeJS.ErrnoException).code === 'ENOENT');
    }
}
