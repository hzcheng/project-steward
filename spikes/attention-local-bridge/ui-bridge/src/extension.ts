import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { LocalStore } from './localStore';
import { parseRoutingChallenge } from '../../shared/protocol';
import { ProbeSnapshot } from '../../shared/storeProtocol';
import { createWorkspaceIdentity } from '../../shared/workspaceIdentity';

const BRIDGE_CHALLENGE = '_projectStewardAttentionSpike.bridge.challenge';
const WORKSPACE_CHALLENGE = '_projectStewardAttentionSpike.workspace.challenge';
const BRIDGE_PUBLISH = '_projectStewardAttentionSpike.bridge.publish';
const BRIDGE_STATUS = '_projectStewardAttentionSpike.bridge.status';
const BRIDGE_SET_WATCHER = '_projectStewardAttentionSpike.bridge.setWatcher';
const BRIDGE_CLEAR = '_projectStewardAttentionSpike.bridge.clear';
const WORKSPACE_AGGREGATE = '_projectStewardAttentionSpike.workspace.aggregate';

interface AggregateState {
    bridgeProcessId: string;
    workspaceIdentity: string;
    snapshots: ProbeSnapshot[];
    counters: unknown;
    observedAtMs: number;
}

export function activate(context: vscode.ExtensionContext): void {
    const bridgeProcessId = crypto.randomBytes(16).toString('hex');
    const workspaceIdentity = createWorkspaceIdentity(
        (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.path)
    );
    const bridgeRoot = context.globalStorageUri.scheme === 'file'
        ? path.join(context.globalStorageUri.fsPath, 'attention-local-bridge-spike', 'v1')
        : null;
    const instanceId = crypto.randomBytes(16).toString('hex');
    const store = bridgeRoot === null ? null : new LocalStore(bridgeRoot, instanceId, bridgeProcessId);
    let watcherEnabled = false;
    let fsWatcher: fs.FSWatcher | null = null;
    let lastAggregate = '';
    let scanTimer: NodeJS.Timeout | null = null;

    async function scanAndNotify(): Promise<void> {
        if (store === null) {
            return;
        }
        const scan = await store.scan(Date.now());
        const semantic = JSON.stringify(scan.snapshots.map(snapshot => ({
            instanceId: snapshot.instanceId,
            sequence: snapshot.sequence,
            payload: snapshot.payload,
        })));
        if (semantic === lastAggregate) {
            return;
        }
        lastAggregate = semantic;
        const aggregate: AggregateState = {
            bridgeProcessId,
            workspaceIdentity,
            snapshots: scan.snapshots,
            counters: scan.counters,
            observedAtMs: Date.now(),
        };
        await vscode.commands.executeCommand(WORKSPACE_AGGREGATE, aggregate);
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
        if (store === null) {
            throw new Error(`globalStorageUri must use file scheme, got ${context.globalStorageUri.scheme}`);
        }
        await store.write(raw as ProbeSnapshot);
        await scanAndNotify();
        return { accepted: true, bridgeProcessId, instanceId };
    });
    const statusDisposable = vscode.commands.registerCommand(BRIDGE_STATUS, async () => {
        const scan = store === null ? null : await store.scan(Date.now());
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
        if (watcherEnabled && bridgeRoot !== null) {
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
        if (store !== null) {
            await store.removeOwnSnapshot();
        }
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
    }, 2000);

    context.subscriptions.push(
        challengeDisposable,
        publishDisposable,
        statusDisposable,
        watcherDisposable,
        clearDisposable,
        scanRegistration,
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
                if (store !== null) {
                    void store.removeOwnSnapshot();
                }
            },
        },
    );
}

export function deactivate(): void {
    // Nothing to dispose beyond context subscriptions.
}
