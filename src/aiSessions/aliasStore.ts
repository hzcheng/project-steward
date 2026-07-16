'use strict';

import * as fs from 'fs';
import * as path from 'path';

const AI_SESSION_ALIASES_FILE_NAME = 'ai-session-aliases.json';

export default class AiSessionAliasStore {
    private readonly aliasesPath: string;

    constructor(globalStoragePath: string) {
        this.aliasesPath = path.join(globalStoragePath, AI_SESSION_ALIASES_FILE_NAME);
    }

    getAll(): Record<string, string> {
        if (!fs.existsSync(this.aliasesPath)) {
            return {};
        }

        let aliases = JSON.parse(fs.readFileSync(this.aliasesPath, 'utf8'));
        if (aliases === null || aliases === undefined || typeof aliases !== 'object' || Array.isArray(aliases)) {
            return {};
        }

        return this.normalizeAliases(aliases);
    }

    saveAll(aliases: Record<string, unknown>): void {
        this.ensureDirectory();
        fs.writeFileSync(this.aliasesPath, JSON.stringify(this.normalizeAliases(aliases), null, 2), 'utf8');
    }

    set(sessionKey: string, alias: string): void {
        let cleanAlias = sanitizeAiSessionAlias(alias);
        if (!sessionKey || !cleanAlias) {
            return;
        }

        let aliases = this.getAll();
        aliases[sessionKey] = cleanAlias;
        this.saveAll(aliases);
    }

    remove(sessionKey: string): void {
        if (!sessionKey) {
            return;
        }

        let aliases = this.getAll();
        if (!aliases[sessionKey]) {
            return;
        }

        delete aliases[sessionKey];
        this.saveAll(aliases);
    }

    private ensureDirectory(): void {
        fs.mkdirSync(path.dirname(this.aliasesPath), { recursive: true });
    }

    private normalizeAliases(aliases: Record<string, unknown>): Record<string, string> {
        return Object.keys(aliases).reduce((result, key) => {
            let alias = aliases[key];
            if (typeof alias === 'string' && alias.trim()) {
                result[key] = alias;
            }

            return result;
        }, {} as Record<string, string>);
    }
}

export function sanitizeAiSessionAlias(value: string): string {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}
