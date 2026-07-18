'use strict';

import type * as vscode from 'vscode';
import { serializeTmuxLaunchCommand } from './launchSpec';
import type {
    AiSessionCreateRuntimeRequest,
    AiSessionExecutableRuntimeBackend,
    AiSessionPendingRuntimeSnapshot,
    AiSessionResumeRuntimeRequest,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import { getTmuxRuntimeKey, ProjectTmuxLayout, SessionTmuxLayout } from './tmuxLayout';
import { TmuxAttachBinding, TmuxAttachBindingStore } from './tmuxAttachBindingStore';
import { TmuxClient } from './tmuxClient';
import { TmuxRuntimeBindingStore, TmuxPendingRuntimeBinding } from './tmuxRuntimeBindingStore';
import { TmuxRuntimeDiscovery } from './tmuxRuntimeDiscovery';

const PROJECT_BOOTSTRAP_WINDOW = 'project-steward';
const SESSION_WINDOW = 'ai-session';
const PROJECT_BOOTSTRAP_COMMAND = 'exec /bin/sh';
const TERMINAL_PROCESS_ID_TIMEOUT_MS = 2000;

interface AttachTerminal {
    readonly name: string;
    readonly processId: number | PromiseLike<number | undefined>;
    show(): void;
    dispose(): void;
}

interface AttachEntry<TTerminal> {
    terminal: TTerminal;
    binding: TmuxAttachBinding;
}

export interface TmuxRuntimeBackendDependencies<TTerminal> {
    platform: NodeJS.Platform;
    client: TmuxClient;
    discovery: TmuxRuntimeDiscovery;
    runtimeStore: TmuxRuntimeBindingStore;
    attachStore: TmuxAttachBindingStore;
    withCreationLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
    createTerminal(options: vscode.TerminalOptions): TTerminal;
    nowMs(): number;
}

export class TmuxRuntimeBackend<TTerminal = vscode.Terminal>
implements AiSessionExecutableRuntimeBackend<TTerminal> {
    private readonly attaches = new Map<string, AttachEntry<TTerminal>>();
    private readonly ambiguousCreations = new Set<string>();
    private readonly ambiguousPromotions = new Set<string>();

    constructor(private readonly dependencies: TmuxRuntimeBackendDependencies<TTerminal>) { }

    refresh(force: boolean = false): Promise<void> {
        return this.dependencies.discovery.refresh(force);
    }

    getActive(): AiSessionRuntimeSnapshot<TTerminal>[] {
        return this.dependencies.discovery.getActive().map(runtime => this.withAttach(runtime));
    }

    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[] {
        return this.dependencies.discovery.getPending().map(runtime =>
            this.withAttach(runtime) as AiSessionPendingRuntimeSnapshot<TTerminal>);
    }

    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[] {
        return this.dependencies.discovery.find(identity).map(runtime => this.withAttach(runtime));
    }

    async ensureResume(
        request: AiSessionResumeRuntimeRequest,
        layout: AiSessionTmuxLayout = 'project'
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>> {
        await this.requireAvailable();
        const identity = finalIdentity(request.identity);
        const locator = getFinalLocator(identity, layout);
        const lockKey = getTmuxRuntimeKey(identity);
        const runtime = await this.dependencies.withCreationLock(lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            const existing = this.findVerified(identity, locator);
            if (existing) {
                return existing;
            }
            if (this.ambiguousCreations.has(lockKey)) {
                throw new Error('The prior tmux creation result is ambiguous; the provider command was not sent again.');
            }
            return this.createFinalRuntime(request, layout, locator, lockKey);
        });
        return this.attachAndFocus(runtime, request.terminalName);
    }

    async ensurePending(
        request: AiSessionCreateRuntimeRequest,
        layout: AiSessionTmuxLayout = 'project'
    ): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>> {
        await this.requireAvailable();
        const identity = pendingIdentity(request.identity);
        const locator = getPendingLocator(identity, layout);
        const lockKey = getTmuxRuntimeKey(identity);
        const runtime = await this.dependencies.withCreationLock(lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            const existing = this.findVerified(identity, locator) as AiSessionPendingRuntimeSnapshot | undefined;
            if (existing) {
                return existing;
            }
            if (this.ambiguousCreations.has(lockKey)) {
                throw new Error('The prior tmux creation result is ambiguous; the provider command was not sent again.');
            }
            return this.createPendingRuntime(request, layout, locator, lockKey);
        });
        return this.attachAndFocus(runtime, request.terminalName) as Promise<AiSessionPendingRuntimeSnapshot<TTerminal>>;
    }

    async promotePending(pendingId: string, sessionId: string): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        await this.requireAvailable();
        await this.dependencies.discovery.refresh(true);
        const pending = this.dependencies.discovery.getPending()
            .find(runtime => runtime.identity.pendingId === pendingId);
        if (!pending || !pending.tmux || !sessionId) {
            return [];
        }
        const lockKey = getTmuxRuntimeKey(pending.identity);
        return this.dependencies.withCreationLock<AiSessionRuntimeSnapshot<TTerminal>[]>(lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            const currentPending = this.dependencies.discovery.getPending()
                .find(runtime => runtime.identity.pendingId === pendingId && !!runtime.tmux);
            if (!currentPending || !currentPending.tmux) {
                return [];
            }
            const identity: AiSessionRuntimeIdentity = {
                provider: currentPending.identity.provider,
                projectKey: currentPending.identity.projectKey,
                cwd: currentPending.identity.cwd,
                sessionId,
            };
            const finalLocator = getFinalLocator(identity, currentPending.tmux.layout);
            const finalLockKey = getTmuxRuntimeKey(identity);
            return this.dependencies.withCreationLock<AiSessionRuntimeSnapshot<TTerminal>[]>(
                finalLockKey,
                async () => {
                    await this.dependencies.discovery.refresh(true);
                    const compatible = this.findVerified(identity, finalLocator);
                    if (compatible) {
                        return [this.withAttach(asConflict(compatible)), this.withAttach(asConflict(currentPending))];
                    }
                    if (await this.locatorIsOccupied(finalLocator)) {
                        return [this.withAttach(asConflict(currentPending))];
                    }
                    if (this.ambiguousPromotions.has(lockKey)) {
                        return [this.withAttach(asConflict(currentPending))];
                    }

                    try {
                        await this.dependencies.client.clearPendingMetadata(currentPending.tmux);
                        await this.renameRuntime(currentPending.tmux, finalLocator);
                        await this.writeFinalMetadata(identity, finalLocator, {
                            createdAt: currentPending.createdAt,
                            markerPath: currentPending.markerPath,
                        });
                        await this.persistKnown(identity, finalLocator);
                        await this.dependencies.runtimeStore.removePending(pendingId);
                    } catch (error) {
                        this.ambiguousPromotions.add(lockKey);
                        await this.dependencies.discovery.refresh(true);
                        const recovered = this.findVerified(identity, finalLocator);
                        if (!recovered) {
                            throw error;
                        }
                        await this.persistKnown(identity, finalLocator);
                        await this.dependencies.runtimeStore.removePending(pendingId);
                    }

                    await this.dependencies.discovery.refresh(true);
                    const promoted = this.findVerified(identity, finalLocator);
                    if (!promoted) {
                        throw new Error('The promoted tmux runtime could not be verified.');
                    }
                    await this.migrateAttach(currentPending, promoted);
                    return [this.withAttach(promoted)];
                }
            );
        });
    }

    async focus(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (!runtime || runtime.backend !== 'tmux' || !runtime.tmux) {
            return;
        }
        await this.dependencies.client.selectWindow(runtime.tmux);
        const entry = this.attaches.get(registryKey(runtime));
        if (entry) {
            attachTerminal(entry.terminal).show();
        }
    }

    async detach(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (!runtime || runtime.backend !== 'tmux') {
            return;
        }
        const key = registryKey(runtime);
        const entry = this.attaches.get(key);
        if (!entry) {
            return;
        }
        this.attaches.delete(key);
        const terminal = attachTerminal(entry.terminal);
        this.dependencies.attachStore.remove(terminal.processId);
        terminal.dispose();
    }

    async restoreAttachTerminals(terminals: readonly TTerminal[]): Promise<void> {
        await this.dependencies.discovery.refresh(true);
        for (const terminal of terminals || []) {
            const attach = attachTerminal(terminal);
            const processId = await resolveProcessId(attach.processId);
            if (processId === null) {
                continue;
            }
            const binding = this.dependencies.attachStore.get(processId);
            const runtime = binding && terminalTitleMatches(attach.name, binding)
                ? this.runtimeForBinding(binding)
                : undefined;
            if (!binding || !runtime || this.attaches.has(registryKey(runtime))) {
                this.dependencies.attachStore.remove(processId);
                continue;
            }
            this.attaches.set(registryKey(runtime), { terminal, binding });
        }
        await this.dependencies.attachStore.flush();
    }

    handleClosedTerminal(terminal: TTerminal): void {
        for (const [key, entry] of this.attaches) {
            if (entry.terminal !== terminal) {
                continue;
            }
            this.attaches.delete(key);
            this.dependencies.attachStore.remove(attachTerminal(terminal).processId);
        }
    }

    private async createFinalRuntime(
        request: AiSessionResumeRuntimeRequest,
        layout: AiSessionTmuxLayout,
        locator: AiSessionTmuxLocator,
        lockKey: string
    ): Promise<AiSessionRuntimeSnapshot> {
        const createdAt = new Date(this.dependencies.nowMs()).toISOString();
        try {
            await this.createTarget(layout, locator, request.identity.cwd,
                serializeTmuxLaunchCommand(request.launch), request.identity.projectKey);
            await this.writeFinalMetadata(request.identity, locator, {
                createdAt,
                markerPath: request.launch.markerPath || '',
            });
            await this.persistKnown(request.identity, locator);
        } catch (error) {
            return this.recoverAmbiguousCreation(request.identity, locator, lockKey, error);
        }
        return this.verifyCreated(request.identity, locator);
    }

    private async createPendingRuntime(
        request: AiSessionCreateRuntimeRequest,
        layout: AiSessionTmuxLayout,
        locator: AiSessionTmuxLocator,
        lockKey: string
    ): Promise<AiSessionPendingRuntimeSnapshot> {
        const binding: TmuxPendingRuntimeBinding = {
            version: 1,
            state: 'pending',
            pendingId: request.identity.pendingId,
            provider: request.identity.provider,
            projectKey: request.identity.projectKey,
            cwd: request.identity.cwd,
            createdAt: request.createdAt,
            excludedSessionIds: [...request.excludedSessionIds],
            ...(request.title === undefined ? {} : { title: request.title }),
            layout,
            locator: { ...locator },
        };
        try {
            await this.createTarget(layout, locator, request.identity.cwd,
                serializeTmuxLaunchCommand(request.launch), request.identity.projectKey);
            await this.writePendingMetadata(request.identity, locator, request.createdAt,
                request.launch.markerPath || '');
            await this.dependencies.runtimeStore.setPending(binding);
        } catch (error) {
            this.ambiguousCreations.add(lockKey);
            await this.dependencies.runtimeStore.setPending(binding);
            await this.dependencies.discovery.refresh(true);
            const recovered = this.findVerified(request.identity, locator) as AiSessionPendingRuntimeSnapshot | undefined;
            if (!recovered) {
                throw error;
            }
            return recovered;
        }
        return this.verifyCreated(request.identity, locator) as Promise<AiSessionPendingRuntimeSnapshot>;
    }

    private async createTarget(
        layout: AiSessionTmuxLayout,
        locator: AiSessionTmuxLocator,
        cwd: string,
        command: string,
        projectKey: string
    ): Promise<void> {
        if (layout === 'session') {
            if (await this.dependencies.client.hasSession(locator.sessionName)) {
                throw new Error('The requested tmux session name is already occupied by an unverified target.');
            }
            await this.dependencies.client.createSession(locator.sessionName, SESSION_WINDOW, cwd, command);
            await this.dependencies.client.configureManagedWindow(locator.sessionName, SESSION_WINDOW);
            return;
        }

        const compatibleContainer = this.projectContainerIsVerified(locator);
        const hasSession = await this.dependencies.client.hasSession(locator.sessionName);
        if (hasSession && !compatibleContainer) {
            throw new Error('The requested project tmux session is occupied by an unverified target.');
        }
        if (!hasSession) {
            await this.dependencies.client.createSession(
                locator.sessionName, PROJECT_BOOTSTRAP_WINDOW, cwd, PROJECT_BOOTSTRAP_COMMAND
            );
            await this.dependencies.client.setSessionOptions(locator.sessionName,
                projectSessionMetadata(projectKey));
        }
        if (!locator.windowName) {
            throw new Error('A project tmux runtime requires a window name.');
        }
        if (await this.locatorIsOccupied(locator)) {
            throw new Error('The requested project tmux window is occupied by an unverified target.');
        }
        await this.dependencies.client.createWindow(locator.sessionName, locator.windowName, cwd, command);
        await this.dependencies.client.configureManagedWindow(locator.sessionName, locator.windowName);
    }

    private projectContainerIsVerified(locator: AiSessionTmuxLocator): boolean {
        return [...this.dependencies.discovery.getActive(), ...this.dependencies.discovery.getPending()]
            .some(runtime => runtime.tmux?.layout === 'project'
                && runtime.tmux.sessionName === locator.sessionName
                && runtime.identity.projectKey.length > 0);
    }

    private async writeFinalMetadata(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        lifecycle: { createdAt: string; markerPath: string }
    ): Promise<void> {
        const full = fullMetadata(identity, locator.layout, lifecycle.createdAt, lifecycle.markerPath);
        if (locator.layout === 'project') {
            if (!locator.windowName) {
                throw new Error('A project tmux runtime requires a window name.');
            }
            await this.dependencies.client.setSessionOptions(locator.sessionName,
                projectSessionMetadata(identity.projectKey));
            await this.dependencies.client.setWindowOptions(locator.sessionName, locator.windowName, full);
            return;
        }
        await this.dependencies.client.setSessionOptions(locator.sessionName, full);
        await this.dependencies.client.setWindowOptions(locator.sessionName, SESSION_WINDOW,
            sessionWindowMetadata());
    }

    private async writePendingMetadata(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        createdAt: string,
        markerPath: string
    ): Promise<void> {
        return this.writeFinalMetadata(identity, locator, { createdAt, markerPath });
    }

    private async persistKnown(identity: AiSessionRuntimeIdentity, locator: AiSessionTmuxLocator): Promise<void> {
        if (!identity.sessionId) {
            throw new Error('A known tmux runtime requires a session ID.');
        }
        await this.dependencies.runtimeStore.setKnown({
            version: 1,
            state: 'known',
            provider: identity.provider,
            sessionId: identity.sessionId,
            projectKey: identity.projectKey,
            layout: locator.layout,
            locator: { ...locator },
            lastSeenAtMs: this.dependencies.nowMs(),
        });
    }

    private async verifyCreated(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator
    ): Promise<AiSessionRuntimeSnapshot> {
        await this.dependencies.discovery.refresh(true);
        const runtime = this.findVerified(identity, locator);
        if (!runtime) {
            throw new Error('The created tmux runtime could not be verified.');
        }
        return runtime;
    }

    private async recoverAmbiguousCreation(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        lockKey: string,
        error: unknown
    ): Promise<AiSessionRuntimeSnapshot> {
        this.ambiguousCreations.add(lockKey);
        await this.dependencies.discovery.refresh(true);
        const recovered = this.findVerified(identity, locator);
        if (!recovered) {
            throw error;
        }
        await this.persistKnown(identity, locator);
        return recovered;
    }

    private findVerified(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator
    ): AiSessionRuntimeSnapshot | undefined {
        return this.dependencies.discovery.find(identity)
            .find(runtime => !!runtime.tmux && locatorsEqual(runtime.tmux, locator));
    }

    private async attachAndFocus<T extends AiSessionRuntimeSnapshot>(
        runtime: T,
        terminalName: string
    ): Promise<T & AiSessionRuntimeSnapshot<TTerminal>> {
        if (!runtime.tmux) {
            throw new Error('A tmux runtime must include a locator.');
        }
        await this.dependencies.client.selectWindow(runtime.tmux);
        const key = registryKey(runtime);
        let entry = this.attaches.get(key);
        if (!entry) {
            const binding = attachBinding(runtime, terminalName);
            const terminal = this.dependencies.createTerminal({
                name: terminalName,
                shellPath: this.dependencies.client.getExecutablePath(),
                shellArgs: ['attach-session', '-t', runtime.tmux.sessionName],
                env: { TMUX: null },
            });
            entry = { terminal, binding };
            this.attaches.set(key, entry);
            this.dependencies.attachStore.set(attachTerminal(terminal).processId, binding);
        }
        try {
            attachTerminal(entry.terminal).show();
        } catch (error) {
            this.attaches.delete(key);
            this.dependencies.attachStore.remove(attachTerminal(entry.terminal).processId);
            throw error;
        }
        return this.withAttach(runtime) as T & AiSessionRuntimeSnapshot<TTerminal>;
    }

    private withAttach(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot<TTerminal> {
        const entry = this.attaches.get(registryKey(runtime));
        const { terminal: _terminal, ...base } = runtime;
        return {
            ...base,
            identity: { ...runtime.identity },
            attached: !!entry,
            ...(entry ? { terminal: entry.terminal } : {}),
            ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        };
    }

    private async requireAvailable(): Promise<void> {
        if (this.dependencies.platform === 'win32') {
            throw new Error('Managed tmux runtimes require a POSIX extension host.');
        }
        const availability = await this.dependencies.client.checkAvailability();
        if ('category' in availability) {
            throw new Error(availability.message);
        }
    }

    private runtimeForBinding(binding: TmuxAttachBinding): AiSessionRuntimeSnapshot | undefined {
        const runtimes = [
            ...this.dependencies.discovery.getActive(),
            ...this.dependencies.discovery.getPending(),
        ];
        if (binding.layout === 'project') {
            return runtimes.find(runtime => runtime.tmux?.layout === 'project'
                && runtime.identity.projectKey === binding.projectKey
                && runtime.tmux.sessionName === binding.sessionName);
        }
        return runtimes.find(runtime => runtime.tmux?.layout === 'session'
            && runtime.identity.projectKey === binding.projectKey
            && runtime.tmux.sessionName === binding.sessionName
            && (!binding.provider || runtime.identity.provider === binding.provider)
            && (!binding.sessionId || runtime.identity.sessionId === binding.sessionId));
    }

    private async locatorIsOccupied(locator: AiSessionTmuxLocator): Promise<boolean> {
        const rows = await this.dependencies.client.listWindows();
        return rows.some(row => row.sessionName === locator.sessionName
            && (locator.layout === 'session' || row.windowName === locator.windowName));
    }

    private async renameRuntime(from: AiSessionTmuxLocator, to: AiSessionTmuxLocator): Promise<void> {
        if (from.layout !== to.layout) {
            throw new Error('A tmux runtime cannot change layout during promotion.');
        }
        if (from.layout === 'project') {
            if (!from.windowName || !to.windowName || from.sessionName !== to.sessionName) {
                throw new Error('A project tmux promotion requires two windows in the same session.');
            }
            await this.dependencies.client.renameWindow(from.sessionName, from.windowName, to.windowName);
            return;
        }
        await this.dependencies.client.renameSession(from.sessionName, to.sessionName);
    }

    private async migrateAttach(
        pending: AiSessionRuntimeSnapshot,
        promoted: AiSessionRuntimeSnapshot
    ): Promise<void> {
        const oldKey = registryKey(pending);
        const newKey = registryKey(promoted);
        if (oldKey === newKey) {
            return;
        }
        const entry = this.attaches.get(oldKey);
        if (!entry) {
            return;
        }
        this.attaches.delete(oldKey);
        const binding = attachBinding(promoted, entry.binding.terminalNamePrefix);
        this.attaches.set(newKey, { terminal: entry.terminal, binding });
        this.dependencies.attachStore.set(attachTerminal(entry.terminal).processId, binding);
        await this.dependencies.attachStore.flush();
    }
}

function finalIdentity(identity: AiSessionRuntimeIdentity & { sessionId: string }): AiSessionRuntimeIdentity {
    return {
        provider: identity.provider,
        projectKey: identity.projectKey,
        cwd: identity.cwd,
        sessionId: identity.sessionId,
    };
}

function pendingIdentity(identity: AiSessionRuntimeIdentity & { pendingId: string }): AiSessionRuntimeIdentity {
    return {
        provider: identity.provider,
        projectKey: identity.projectKey,
        cwd: identity.cwd,
        pendingId: identity.pendingId,
    };
}

function getFinalLocator(identity: AiSessionRuntimeIdentity, layout: AiSessionTmuxLayout): AiSessionTmuxLocator {
    return layout === 'project'
        ? new ProjectTmuxLayout().getLocator(identity)
        : new SessionTmuxLayout().getLocator(identity);
}

function getPendingLocator(identity: AiSessionRuntimeIdentity, layout: AiSessionTmuxLayout): AiSessionTmuxLocator {
    return layout === 'project'
        ? new ProjectTmuxLayout().getPendingLocator(identity)
        : new SessionTmuxLayout().getPendingLocator(identity);
}

function projectSessionMetadata(projectKey: string): Record<string, string> {
    return {
        managed: '1',
        version: '1',
        layout: 'project',
        projectKey,
    };
}

function sessionWindowMetadata(): Record<string, string> {
    return { managed: '1', version: '1', layout: 'session' };
}

function fullMetadata(
    identity: AiSessionRuntimeIdentity,
    layout: AiSessionTmuxLayout,
    createdAt: string,
    markerPath: string
): Record<string, string> {
    return {
        managed: '1',
        version: '1',
        layout,
        ...(layout === 'session' ? { projectKey: identity.projectKey } : {}),
        provider: identity.provider,
        ...(identity.sessionId ? { sessionId: identity.sessionId } : { pendingId: identity.pendingId as string }),
        createdAt,
        ...(markerPath ? { marker: markerPath } : {}),
    };
}

function attachBinding(runtime: AiSessionRuntimeSnapshot, terminalName: string): TmuxAttachBinding {
    if (!runtime.tmux) {
        throw new Error('A tmux attach binding requires a locator.');
    }
    return {
        version: 1,
        layout: runtime.tmux.layout,
        projectKey: runtime.identity.projectKey,
        sessionName: runtime.tmux.sessionName,
        ...(runtime.tmux.layout === 'project' && runtime.tmux.windowName
            ? { windowName: runtime.tmux.windowName }
            : {}),
        ...(runtime.tmux.layout === 'session' ? { provider: runtime.identity.provider } : {}),
        ...(runtime.tmux.layout === 'session' && runtime.identity.sessionId
            ? { sessionId: runtime.identity.sessionId }
            : {}),
        terminalNamePrefix: terminalName,
    };
}

function registryKey(runtime: AiSessionRuntimeSnapshot): string {
    if (runtime.tmux?.layout === 'project') {
        return `project:${runtime.identity.projectKey}`;
    }
    const identityId = runtime.identity.sessionId || `pending:${runtime.identity.pendingId || ''}`;
    return `session:${runtime.identity.provider}:${identityId}`;
}

function attachTerminal<TTerminal>(terminal: TTerminal): AttachTerminal {
    return terminal as unknown as AttachTerminal;
}

function terminalTitleMatches(title: string, binding: TmuxAttachBinding): boolean {
    return typeof title === 'string' && title.startsWith(binding.terminalNamePrefix);
}

function resolveProcessId(value: AttachTerminal['processId']): Promise<number | null> {
    return new Promise(resolve => {
        let settled = false;
        const settle = (processId: number | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve(typeof processId === 'number' && Number.isSafeInteger(processId) && processId > 0
                ? processId
                : null);
        };
        const timeout = setTimeout(() => settle(undefined), TERMINAL_PROCESS_ID_TIMEOUT_MS);
        Promise.resolve(value).then(settle, () => settle(undefined));
    });
}

function locatorsEqual(left: AiSessionTmuxLocator, right: AiSessionTmuxLocator): boolean {
    return left.layout === right.layout
        && left.sessionName === right.sessionName
        && left.windowName === right.windowName;
}

function asConflict(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot {
    return {
        ...runtime,
        identity: { ...runtime.identity },
        state: 'conflict',
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}
