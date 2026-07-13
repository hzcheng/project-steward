'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexSession } from '../models';
import { filterAiSessionsByCandidatePaths, normalizeAiSessionCandidatePaths } from '../aiSessions/sessionHelpers';
import type { AiSessionQueryOptions } from '../aiSessions/types';

interface CodexSessionIndexEntry {
    id?: string;
    thread_name?: string;
    updated_at?: string;
}

interface CodexSessionMeta {
    id?: string;
    session_id?: string;
    cwd?: string;
    timestamp?: string;
    isSubagent?: boolean;
}

export interface CodexSessionReadResult {
    available: boolean;
    sessions: CodexSession[];
}

export interface Disposable {
    dispose(): void;
}

export default class CodexSessionService {
    private cachedResult: CodexSessionReadResult = null;
    private cachedAt = 0;
    private readonly cacheTtlMs = 5000;
    private readonly changePollIntervalMs = 3000;

    getSessions(options: boolean | AiSessionQueryOptions = false): CodexSessionReadResult {
        let { forceRefresh, candidatePaths } = this.getQueryOptions(options);
        let now = Date.now();
        if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
            return this.filterResult(this.cachedResult, candidatePaths);
        }

        let codexHome = this.getCodexHome();
        if (!codexHome) {
            return this.filterResult(this.cacheResult({ available: false, sessions: [] }), candidatePaths);
        }

        let indexPath = path.join(codexHome, 'session_index.jsonl');
        let hasIndex = fs.existsSync(indexPath);
        let sessionFiles = this.getSessionFiles(codexHome);
        if (!hasIndex && !sessionFiles.size) {
            return this.filterResult(this.cacheResult({ available: false, sessions: [] }), candidatePaths);
        }

        let entries = hasIndex ? this.readSessionIndex(indexPath) : [];
        let sessionsById = new Map<string, CodexSession>();
        for (let entry of entries) {
            if (!entry.id || !sessionFiles.has(entry.id)) {
                continue;
            }

            let meta = this.readSessionMeta(entry.id, sessionFiles);
            if (meta?.isSubagent) {
                continue;
            }

            let previous = sessionsById.get(entry.id);
            let session: CodexSession = {
                id: entry.id,
                name: entry.thread_name || previous?.name || entry.id,
                updatedAt: entry.updated_at || meta?.timestamp || previous?.updatedAt,
                cwd: meta?.cwd,
            };

            if (!previous || this.compareUpdatedAt(session.updatedAt, previous.updatedAt) > 0) {
                sessionsById.set(session.id, session);
            }
        }

        this.addSessionsFromFiles(sessionsById, sessionFiles);

        let sessions = Array.from(sessionsById.values())
            .sort((a, b) => this.compareUpdatedAt(b.updatedAt, a.updatedAt));

        return this.filterResult(this.cacheResult({ available: true, sessions }), candidatePaths);
    }

    archiveSession(sessionId: string): boolean {
        if (!sessionId) {
            return false;
        }

        let codexHome = this.getCodexHome();
        if (!codexHome) {
            return false;
        }

        let sessionFile = this.getSessionFiles(codexHome).get(sessionId);
        if (!sessionFile) {
            return false;
        }

        try {
            let archivePath = path.join(codexHome, 'archived_sessions');
            fs.mkdirSync(archivePath, { recursive: true });
            fs.renameSync(sessionFile, this.getAvailableArchivePath(archivePath, path.basename(sessionFile)));
            this.invalidateCache();
            return true;
        } catch (e) {
            return false;
        }
    }

    invalidateCache() {
        this.cachedResult = null;
        this.cachedAt = 0;
    }

    watchSessionChanges(onDidChange: () => void): Disposable {
        let previousFingerprint = this.getSessionFingerprint();
        let interval = setInterval(() => {
            let nextFingerprint = this.getSessionFingerprint();
            if (nextFingerprint === previousFingerprint) {
                return;
            }

            previousFingerprint = nextFingerprint;
            this.invalidateCache();
            onDidChange();
        }, this.changePollIntervalMs);

        return {
            dispose: () => clearInterval(interval),
        };
    }

    private cacheResult(result: CodexSessionReadResult): CodexSessionReadResult {
        this.cachedResult = result;
        this.cachedAt = Date.now();

        return result;
    }

    private getQueryOptions(options: boolean | AiSessionQueryOptions): { forceRefresh: boolean; candidatePaths: string[] } {
        if (typeof options === 'boolean') {
            return { forceRefresh: options, candidatePaths: [] };
        }

        return {
            forceRefresh: Boolean(options?.forceRefresh),
            candidatePaths: normalizeAiSessionCandidatePaths(options?.candidatePaths || []),
        };
    }

    private filterResult(result: CodexSessionReadResult, candidatePaths: string[]): CodexSessionReadResult {
        return filterAiSessionsByCandidatePaths(result, candidatePaths, session => session.cwd);
    }

    private getAvailableArchivePath(archivePath: string, fileName: string): string {
        let parsed = path.parse(fileName);
        let destination = path.join(archivePath, fileName);
        let index = 1;

        while (fs.existsSync(destination)) {
            destination = path.join(archivePath, `${parsed.name}-${index}${parsed.ext}`);
            index++;
        }

        return destination;
    }

    private getCodexHome(): string {
        let configuredHome = process.env.CODEX_HOME;
        if (configuredHome && fs.existsSync(configuredHome)) {
            return configuredHome;
        }

        let defaultHome = path.join(os.homedir(), '.codex');
        return fs.existsSync(defaultHome) ? defaultHome : null;
    }

    private getSessionFingerprint(): string {
        let codexHome = this.getCodexHome();
        if (!codexHome) {
            return 'missing';
        }

        let indexPath = path.join(codexHome, 'session_index.jsonl');
        return [
            codexHome,
            this.getFileSignature(indexPath),
            this.getSessionFilesSignature(codexHome),
        ].join('|');
    }

    private getFileSignature(filePath: string): string {
        try {
            let stat = fs.statSync(filePath);
            return `${filePath}:${stat.size}:${stat.mtimeMs}`;
        } catch (e) {
            return `${filePath}:missing`;
        }
    }

    private getSessionFilesSignature(codexHome: string): string {
        let sessionFiles = this.getSessionFiles(codexHome);
        return Array.from(sessionFiles.entries())
            .map(([sessionId, filePath]) => `${sessionId}:${filePath}:${this.getFileSignature(filePath)}`)
            .sort()
            .join(',');
    }

    private readSessionIndex(indexPath: string): CodexSessionIndexEntry[] {
        try {
            let lines = fs.readFileSync(indexPath, 'utf8')
                .split(/\r?\n/g)
                .map(line => line.trim())
                .filter(line => line.length);

            let entries: CodexSessionIndexEntry[] = [];
            for (let line of lines) {
                try {
                    let entry = JSON.parse(line) as CodexSessionIndexEntry;
                    if (entry.id) {
                        entries.push(entry);
                    }
                } catch (e) {
                    // Keep reading the rest of the index if one line is corrupt.
                }
            }

            return entries;
        } catch (e) {
            return [];
        }
    }

    private getSessionFiles(codexHome: string): Map<string, string> {
        let files = new Map<string, string>();
        this.addSessionFiles(path.join(codexHome, 'sessions'), files, true);

        return files;
    }

    private addSessionFiles(sessionPath: string, files: Map<string, string>, recursive: boolean) {
        if (!fs.existsSync(sessionPath)) {
            return;
        }

        try {
            for (let entry of fs.readdirSync(sessionPath, { withFileTypes: true })) {
                let entryPath = path.join(sessionPath, entry.name);
                if (recursive && entry.isDirectory()) {
                    this.addSessionFiles(entryPath, files, recursive);
                    continue;
                }

                if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                    continue;
                }

                let id = this.getSessionIdFromFileName(entry.name);
                if (id) {
                    files.set(id, entryPath);
                }
            }
        } catch (e) {
            return;
        }
    }

    private getSessionIdFromFileName(fileName: string): string {
        let match = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return match ? match[0] : null;
    }

    private addSessionsFromFiles(sessionsById: Map<string, CodexSession>, sessionFiles: Map<string, string>) {
        for (let [sessionId] of sessionFiles) {
            let meta = this.readSessionMeta(sessionId, sessionFiles);
            if (!meta || meta.isSubagent) {
                continue;
            }

            let previous = sessionsById.get(sessionId);
            sessionsById.set(sessionId, {
                id: sessionId,
                name: previous?.name || sessionId,
                updatedAt: previous?.updatedAt || meta.timestamp,
                cwd: previous?.cwd || meta.cwd,
            });
        }
    }

    private isExplicitSubagentSource(source: unknown): boolean {
        return Boolean(
            source
            && typeof source === 'object'
            && Object.prototype.hasOwnProperty.call(source, 'subagent')
        );
    }

    private readSessionMeta(sessionId: string, sessionFiles: Map<string, string>): CodexSessionMeta {
        let sessionFile = sessionFiles.get(sessionId);
        if (!sessionFile) {
            return null;
        }

        let firstLine = this.readFirstLine(sessionFile);
        if (!firstLine) {
            return null;
        }

        try {
            let event = JSON.parse(firstLine);
            if (event?.type !== 'session_meta') {
                return null;
            }

            let payload = event.payload || {};
            return {
                id: payload.id,
                session_id: payload.session_id,
                cwd: payload.cwd,
                timestamp: payload.timestamp || event.timestamp,
                isSubagent: this.isExplicitSubagentSource(payload.source),
            };
        } catch (e) {
            return null;
        }
    }

    private readFirstLine(filePath: string): string {
        let fd: number = null;
        try {
            fd = fs.openSync(filePath, 'r');
            let chunks: Buffer[] = [];
            let buffer = Buffer.alloc(4096);
            let bytesRead = 0;

            do {
                bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
                if (bytesRead <= 0) {
                    break;
                }

                let chunk = buffer.slice(0, bytesRead);
                let newlineIndex = chunk.indexOf(10);
                if (newlineIndex !== -1) {
                    chunks.push(chunk.slice(0, newlineIndex));
                    break;
                }

                chunks.push(Buffer.from(chunk));
            } while (bytesRead === buffer.length);

            return Buffer.concat(chunks).toString('utf8').trim();
        } catch (e) {
            return null;
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (e) {
                    // Ignore close failures for best-effort metadata reads.
                }
            }
        }
    }

    private compareUpdatedAt(a: string, b: string): number {
        let aTime = a ? Date.parse(a) : 0;
        let bTime = b ? Date.parse(b) : 0;

        if (isNaN(aTime) && isNaN(bTime)) {
            return 0;
        }

        if (isNaN(aTime)) {
            return -1;
        }

        if (isNaN(bTime)) {
            return 1;
        }

        return aTime - bTime;
    }
}
