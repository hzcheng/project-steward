import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { resolveBridgeStorageRoot } from './bridgeStorageRoot';
import { LocalStore } from './localStore';
import { parseRoutingChallenge } from '../../../shared/attention-bridge/protocol';
import { ProbeSnapshot } from '../../../shared/attention-bridge/storeProtocol';
import { createWorkspaceIdentity } from '../../../shared/attention-bridge/workspaceIdentity';
import {
    FocusSpikeRequest,
    FOCUS_SPIKE_TTL_MS,
    parseFocusSpikeRequest,
    parseFocusSpikeRequestForRelay,
    shouldHandleFocusSpikeRequest,
    tryParseFocusSpikeJson,
} from '../../../spikes/attention-local-bridge/shared/focusRelay';

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
const FOCUS_WORKSPACE = '_projectStewardOpenWindowSpike.workspace.focus';
const FOCUS_BRIDGE_LIST = '_projectStewardOpenWindowSpike.bridge.list';
const FOCUS_BRIDGE_REQUEST = '_projectStewardOpenWindowSpike.bridge.request';
const FOCUS_SPIKE_ROOT = 'open-window-focus-spike';
const FOCUS_SPIKE_SOURCE_TIMEOUT_MS = 3_000;
const FOCUS_SPIKE_RETRY_MS = 100;
const FOCUS_SPIKE_MAINTENANCE_MS = 2_000;
const PROCESS_ID_PATTERN = /^[a-f0-9]{32}$/;

interface AggregateState {
    bridgeProcessId: string;
    workspaceIdentity: string;
    snapshots: ProbeSnapshot[];
    counters: unknown;
    observedAtMs: number;
}

interface FocusSpikeRegistration {
    protocolVersion: 1;
    instanceId: string;
    workspaceIdentity: string;
    updatedAtMs: number;
}

interface WorkspaceFocusResult {
    requestId: string;
    targetInstanceId: string;
    focused: boolean;
    latencyMs: number;
}

interface FocusSpikeResult extends WorkspaceFocusResult {
    sourceInstanceId: string;
    handlingInstanceId: string;
    completedAtMs: number;
    error?: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

async function removeFileIfPresent(filePath: string): Promise<void> {
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
            throw error;
        }
    }
}

async function readJsonIfPresent(filePath: string): Promise<unknown | null> {
    try {
        const parsed = tryParseFocusSpikeJson(await fs.promises.readFile(filePath, 'utf8'));
        if (parsed === null) {
            await removeFileIfPresent(filePath);
        }
        return parsed;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return null;
        }
        throw error;
    }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
        await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        await fs.promises.rename(temporaryPath, filePath);
    } catch (error) {
        await removeFileIfPresent(temporaryPath);
        throw error;
    }
}

function delay(durationMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, durationMs));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const bridgeProcessId = crypto.randomBytes(16).toString('hex');
    const workspaceIdentity = createWorkspaceIdentity(
        (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.path)
    );
    const bridgeRoot = resolveBridgeStorageRoot(context.globalStoragePath, context.globalStorageUri.scheme);
    const instanceId = crypto.randomBytes(16).toString('hex');
    const store = new LocalStore(bridgeRoot, instanceId, bridgeProcessId);
    const focusRoot = path.join(bridgeRoot, FOCUS_SPIKE_ROOT);
    const focusRegistrationsDirectory = path.join(focusRoot, 'registrations');
    const focusRequestsDirectory = path.join(focusRoot, 'requests');
    const focusResultsDirectory = path.join(focusRoot, 'results');
    await Promise.all([
        fs.promises.mkdir(focusRegistrationsDirectory, { recursive: true, mode: 0o700 }),
        fs.promises.mkdir(focusRequestsDirectory, { recursive: true, mode: 0o700 }),
        fs.promises.mkdir(focusResultsDirectory, { recursive: true, mode: 0o700 }),
    ]);
    let watcherEnabled = false;
    let fsWatcher: fs.FSWatcher | null = null;
    let lastAggregate = '';
    let scanTimer: NodeJS.Timeout | null = null;
    let boundWorkspaceProcessId: string | null = null;
    let focusWatcher: fs.FSWatcher | null = null;
    let focusRetryTimer: NodeJS.Timeout | null = null;
    let focusMaintenanceTimer: NodeJS.Timeout | null = null;
    let focusScanPromise: Promise<void> | null = null;
    const acknowledgedEventIds = await store.readAcknowledgements();

    function registrationPath(workspaceProcessId: string): string {
        return path.join(focusRegistrationsDirectory, `${workspaceProcessId}.json`);
    }

    function requestPath(requestId: string): string {
        return path.join(focusRequestsDirectory, `${requestId}.json`);
    }

    function resultPath(requestId: string): string {
        return path.join(focusResultsDirectory, `${requestId}.json`);
    }

    async function writeFocusRegistration(): Promise<void> {
        if (boundWorkspaceProcessId === null) {
            return;
        }
        const registration: FocusSpikeRegistration = {
            protocolVersion: 1,
            instanceId: boundWorkspaceProcessId,
            workspaceIdentity,
            updatedAtMs: Date.now(),
        };
        await writeJsonAtomically(registrationPath(boundWorkspaceProcessId), registration);
    }

    async function bindWorkspaceProcess(workspaceProcessId: string): Promise<void> {
        if (!PROCESS_ID_PATTERN.test(workspaceProcessId)) {
            throw new Error('focus workspaceProcessId is invalid');
        }
        if (boundWorkspaceProcessId !== null && boundWorkspaceProcessId !== workspaceProcessId) {
            throw new Error('focus bridge is already bound to another Workspace process');
        }
        boundWorkspaceProcessId = workspaceProcessId;
        await writeFocusRegistration();
    }

    async function readFocusRegistrations(nowMs: number): Promise<FocusSpikeRegistration[]> {
        const registrations: FocusSpikeRegistration[] = [];
        for (const fileName of await fs.promises.readdir(focusRegistrationsDirectory)) {
            if (!/^[a-f0-9]{32}\.json$/.test(fileName)) {
                continue;
            }
            const filePath = path.join(focusRegistrationsDirectory, fileName);
            const raw = await readJsonIfPresent(filePath);
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                await removeFileIfPresent(filePath);
                continue;
            }
            const record = raw as Record<string, unknown>;
            if (record.protocolVersion !== 1 || typeof record.instanceId !== 'string'
                || !PROCESS_ID_PATTERN.test(record.instanceId) || `${record.instanceId}.json` !== fileName
                || typeof record.workspaceIdentity !== 'string' || typeof record.updatedAtMs !== 'number'
                || !Number.isFinite(record.updatedAtMs) || nowMs < record.updatedAtMs
                || nowMs - record.updatedAtMs >= FOCUS_SPIKE_TTL_MS) {
                await removeFileIfPresent(filePath);
                continue;
            }
            registrations.push(record as unknown as FocusSpikeRegistration);
        }
        return registrations.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    }

    async function cleanExpiredFocusFiles(nowMs: number): Promise<void> {
        await readFocusRegistrations(nowMs);
        for (const fileName of await fs.promises.readdir(focusRequestsDirectory)) {
            if (!/^[a-f0-9]{32}\.json$/.test(fileName)) {
                continue;
            }
            const filePath = path.join(focusRequestsDirectory, fileName);
            const raw = await readJsonIfPresent(filePath);
            try {
                parseFocusSpikeRequest(raw, nowMs);
            } catch (_error) {
                await removeFileIfPresent(filePath);
            }
        }
        for (const fileName of await fs.promises.readdir(focusResultsDirectory)) {
            if (!/^[a-f0-9]{32}\.json$/.test(fileName)) {
                continue;
            }
            const filePath = path.join(focusResultsDirectory, fileName);
            const raw = await readJsonIfPresent(filePath);
            const completedAtMs = raw && typeof raw === 'object' && !Array.isArray(raw)
                ? (raw as Record<string, unknown>).completedAtMs
                : undefined;
            if (typeof completedAtMs !== 'number' || !Number.isFinite(completedAtMs)
                || nowMs < completedAtMs || nowMs - completedAtMs >= FOCUS_SPIKE_TTL_MS) {
                await removeFileIfPresent(filePath);
            }
        }
    }

    async function processFocusRequests(): Promise<void> {
        if (boundWorkspaceProcessId === null) {
            return;
        }
        const nowMs = Date.now();
        for (const fileName of await fs.promises.readdir(focusRequestsDirectory)) {
            if (!/^[a-f0-9]{32}\.json$/.test(fileName)) {
                continue;
            }
            const filePath = path.join(focusRequestsDirectory, fileName);
            const raw = await readJsonIfPresent(filePath);
            let request: FocusSpikeRequest;
            try {
                request = parseFocusSpikeRequest(raw, nowMs);
            } catch (_error) {
                await removeFileIfPresent(filePath);
                continue;
            }
            if (!shouldHandleFocusSpikeRequest(request, boundWorkspaceProcessId, nowMs)) {
                continue;
            }

            let result: FocusSpikeResult;
            try {
                const workspaceResult = await vscode.commands.executeCommand<WorkspaceFocusResult>(FOCUS_WORKSPACE, request);
                if (!workspaceResult || workspaceResult.requestId !== request.requestId
                    || workspaceResult.targetInstanceId !== boundWorkspaceProcessId) {
                    throw new Error('focus Workspace result mismatch');
                }
                result = {
                    ...workspaceResult,
                    sourceInstanceId: request.sourceInstanceId,
                    handlingInstanceId: boundWorkspaceProcessId,
                    completedAtMs: Date.now(),
                };
            } catch (error) {
                result = {
                    requestId: request.requestId,
                    sourceInstanceId: request.sourceInstanceId,
                    targetInstanceId: request.targetInstanceId,
                    handlingInstanceId: boundWorkspaceProcessId,
                    focused: false,
                    latencyMs: Date.now() - request.createdAtMs,
                    completedAtMs: Date.now(),
                    error: error instanceof Error ? error.message : String(error),
                };
            }
            await writeJsonAtomically(resultPath(request.requestId), result);
            await removeFileIfPresent(filePath);
        }
    }

    async function scanFocusRequests(): Promise<void> {
        if (focusScanPromise !== null) {
            return focusScanPromise;
        }
        const operation = processFocusRequests();
        focusScanPromise = operation;
        try {
            await operation;
        } finally {
            if (focusScanPromise === operation) {
                focusScanPromise = null;
            }
        }
    }

    function scheduleFocusScan(): void {
        if (focusRetryTimer !== null) {
            return;
        }
        focusRetryTimer = setTimeout(() => {
            focusRetryTimer = null;
            void scanFocusRequests().catch(() => undefined);
        }, FOCUS_SPIKE_RETRY_MS);
    }

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
        await vscode.commands.executeCommand(PRODUCTION_WORKSPACE_AGGREGATE, {
            snapshots: applyAcknowledgements(scan.snapshots),
            observedAtMs: aggregate.observedAtMs,
        });
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
        const snapshot = raw as ProbeSnapshot;
        await bindWorkspaceProcess(snapshot.workspaceProcessId);
        await store.writeForeign(snapshot);
        await scanAndNotify();
        return { accepted: true, bridgeProcessId, instanceId };
    });
    const productionPublishDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_PUBLISH, async (raw: unknown) => {
        await store.writeForeign(raw as ProbeSnapshot);
        const scan = await store.scan(Date.now());
        await vscode.commands.executeCommand(PRODUCTION_WORKSPACE_AGGREGATE, {
            snapshots: applyAcknowledgements(scan.snapshots),
            observedAtMs: Date.now(),
        });
        return { accepted: true, bridgeProcessId, instanceId };
    });
    const productionAcknowledgeDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_ACKNOWLEDGE, async (raw: unknown) => {
        const eventIds = (raw as { eventIds?: unknown })?.eventIds;
        if (!Array.isArray(eventIds) || eventIds.length > 1000
            || eventIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 1024)) {
            throw new Error('attention acknowledgement eventIds are invalid');
        }
        await store.writeAcknowledgements(eventIds as string[]);
        eventIds.forEach(id => acknowledgedEventIds.add(id as string));
        await scanAndNotify();
        return { acknowledged: eventIds.length };
    });
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
    const focusListDisposable = vscode.commands.registerCommand(FOCUS_BRIDGE_LIST, async () => {
        const registrations = await readFocusRegistrations(Date.now());
        return {
            targetInstanceIds: registrations.map(registration => registration.instanceId),
            registrationCount: registrations.length,
        };
    });
    const focusRequestDisposable = vscode.commands.registerCommand(FOCUS_BRIDGE_REQUEST, async (raw: unknown) => {
        const nowMs = Date.now();
        const request = parseFocusSpikeRequestForRelay(raw, nowMs);
        if (boundWorkspaceProcessId !== request.sourceInstanceId) {
            throw new Error('focus source mismatch');
        }
        const registrations = await readFocusRegistrations(Date.now());
        if (!registrations.some(registration => registration.instanceId === request.targetInstanceId)) {
            throw new Error(`focus target missing: ${request.targetInstanceId}`);
        }

        await writeJsonAtomically(requestPath(request.requestId), request);
        scheduleFocusScan();
        const deadlineMs = Date.now() + FOCUS_SPIKE_SOURCE_TIMEOUT_MS;
        while (Date.now() < deadlineMs) {
            const rawResult = await readJsonIfPresent(resultPath(request.requestId));
            if (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)) {
                const result = rawResult as FocusSpikeResult;
                if (result.requestId !== request.requestId || result.sourceInstanceId !== request.sourceInstanceId
                    || result.targetInstanceId !== request.targetInstanceId
                    || result.handlingInstanceId !== request.targetInstanceId) {
                    throw new Error('focus result mismatch');
                }
                await removeFileIfPresent(resultPath(request.requestId));
                return result;
            }
            await delay(FOCUS_SPIKE_RETRY_MS);
        }
        await removeFileIfPresent(requestPath(request.requestId));
        throw new Error(`focus request timed out after ${FOCUS_SPIKE_SOURCE_TIMEOUT_MS}ms`);
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
    focusWatcher = fs.watch(focusRequestsDirectory, () => {
        scheduleFocusScan();
    });
    focusMaintenanceTimer = setInterval(() => {
        void Promise.all([
            writeFocusRegistration(),
            cleanExpiredFocusFiles(Date.now()),
            scanFocusRequests(),
        ]).catch(() => undefined);
    }, FOCUS_SPIKE_MAINTENANCE_MS);

    context.subscriptions.push(
        challengeDisposable,
        publishDisposable,
        productionPublishDisposable,
        productionAcknowledgeDisposable,
        statusDisposable,
        watcherDisposable,
        clearDisposable,
        focusListDisposable,
        focusRequestDisposable,
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
                if (focusRetryTimer !== null) {
                    clearTimeout(focusRetryTimer);
                    focusRetryTimer = null;
                }
                if (focusMaintenanceTimer !== null) {
                    clearInterval(focusMaintenanceTimer);
                    focusMaintenanceTimer = null;
                }
                if (focusWatcher !== null) {
                    focusWatcher.close();
                    focusWatcher = null;
                }
                if (boundWorkspaceProcessId !== null) {
                    void removeFileIfPresent(registrationPath(boundWorkspaceProcessId));
                }
                void store.removeOwnSnapshot();
            },
        },
    );
}

export function deactivate(): void {
    // Nothing to dispose beyond context subscriptions.
}
