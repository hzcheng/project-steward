'use strict';

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { AttentionAggregate } from './attentionAggregate';
import { aggregateAttentionSnapshots } from './attentionAggregate';
import type { AttentionOwnerSnapshot, AttentionPayloadItem } from './attentionPayload';
import { createAttentionPayload, validateAttentionOwnerSnapshot } from './attentionPayload';

const PUBLISH_COMMAND = '_projectStewardAttention.bridge.publish';
const AGGREGATE_COMMAND = '_projectStewardAttention.workspace.aggregate';
const ACKNOWLEDGE_COMMAND = '_projectStewardAttention.bridge.acknowledge';

interface BridgeEnvelope {
    protocolVersion: 1;
    instanceId: string;
    workspaceProcessId: string;
    workspaceIdentity: string;
    sequence: number;
    sentAtMs: number;
    writtenAtMs: number;
    payload: string;
}

export default class AttentionBridgeClient implements vscode.Disposable {
    private readonly instanceId = crypto.randomBytes(16).toString('hex');
    private sequence = 0;
    private lastSemantic = '';
    private lastPublishedAt = 0;
    private lastItems: AttentionPayloadItem[] = [];
    private lastAggregate: AttentionAggregate | null = null;
    private lastErrorAt = 0;
    private readonly aggregateRegistration: vscode.Disposable;

    constructor(
        private readonly workspaceIdentity: string,
        private readonly onAggregate: (aggregate: AttentionAggregate) => void,
        private readonly onError: (error: unknown) => void
    ) {
        this.aggregateRegistration = vscode.commands.registerCommand(AGGREGATE_COMMAND, (raw: unknown) => this.receiveAggregate(raw));
    }

    async publish(items: AttentionPayloadItem[], forceHeartbeat = false): Promise<boolean> {
        const payload = createAttentionPayload(items);
        const semantic = JSON.stringify(payload.items);
        if (!forceHeartbeat && semantic === this.lastSemantic && Date.now() - this.lastPublishedAt < 30_000) return true;
        const owner: AttentionOwnerSnapshot = {
            ...payload,
            instanceId: this.instanceId,
            sequence: ++this.sequence,
            leaseUpdatedAtMs: Date.now(),
        };
        const now = Date.now();
        const envelope: BridgeEnvelope = {
            protocolVersion: 1,
            instanceId: this.instanceId,
            workspaceProcessId: this.instanceId,
            workspaceIdentity: this.workspaceIdentity,
            sequence: owner.sequence,
            sentAtMs: now,
            writtenAtMs: now,
            payload: JSON.stringify(owner),
        };
        try {
            await vscode.commands.executeCommand(PUBLISH_COMMAND, envelope);
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
        const acknowledgements = (this.lastAggregate?.items || [])
            .filter(item => item.eventId && ids.has(item.eventId))
            .map(item => ({ ...item, state: 'acknowledged' as const, observedAtMs: Date.now() }));
        if (!acknowledgements.length) return;
        try {
            await vscode.commands.executeCommand(ACKNOWLEDGE_COMMAND, { eventIds: Array.from(ids) });
        } catch (error) {
            if (Date.now() - this.lastErrorAt >= 60_000) {
                this.lastErrorAt = Date.now();
                this.onError(error);
            }
        }
        const bySession = new Map(this.lastItems.map(item => [item.sessionKey, item]));
        acknowledgements.forEach(item => bySession.set(item.sessionKey, item));
        await this.publish(Array.from(bySession.values()), true);
    }

    private receiveAggregate(raw: unknown): void {
        try {
            const record = raw as { snapshots?: Array<{ payload?: unknown }>; observedAtMs?: unknown };
            if (!record || !Array.isArray(record.snapshots)) throw new Error('bridge aggregate snapshots are invalid');
            const snapshots = record.snapshots.map(snapshot => {
                if (typeof snapshot.payload !== 'string') throw new Error('bridge aggregate payload is invalid');
                return validateAttentionOwnerSnapshot(JSON.parse(snapshot.payload));
            });
            const observedAtMs = typeof record.observedAtMs === 'number' ? record.observedAtMs : Date.now();
            this.lastAggregate = aggregateAttentionSnapshots(snapshots, new Set<string>(), observedAtMs);
            this.onAggregate(this.lastAggregate);
        } catch (error) {
            this.onError(error);
        }
    }
}

export function createAttentionWorkspaceIdentity(paths: string[]): string {
    return (paths || []).slice().sort().join('\n') || '/';
}
