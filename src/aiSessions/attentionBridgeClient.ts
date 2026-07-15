'use strict';

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { AttentionAggregate } from './attentionAggregate';
import { validateAttentionAggregate } from './attentionAggregate';
import type { AttentionOwnerSnapshot, AttentionPayloadItem } from './attentionPayload';
import { createAttentionPayload, validateAttentionBridgeHandshakeResponse } from './attentionPayload';

const PUBLISH_COMMAND = '_projectStewardAttention.bridge.publish';
const AGGREGATE_COMMAND = '_projectStewardAttention.workspace.aggregate';
const ACKNOWLEDGE_COMMAND = '_projectStewardAttention.bridge.acknowledge';
const HANDSHAKE_COMMAND = '_projectStewardAttention.bridge.handshake';
const UNREGISTER_COMMAND = '_projectStewardAttention.bridge.unregister';
const RETRY_DELAYS_MS = [100, 500, 2_000, 10_000, 30_000];

export interface AttentionBridgeClientOptions {
    now?: () => number;
    setTimeout?: (callback: () => void, delayMs: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    mainExtensionVersion?: string;
}

export default class AttentionBridgeClient implements vscode.Disposable {
    private readonly instanceId = crypto.randomBytes(16).toString('hex');
    private sequence = 0;
    private heartbeat = 0;
    private lastSemantic = '';
    private lastPublishedAt = 0;
    private lastItems: AttentionPayloadItem[] = [];
    private latestItems: AttentionPayloadItem[] = [];
    private hasLatestSnapshot = false;
    private lastAggregate: AttentionAggregate | null = null;
    private lastErrorAt = 0;
    private readonly aggregateRegistration: vscode.Disposable;
    private readonly now: () => number;
    private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
    private readonly cancelTimeout: (handle: unknown) => void;
    private readonly mainExtensionVersion: string;
    private connected = false;
    private incompatible = false;
    private disposed = false;
    private retryAttempt = 0;
    private retryTimer: unknown = null;
    private handshakeFlight: Promise<boolean> | null = null;
    private publicationQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly onAggregate: (aggregate: AttentionAggregate) => void,
        private readonly onError: (error: unknown) => void,
        options: AttentionBridgeClientOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
        this.scheduleTimeout = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this.cancelTimeout = options.clearTimeout ?? (handle => clearTimeout(handle as NodeJS.Timeout));
        this.mainExtensionVersion = options.mainExtensionVersion || 'unknown';
        this.aggregateRegistration = vscode.commands.registerCommand(AGGREGATE_COMMAND, (raw: unknown) => this.receiveAggregate(raw));
        void this.ensureHandshake();
    }

    publish(items: AttentionPayloadItem[], forceHeartbeat = false): Promise<boolean> {
        if (this.disposed) return Promise.resolve(false);
        const payload = createAttentionPayload(items);
        this.latestItems = payload.items.map(item => ({ ...item }));
        this.hasLatestSnapshot = true;
        return this.enqueuePublication(payload.items, forceHeartbeat);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.aggregateRegistration.dispose();
        if (this.retryTimer !== null) this.cancelTimeout(this.retryTimer);
        this.retryTimer = null;
        const unregister = () => vscode.commands.executeCommand(
            UNREGISTER_COMMAND,
            { protocolVersion: 1, instanceId: this.instanceId },
        ).then(() => undefined, () => undefined);
        const result = this.publicationQueue.then(unregister, unregister);
        this.publicationQueue = result.then(() => undefined, () => undefined);
    }

    async acknowledge(eventIds: string[]): Promise<void> {
        const ids = new Set(eventIds || []);
        const acknowledgements = this.lastItems
            .filter(item => item.eventId && ids.has(item.eventId))
            .map(item => ({ ...item, state: 'acknowledged' as const, observedAtMs: this.now() }));
        if (!ids.size) return;
        try {
            await vscode.commands.executeCommand(ACKNOWLEDGE_COMMAND, { eventIds: Array.from(ids) });
        } catch (error) {
            this.reportError(error);
        }
        if (!acknowledgements.length) return;
        const bySession = new Map(this.latestItems.map(item => [item.sessionKey, item]));
        acknowledgements.forEach(item => bySession.set(item.sessionKey, item));
        await this.publish(Array.from(bySession.values()), true);
    }

    private enqueuePublication(items: AttentionPayloadItem[], forceHeartbeat: boolean): Promise<boolean> {
        if (this.disposed) return Promise.resolve(false);
        let accepted = false;
        const operation = async () => {
            if (this.disposed || !await this.ensureHandshake() || this.disposed) return;
            accepted = await this.publishNow(items, forceHeartbeat);
        };
        const result = this.publicationQueue.then(operation, operation);
        this.publicationQueue = result.then(() => undefined, () => undefined);
        return result.then(() => accepted);
    }

    private async publishNow(items: AttentionPayloadItem[], forceHeartbeat: boolean): Promise<boolean> {
        if (this.disposed) return false;
        const payload = createAttentionPayload(items, this.now());
        const semantic = JSON.stringify(payload.items);
        if (!forceHeartbeat && semantic === this.lastSemantic && this.now() - this.lastPublishedAt < 30_000) return true;
        const owner: AttentionOwnerSnapshot = {
            ...payload,
            instanceId: this.instanceId,
            sequence: ++this.sequence,
            heartbeat: ++this.heartbeat,
        };
        try {
            await vscode.commands.executeCommand(PUBLISH_COMMAND, owner);
            this.lastSemantic = semantic;
            this.lastPublishedAt = this.now();
            this.lastItems = payload.items;
            return true;
        } catch (error) {
            this.connected = false;
            this.reportError(error);
            this.scheduleRetry();
            return false;
        }
    }

    private receiveAggregate(raw: unknown): void {
        try {
            this.lastAggregate = validateAttentionAggregate(raw);
            this.onAggregate(this.lastAggregate);
        } catch (error) {
            this.onError(error);
        }
    }

    private ensureHandshake(): Promise<boolean> {
        if (this.disposed || this.incompatible) return Promise.resolve(false);
        if (this.connected) return Promise.resolve(true);
        if (this.handshakeFlight) return this.handshakeFlight;
        this.handshakeFlight = this.handshake().then(result => {
            this.handshakeFlight = null;
            return result;
        }, error => {
            this.handshakeFlight = null;
            throw error;
        });
        return this.handshakeFlight;
    }

    private async handshake(): Promise<boolean> {
        try {
            const response = await vscode.commands.executeCommand(HANDSHAKE_COMMAND, {
                protocolVersion: 1,
                mainExtensionVersion: this.mainExtensionVersion,
                instanceId: this.instanceId,
            });
            validateAttentionBridgeHandshakeResponse(response);
            this.connected = true;
            this.retryAttempt = 0;
            if (this.retryTimer !== null) this.cancelTimeout(this.retryTimer);
            this.retryTimer = null;
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/protocol|capabilit/i.test(message)) {
                this.incompatible = true;
            } else {
                this.scheduleRetry();
            }
            this.reportError(error);
            return false;
        }
    }

    private scheduleRetry(): void {
        if (this.disposed || this.incompatible || this.retryTimer !== null) return;
        const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)];
        this.retryAttempt += 1;
        this.retryTimer = this.scheduleTimeout(() => {
            this.retryTimer = null;
            void this.ensureHandshake().then(ready => {
                if (ready && this.hasLatestSnapshot) void this.enqueuePublication(this.latestItems, true);
            });
        }, delay);
    }

    private reportError(error: unknown): void {
        if (this.now() - this.lastErrorAt >= 60_000 || this.lastErrorAt === 0) {
            this.lastErrorAt = this.now();
            this.onError(error);
        }
    }
}
