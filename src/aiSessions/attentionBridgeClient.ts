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

export default class AttentionBridgeClient implements vscode.Disposable {
    private readonly instanceId = crypto.randomBytes(16).toString('hex');
    private sequence = 0;
    private heartbeat = 0;
    private lastSemantic = '';
    private lastPublishedAt = 0;
    private lastItems: AttentionPayloadItem[] = [];
    private lastAggregate: AttentionAggregate | null = null;
    private lastErrorAt = 0;
    private readonly aggregateRegistration: vscode.Disposable;
    private readonly bridgeReady: Promise<boolean>;

    constructor(
        private readonly onAggregate: (aggregate: AttentionAggregate) => void,
        private readonly onError: (error: unknown) => void
    ) {
        this.aggregateRegistration = vscode.commands.registerCommand(AGGREGATE_COMMAND, (raw: unknown) => this.receiveAggregate(raw));
        this.bridgeReady = this.handshake();
    }

    async publish(items: AttentionPayloadItem[], forceHeartbeat = false): Promise<boolean> {
        if (!await this.bridgeReady) return false;
        const payload = createAttentionPayload(items);
        const semantic = JSON.stringify(payload.items);
        if (!forceHeartbeat && semantic === this.lastSemantic && Date.now() - this.lastPublishedAt < 30_000) return true;
        const owner: AttentionOwnerSnapshot = {
            ...payload,
            instanceId: this.instanceId,
            sequence: ++this.sequence,
            heartbeat: ++this.heartbeat,
        };
        try {
            await vscode.commands.executeCommand(PUBLISH_COMMAND, owner);
            this.lastSemantic = semantic;
            this.lastPublishedAt = Date.now();
            this.lastItems = payload.items;
            return true;
        } catch (error) {
            if (Date.now() - this.lastErrorAt >= 60_000) {
                this.lastErrorAt = Date.now();
                this.onError(error);
            }
            return false;
        }
    }

    dispose(): void {
        this.aggregateRegistration.dispose();
    }

    async acknowledge(eventIds: string[]): Promise<void> {
        const ids = new Set(eventIds || []);
        const acknowledgements = this.lastItems
            .filter(item => item.eventId && ids.has(item.eventId))
            .map(item => ({ ...item, state: 'acknowledged' as const, observedAtMs: Date.now() }));
        if (!ids.size) return;
        try {
            await vscode.commands.executeCommand(ACKNOWLEDGE_COMMAND, { eventIds: Array.from(ids) });
        } catch (error) {
            if (Date.now() - this.lastErrorAt >= 60_000) {
                this.lastErrorAt = Date.now();
                this.onError(error);
            }
        }
        if (!acknowledgements.length) return;
        const bySession = new Map(this.lastItems.map(item => [item.sessionKey, item]));
        acknowledgements.forEach(item => bySession.set(item.sessionKey, item));
        await this.publish(Array.from(bySession.values()), true);
    }

    private receiveAggregate(raw: unknown): void {
        try {
            this.lastAggregate = validateAttentionAggregate(raw);
            this.onAggregate(this.lastAggregate);
        } catch (error) {
            this.onError(error);
        }
    }

    private async handshake(): Promise<boolean> {
        try {
            const response = await vscode.commands.executeCommand(HANDSHAKE_COMMAND, {
                protocolVersion: 1,
                mainExtensionVersion: '1.1.8',
                instanceId: this.instanceId,
            });
            validateAttentionBridgeHandshakeResponse(response);
            return true;
        } catch (error) {
            this.reportError(error);
            return false;
        }
    }

    private reportError(error: unknown): void {
        if (Date.now() - this.lastErrorAt >= 60_000) {
            this.lastErrorAt = Date.now();
            this.onError(error);
        }
    }
}
