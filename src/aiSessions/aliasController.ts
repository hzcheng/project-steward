'use strict';

import type { AiSessionProviderId } from '../models';
import { sanitizeAiSessionAlias } from './aliasStore';
import type { AiSessionReadResult } from './types';

export interface AiSessionAliasStoreLike {
    getAll(): Record<string, string>;
    saveAll(aliases: Record<string, unknown>): void;
    remove(sessionKey: string): void;
    set(sessionKey: string, alias: string): void;
}

export interface AiSessionAliasControllerOptions {
    store: AiSessionAliasStoreLike;
    isProviderId: (value: string) => value is AiSessionProviderId;
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    getProviderResult: (providerId: AiSessionProviderId, options: { reason: string }) => AiSessionReadResult;
    logError: (message: string, error: unknown) => void;
    showSaveError?: () => void;
}

export default class AiSessionAliasController {
    constructor(private readonly options: AiSessionAliasControllerOptions) {}

    getAll(): Record<string, string> {
        try {
            return this.options.store.getAll();
        } catch (error) {
            this.options.logError('Failed to read AI session aliases.', error);
            return {};
        }
    }

    saveAll(aliases: Record<string, string>) {
        try {
            this.options.store.saveAll(aliases);
        } catch (error) {
            this.options.logError('Failed to save AI session aliases.', error);
            this.options.showSaveError?.();
        }
    }

    remove(providerId: AiSessionProviderId, sessionId: string) {
        try {
            this.options.store.remove(this.options.getSessionKey(providerId, sessionId));
        } catch (error) {
            this.options.logError('Failed to delete AI session alias.', error);
        }
    }

    set(providerId: AiSessionProviderId, sessionId: string, alias: string) {
        alias = sanitizeAiSessionAlias(alias);
        if (!this.options.isProviderId(providerId) || !sessionId || !alias) {
            return;
        }

        try {
            this.options.store.set(this.options.getSessionKey(providerId, sessionId), alias);
        } catch (error) {
            this.options.logError('Failed to save AI session alias.', error);
            this.options.showSaveError?.();
        }
    }

    getOriginalName(providerId: AiSessionProviderId, sessionId: string): string {
        let sessionResult = this.options.getProviderResult(providerId, { reason: 'alias-original-name' });
        let session = sessionResult.sessions.find(candidate => candidate.id === sessionId);

        return session?.name || sessionId;
    }
}
