'use strict';

import type { AiSessionProviderId } from '../models';

export interface AiSessionPinStoreLike {
    getAll(): Set<string>;
    toggle(sessionKey: string): boolean;
    remove(sessionKey: string): void;
    migrateLegacy(sessionKeys: string[]): void;
}

export interface AiSessionPinControllerOptions {
    store: AiSessionPinStoreLike;
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    logError: (message: string, error: unknown) => void;
    showUpdateError?: () => void;
}

export default class AiSessionPinController {
    constructor(private readonly options: AiSessionPinControllerOptions) {}

    getAll(): Set<string> {
        try {
            return this.options.store.getAll();
        } catch (error) {
            this.options.logError('Failed to read pinned AI sessions.', error);
            return new Set<string>();
        }
    }

    toggle(providerId: AiSessionProviderId, sessionId: string): boolean {
        try {
            this.options.store.toggle(this.options.getSessionKey(providerId, sessionId));
            return true;
        } catch (error) {
            this.options.logError('Failed to update the pinned AI session.', error);
            this.options.showUpdateError?.();
            return false;
        }
    }

    remove(providerId: AiSessionProviderId, sessionId: string) {
        try {
            this.options.store.remove(this.options.getSessionKey(providerId, sessionId));
        } catch (error) {
            this.options.logError('Failed to delete the pinned AI session.', error);
        }
    }

    async migrateLegacy(sessionKeys: string[], clearLegacy: () => PromiseLike<unknown>): Promise<void> {
        try {
            this.options.store.migrateLegacy(Array.isArray(sessionKeys) ? sessionKeys : []);
            clearLegacy().then(undefined, error => {
                this.options.logError('Failed to clear legacy pinned AI session state.', error);
            });
        } catch (error) {
            this.options.logError('Failed to migrate pinned AI sessions.', error);
        }
    }
}
