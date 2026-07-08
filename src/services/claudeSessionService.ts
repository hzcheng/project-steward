'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexSession } from '../models';
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
    private readonly cacheTtlMs = 5000;
    private readonly changePollIntervalMs = 3000;

    getSessions(forceRefresh: boolean = false): ClaudeSessionReadResult {
        let now = Date.now();
        if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
            return this.cachedResult;
        }

        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return this.cacheResult({ available: false, sessions: [] });
        }

        let projectRoot = path.join(claudeHome, 'projects');
        let sessionFiles = this.getSessionFiles(projectRoot);
        if (!sessionFiles.length) {
            return this.cacheResult({ available: false, sessions: [] });
        }

        let sessions = sessionFiles
            .map(sessionFile => this.readSession(sessionFile))
            .filter(session => !!session)
            .sort((a, b) => this.compareUpdatedAt(b.updatedAt, a.updatedAt));

        return this.cacheResult({ available: true, sessions });
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

        return files;
    }

    private findSessionFile(projectRoot: string, sessionId: string): string {
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

        let cwd: string = null;
        let updatedAt: string = new Date(stat.mtimeMs).toISOString();
        let customTitle: string = null;
        let aiTitle: string = null;
        let promptTitle: string = null;

        try {
            let lines = fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/g);
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
                if (event.cwd) {
                    cwd = this.normalizePath(event.cwd);
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
