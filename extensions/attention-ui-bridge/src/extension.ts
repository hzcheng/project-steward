import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { resolveBridgeStorageRoot } from './bridgeStorageRoot';
import { LocalStore } from './localStore';
import { OpenProjectCoordinator } from './openProjectCoordinator';
import { ProductionAttentionStore } from './productionAttentionStore';
import { aggregateAttentionSnapshots, validateAttentionAggregate } from '../../../src/aiSessions/attentionAggregate';
import {
    validateAttentionBridgeHandshakeRequest,
    validateAttentionOwnerSnapshot,
    validateAttentionUnregisterRequest,
} from '../../../src/aiSessions/attentionPayload';
import { parseRoutingChallenge } from '../../../shared/attention-bridge/protocol';
import { ProbeSnapshot } from '../../../shared/attention-bridge/storeProtocol';
import { createWorkspaceIdentity } from '../../../shared/attention-bridge/workspaceIdentity';

const BRIDGE_CHALLENGE = '_projectStewardAttentionSpike.bridge.challenge';
const WORKSPACE_CHALLENGE = '_projectStewardAttentionSpike.workspace.challenge';
const BRIDGE_PUBLISH = '_projectStewardAttentionSpike.bridge.publish';
const BRIDGE_STATUS = '_projectStewardAttentionSpike.bridge.status';
const BRIDGE_SET_WATCHER = '_projectStewardAttentionSpike.bridge.setWatcher';
const BRIDGE_CLEAR = '_projectStewardAttentionSpike.bridge.clear';
const WORKSPACE_AGGREGATE = '_projectStewardAttentionSpike.workspace.aggregate';
const PRODUCTION_BRIDGE_PUBLISH = '_projectStewardAttention.bridge.publish';
const PRODUCTION_WORKSPACE_AGGREGATE = '_projectStewardAttention.workspace.aggregate';
const PRODUCTION_BRIDGE_ACKNOWLEDGE = '_projectStewardAttention.bridge.acknowledge';
const PRODUCTION_BRIDGE_HANDSHAKE = '_projectStewardAttention.bridge.handshake';
const PRODUCTION_BRIDGE_UNREGISTER = '_projectStewardAttention.bridge.unregister';
const OPEN_PROJECT_BRIDGE_PUBLISH = '_projectStewardOpenProjects.bridge.publish';
const OPEN_PROJECT_BRIDGE_UNREGISTER = '_projectStewardOpenProjects.bridge.unregister';
const OPEN_PROJECT_WORKSPACE_AGGREGATE = '_projectStewardOpenProjects.workspace.aggregate';

interface AggregateState {
    bridgeProcessId: string;
    workspaceIdentity: string;
    snapshots: ProbeSnapshot[];
    counters: unknown;
    observedAtMs: number;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const bridgeProcessId = crypto.randomBytes(16).toString('hex');
    const workspaceIdentity = createWorkspaceIdentity(
        (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.path)
    );
    const bridgeRoot = resolveBridgeStorageRoot(context.globalStoragePath, context.globalStorageUri.scheme);
    const instanceId = crypto.randomBytes(16).toString('hex');
    const store = new LocalStore(bridgeRoot, instanceId, bridgeProcessId);
    const productionStore = new ProductionAttentionStore(path.join(bridgeRoot, 'production-attention', 'v1'), bridgeProcessId);
    let watcherEnabled = false;
    let fsWatcher: fs.FSWatcher | null = null;
    let lastAggregate = '';
    let lastProductionAggregate = '';
    let scanTimer: NodeJS.Timeout | null = null;
    const acknowledgedEventIds = await store.readAcknowledgements();
    const openProjectCoordinator = new OpenProjectCoordinator(bridgeRoot, {
        now: () => Date.now(),
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
        createWatcher: (directory, onDidChange) => {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            return fs.watch(directory, onDidChange);
        },
        deliverAggregate: aggregate => vscode.commands.executeCommand(
            OPEN_PROJECT_WORKSPACE_AGGREGATE,
            aggregate,
        ),
    });

    function applyAcknowledgements(snapshots: ProbeSnapshot[]): ProbeSnapshot[] {
        return snapshots.map(snapshot => {
            try {
                const owner = JSON.parse(snapshot.payload) as { items?: Array<Record<string, unknown>> };
                if (!Array.isArray(owner.items)) return snapshot;
                owner.items = owner.items.map(item => typeof item.eventId === 'string' && acknowledgedEventIds.has(item.eventId)
                    ? { ...item, state: 'acknowledged' }
                    : item);
                return { ...snapshot, payload: JSON.stringify(owner) };
            } catch (_error) {
                return snapshot;
            }
        });
    }

    async function scanAndNotify(): Promise<void> {
        const persistedAcknowledgements = await store.readAcknowledgements(Date.now());
        acknowledgedEventIds.clear();
        persistedAcknowledgements.forEach(eventId => acknowledgedEventIds.add(eventId));
        const scan = await store.scan(Date.now());
        const semantic = `${JSON.stringify(scan.snapshots.map(snapshot => ({
            instanceId: snapshot.instanceId,
            sequence: snapshot.sequence,
            payload: snapshot.payload,
        })))}|${JSON.stringify(Array.from(acknowledgedEventIds).sort())}`;
        if (semantic === lastAggregate) {
            return;
        }
        lastAggregate = semantic;
        const aggregate: AggregateState = {
            bridgeProcessId,
            workspaceIdentity,
            snapshots: applyAcknowledgements(scan.snapshots),
            counters: scan.counters,
            observedAtMs: Date.now(),
        };
        await vscode.commands.executeCommand(WORKSPACE_AGGREGATE, aggregate);
    }

    async function scanProductionAndNotify(force = false): Promise<void> {
        const persistedAcknowledgements = await store.readAcknowledgements(Date.now());
        acknowledgedEventIds.clear();
        persistedAcknowledgements.forEach(eventId => acknowledgedEventIds.add(eventId));
        const scan = await productionStore.scan(Date.now());
        const aggregate = validateAttentionAggregate(aggregateAttentionSnapshots(scan.snapshots, acknowledgedEventIds, Date.now()));
        if (!force && aggregate.aggregateRevision === lastProductionAggregate) return;
        lastProductionAggregate = aggregate.aggregateRevision;
        await vscode.commands.executeCommand(PRODUCTION_WORKSPACE_AGGREGATE, aggregate);
    }

    const challengeDisposable = vscode.commands.registerCommand(BRIDGE_CHALLENGE, async (raw: unknown) => {
        const request = parseRoutingChallenge(raw);
        if (request.workspaceIdentity !== workspaceIdentity) {
            throw new Error(`bridge workspace identity mismatch: ${workspaceIdentity}`);
        }
        const reverse = await vscode.commands.executeCommand<Record<string, unknown>>(WORKSPACE_CHALLENGE, {
            ...request,
            bridgeProcessId,
        });
        if (!reverse || reverse.workspaceProcessId !== request.workspaceProcessId ||
            reverse.workspaceIdentity !== request.workspaceIdentity || reverse.nonce !== request.nonce ||
            reverse.bridgeProcessId !== bridgeProcessId) {
            throw new Error('reverse Workspace response mismatch');
        }
        return {
            ...request,
            bridgeProcessId,
        };
    });

    const publishDisposable = vscode.commands.registerCommand(BRIDGE_PUBLISH, async (raw: unknown) => {
        await store.writeForeign(raw as ProbeSnapshot);
        await scanAndNotify();
        return { accepted: true, bridgeProcessId, instanceId };
    });
    const productionHandshakeDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_HANDSHAKE, async (raw: unknown) => {
        validateAttentionBridgeHandshakeRequest(raw);
        await scanProductionAndNotify(true);
        return {
            accepted: true,
            protocolVersion: 1,
            bridgeExtensionVersion: '0.1.1',
            capabilities: { snapshots: true, acknowledgements: true, atomicReplace: true },
        };
    });
    const productionPublishDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_PUBLISH, async (raw: unknown) => {
        const snapshot = validateAttentionOwnerSnapshot(raw);
        await productionStore.write(snapshot, Date.now(), '0.1.1');
        await scanProductionAndNotify();
        return { accepted: true, bridgeProcessId, instanceId };
    });
    const productionUnregisterDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_UNREGISTER, async (raw: unknown) => {
        const request = validateAttentionUnregisterRequest(raw);
        await productionStore.remove(request.instanceId);
        await scanProductionAndNotify(true);
        return { removed: true };
    });
    const productionAcknowledgeDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_ACKNOWLEDGE, async (raw: unknown) => {
        const eventIds = (raw as { eventIds?: unknown })?.eventIds;
        if (!Array.isArray(eventIds) || eventIds.length > 1000
            || eventIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 1024)) {
            throw new Error('attention acknowledgement eventIds are invalid');
        }
        await store.writeAcknowledgements(eventIds as string[]);
        eventIds.forEach(id => acknowledgedEventIds.add(id as string));
        await scanProductionAndNotify(true);
        return { acknowledged: eventIds.length };
    });
    const openProjectPublishDisposable = vscode.commands.registerCommand(
        OPEN_PROJECT_BRIDGE_PUBLISH,
        (raw: unknown) => openProjectCoordinator.publish(raw),
    );
    const openProjectUnregisterDisposable = vscode.commands.registerCommand(
        OPEN_PROJECT_BRIDGE_UNREGISTER,
        (raw: unknown) => openProjectCoordinator.unregister(raw),
    );
    const statusDisposable = vscode.commands.registerCommand(BRIDGE_STATUS, async () => {
        const scan = await store.scan(Date.now());
        return {
            bridgeProcessId,
            instanceId,
            workspaceIdentity,
            storageRoot: bridgeRoot,
            watcherEnabled,
            scan,
        };
    });
    const watcherDisposable = vscode.commands.registerCommand(BRIDGE_SET_WATCHER, async (enabled: unknown) => {
        watcherEnabled = enabled === true;
        if (fsWatcher !== null) {
            fsWatcher.close();
            fsWatcher = null;
        }
        if (watcherEnabled) {
            const instancesDirectory = path.join(bridgeRoot, 'instances');
            await fs.promises.mkdir(instancesDirectory, { recursive: true, mode: 0o700 });
            fsWatcher = fs.watch(instancesDirectory, () => {
                void scanAndNotify().catch(() => undefined);
            });
            await scanAndNotify();
        }
        return { watcherEnabled };
    });
    const clearDisposable = vscode.commands.registerCommand(BRIDGE_CLEAR, async () => {
        await store.removeOwnSnapshot();
        lastAggregate = '';
        return { cleared: true, bridgeProcessId, instanceId };
    });
    const scanRegistration = vscode.commands.registerCommand('_projectStewardAttentionSpike.bridge.scan', scanAndNotify);
    scanTimer = setInterval(() => {
        void scanAndNotify().catch(error => {
            void vscode.commands.executeCommand(WORKSPACE_AGGREGATE, {
                bridgeProcessId,
                workspaceIdentity,
                error: error instanceof Error ? error.message : String(error),
                observedAtMs: Date.now(),
            });
        });
        void scanProductionAndNotify().catch(() => undefined);
    }, 2000);

    context.subscriptions.push(
        challengeDisposable,
        publishDisposable,
        productionHandshakeDisposable,
        productionPublishDisposable,
        productionUnregisterDisposable,
        productionAcknowledgeDisposable,
        openProjectPublishDisposable,
        openProjectUnregisterDisposable,
        statusDisposable,
        watcherDisposable,
        clearDisposable,
        scanRegistration,
        openProjectCoordinator,
        {
            dispose: () => {
                if (scanTimer !== null) {
                    clearInterval(scanTimer);
                    scanTimer = null;
                }
                if (fsWatcher !== null) {
                    fsWatcher.close();
                    fsWatcher = null;
                }
                void store.removeOwnSnapshot();
            },
        },
    );
}

export function deactivate(): void {
    // Nothing to dispose beyond context subscriptions.
}
