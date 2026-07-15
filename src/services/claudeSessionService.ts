'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexSession } from '../models';
import { filterAiSessionsByCandidatePaths, normalizeAiSessionCandidatePaths } from '../aiSessions/sessionHelpers';
import type { AiSessionQueryOptions } from '../aiSessions/types';
import { parseClaudeLifecycleLines, AiSessionLifecycleRequest, AiSessionLifecycleSignal } from '../aiSessions/lifecycle';
import { readJsonlTailLines } from '../aiSessions/jsonlTail';
import { Disposable } from './codexSessionService';

interface ClaudeSessionEvent {
    sessionId?: string;
    cwd?: string;
    timestamp?: string;
    type?: string;
    customTitle?: string;
    aiTitle?: string;
    lastPrompt?: string;
    message?: {
        role?: string;
        content?: string | { type?: string; text?: string }[];
    };
}

export interface ClaudeSessionReadResult {
    available: boolean;
    sessions: CodexSession[];
}

export default class ClaudeSessionService {
    private cachedResult: ClaudeSessionReadResult = null;
    private cachedAt = 0;
    private sessionCache = new Map<string, { signature: string; session: CodexSession }>();
    private readonly sessionFilesById = new Map<string, string>();
    private readonly cacheTtlMs = 5000;
    private readonly changePollIntervalMs = 3000;
    private readonly cwdScanChunkBytes = 64 * 1024;
    private readonly sessionSampleBytes = 128 * 1024;

    getSessions(options: boolean | AiSessionQueryOptions = false): ClaudeSessionReadResult {
        let { forceRefresh, candidatePaths } = this.getQueryOptions(options);
        let now = Date.now();
        if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
            return this.filterResult(this.cachedResult, candidatePaths);
        }

        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return this.filterResult(this.cacheResult({ available: false, sessions: [] }), candidatePaths);
        }

        let projectRoot = path.join(claudeHome, 'projects');
        let sessionFiles = this.getSessionFiles(projectRoot);
        if (!sessionFiles.length) {
            return this.filterResult(this.cacheResult({ available: false, sessions: [] }), candidatePaths);
        }

        let sessions = sessionFiles
            .map(sessionFile => this.readSession(sessionFile))
            .filter(session => !!session)
            .sort((a, b) => this.compareUpdatedAt(b.updatedAt, a.updatedAt));

        return this.filterResult(this.cacheResult({ available: true, sessions }), candidatePaths);
    }

    getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal> {
        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return {};
        }
        let projectRoot = path.join(claudeHome, 'projects');
        let signals: Record<string, AiSessionLifecycleSignal> = {};
        let discovered = false;
        for (let request of requests || []) {
            if (!request?.sessionId || !Number.isFinite(request.runStartedAtMs) || signals[request.sessionId]) {
                continue;
            }
            let sessionFile = this.sessionFilesById.get(request.sessionId);
            if (sessionFile && !fs.existsSync(sessionFile)) {
                this.sessionFilesById.delete(request.sessionId);
                sessionFile = null;
            }
            if (!sessionFile && !discovered) {
                this.getSessionFiles(projectRoot);
                discovered = true;
                sessionFile = this.sessionFilesById.get(request.sessionId);
            }
            if (!sessionFile) {
                continue;
            }
            let signal = parseClaudeLifecycleLines(readJsonlTailLines(sessionFile), request.runStartedAtMs);
            if (signal) {
                signals[request.sessionId] = signal;
            }
        }
        return signals;
    }

    archiveSession(sessionId: string): boolean {
        if (!sessionId || !this.isSessionId(sessionId)) {
            return false;
        }

        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return false;
        }

        let sessionFile = this.findSessionFile(path.join(claudeHome, 'projects'), sessionId);
        if (!sessionFile) {
            return false;
        }

        try {
            let projectDirName = path.basename(path.dirname(sessionFile));
            let archivePath = path.join(claudeHome, 'archived_projects', projectDirName);
            fs.mkdirSync(archivePath, { recursive: true });
            fs.renameSync(sessionFile, this.getAvailableArchivePath(archivePath, path.basename(sessionFile)));
            this.sessionFilesById.delete(sessionId);
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

    private cacheResult(result: ClaudeSessionReadResult): ClaudeSessionReadResult {
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

    private filterResult(result: ClaudeSessionReadResult, candidatePaths: string[]): ClaudeSessionReadResult {
        return filterAiSessionsByCandidatePaths(result, candidatePaths, session => session.workDir || session.cwd);
    }

    private getClaudeHome(): string {
        let configuredHome = process.env.CLAUDE_HOME;
        if (configuredHome && fs.existsSync(configuredHome)) {
            return configuredHome;
        }

        let defaultHome = path.join(os.homedir(), '.claude');
        return fs.existsSync(defaultHome) ? defaultHome : null;
    }

    private getSessionFiles(projectRoot: string): string[] {
        if (!fs.existsSync(projectRoot)) {
            return [];
        }

        let files: string[] = [];
        try {
            for (let projectEntry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
                if (!projectEntry.isDirectory()) {
                    continue;
                }

                let projectPath = path.join(projectRoot, projectEntry.name);
                for (let sessionEntry of fs.readdirSync(projectPath, { withFileTypes: true })) {
                    if (sessionEntry.isFile() && sessionEntry.name.endsWith('.jsonl') && this.isSessionId(sessionEntry.name)) {
                        files.push(path.join(projectPath, sessionEntry.name));
                    }
                }
            }
        } catch (e) {
            return [];
        }

        for (let filePath of files) {
            let sessionId = this.getSessionIdFromFileName(path.basename(filePath));
            if (sessionId) {
                this.sessionFilesById.set(sessionId, filePath);
            }
        }

        return files;
    }

    private findSessionFile(projectRoot: string, sessionId: string): string {
        let cached = this.sessionFilesById.get(sessionId);
        if (cached && fs.existsSync(cached)) {
            return cached;
        }
        let fileName = `${sessionId}.jsonl`;
        return this.getSessionFiles(projectRoot).find(filePath => path.basename(filePath) === fileName) || null;
    }

    private readSession(sessionFile: string): CodexSession {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(sessionFile);
            if (stat.size === 0) {
                return null;
            }
        } catch (e) {
            return null;
        }

        let cacheSignature = this.getStatSignature(stat);
        let cached = this.sessionCache.get(sessionFile);
        if (cached?.signature === cacheSignature) {
            return cached.session;
        }

        let sessionId = this.getSessionIdFromFileName(path.basename(sessionFile));
        if (!sessionId) {
            return null;
        }

        let cwd: string = this.readSessionCwd(sessionFile, sessionId);
        let updatedAt: string = new Date(stat.mtimeMs).toISOString();
        let customTitle: string = null;
        let aiTitle: string = null;
        let promptTitle: string = null;

        try {
            let lines = this.readSessionLines(sessionFile, stat);
            for (let line of lines) {
                if (!line.trim()) {
                    continue;
                }

                let event: ClaudeSessionEvent;
                try {
                    event = JSON.parse(line);
                } catch (e) {
                    continue;
                }

                if (event.sessionId && event.sessionId !== sessionId) {
                    continue;
                }
                let eventCwd = this.getEventCwd(event, sessionId);
                if (eventCwd) {
                    cwd = eventCwd;
                }
                if (event.timestamp && !isNaN(Date.parse(event.timestamp))) {
                    updatedAt = event.timestamp;
                }
                if (event.customTitle) {
                    customTitle = event.customTitle;
                }
                if (event.aiTitle) {
                    aiTitle = event.aiTitle;
                }
                if (event.lastPrompt) {
                    promptTitle = event.lastPrompt;
                }

                let messageText = this.getMessageText(event);
                if (messageText) {
                    promptTitle = messageText;
                }
            }
        } catch (e) {
            // Fall back to file metadata if the JSONL cannot be read cleanly.
        }

        let session: CodexSession = {
            id: sessionId,
            name: this.trimTitle(customTitle || aiTitle || promptTitle) || sessionId,
            updatedAt,
            cwd,
            workDir: cwd,
            provider: 'claude',
        };
        this.sessionCache.set(sessionFile, { signature: cacheSignature, session });

        return session;
    }

    private readSessionCwd(sessionFile: string, sessionId: string): string {
        let fd: number = null;
        let carry = '';
        try {
            fd = fs.openSync(sessionFile, 'r');
            let buffer = Buffer.alloc(this.cwdScanChunkBytes);
            let bytesRead = 0;

            do {
                bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
                if (bytesRead <= 0) {
                    break;
                }

                let chunk = carry + buffer.slice(0, bytesRead).toString('utf8');
                let lines = chunk.split(/\r?\n/g);
                carry = lines.pop() || '';

                for (let line of lines) {
                    let cwd = this.readCwdFromJsonLine(line, sessionId);
                    if (cwd) {
                        return cwd;
                    }
                }
            } while (bytesRead === buffer.length);

            return this.readCwdFromJsonLine(carry, sessionId);
        } catch (e) {
            return null;
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (e) {
                    // Ignore close failures for best-effort cwd reads.
                }
            }
        }
    }

    private readCwdFromJsonLine(line: string, sessionId: string): string {
        if (!line.trim()) {
            return null;
        }

        try {
            return this.getEventCwd(JSON.parse(line), sessionId);
        } catch (e) {
            return null;
        }
    }

    private getEventCwd(event: ClaudeSessionEvent, sessionId: string): string {
        if (!event || (event.sessionId && event.sessionId !== sessionId) || !event.cwd) {
            return null;
        }

        return this.normalizePath(event.cwd);
    }

    private readSessionLines(sessionFile: string, stat: fs.Stats): string[] {
        if (stat.size <= this.sessionSampleBytes * 2) {
            return fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/g);
        }

        let fd: number = null;
        try {
            fd = fs.openSync(sessionFile, 'r');
            let firstBuffer = Buffer.alloc(this.sessionSampleBytes);
            let lastBuffer = Buffer.alloc(this.sessionSampleBytes);
            let firstBytes = fs.readSync(fd, firstBuffer, 0, firstBuffer.length, 0);
            let lastOffset = Math.max(stat.size - this.sessionSampleBytes, 0);
            let lastBytes = fs.readSync(fd, lastBuffer, 0, lastBuffer.length, lastOffset);

            return [
                ...firstBuffer.slice(0, firstBytes).toString('utf8').split(/\r?\n/g),
                ...lastBuffer.slice(0, lastBytes).toString('utf8').split(/\r?\n/g),
            ];
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (e) {
                    // Ignore close failures for best-effort session reads.
                }
            }
        }
    }

    private getMessageText(event: ClaudeSessionEvent): string {
        if (event.type !== 'user' || !event.message || event.message.role !== 'user') {
            return null;
        }

        let content = event.message.content;
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .filter(part => part?.type === 'text' && !!part.text)
                .map(part => part.text)
                .join(' ');
        }

        return null;
    }

    private trimTitle(value: string): string {
        value = String(value || '').replace(/\s+/g, ' ').trim();
        return value.length > 80 ? `${value.substring(0, 77)}...` : value;
    }

    private getSessionFingerprint(): string {
        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return 'missing';
        }

        let projectRoot = path.join(claudeHome, 'projects');
        return [
            claudeHome,
            ...this.getSessionFiles(projectRoot).map(filePath => this.getFileSignature(filePath)).sort(),
        ].join('|');
    }

    private getFileSignature(filePath: string): string {
        try {
            let stat = fs.statSync(filePath);
            return `${filePath}:${this.getStatSignature(stat)}`;
        } catch (e) {
            return `${filePath}:missing`;
        }
    }

    private getStatSignature(stat: fs.Stats): string {
        return `${stat.size}:${stat.mtimeMs}`;
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

    private getSessionIdFromFileName(fileName: string): string {
        let match = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return match ? match[0] : null;
    }

    private isSessionId(value: string): boolean {
        return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value || '');
    }

    private normalizePath(value: string): string {
        if (!value) {
            return '';
        }

        return value.replace(/\\/g, '/').replace(/\/+$/g, '');
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
