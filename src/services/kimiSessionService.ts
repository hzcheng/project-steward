'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexSession } from '../models';
import { aiSessionPathContains, filterAiSessionsByCandidatePaths, normalizeAiSessionCandidatePaths } from '../aiSessions/sessionHelpers';
import type { AiSessionQueryOptions } from '../aiSessions/types';
import { parseKimiLifecycleLines, AiSessionLifecycleRequest, AiSessionLifecycleSignal } from '../aiSessions/lifecycle';
import { readJsonlTailLines } from '../aiSessions/jsonlTail';
import { Disposable } from './codexSessionService';

interface KimiWorkDirEntry {
    path?: string;
    last_session_id?: string;
}

interface KimiConfig {
    work_dirs?: KimiWorkDirEntry[];
}

interface KimiSessionState {
    custom_title?: string;
    archived?: boolean;
    archived_at?: string;
    plan_mode?: boolean;
    plan_slug?: string;
}

export interface KimiSessionReadResult {
    available: boolean;
    sessions: CodexSession[];
}

export default class KimiSessionService {
    private cachedResult: KimiSessionReadResult = null;
    private cachedAt = 0;
    private readonly sessionDirsById = new Map<string, string>();
    private readonly cacheTtlMs = 5000;
    private readonly changePollIntervalMs = 3000;

    getSessions(options: boolean | AiSessionQueryOptions = false): KimiSessionReadResult {
        let { forceRefresh, candidatePaths } = this.getQueryOptions(options);
        let now = Date.now();
        if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
            return this.filterResult(this.cachedResult, candidatePaths);
        }

        let kimiHome = this.getKimiHome();
        if (!kimiHome) {
            return this.cacheResult({ available: false, sessions: [] });
        }

        let workDirs = this.getWorkDirs(kimiHome);
        if (!workDirs.length) {
            return this.cacheResult({ available: false, sessions: [] });
        }

        if (candidatePaths.length) {
            workDirs = workDirs.filter(workDir => candidatePaths.some(candidatePath => aiSessionPathContains(candidatePath, workDir)));
            if (!workDirs.length) {
                return { available: true, sessions: [] };
            }
        }

        let sessions: CodexSession[] = [];
        for (let workDir of workDirs) {
            sessions.push(...this.getSessionsForWorkDir(kimiHome, workDir));
        }

        sessions.sort((a, b) => this.compareUpdatedAt(b.updatedAt, a.updatedAt));
        let result = { available: true, sessions };
        return candidatePaths.length ? this.filterResult(result, candidatePaths) : this.cacheResult(result);
    }

    getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal> {
        let kimiHome = this.getKimiHome();
        if (!kimiHome) {
            return {};
        }
        let signals: Record<string, AiSessionLifecycleSignal> = {};
        for (let request of requests || []) {
            if (!request?.sessionId || !Number.isFinite(request.runStartedAtMs) || signals[request.sessionId]) {
                continue;
            }
            let sessionDir = this.findSessionDir(kimiHome, request.sessionId);
            if (!sessionDir) {
                continue;
            }
            let signal = parseKimiLifecycleLines(
                readJsonlTailLines(path.join(sessionDir, 'wire.jsonl')),
                request.runStartedAtMs
            );
            if (signal) {
                signals[request.sessionId] = signal;
            }
        }
        return signals;
    }

    archiveSession(sessionId: string): boolean {
        if (!sessionId) {
            return false;
        }

        let kimiHome = this.getKimiHome();
        if (!kimiHome) {
            return false;
        }

        let sessionDir = this.findSessionDir(kimiHome, sessionId);
        if (!sessionDir) {
            return false;
        }

        try {
            let statePath = path.join(sessionDir, 'state.json');
            let state = this.readJson<KimiSessionState>(statePath) || {};
            state.archived = true;
            state.archived_at = new Date().toISOString();
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
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

    private cacheResult(result: KimiSessionReadResult): KimiSessionReadResult {
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

    private filterResult(result: KimiSessionReadResult, candidatePaths: string[]): KimiSessionReadResult {
        return filterAiSessionsByCandidatePaths(result, candidatePaths, session => session.workDir || session.cwd);
    }

    private getKimiHome(): string {
        let configuredHome = process.env.KIMI_SHARE_DIR;
        if (configuredHome && fs.existsSync(configuredHome)) {
            return configuredHome;
        }

        let defaultHome = path.join(os.homedir(), '.kimi');
        return fs.existsSync(defaultHome) ? defaultHome : null;
    }

    private getWorkDirs(kimiHome: string): string[] {
        let configPath = path.join(kimiHome, 'kimi.json');
        let config = this.readJson<KimiConfig>(configPath);
        if (!config?.work_dirs?.length) {
            return [];
        }

        let seen = new Set<string>();
        let workDirs: string[] = [];
        for (let entry of config.work_dirs) {
            let workDir = this.normalizePath(entry.path);
            if (!workDir || seen.has(workDir)) {
                continue;
            }

            seen.add(workDir);
            workDirs.push(workDir);
        }

        return workDirs;
    }

    private getSessionsForWorkDir(kimiHome: string, workDir: string): CodexSession[] {
        let sessionsDir = path.join(kimiHome, 'sessions', this.getWorkDirHash(workDir));
        if (!fs.existsSync(sessionsDir)) {
            return [];
        }

        let sessions: CodexSession[] = [];
        try {
            for (let entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
                if (!entry.isDirectory() || !this.isSessionId(entry.name)) {
                    continue;
                }

                let sessionDir = path.join(sessionsDir, entry.name);
                this.sessionDirsById.set(entry.name, sessionDir);
                let session = this.readSession(workDir, entry.name, sessionDir);
                if (session) {
                    sessions.push(session);
                }
            }
        } catch (e) {
            return [];
        }

        return sessions;
    }

    private findSessionDir(kimiHome: string, sessionId: string): string {
        if (!this.isSessionId(sessionId)) {
            return null;
        }

        let cached = this.sessionDirsById.get(sessionId);
        if (cached && fs.existsSync(cached)) {
            return cached;
        }
        this.sessionDirsById.delete(sessionId);

        let sessionsRoot = path.join(kimiHome, 'sessions');
        if (!fs.existsSync(sessionsRoot)) {
            return null;
        }

        try {
            for (let workDirEntry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
                if (!workDirEntry.isDirectory()) {
                    continue;
                }

                let sessionDir = path.join(sessionsRoot, workDirEntry.name, sessionId);
                if (fs.existsSync(sessionDir)) {
                    this.sessionDirsById.set(sessionId, sessionDir);
                    return sessionDir;
                }
            }
        } catch (e) {
            return null;
        }

        return null;
    }

    private readSession(workDir: string, sessionId: string, sessionDir: string): CodexSession {
        let wirePath = path.join(sessionDir, 'wire.jsonl');
        if (!fs.existsSync(wirePath)) {
            return null;
        }

        let wireStat: fs.Stats;
        try {
            wireStat = fs.statSync(wirePath);
            if (wireStat.size === 0) {
                return null;
            }
        } catch (e) {
            return null;
        }

        let state = this.readJson<KimiSessionState>(path.join(sessionDir, 'state.json'));
        if (state?.archived) {
            return null;
        }

        return {
            id: sessionId,
            name: state?.custom_title || state?.plan_slug || sessionId,
            updatedAt: new Date(wireStat.mtimeMs).toISOString(),
            cwd: workDir,
            workDir,
            provider: 'kimi',
        };
    }

    private getSessionFingerprint(): string {
        let kimiHome = this.getKimiHome();
        if (!kimiHome) {
            return 'missing';
        }

        let workDirs = this.getWorkDirs(kimiHome);
        return [
            kimiHome,
            this.getFileSignature(path.join(kimiHome, 'kimi.json')),
            ...workDirs.map(workDir => this.getWorkDirSignature(kimiHome, workDir)),
        ].join('|');
    }

    private getWorkDirSignature(kimiHome: string, workDir: string): string {
        let sessionsDir = path.join(kimiHome, 'sessions', this.getWorkDirHash(workDir));
        if (!fs.existsSync(sessionsDir)) {
            return `${workDir}:missing`;
        }

        try {
            return `${workDir}:` + fs.readdirSync(sessionsDir, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && this.isSessionId(entry.name))
                .map(entry => {
                    let sessionDir = path.join(sessionsDir, entry.name);
                    return [
                        entry.name,
                        this.getFileSignature(path.join(sessionDir, 'state.json')),
                        this.getWireFilePresenceSignature(path.join(sessionDir, 'wire.jsonl')),
                    ].join(':');
                })
                .sort()
                .join(',');
        } catch (e) {
            return `${workDir}:unreadable`;
        }
    }

    private getWireFilePresenceSignature(filePath: string): string {
        try {
            let stat = fs.statSync(filePath);
            return stat.size > 0 ? 'wire-nonempty' : 'wire-empty';
        } catch (e) {
            return 'no-wire';
        }
    }

    private getFileSignature(filePath: string): string {
        try {
            let stat = fs.statSync(filePath);
            return `${filePath}:${stat.size}:${stat.mtimeMs}`;
        } catch (e) {
            return `${filePath}:missing`;
        }
    }

    private getWorkDirHash(workDir: string): string {
        return crypto.createHash('md5').update(workDir, 'utf8').digest('hex');
    }

    private isSessionId(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    private readJson<T>(filePath: string): T {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
        } catch (e) {
            return null;
        }
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
