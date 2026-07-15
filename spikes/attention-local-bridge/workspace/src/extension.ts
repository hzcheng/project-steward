import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    AutoRunControl,
    createAutoRunResultFileName,
    matchesAutoRunFixture,
    parseAutoRunControl,
    shouldStartAutoRun,
} from '../../shared/autoRunControl';
import { drainBatch } from '../../shared/drainBatch';
import { FocusSpikeRequest, parseFocusSpikeRequest } from '../../shared/focusRelay';
import {
    assertMatchingRoutingResponse,
    assertStableBridgeProcessId,
    parseRoutingResponse,
    PROCESS_ID_PATTERN,
    PROTOCOL_VERSION,
} from '../../../../shared/attention-bridge/protocol';
import { createSingleFlight } from '../../shared/singleFlight';
import { summarizeLatencies } from '../../shared/metrics';
import { ProbeSnapshot } from '../../../../shared/attention-bridge/storeProtocol';
import { createWorkspaceIdentity } from '../../../../shared/attention-bridge/workspaceIdentity';

const BRIDGE_CHALLENGE = '_projectStewardAttentionSpike.bridge.challenge';
const WORKSPACE_CHALLENGE = '_projectStewardAttentionSpike.workspace.challenge';
const BRIDGE_PUBLISH = '_projectStewardAttentionSpike.bridge.publish';
const BRIDGE_STATUS = '_projectStewardAttentionSpike.bridge.status';
const BRIDGE_SET_WATCHER = '_projectStewardAttentionSpike.bridge.setWatcher';
const BRIDGE_CLEAR = '_projectStewardAttentionSpike.bridge.clear';
const WORKSPACE_AGGREGATE = '_projectStewardAttentionSpike.workspace.aggregate';
const FOCUS_WORKSPACE = '_projectStewardOpenWindowSpike.workspace.focus';
const FOCUS_BRIDGE_LIST = '_projectStewardOpenWindowSpike.bridge.list';
const FOCUS_BRIDGE_REQUEST = '_projectStewardOpenWindowSpike.bridge.request';
const RUN_FOCUS_SPIKE = 'projectSteward.openWindowFocusSpike';
const STATUS_PREFIX = 'ATTENTION_SPIKE_ROUTING_STATUS ';
const AUTO_RUN_CONTROL_PATH = '/tmp/project-steward-attention-routing-control.json';
const AUTO_RUN_RESULT_ROOT = '/tmp/project-steward-attention-routing-results';
const AUTO_RUN_DELAY_MS = 2000;
const WORKSPACE_PROBE_VERSION = '0.0.5';

interface RoutingStatus {
    phase: 'routing';
    result: 'IDLE' | 'RUNNING' | 'PASS' | 'FAIL';
    workspaceProcessId: string;
    workspaceIdentity: string;
    remoteName: string;
    bridgeProcessIds: string[];
    attempted: number;
    completed: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
}

interface FileStressStatus {
    result: 'IDLE' | 'RUNNING' | 'PASS' | 'FAIL';
    instanceId: string;
    sequence: number;
    changes: number;
    peerSequences: Record<string, number>;
    latencySamples: number;
    p95LatencyMs: number | null;
    maxLatencyMs: number | null;
    rollbackCount: number;
    error: string | null;
}

interface FocusSpikeTargetList {
    targetInstanceIds: string[];
    registrationCount: number;
}

interface FocusSpikeResult {
    requestId: string;
    targetInstanceId: string;
    handlingInstanceId: string;
    focused: boolean;
    latencyMs: number;
    error?: string;
}

function withTimeout<T>(promise: Thenable<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        Promise.resolve(promise).then(
            value => {
                clearTimeout(timeout);
                resolve(value);
            },
            error => {
                clearTimeout(timeout);
                reject(error);
            }
        );
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function requireCommandResult<T>(value: T | undefined, label: string): T {
    if (value === undefined) {
        throw new Error(`${label} returned no result`);
    }
    return value;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

async function readAutoRunControl(): Promise<AutoRunControl | null> {
    let source: string;
    try {
        source = await fs.promises.readFile(AUTO_RUN_CONTROL_PATH, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return null;
        }
        throw error;
    }

    try {
        return parseAutoRunControl(JSON.parse(source), Date.now());
    } catch (_error) {
        return null;
    }
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return false;
        }
        throw error;
    }
}

async function writeResultAtomically(resultPath: string, value: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
    const temporaryPath = `${resultPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
        await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
        await fs.promises.rename(temporaryPath, resultPath);
    } catch (error) {
        try {
            await fs.promises.unlink(temporaryPath);
        } catch (cleanupError) {
            if (!hasErrorCode(cleanupError, 'ENOENT')) {
                // Preserve the original write/rename error.
            }
        }
        throw error;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const workspaceProcessId = crypto.randomBytes(16).toString('hex');
    const workspaceIdentity = createWorkspaceIdentity(
        (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.path)
    );
    const remoteName = vscode.env.remoteName || 'local';
    const outputChannel = vscode.window.createOutputChannel('Project Steward Attention Spike Routing');
    let status: RoutingStatus = {
        phase: 'routing',
        result: 'IDLE',
        workspaceProcessId,
        workspaceIdentity,
        remoteName,
        bridgeProcessIds: [],
        attempted: 0,
        completed: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
    };
    const instanceId = crypto.randomBytes(16).toString('hex');
    let fileStressTimer: NodeJS.Timeout | null = null;
    let fileStressStartedAtMs = 0;
    let fileStressHeartbeatUntilMs = 0;
    const peerSequences = new Map<string, number>();
    const peerSequenceObservedAt = new Map<string, number>();
    const latencySamples: number[] = [];
    let fileStatus: FileStressStatus = {
        result: 'IDLE',
        instanceId,
        sequence: 0,
        changes: 0,
        peerSequences: {},
        latencySamples: 0,
        p95LatencyMs: null,
        maxLatencyMs: null,
        rollbackCount: 0,
        error: null,
    };

    const reverseDisposable = vscode.commands.registerCommand(WORKSPACE_CHALLENGE, (raw: unknown) => {
        const value = raw as Record<string, unknown>;
        if (value.workspaceProcessId !== workspaceProcessId) {
            throw new Error(`reverse command reached wrong Workspace process: expected ${value.workspaceProcessId}, got ${workspaceProcessId}`);
        }
        if (value.workspaceIdentity !== workspaceIdentity) {
            throw new Error('reverse command workspace identity mismatch');
        }
        if (typeof value.bridgeProcessId !== 'string' || !PROCESS_ID_PATTERN.test(value.bridgeProcessId)) {
            throw new Error('reverse command bridgeProcessId is invalid');
        }
        if (typeof value.nonce !== 'string' || !PROCESS_ID_PATTERN.test(value.nonce)) {
            throw new Error('reverse command nonce is invalid');
        }
        return {
            workspaceProcessId,
            workspaceIdentity,
            bridgeProcessId: value.bridgeProcessId,
            nonce: value.nonce,
        };
    });

    async function publishFileSnapshot(): Promise<void> {
        const snapshot: ProbeSnapshot = {
            protocolVersion: 1,
            instanceId,
            workspaceProcessId,
            workspaceIdentity,
            sequence: fileStatus.sequence,
            sentAtMs: Date.now(),
            writtenAtMs: Date.now(),
            payload: `${workspaceProcessId}:${fileStatus.sequence}`,
        };
        await withTimeout(vscode.commands.executeCommand(BRIDGE_PUBLISH, snapshot), 5000, 'snapshot publish');
    }

    const focusWorkspaceDisposable = vscode.commands.registerCommand(FOCUS_WORKSPACE, async (raw: unknown) => {
        const requestCreatedAtMs = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>).createdAtMs
            : undefined;
        if (typeof requestCreatedAtMs !== 'number' || !Number.isFinite(requestCreatedAtMs)) {
            throw new Error('focus request createdAtMs is invalid');
        }
        const request = parseFocusSpikeRequest(raw, requestCreatedAtMs);
        if (request.targetInstanceId !== workspaceProcessId) throw new Error('focus target mismatch');
        const startedAtMs = Date.now();
        await vscode.commands.executeCommand('workbench.action.focusWindow');
        return {
            requestId: request.requestId,
            targetInstanceId: workspaceProcessId,
            focused: vscode.window.state.focused,
            latencyMs: Date.now() - startedAtMs,
        };
    });

    const runFocusSpikeDisposable = vscode.commands.registerCommand(RUN_FOCUS_SPIKE, async () => {
        await publishFileSnapshot();
        const before = requireCommandResult(
            await withTimeout(
                vscode.commands.executeCommand<FocusSpikeTargetList>(FOCUS_BRIDGE_LIST),
                3000,
                'focus target scan'
            ),
            'focus target scan'
        );
        const selected = await vscode.window.showQuickPick(
            before.targetInstanceIds.map(targetInstanceId => ({
                label: targetInstanceId,
                description: targetInstanceId === workspaceProcessId ? 'current window' : 'existing window',
                targetInstanceId,
            })),
            { placeHolder: 'Choose the exact existing VS Code window to focus' }
        );
        if (!selected) {
            return;
        }

        const request: FocusSpikeRequest = {
            protocolVersion: 1,
            requestId: crypto.randomBytes(16).toString('hex'),
            sourceInstanceId: workspaceProcessId,
            targetInstanceId: selected.targetInstanceId,
            createdAtMs: Date.now(),
        };
        let result: FocusSpikeResult | null = null;
        let error: string | null = null;
        try {
            result = requireCommandResult(
                await withTimeout(
                    vscode.commands.executeCommand<FocusSpikeResult>(FOCUS_BRIDGE_REQUEST, request),
                    4000,
                    `focus request ${request.requestId}`
                ),
                `focus request ${request.requestId}`
            );
            if (result.error) {
                error = result.error;
            }
        } catch (focusError) {
            error = errorMessage(focusError);
        }

        let registrationCountAfter = before.registrationCount;
        try {
            const after = requireCommandResult(
                await withTimeout(
                    vscode.commands.executeCommand<FocusSpikeTargetList>(FOCUS_BRIDGE_LIST),
                    3000,
                    'post-focus target scan'
                ),
                'post-focus target scan'
            );
            registrationCountAfter = after.registrationCount;
        } catch (scanError) {
            error = error || errorMessage(scanError);
        }

        outputChannel.appendLine(`OPEN_WINDOW_FOCUS_SPIKE ${JSON.stringify({
            requestId: request.requestId,
            sourceInstanceId: request.sourceInstanceId,
            targetInstanceId: request.targetInstanceId,
            handlingInstanceId: result ? result.handlingInstanceId : null,
            focused: result ? result.focused : false,
            latencyMs: result ? result.latencyMs : null,
            registrationCountBefore: before.registrationCount,
            registrationCountAfter,
            error,
        })}`);
        outputChannel.show(true);
    });

    const aggregateDisposable = vscode.commands.registerCommand(WORKSPACE_AGGREGATE, (raw: unknown) => {
        const aggregate = raw as {
            workspaceIdentity?: unknown;
            bridgeProcessId?: unknown;
            snapshots?: ProbeSnapshot[];
            observedAtMs?: unknown;
            error?: unknown;
        };
        if (aggregate.workspaceIdentity !== workspaceIdentity) {
            throw new Error('aggregate workspace identity mismatch');
        }
        if (aggregate.error !== undefined) {
            fileStatus.result = 'FAIL';
            fileStatus.error = String(aggregate.error);
            return;
        }
        if (!Array.isArray(aggregate.snapshots) || typeof aggregate.observedAtMs !== 'number') {
            throw new Error('aggregate payload is invalid');
        }
        for (const snapshot of aggregate.snapshots) {
            const previous = peerSequences.get(snapshot.instanceId);
            if (previous !== undefined && snapshot.sequence < previous) {
                fileStatus.rollbackCount += 1;
                continue;
            }
            if (previous === undefined || snapshot.sequence > previous) {
                peerSequences.set(snapshot.instanceId, snapshot.sequence);
                peerSequenceObservedAt.set(snapshot.instanceId, aggregate.observedAtMs);
                if (snapshot.instanceId !== instanceId && fileStressStartedAtMs > 0) {
                    latencySamples.push(Math.max(0, aggregate.observedAtMs - snapshot.writtenAtMs));
                    if (latencySamples.length > 2000) {
                        latencySamples.shift();
                    }
                }
            }
        }
        fileStatus.peerSequences = Array.from(peerSequences.entries()).sort().reduce<Record<string, number>>((result, [id, sequence]) => {
            result[id] = sequence;
            return result;
        }, {});
        fileStatus.latencySamples = latencySamples.length;
        const latencySummary = summarizeLatencies(latencySamples);
        fileStatus.p95LatencyMs = latencySummary.p95Ms;
        fileStatus.maxLatencyMs = latencySummary.maxMs;
    });

    async function startFileStress(): Promise<void> {
        if (fileStressTimer !== null) {
            return;
        }
        fileStatus = { ...fileStatus, result: 'RUNNING', error: null };
        fileStressStartedAtMs = Date.now();
        fileStressHeartbeatUntilMs = 0;
        await publishFileSnapshot();
        fileStressTimer = setInterval(() => {
            if (fileStatus.changes >= 300) {
                if (fileStressHeartbeatUntilMs === 0) {
                    fileStressHeartbeatUntilMs = Date.now() + 30_000;
                    fileStatus.result = 'PASS';
                }
                if (Date.now() >= fileStressHeartbeatUntilMs) {
                    if (fileStressTimer !== null) {
                        clearInterval(fileStressTimer);
                        fileStressTimer = null;
                    }
                    return;
                }
                void publishFileSnapshot().catch(error => {
                    fileStatus.result = 'FAIL';
                    fileStatus.error = errorMessage(error);
                });
                return;
            }
            fileStatus.sequence += 1;
            fileStatus.changes += 1;
            void publishFileSnapshot().catch(error => {
                fileStatus.result = 'FAIL';
                fileStatus.error = errorMessage(error);
            });
        }, 2000);
    }

    async function stopFileStress(): Promise<void> {
        if (fileStressTimer !== null) {
            clearInterval(fileStressTimer);
            fileStressTimer = null;
        }
        if (fileStatus.result === 'RUNNING') {
            fileStatus.result = 'IDLE';
        }
    }

    async function runRoutingChallenge(total: number): Promise<void> {
        const seenBridgeProcessIds = new Set<string>();
        let completed = 0;
        status = {
            phase: 'routing',
            result: 'RUNNING',
            workspaceProcessId,
            workspaceIdentity,
            remoteName,
            bridgeProcessIds: [],
            attempted: 0,
            completed: 0,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: null,
        };

        try {
            for (let offset = 0; offset < total; offset += 20) {
                const batchSize = Math.min(20, total - offset);
                const batch = Array.from({ length: batchSize }, async () => {
                    const nonce = crypto.randomBytes(16).toString('hex');
                    const request = { protocolVersion: PROTOCOL_VERSION, workspaceProcessId, workspaceIdentity, nonce };
                    status.attempted += 1;
                    const raw = await withTimeout(
                        vscode.commands.executeCommand(BRIDGE_CHALLENGE, request),
                        5000,
                        `routing challenge ${nonce}`
                    );
                    const response = parseRoutingResponse(raw);
                    assertMatchingRoutingResponse(request, response);
                    assertStableBridgeProcessId(seenBridgeProcessIds, response.bridgeProcessId);
                    seenBridgeProcessIds.add(response.bridgeProcessId);
                    completed += 1;
                    status.completed = completed;
                    status.bridgeProcessIds = Array.from(seenBridgeProcessIds);
                });
                await drainBatch(batch);
            }
            status.result = 'PASS';
        } catch (error) {
            status.result = 'FAIL';
            if (status.error === null) {
                status.error = errorMessage(error);
            }
        } finally {
            status.finishedAt = new Date().toISOString();
        }
    }

    const runRoutingChallengeSingleFlight = createSingleFlight(runRoutingChallenge);

    async function maybeRunRoutingFromControl(): Promise<void> {
        const control = await readAutoRunControl();
        outputChannel.appendLine(`ATTENTION_SPIKE_AUTOMATION_CHECK ${JSON.stringify({
            probeVersion: WORKSPACE_PROBE_VERSION,
            workspaceProcessId,
            workspaceIdentity,
            remoteName,
            controlValid: control !== null,
            runId: control === null ? null : control.runId,
            mode: control === null ? null : control.mode,
            matches: control !== null && matchesAutoRunFixture(control, workspaceIdentity),
        })}`);
        if (control === null || !matchesAutoRunFixture(control, workspaceIdentity)) {
            return;
        }

        const resultFileName = control.mode === 'same-workspace-routing'
            ? createAutoRunResultFileName(workspaceIdentity, workspaceProcessId)
            : createAutoRunResultFileName(workspaceIdentity);
        const resultPath = path.join(
            AUTO_RUN_RESULT_ROOT,
            control.runId,
            resultFileName
        );
        const resultAlreadyExists = await fileExists(resultPath);
        if (!shouldStartAutoRun(control, workspaceIdentity, resultAlreadyExists)) {
            return;
        }

        await runRoutingChallengeSingleFlight(control.total);
        await writeResultAtomically(resultPath, {
            probeVersion: WORKSPACE_PROBE_VERSION,
            runId: control.runId,
            mode: control.mode,
            status,
        });
    }

    function logAutomationError(error: unknown): void {
        try {
            outputChannel.appendLine(`ATTENTION_SPIKE_AUTOMATION_ERROR ${errorMessage(error)}`);
        } catch (_outputError) {
            // The Extension Host may dispose the output channel while an async run settles.
        }
    }

    let initialFocusRegistrationTimer: NodeJS.Timeout | null = setTimeout(() => {
        initialFocusRegistrationTimer = null;
        void publishFileSnapshot().catch(logAutomationError);
    }, 0);

    let autoRunTimer: NodeJS.Timeout | null = setTimeout(() => {
        autoRunTimer = null;
        void maybeRunRoutingFromControl().catch(logAutomationError);
    }, AUTO_RUN_DELAY_MS);

    const showStatusDisposable = vscode.commands.registerCommand('projectStewardAttentionSpike.showStatus', () => {
        outputChannel.appendLine(`${STATUS_PREFIX}${JSON.stringify(status)}`);
        outputChannel.show(true);
    });

    const showFileStatusDisposable = vscode.commands.registerCommand('projectStewardAttentionSpike.showFileStatus', async () => {
        const bridgeStatus = await vscode.commands.executeCommand(BRIDGE_STATUS);
        outputChannel.appendLine(`ATTENTION_SPIKE_FILE_STATUS ${JSON.stringify({ fileStatus, bridgeStatus })}`);
        outputChannel.show(true);
    });

    context.subscriptions.push(
        outputChannel,
        reverseDisposable,
        aggregateDisposable,
        focusWorkspaceDisposable,
        runFocusSpikeDisposable,
        showStatusDisposable,
        showFileStatusDisposable,
        {
            dispose: () => {
                if (initialFocusRegistrationTimer !== null) {
                    clearTimeout(initialFocusRegistrationTimer);
                    initialFocusRegistrationTimer = null;
                }
                if (autoRunTimer !== null) {
                    clearTimeout(autoRunTimer);
                    autoRunTimer = null;
                }
            },
        },
        vscode.commands.registerCommand('projectStewardAttentionSpike.startRouting', () => runRoutingChallengeSingleFlight(1000)),
        vscode.commands.registerCommand('projectStewardAttentionSpike.startSameWorkspaceRouting', () => runRoutingChallengeSingleFlight(200)),
        vscode.commands.registerCommand('projectStewardAttentionSpike.startFileStress', startFileStress),
        vscode.commands.registerCommand('projectStewardAttentionSpike.stopFileStress', stopFileStress),
        vscode.commands.registerCommand('projectStewardAttentionSpike.enableWatcher', () => vscode.commands.executeCommand(BRIDGE_SET_WATCHER, true)),
        vscode.commands.registerCommand('projectStewardAttentionSpike.disableWatcher', () => vscode.commands.executeCommand(BRIDGE_SET_WATCHER, false)),
        vscode.commands.registerCommand('projectStewardAttentionSpike.clearLocalState', () => vscode.commands.executeCommand(BRIDGE_CLEAR)),
        {
            dispose: () => {
                if (fileStressTimer !== null) {
                    clearInterval(fileStressTimer);
                    fileStressTimer = null;
                }
                void vscode.commands.executeCommand(BRIDGE_CLEAR);
            },
        },
    );
}

export function deactivate(): void {
    // Nothing to dispose beyond context subscriptions.
}
