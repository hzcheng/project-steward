import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type WorkspaceKind = 'singleFolder' | 'savedMultiRoot' | 'untitledMultiRoot';
type ProbeEnvironment = 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';
type ProbeOutcome =
    | 'focused-existing'
    | 'opened-duplicate'
    | 'replaced-source'
    | 'unsupported'
    | 'not-runnable';

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
    updatedAtMs: number;
}

interface ProbeObservation {
    version: 1;
    recordedAt: string;
    environment: ProbeEnvironment;
    kind: WorkspaceKind;
    sourceInstanceId: string;
    targetInstanceId: string | null;
    navigationUri: string | null;
    windowCountBefore: number;
    windowCountAfter: number;
    targetFocusSequenceBefore: number;
    targetFocusSequenceAfter: number | null;
    outcome: ProbeOutcome;
    reason: string | null;
}

const REGISTRATION_TTL_MS = 5_000;
const OBSERVATION_DELAY_MS = 1_500;
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
    if (!workspaceFile || folders.length < 1) {
        return null;
    }
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
    let focused = true;
    let focusSequence = 0;
    let focusedAtMs = Date.now();

    async function publishRegistration(): Promise<void> {
        if (!workspace) { return; }
        const registration: ProbeRegistration = {
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
            updatedAtMs: Date.now(),
        };
        await writeJsonAtomically(registrationPath, registration);
    }

    const heartbeat = setInterval(() => {
        publishRegistration().catch(error => output.appendLine(`registration error: ${errorMessage(error)}`));
    }, 1_000);
    void publishRegistration();

    const focusDisposable = vscode.window.onDidChangeWindowState(state => {
        focused = state.focused;
        if (focused) {
            focusSequence += 1;
            focusedAtMs = Date.now();
        }
        void publishRegistration();
    });

    const runDisposable = vscode.commands.registerCommand(
        'projectStewardWorkspaceNavigationProbe.run',
        async () => {
            if (!workspace) {
                vscode.window.showWarningMessage('Workspace navigation probe requires a folder or multi-root workspace.');
                return;
            }
            await publishRegistration();
            const before = await scanRegistrations(registrationsDirectory);
            const candidates = before.filter(registration => registration.instanceId !== instanceId);
            if (candidates.length === 0) {
                const observation: ProbeObservation = {
                    version: 1,
                    recordedAt: new Date().toISOString(),
                    environment: resolveEnvironment(),
                    kind: workspace.kind,
                    sourceInstanceId: instanceId,
                    targetInstanceId: null,
                    navigationUri: null,
                    windowCountBefore: before.length,
                    windowCountAfter: before.length,
                    targetFocusSequenceBefore: 0,
                    targetFocusSequenceAfter: null,
                    outcome: 'not-runnable',
                    reason: 'No other live probe registration is available as a controlled target.',
                };
                const resultPath = path.join(resultsDirectory, `${Date.now()}-${instanceId}-none.json`);
                await writeJsonAtomically(resultPath, observation);
                output.appendLine(`WORKSPACE_NAVIGATION_PROBE ${JSON.stringify(observation)}`);
                output.show(true);
                vscode.window.showWarningMessage(`Workspace navigation probe: ${observation.reason}`);
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
            let reason: string | null = null;
            try {
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.parse(target.navigationUri),
                    { forceNewWindow: true }
                );
            } catch (error) {
                reason = `vscode.openFolder failed: ${errorMessage(error)}`;
            }
            await delay(OBSERVATION_DELAY_MS);
            const after = await scanRegistrations(registrationsDirectory);
            const sourceAfter = after.find(registration => registration.instanceId === instanceId);
            const targetAfter = after.find(registration => registration.instanceId === target.instanceId);
            let outcome: ProbeOutcome;
            if (reason) {
                outcome = 'unsupported';
            } else if (after.length > before.length) {
                outcome = 'opened-duplicate';
                reason = 'Live workspace-extension instance count increased after vscode.openFolder.';
            } else if (!sourceAfter) {
                outcome = 'replaced-source';
                reason = 'The source workspace-extension instance disappeared after vscode.openFolder.';
            } else if (targetAfter
                && targetAfter.focusSequence > target.focusSequence
                && targetAfter.focusedAtMs >= startedAtMs
                && after.length === before.length) {
                outcome = 'focused-existing';
            } else {
                outcome = 'unsupported';
                reason = 'The target focus event was not observed with an unchanged live instance count.';
            }

            const observation: ProbeObservation = {
                version: 1,
                recordedAt: new Date().toISOString(),
                environment: target.environment,
                kind: target.kind,
                sourceInstanceId: instanceId,
                targetInstanceId: target.instanceId,
                navigationUri: target.navigationUri,
                windowCountBefore: before.length,
                windowCountAfter: after.length,
                targetFocusSequenceBefore: target.focusSequence,
                targetFocusSequenceAfter: targetAfter ? targetAfter.focusSequence : null,
                outcome,
                reason,
            };
            const resultPath = path.join(
                resultsDirectory,
                `${Date.now()}-${instanceId}-${target.instanceId}.json`
            );
            await writeJsonAtomically(resultPath, observation);
            output.appendLine(`WORKSPACE_NAVIGATION_PROBE ${JSON.stringify(observation)}`);
            output.show(true);
            vscode.window.showInformationMessage(`Workspace navigation probe: ${outcome}`);
        }
    );

    const statusDisposable = vscode.commands.registerCommand(
        'projectStewardWorkspaceNavigationProbe.showStatus',
        async () => {
            const registrations = await scanRegistrations(registrationsDirectory);
            output.appendLine(`WORKSPACE_NAVIGATION_PROBE_STATUS ${JSON.stringify({
                instanceId,
                workspace,
                environment: resolveEnvironment(),
                liveRegistrations: registrations,
            })}`);
            output.show(true);
        }
    );

    context.subscriptions.push(
        output,
        focusDisposable,
        runDisposable,
        statusDisposable,
        {
            dispose: () => {
                clearInterval(heartbeat);
                fs.promises.unlink(registrationPath).catch(error => {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        output.appendLine(`registration cleanup error: ${errorMessage(error)}`);
                    }
                });
            },
        }
    );
}
