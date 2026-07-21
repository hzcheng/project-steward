import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { classifyProbeOutcome } from './outcomeClassifier';

type WorkspaceKind = 'singleFolder' | 'savedMultiRoot' | 'untitledMultiRoot';
type ProbeEnvironment = 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';
type ProbeOutcome = ReturnType<typeof classifyProbeOutcome>['outcome'];
interface ProbeRegistration {
    version: 1;
    instanceId: string;
    processId: number;
    environment: ProbeEnvironment;
    kind: WorkspaceKind;
    displayName: string;
    navigationUri: string;
    focused: boolean;
    focusSequence: number;
    focusedAtMs: number;
    heartbeatAtMs: number;
    updatedAtMs: number;
}

interface ProbeObservation {
    version: 1;
    trialId: string;
    recordedAt: string;
    startedAtMs: number;
    environment: ProbeEnvironment;
    kind: WorkspaceKind;
    sourceInstanceId: string;
    targetInstanceId: string | null;
    navigationUri: string | null;
    registrationCountBefore: number;
    registrationCountAfter: number;
    authoritativeWindowCountBefore: number | null;
    authoritativeWindowCountAfter: number | null;
    authoritativeWindowCountSource: string | null;
    evidenceSourceId: string | null;
    evidenceArtifactRef: string | null;
    evidenceSha256: string | null;
    sourceHeartbeatBeforeMs: number;
    sourceHeartbeatAfterMs: number | null;
    targetFocusSequenceBefore: number;
    targetFocusSequenceAfter: number | null;
    targetFocusedAtMs: number | null;
    outcome: ProbeOutcome;
    reason: string | null;
}

const REGISTRATION_TTL_MS = 5_000;
const OBSERVATION_DELAY_MS = 1_500;
const LIFECYCLE_MAX_MS = 10 * 60 * 1_000;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function resolveEnvironment(): ProbeEnvironment {
    switch (vscode.env.remoteName) {
        case undefined: return 'local';
        case 'ssh-remote': return 'ssh';
        case 'wsl': return 'wsl';
        case 'dev-container': return 'devContainer';
        default: return 'remote';
    }
}

function resolveWorkspace(): Pick<ProbeRegistration, 'kind' | 'displayName' | 'navigationUri'> | null {
    const workspaceFile = vscode.workspace.workspaceFile;
    const folders = vscode.workspace.workspaceFolders || [];
    if (!workspaceFile && folders.length === 1) {
        return {
            kind: 'singleFolder',
            displayName: folders[0].name,
            navigationUri: folders[0].uri.toString(),
        };
    }
    if (!workspaceFile || folders.length < 1) { return null; }
    return {
        kind: workspaceFile.scheme === 'untitled' ? 'untitledMultiRoot' : 'savedMultiRoot',
        displayName: vscode.workspace.name || workspaceFile.path.split('/').pop() || workspaceFile.toString(),
        navigationUri: workspaceFile.toString(),
    };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(temporaryPath, filePath);
}

function parseRegistration(raw: string, nowMs: number): ProbeRegistration | null {
    try {
        const value = JSON.parse(raw) as Partial<ProbeRegistration>;
        if (value.version !== 1
            || typeof value.instanceId !== 'string'
            || !INSTANCE_ID_PATTERN.test(value.instanceId)
            || typeof value.processId !== 'number'
            || !Number.isSafeInteger(value.processId)
            || typeof value.navigationUri !== 'string'
            || typeof value.updatedAtMs !== 'number'
            || nowMs - value.updatedAtMs > REGISTRATION_TTL_MS
            || typeof value.focusSequence !== 'number'
            || typeof value.focusedAtMs !== 'number'
            || typeof value.heartbeatAtMs !== 'number'
            || typeof value.focused !== 'boolean'
            || typeof value.displayName !== 'string'
            || !['local', 'ssh', 'wsl', 'devContainer', 'remote'].includes(value.environment as string)
            || !['singleFolder', 'savedMultiRoot', 'untitledMultiRoot'].includes(value.kind as string)) {
            return null;
        }
        return value as ProbeRegistration;
    } catch (_error) {
        return null;
    }
}

async function scanRegistrations(registrationsDirectory: string): Promise<ProbeRegistration[]> {
    let entries: string[];
    try {
        entries = await fs.promises.readdir(registrationsDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
        throw error;
    }
    const nowMs = Date.now();
    const registrations: ProbeRegistration[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) { continue; }
        try {
            const source = await fs.promises.readFile(path.join(registrationsDirectory, entry), 'utf8');
            const registration = parseRegistration(source, nowMs);
            if (registration) { registrations.push(registration); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
    }
    return registrations.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}

export function activate(context: vscode.ExtensionContext): void {
    const workspace = resolveWorkspace();
    const output = vscode.window.createOutputChannel('Project Steward Workspace Navigation Probe');
    const instanceId = crypto.randomBytes(16).toString('hex');
    const probeRoot = path.join(context.globalStorageUri.fsPath, 'workspace-navigation-probe', 'v1');
    const registrationsDirectory = path.join(probeRoot, 'registrations');
    const resultsDirectory = path.join(probeRoot, 'results');
    const registrationPath = path.join(registrationsDirectory, `${instanceId}.json`);
    let focused = false;
    let focusSequence = 0;
    let focusedAtMs = 0;
    let heartbeatAtMs = 0;
    let heartbeat: NodeJS.Timeout | null = null;
    let lifecycleTimeout: NodeJS.Timeout | null = null;
    let focusDisposable: vscode.Disposable | null = null;

    async function publishRegistration(heartbeatTick = false): Promise<void> {
        if (!workspace || heartbeat === null) { return; }
        const nowMs = Date.now();
        if (heartbeatTick) { heartbeatAtMs = nowMs; }
        await writeJsonAtomically(registrationPath, {
            version: 1,
            instanceId,
            processId: process.pid,
            environment: resolveEnvironment(),
            kind: workspace.kind,
            displayName: workspace.displayName,
            navigationUri: workspace.navigationUri,
            focused,
            focusSequence,
            focusedAtMs,
            heartbeatAtMs,
            updatedAtMs: nowMs,
        } as ProbeRegistration);
    }

    async function stopLifecycle(): Promise<void> {
        if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; }
        if (lifecycleTimeout !== null) { clearTimeout(lifecycleTimeout); lifecycleTimeout = null; }
        if (focusDisposable) { focusDisposable.dispose(); focusDisposable = null; }
        try {
            await fs.promises.unlink(registrationPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
    }

    async function startLifecycle(): Promise<boolean> {
        if (!workspace) {
            vscode.window.showWarningMessage('Workspace navigation probe requires a folder or multi-root workspace.');
            return false;
        }
        if (heartbeat !== null) { return true; }
        focusDisposable = vscode.window.onDidChangeWindowState(state => {
            focused = state.focused;
            if (focused) { focusSequence += 1; focusedAtMs = Date.now(); }
            void publishRegistration();
        });
        heartbeat = setInterval(() => {
            publishRegistration(true).catch(error => output.appendLine(`registration error: ${errorMessage(error)}`));
        }, 1_000);
        lifecycleTimeout = setTimeout(() => {
            void stopLifecycle().then(() => {
                output.appendLine('WORKSPACE_NAVIGATION_PROBE lifecycle stopped after 10 minutes.');
            });
        }, LIFECYCLE_MAX_MS);
        await publishRegistration(true);
        return true;
    }

    async function recordObservation(observation: ProbeObservation): Promise<void> {
        await writeJsonAtomically(path.join(resultsDirectory, `${observation.trialId}.json`), observation);
        output.appendLine(`WORKSPACE_NAVIGATION_PROBE ${JSON.stringify(observation)}`);
        output.show(true);
    }

    const startDisposable = vscode.commands.registerCommand(
        'projectStewardWorkspaceNavigationProbe.start',
        async () => {
            if (await startLifecycle()) {
                vscode.window.showInformationMessage('Workspace navigation probe trial lifecycle started for 10 minutes.');
            }
        }
    );
    const stopDisposable = vscode.commands.registerCommand(
        'projectStewardWorkspaceNavigationProbe.stop',
        async () => {
            await stopLifecycle();
            vscode.window.showInformationMessage('Workspace navigation probe trial lifecycle stopped.');
        }
    );
    const runDisposable = vscode.commands.registerCommand(
        'projectStewardWorkspaceNavigationProbe.run',
        async () => {
            if (!workspace || heartbeat === null) {
                vscode.window.showWarningMessage(
                    'Start the workspace navigation probe trial lifecycle in both source and target windows first.'
                );
                return;
            }
            await publishRegistration();
            const before = await scanRegistrations(registrationsDirectory);
            const sourceBefore = before.find(registration => registration.instanceId === instanceId);
            const candidates = before.filter(registration => registration.instanceId !== instanceId);
            if (!sourceBefore || candidates.length === 0) {
                const startedAtMs = Date.now();
                const trialId = crypto.randomBytes(16).toString('hex');
                await recordObservation({
                    version: 1,
                    trialId,
                    recordedAt: new Date().toISOString(),
                    startedAtMs,
                    environment: resolveEnvironment(),
                    kind: workspace.kind,
                    sourceInstanceId: instanceId,
                    targetInstanceId: null,
                    navigationUri: null,
                    registrationCountBefore: before.length,
                    registrationCountAfter: before.length,
                    authoritativeWindowCountBefore: null,
                    authoritativeWindowCountAfter: null,
                    authoritativeWindowCountSource: null,
                    evidenceSourceId: null,
                    evidenceArtifactRef: null,
                    evidenceSha256: null,
                    sourceHeartbeatBeforeMs: sourceBefore ? sourceBefore.heartbeatAtMs : 0,
                    sourceHeartbeatAfterMs: null,
                    targetFocusSequenceBefore: 0,
                    targetFocusSequenceAfter: null,
                    targetFocusedAtMs: null,
                    outcome: 'not-runnable',
                    reason: 'No other live, explicitly started probe registration is available as a target.',
                });
                return;
            }
            const selected = await vscode.window.showQuickPick(
                candidates.map(target => ({
                    label: target.displayName,
                    description: `${target.environment} · ${target.kind}`,
                    detail: `${target.instanceId} · ${target.navigationUri}`,
                    target,
                })),
                { placeHolder: 'Select an already open target workspace' }
            );
            if (!selected) { return; }

            const target = selected.target;
            const startedAtMs = Date.now();
            const trialId = crypto.randomBytes(16).toString('hex');
            let commandError: string | null = null;
            try {
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.parse(target.navigationUri),
                    { forceNewWindow: true }
                );
            } catch (error) {
                commandError = `vscode.openFolder failed: ${errorMessage(error)}`;
            }
            await delay(OBSERVATION_DELAY_MS);
            const after = await scanRegistrations(registrationsDirectory);
            const sourceAfter = after.find(registration => registration.instanceId === instanceId);
            const targetAfter = after.find(registration => registration.instanceId === target.instanceId);
            const classification = classifyProbeOutcome({
                commandError,
                registrationCountBefore: before.length,
                registrationCountAfter: after.length,
                startedAtMs,
                sourceHeartbeatBeforeMs: sourceBefore.heartbeatAtMs,
                sourceHeartbeatAfterMs: sourceAfter ? sourceAfter.heartbeatAtMs : null,
            });
            await recordObservation({
                version: 1,
                trialId,
                recordedAt: new Date().toISOString(),
                startedAtMs,
                environment: target.environment,
                kind: target.kind,
                sourceInstanceId: instanceId,
                targetInstanceId: target.instanceId,
                navigationUri: target.navigationUri,
                registrationCountBefore: before.length,
                registrationCountAfter: after.length,
                authoritativeWindowCountBefore: null,
                authoritativeWindowCountAfter: null,
                authoritativeWindowCountSource: null,
                evidenceSourceId: null,
                evidenceArtifactRef: null,
                evidenceSha256: null,
                sourceHeartbeatBeforeMs: sourceBefore.heartbeatAtMs,
                sourceHeartbeatAfterMs: sourceAfter ? sourceAfter.heartbeatAtMs : null,
                targetFocusSequenceBefore: target.focusSequence,
                targetFocusSequenceAfter: targetAfter ? targetAfter.focusSequence : null,
                targetFocusedAtMs: targetAfter ? targetAfter.focusedAtMs : null,
                outcome: classification.outcome,
                reason: classification.reason,
            });
        }
    );
    const statusDisposable = vscode.commands.registerCommand(
        'projectStewardWorkspaceNavigationProbe.showStatus',
        async () => {
            output.appendLine(`WORKSPACE_NAVIGATION_PROBE_STATUS ${JSON.stringify({
                instanceId,
                workspace,
                environment: resolveEnvironment(),
                lifecycleStarted: heartbeat !== null,
                liveRegistrations: await scanRegistrations(registrationsDirectory),
            })}`);
            output.show(true);
        }
    );

    context.subscriptions.push(
        output,
        startDisposable,
        stopDisposable,
        runDisposable,
        statusDisposable,
        { dispose: () => { void stopLifecycle(); } }
    );
}
