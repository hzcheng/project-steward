'use strict';

import { createHash } from 'crypto';
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
    TmuxRuntimeUnavailableReason,
} from './runtimeTypes';
import { TmuxRuntimeUnavailableError } from './runtimeTypes';
import { getTmuxRuntimeKey, ProjectTmuxLayout, SessionTmuxLayout } from './tmuxLayout';
import { TmuxAttachBinding, TmuxAttachBindingStore } from './tmuxAttachBindingStore';
import { TmuxClient, TmuxClientError } from './tmuxClient';
import {
    TmuxAmbiguousRuntimeBinding,
    TmuxConsumedPendingBinding,
    TmuxPromotingRuntimeBinding,
    TmuxRuntimeBindingStore,
    TmuxPendingRuntimeBinding,
    validateTmuxPendingRuntimeBinding,
} from './tmuxRuntimeBindingStore';
import { TmuxRuntimeDiscovery } from './tmuxRuntimeDiscovery';

const PROJECT_BOOTSTRAP_WINDOW = 'project-steward';
const SESSION_WINDOW = 'ai-session';
const PROJECT_BOOTSTRAP_COMMAND = 'exec /bin/sh';
const TERMINAL_PROCESS_ID_TIMEOUT_MS = 2000;
const MAX_LOCAL_PATH_LENGTH = 4096;
const MAX_IDENTITY_FIELD_LENGTH = 512;
const MAX_EXECUTABLE_LENGTH = 4096;
const MAX_LAUNCH_ARGUMENT_BYTES = 16 * 1024;
const MAX_LAUNCH_ARGUMENTS = 256;
const MAX_EXCLUDED_SESSION_IDS = 1000;
const MAX_AGGREGATE_LAUNCH_BYTES = 32 * 1024;
const MAX_SERIALIZED_TMUX_COMMAND_BYTES = 128 * 1024;
const LOCAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

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

    constructor(private readonly dependencies: TmuxRuntimeBackendDependencies<TTerminal>) { }

    async refresh(force: boolean = false): Promise<void> {
        await this.requireAvailable();
        try {
            await this.dependencies.discovery.refresh(force);
        } catch (error) {
            const unavailable = readOnlyRefreshUnavailableError(error);
            throw unavailable || error;
        }
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
        request = snapshotResumeRequest(request);
        requireLayout(layout);
        validateDispatchInputs(request.identity, request.launch);
        await this.requireAvailable();
        const identity = finalIdentity(request.identity);
        const locator = getFinalLocator(identity, layout);
        const lockKey = getTmuxRuntimeKey(identity);
        const runtime = await this.withCreationLocks(identity, layout, lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            const existing = this.findVerified(identity, locator);
            if (existing) {
                await this.dependencies.runtimeStore.removeAmbiguous(identity);
                return existing;
            }
            const ambiguous = await this.dependencies.runtimeStore.getAmbiguous(identity);
            if (ambiguous) {
                throw new Error('The prior tmux creation result is ambiguous; the provider command was not sent again.');
            }
            return this.createFinalRuntime(request, layout, locator);
        });
        return this.attachAndFocus(runtime, request.terminalName);
    }

    async ensurePending(
        request: AiSessionCreateRuntimeRequest,
        layout: AiSessionTmuxLayout = 'project'
    ): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>> {
        request = snapshotPendingRequest(request);
        requireLayout(layout);
        validateDispatchInputs(request.identity, request.launch);
        const identity = pendingIdentity(request.identity);
        await this.auditPendingId(identity);
        const locator = getPendingLocator(identity, layout);
        const binding = validateTmuxPendingRuntimeBinding({
            version: 1,
            state: 'pending',
            pendingId: identity.pendingId,
            provider: identity.provider,
            projectKey: identity.projectKey,
            cwd: identity.cwd,
            createdAt: request.createdAt,
            excludedSessionIds: request.excludedSessionIds,
            ...(request.title === undefined ? {} : { title: request.title }),
            acceptedAtMs: Date.parse(request.createdAt),
            layout,
            locator,
        }, this.dependencies.nowMs());
        if (!binding) {
            throw new Error('The pending runtime request is invalid or expired.');
        }
        await this.requireAvailable();
        const lockKey = pendingLifecycleLockKey(identity.pendingId as string);
        const runtime = await this.withCreationLocks(identity, layout, lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            const lifecycle = await this.auditPendingId(identity);
            const existing = this.findVerified(identity, locator) as AiSessionPendingRuntimeSnapshot | undefined;
            if (existing) {
                await this.dependencies.runtimeStore.removeAmbiguous(identity);
                return existing;
            }
            const ambiguous = lifecycle.ambiguous;
            if (ambiguous) {
                return this.recoverPendingAmbiguity(request, binding, locator, ambiguous);
            }
            const dispatchBinding = validateTmuxPendingRuntimeBinding({
                ...binding,
                acceptedAtMs: this.dependencies.nowMs(),
            }, this.dependencies.nowMs());
            if (!dispatchBinding) {
                throw new Error('The pending runtime request expired before provider dispatch.');
            }
            return this.createPendingRuntime(request, dispatchBinding, locator);
        });
        return this.attachAndFocus(runtime, request.terminalName) as Promise<AiSessionPendingRuntimeSnapshot<TTerminal>>;
    }

    private async auditPendingId(identity: AiSessionRuntimeIdentity): Promise<{
        ambiguous: TmuxAmbiguousRuntimeBinding | null;
        pending: TmuxPendingRuntimeBinding | null;
    }> {
        const pendingId = identity.pendingId as string;
        const promoting = await this.dependencies.runtimeStore.getPromotingByPendingId(pendingId);
        if (promoting && !pendingLifecycleIdentityMatches(promoting, identity)) {
            throw pendingIdentityConflictError();
        }
        if (promoting) {
            throw new Error('The pending tmux runtime has a promotion in progress.');
        }
        const consumed = await this.dependencies.runtimeStore.getConsumedByPendingId(pendingId);
        if (consumed && !pendingLifecycleIdentityMatches(consumed, identity)) {
            throw pendingIdentityConflictError();
        }
        if (consumed) {
            throw consumedPendingError(consumed);
        }
        const ambiguous = await this.dependencies.runtimeStore.getAmbiguousByPendingId(pendingId);
        if (ambiguous && !pendingLifecycleIdentityMatches(ambiguous, identity)) {
            throw pendingIdentityConflictError();
        }
        const pending = await this.dependencies.runtimeStore.getPending(pendingId);
        if (pending && !pendingLifecycleIdentityMatches(pending, identity)) {
            throw pendingIdentityConflictError();
        }
        return { ambiguous, pending };
    }

    async promotePending(pendingId: string, sessionId: string): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        if (!isIdentityField(pendingId) || !isIdentityField(sessionId)) {
            return [];
        }
        return this.dependencies.withCreationLock<AiSessionRuntimeSnapshot<TTerminal>[]>(
            pendingLifecycleLockKey(pendingId), async () => {
            const storedIntent = await this.dependencies.runtimeStore.getPromotingByPendingId(pendingId);
            const storedLiveBinding = await this.dependencies.runtimeStore.getPending(pendingId);
            if (storedIntent && storedLiveBinding
                && !promotionIntentMatchesLiveBinding(storedIntent, storedLiveBinding)) {
                throw new Error('The pending tmux promotion intent conflicts with the live pending binding.');
            }
            const storedPending = storedIntent?.pendingBinding
                || storedLiveBinding;
            if (!storedPending) {
                return [];
            }
            if (storedIntent && storedIntent.finalSessionId !== sessionId) {
                throw new Error('The pending tmux runtime has a conflicting promotion in progress.');
            }
            await this.requireAvailable();
            await this.dependencies.discovery.refresh(true);
            const pendingIdentityValue = identityFromPendingBinding(storedPending);
            const consumedByPendingId = await this.dependencies.runtimeStore.getConsumedByPendingId(pendingId);
            if (consumedByPendingId
                && !pendingLifecycleIdentityMatches(consumedByPendingId, pendingIdentityValue)) {
                throw pendingIdentityConflictError();
            }
            const ambiguousByPendingId = await this.dependencies.runtimeStore
                .getAmbiguousByPendingId(pendingId);
            if (ambiguousByPendingId
                && !pendingLifecycleIdentityMatches(ambiguousByPendingId, pendingIdentityValue)) {
                throw pendingIdentityConflictError();
            }
            if (ambiguousByPendingId) {
                throw new Error('The prior pending runtime creation result remains ambiguous.');
            }
            const currentIntent = await this.dependencies.runtimeStore.getPromoting(pendingIdentityValue);
            const freshBinding = await this.dependencies.runtimeStore.getPending(pendingId);
            if (currentIntent && freshBinding
                && !promotionIntentMatchesLiveBinding(currentIntent, freshBinding)) {
                throw new Error('The pending tmux promotion intent conflicts with the live pending binding.');
            }
            const currentBinding = currentIntent?.pendingBinding || freshBinding;
            if (!currentBinding || !pendingBindingsEqual(storedPending, currentBinding)
                || (storedIntent && (!currentIntent || !promotionIntentsMatch(storedIntent, currentIntent)))) {
                return [];
            }
            const currentPending = this.dependencies.discovery.getPending()
                .find(runtime => runtime.identity.pendingId === pendingId
                    && !!runtime.tmux && locatorsEqual(runtime.tmux, currentBinding.locator));
            const pendingSnapshot = currentPending || pendingSnapshotFromBinding(currentBinding);
            const identity: AiSessionRuntimeIdentity = {
                provider: currentBinding.provider,
                projectKey: currentBinding.projectKey,
                cwd: currentBinding.cwd,
                sessionId,
            };
            const finalLocator = getFinalLocator(identity, currentBinding.layout);
            const finalLockKey = getTmuxRuntimeKey(identity);
            return this.dependencies.withCreationLock<AiSessionRuntimeSnapshot<TTerminal>[]>(
                finalLockKey,
                async () => {
                    await this.dependencies.discovery.refresh(true);
                    const intent = await this.dependencies.runtimeStore.getPromoting(pendingIdentityValue);
                    const expectedIntent = promotionIntent(currentBinding, {
                        ...pendingSnapshot,
                        markerPath: intent?.markerPath ?? pendingSnapshot.markerPath,
                    }, identity, finalLocator, this.dependencies.nowMs());
                    if (intent && !promotionIntentsMatch(intent, expectedIntent)) {
                        throw new Error('The pending tmux runtime has a conflicting promotion in progress.');
                    }
                    const consumed = await this.dependencies.runtimeStore.getConsumed(pendingIdentityValue);
                    if (consumed) {
                        if (consumed.finalSessionId !== sessionId
                            || !locatorsEqual(consumed.finalLocator, finalLocator)) {
                            throw new Error('The pending tmux runtime was consumed by a different promotion.');
                        }
                        await this.dependencies.runtimeStore.removePromoting(pendingIdentityValue);
                        await this.dependencies.runtimeStore.removePending(pendingId);
                        const completed = this.findVerified(identity, finalLocator);
                        return completed ? [this.withAttach(completed)] : [];
                    }
                    const compatible = this.findVerified(identity, finalLocator);
                    if (compatible) {
                        if (!intent) {
                            return [this.withAttach(asConflict(compatible)), this.withAttach(asConflict(pendingSnapshot))];
                        }
                        return this.completePromotion(pendingSnapshot, identity, finalLocator,
                            compatible, pendingIdentityValue);
                    }
                    if (intent && await this.promotionTransitionMatches(intent, identity)) {
                        await this.writeFinalMetadata(identity, finalLocator, {
                            createdAt: intent.createdAt,
                            markerPath: intent.markerPath,
                        });
                        await this.dependencies.client.clearPendingMetadata(finalLocator);
                        return this.verifyAndCompletePromotion(pendingSnapshot, identity,
                            finalLocator, pendingIdentityValue);
                    }
                    const sourcePendingVerified = !!currentPending || !!(intent
                        && await this.pendingMetadataMatches(pendingIdentityValue,
                            intent.sourceLocator, intent.createdAt, intent.markerPath));
                    if (!sourcePendingVerified) {
                        throw new Error('The pending tmux promotion state is ambiguous; no mutation was attempted.');
                    }
                    if (await this.locatorIsOccupied(finalLocator)) {
                        return [this.withAttach(asConflict(pendingSnapshot))];
                    }

                    if (!intent && await this.dependencies.runtimeStore.setPromoting(expectedIntent) !== true) {
                        throw new Error('The pending tmux promotion intent could not be persisted.');
                    }
                    try {
                        const sourceLocator = currentPending?.tmux || currentBinding.locator;
                        await this.renameRuntime(sourceLocator, finalLocator);
                        await this.writeFinalMetadata(identity, finalLocator, {
                            createdAt: pendingSnapshot.createdAt,
                            markerPath: pendingSnapshot.markerPath,
                        });
                        await this.dependencies.client.clearPendingMetadata(finalLocator);
                    } catch (error) {
                        await this.dependencies.discovery.refresh(true);
                        const recovered = this.findVerified(identity, finalLocator);
                        if (!recovered) {
                            const sourceStillVerified = await this.pendingMetadataMatches(
                                pendingIdentityValue, currentBinding.locator,
                                pendingSnapshot.createdAt, pendingSnapshot.markerPath
                            );
                            if (sourceStillVerified && !await this.locatorIsOccupied(finalLocator)) {
                                await this.dependencies.runtimeStore.removePromoting(pendingIdentityValue);
                            }
                            throw error;
                        }
                    }
                    return this.verifyAndCompletePromotion(pendingSnapshot, identity,
                        finalLocator, pendingIdentityValue);
                }
            );
        });
    }

    private async promotionTransitionMatches(
        intent: TmuxPromotingRuntimeBinding,
        finalIdentityValue: AiSessionRuntimeIdentity
    ): Promise<boolean> {
        try {
            const sessionOptions = await this.dependencies.client.getSessionOptions(
                intent.finalLocator.sessionName
            );
            const windowName = intent.finalLocator.layout === 'project'
                ? intent.finalLocator.windowName
                : SESSION_WINDOW;
            if (!windowName) {
                return false;
            }
            const windowOptions = await this.dependencies.client.getWindowOptions(
                intent.finalLocator.sessionName, windowName
            );
            const pendingIdentityValue: AiSessionRuntimeIdentity = {
                provider: intent.provider,
                projectKey: intent.projectKey,
                cwd: intent.cwd,
                pendingId: intent.pendingId,
            };
            const pendingMetadata = fullMetadata(pendingIdentityValue, intent.layout,
                intent.createdAt, intent.markerPath);
            const finalMetadata = fullMetadata(finalIdentityValue, intent.layout,
                intent.createdAt, intent.markerPath);
            const bothMetadata = {
                ...pendingMetadata,
                sessionId: intent.finalSessionId,
            };
            const identityOptions = intent.layout === 'project' ? windowOptions : sessionOptions;
            const baseOptions = intent.layout === 'project' ? sessionOptions : windowOptions;
            const expectedBase = intent.layout === 'project'
                ? projectSessionMetadata(intent.projectKey)
                : sessionWindowMetadata();
            return recordsEqual(baseOptions, expectedBase)
                && [pendingMetadata, finalMetadata, bothMetadata]
                    .some(expected => recordsEqual(identityOptions, expected));
        } catch (_error) {
            return false;
        }
    }

    private async pendingMetadataMatches(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        createdAt: string,
        markerPath: string
    ): Promise<boolean> {
        try {
            await this.verifyPendingMetadata(identity, locator, createdAt, markerPath);
            return true;
        } catch (_error) {
            return false;
        }
    }

    private async verifyAndCompletePromotion(
        pending: AiSessionRuntimeSnapshot,
        identity: AiSessionRuntimeIdentity,
        finalLocator: AiSessionTmuxLocator,
        pendingIdentityValue: AiSessionRuntimeIdentity
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        await this.dependencies.discovery.refresh(true);
        const promoted = this.findVerified(identity, finalLocator);
        if (!promoted) {
            throw new Error('The promoted tmux runtime could not be verified.');
        }
        return this.completePromotion(pending, identity, finalLocator, promoted, pendingIdentityValue);
    }

    private async completePromotion(
        pending: AiSessionRuntimeSnapshot,
        identity: AiSessionRuntimeIdentity,
        finalLocator: AiSessionTmuxLocator,
        promoted: AiSessionRuntimeSnapshot,
        pendingIdentityValue: AiSessionRuntimeIdentity
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        await this.persistKnown(identity, finalLocator);
        await this.persistConsumed(pending, identity, finalLocator);
        await this.dependencies.runtimeStore.removePromoting(pendingIdentityValue);
        await this.dependencies.runtimeStore.removePending(pendingIdentityValue.pendingId as string);
        await this.dependencies.discovery.refresh(true);
        await this.migrateAttach(pending, promoted);
        return [this.withAttach(promoted)];
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
        locator: AiSessionTmuxLocator
    ): Promise<AiSessionRuntimeSnapshot> {
        const createdAt = new Date(this.dependencies.nowMs()).toISOString();
        let providerLaunchAttempted = false;
        try {
            await this.createTarget(layout, locator, request.identity.cwd,
                serializeTmuxLaunchCommand(request.launch), request.identity.projectKey,
                async () => {
                    await this.persistAmbiguous(request.identity, locator);
                    providerLaunchAttempted = true;
                });
            await this.writeFinalMetadata(request.identity, locator, {
                createdAt,
                markerPath: request.launch.markerPath || '',
            });
            await this.persistKnown(request.identity, locator);
        } catch (error) {
            if (!providerLaunchAttempted) {
                throw error;
            }
            return this.recoverAmbiguousCreation(request.identity, locator, error);
        }
        const runtime = await this.verifyCreated(request.identity, locator);
        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
        return runtime;
    }

    private async createPendingRuntime(
        request: AiSessionCreateRuntimeRequest,
        binding: TmuxPendingRuntimeBinding,
        locator: AiSessionTmuxLocator
    ): Promise<AiSessionPendingRuntimeSnapshot> {
        let providerLaunchAttempted = false;
        try {
            await this.createTarget(binding.layout, locator, request.identity.cwd,
                serializeTmuxLaunchCommand(request.launch), request.identity.projectKey,
                async () => {
                    await this.persistAmbiguous(request.identity, locator, request, binding);
                    providerLaunchAttempted = true;
                });
            await this.writePendingMetadata(request.identity, locator, request.createdAt,
                request.launch.markerPath || '');
            await this.verifyPendingMetadata(request.identity, locator, request.createdAt,
                request.launch.markerPath || '');
            if (await this.dependencies.runtimeStore.setPending(binding) !== true) {
                throw new Error('The pending tmux binding could not be persisted.');
            }
        } catch (error) {
            if (!providerLaunchAttempted) {
                throw error;
            }
            return this.recoverPendingCreation(request, binding, locator, error);
        }
        const runtime = await this.verifyCreated(request.identity, locator) as AiSessionPendingRuntimeSnapshot;
        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
        return runtime;
    }

    private async createTarget(
        layout: AiSessionTmuxLayout,
        locator: AiSessionTmuxLocator,
        cwd: string,
        command: string,
        projectKey: string,
        onProviderLaunch: () => Promise<void>
    ): Promise<void> {
        if (layout === 'session') {
            if (await this.dependencies.client.hasSession(locator.sessionName)) {
                throw new Error('The requested tmux session name is already occupied by an unverified target.');
            }
            await onProviderLaunch();
            await this.dependencies.client.createSession(locator.sessionName, SESSION_WINDOW, cwd, command);
            await this.dependencies.client.configureManagedWindow(locator.sessionName, SESSION_WINDOW);
            return;
        }

        const hasSession = await this.dependencies.client.hasSession(locator.sessionName);
        const compatibleContainer = this.projectContainerIsVerified(locator, projectKey)
            || (hasSession && recordsEqual(
                await this.dependencies.client.getSessionOptions(locator.sessionName),
                projectSessionMetadata(projectKey)
            ));
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
        await onProviderLaunch();
        await this.dependencies.client.createWindow(locator.sessionName, locator.windowName, cwd, command);
        await this.dependencies.client.configureManagedWindow(locator.sessionName, locator.windowName);
    }

    private projectContainerIsVerified(locator: AiSessionTmuxLocator, projectKey: string): boolean {
        return [...this.dependencies.discovery.getActive(), ...this.dependencies.discovery.getPending()]
            .some(runtime => runtime.tmux?.layout === 'project'
                && runtime.tmux.sessionName === locator.sessionName
                && runtime.identity.projectKey === projectKey);
    }

    private withCreationLocks<T>(
        identity: AiSessionRuntimeIdentity,
        layout: AiSessionTmuxLayout,
        identityLockKey: string,
        operation: () => Promise<T>
    ): Promise<T> {
        if (layout !== 'project') {
            return this.dependencies.withCreationLock(identityLockKey, operation);
        }
        return this.dependencies.withCreationLock(`project:${identity.projectKey}`, () =>
            this.dependencies.withCreationLock(identityLockKey, operation));
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

    private async verifyPendingMetadata(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        createdAt: string,
        markerPath: string
    ): Promise<void> {
        const sessionOptions = await this.dependencies.client.getSessionOptions(locator.sessionName);
        const windowName = locator.layout === 'project' ? locator.windowName : SESSION_WINDOW;
        if (!windowName) {
            throw new Error('The pending tmux metadata could not be verified.');
        }
        const windowOptions = await this.dependencies.client.getWindowOptions(locator.sessionName, windowName);
        const expectedSession = locator.layout === 'project'
            ? projectSessionMetadata(identity.projectKey)
            : fullMetadata(identity, locator.layout, createdAt, markerPath);
        const expectedWindow = locator.layout === 'project'
            ? fullMetadata(identity, locator.layout, createdAt, markerPath)
            : sessionWindowMetadata();
        if (!recordsEqual(sessionOptions, expectedSession) || !recordsEqual(windowOptions, expectedWindow)) {
            throw new Error('The pending tmux metadata could not be verified.');
        }
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
        error: unknown
    ): Promise<AiSessionRuntimeSnapshot> {
        await this.dependencies.discovery.refresh(true);
        const recovered = this.findVerified(identity, locator);
        if (!recovered) {
            if (isProvenNoCreate(error) && !await this.locatorIsOccupied(locator)) {
                await this.dependencies.runtimeStore.removeAmbiguous(identity);
            }
            throw error;
        }
        await this.persistKnown(identity, locator);
        await this.dependencies.runtimeStore.removeAmbiguous(identity);
        return recovered;
    }

    private async persistAmbiguous(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        pendingRequest?: AiSessionCreateRuntimeRequest,
        pendingBinding?: TmuxPendingRuntimeBinding
    ): Promise<void> {
        if (identity.sessionId === undefined && (!pendingRequest || !pendingBinding)) {
            throw new Error('A pending ambiguity tombstone requires the complete accepted request.');
        }
        const record: TmuxAmbiguousRuntimeBinding = {
            version: 1,
            state: 'ambiguous',
            provider: identity.provider,
            projectKey: identity.projectKey,
            ...(identity.sessionId !== undefined
                ? { sessionId: identity.sessionId }
                : {
                    pendingId: identity.pendingId as string,
                    cwd: pendingBinding?.cwd as string,
                    createdAt: pendingBinding?.createdAt as string,
                    excludedSessionIds: [...pendingBinding?.excludedSessionIds || []],
                    ...(pendingBinding?.title === undefined ? {} : { title: pendingBinding.title }),
                    ...(pendingRequest?.launch.markerPath
                        ? { markerPath: pendingRequest.launch.markerPath }
                        : {}),
                    requestFingerprint: pendingRequestFingerprint(pendingRequest as AiSessionCreateRuntimeRequest),
                }),
            layout: locator.layout,
            locator: { ...locator },
            acceptedAtMs: pendingBinding?.acceptedAtMs ?? this.dependencies.nowMs(),
        };
        await this.dependencies.runtimeStore.setAmbiguous(record);
    }

    private async recoverPendingAmbiguity(
        request: AiSessionCreateRuntimeRequest,
        binding: TmuxPendingRuntimeBinding,
        locator: AiSessionTmuxLocator,
        ambiguous: TmuxAmbiguousRuntimeBinding
    ): Promise<AiSessionPendingRuntimeSnapshot> {
        if (ambiguous.sessionId !== undefined
            || !pendingAmbiguityMatches(ambiguous as PendingAmbiguousRuntimeBinding,
                request, binding, locator)) {
            throw new Error('The prior pending runtime request is ambiguous and does not match this request.');
        }
        await this.verifyPendingMetadata(request.identity, locator, request.createdAt,
            request.launch.markerPath || '');
        if (await this.dependencies.runtimeStore.setPending({
            ...binding,
            acceptedAtMs: ambiguous.acceptedAtMs,
        }) !== true) {
            throw new Error('The recovered pending tmux binding could not be persisted.');
        }
        await this.dependencies.discovery.refresh(true);
        const recovered = this.findVerified(request.identity, locator) as AiSessionPendingRuntimeSnapshot | undefined;
        if (!recovered) {
            throw new Error('The pending tmux runtime remains ambiguous after metadata recovery.');
        }
        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
        return recovered;
    }

    private async recoverPendingCreation(
        request: AiSessionCreateRuntimeRequest,
        binding: TmuxPendingRuntimeBinding,
        locator: AiSessionTmuxLocator,
        error: unknown
    ): Promise<AiSessionPendingRuntimeSnapshot> {
        await this.dependencies.discovery.refresh(true);
        const recovered = this.findVerified(request.identity, locator) as AiSessionPendingRuntimeSnapshot | undefined;
        if (!recovered) {
            if (isProvenNoCreate(error) && !await this.locatorIsOccupied(locator)) {
                await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
            }
            throw error;
        }
        if (await this.dependencies.runtimeStore.setPending(binding) !== true) {
            throw new Error('The recovered pending tmux binding could not be persisted.');
        }
        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
        return recovered;
    }

    private async persistConsumed(
        pending: AiSessionRuntimeSnapshot,
        finalIdentityValue: AiSessionRuntimeIdentity,
        finalLocator: AiSessionTmuxLocator
    ): Promise<void> {
        if (!pending.identity.pendingId || !finalIdentityValue.sessionId) {
            throw new Error('A consumed pending runtime requires pending and final IDs.');
        }
        if (await this.dependencies.runtimeStore.setConsumed({
            version: 1,
            state: 'consumed',
            pendingId: pending.identity.pendingId,
            provider: pending.identity.provider,
            projectKey: pending.identity.projectKey,
            cwd: pending.identity.cwd,
            finalSessionId: finalIdentityValue.sessionId,
            layout: finalLocator.layout,
            finalLocator: { ...finalLocator },
            consumedAtMs: this.dependencies.nowMs(),
        }) !== true) {
            throw new Error('The consumed pending tmux binding could not be persisted.');
        }
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
            try {
                attachTerminal(entry.terminal).dispose();
            } catch (_disposeError) {
                // Preserve the original show failure.
            }
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
            throw new TmuxRuntimeUnavailableError(
                'unsupported-platform',
                'Managed tmux runtimes require a POSIX extension host.'
            );
        }
        let availability;
        try {
            availability = await this.dependencies.client.checkAvailability();
        } catch (error) {
            throw new TmuxRuntimeUnavailableError(
                'probe-failed',
                error instanceof Error ? error.message : 'The tmux availability probe failed.'
            );
        }
        if ('category' in availability) {
            throw new TmuxRuntimeUnavailableError(
                unavailableReason(availability.category),
                availability.message
            );
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

function snapshotResumeRequest(request: AiSessionResumeRuntimeRequest): AiSessionResumeRuntimeRequest {
    if (!isRecordShape(request)) {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    const identity = snapshotResumeIdentity(request.identity);
    const projectName = snapshotRequiredString(request.projectName, 'The tmux runtime request');
    const terminalName = snapshotRequiredString(request.terminalName, 'The tmux runtime request');
    const launch = snapshotLaunch(request.launch);
    return {
        identity,
        projectName,
        terminalName,
        launch,
    };
}

function snapshotPendingRequest(request: AiSessionCreateRuntimeRequest): AiSessionCreateRuntimeRequest {
    if (!isRecordShape(request)) {
        throw new Error('The pending runtime request shape is invalid.');
    }
    const identity = snapshotPendingIdentity(request.identity);
    const projectName = snapshotRequiredString(request.projectName, 'The pending runtime request');
    const terminalName = snapshotRequiredString(request.terminalName, 'The pending runtime request');
    const createdAt = snapshotRequiredString(request.createdAt, 'The pending runtime request');
    const excludedSessionIds = snapshotDenseStringArray(request.excludedSessionIds,
        MAX_EXCLUDED_SESSION_IDS, 'excluded session IDs', 'The pending runtime request');
    const title = snapshotOptionalString(request.title, 'The pending runtime request');
    const launch = snapshotLaunch(request.launch);
    return {
        identity,
        projectName,
        terminalName,
        createdAt,
        excludedSessionIds,
        ...(title === undefined ? {} : { title }),
        launch,
    };
}

function snapshotLaunch(
    launch: unknown
): AiSessionResumeRuntimeRequest['launch'] {
    if (!isRecordShape(launch)) {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    const executable = snapshotRequiredString(launch.executable, 'The tmux runtime request');
    const args = snapshotDenseStringArray(launch.args, MAX_LAUNCH_ARGUMENTS,
        'provider launch arguments', 'The tmux runtime request');
    const cwd = snapshotOptionalString(launch.cwd, 'The tmux runtime request');
    const markerPath = snapshotOptionalString(launch.markerPath, 'The tmux runtime request');
    const windowsDirectShell = launch.windowsDirectShell;
    if (windowsDirectShell !== undefined && windowsDirectShell !== 'current'
        && windowsDirectShell !== 'powershell') {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    return {
        executable,
        args,
        ...(cwd === undefined ? {} : { cwd }),
        ...(markerPath === undefined ? {} : { markerPath }),
        ...(windowsDirectShell === undefined
            ? {}
            : { windowsDirectShell: windowsDirectShell as 'current' | 'powershell' }),
    };
}

function snapshotResumeIdentity(value: unknown): AiSessionResumeRuntimeRequest['identity'] {
    if (!isRecordShape(value)) {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    const provider = snapshotRequiredString(value.provider, 'The tmux runtime request');
    const projectKey = snapshotRequiredString(value.projectKey, 'The tmux runtime request');
    const cwd = snapshotRequiredString(value.cwd, 'The tmux runtime request');
    const sessionId = snapshotRequiredString(value.sessionId, 'The tmux runtime request');
    return {
        provider: provider as AiSessionResumeRuntimeRequest['identity']['provider'],
        projectKey,
        cwd,
        sessionId,
    };
}

function snapshotPendingIdentity(value: unknown): AiSessionCreateRuntimeRequest['identity'] {
    if (!isRecordShape(value)) {
        throw new Error('The pending runtime request shape is invalid.');
    }
    const provider = snapshotRequiredString(value.provider, 'The pending runtime request');
    const projectKey = snapshotRequiredString(value.projectKey, 'The pending runtime request');
    const cwd = snapshotRequiredString(value.cwd, 'The pending runtime request');
    const pendingId = snapshotRequiredString(value.pendingId, 'The pending runtime request');
    return {
        provider: provider as AiSessionCreateRuntimeRequest['identity']['provider'],
        projectKey,
        cwd,
        pendingId,
    };
}

function snapshotRequiredString(value: unknown, owner: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${owner} shape is invalid.`);
    }
    return value;
}

function snapshotOptionalString(value: unknown, owner: string): string | undefined {
    return value === undefined ? undefined : snapshotRequiredString(value, owner);
}

function snapshotDenseStringArray(
    value: unknown,
    maximum: number,
    label: string,
    owner: string
): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`${owner} ${label} must be an array.`);
    }
    const length = value.length;
    if (!Number.isSafeInteger(length) || length > maximum) {
        throw new Error(`${owner} has too many ${label}; the ${label} count is too large.`);
    }
    const snapshot: string[] = [];
    for (let index = 0; index < length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new Error(`${owner} requires dense ${label}.`);
        }
        const item = value[index];
        if (typeof item !== 'string') {
            throw new Error(`${owner} requires dense ${label}.`);
        }
        snapshot.push(item);
    }
    return snapshot;
}

function isRecordShape(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pendingIdentity(identity: AiSessionRuntimeIdentity & { pendingId: string }): AiSessionRuntimeIdentity {
    return {
        provider: identity.provider,
        projectKey: identity.projectKey,
        cwd: identity.cwd,
        pendingId: identity.pendingId,
    };
}

function pendingLifecycleLockKey(pendingId: string): string {
    return `pending:${pendingId}`;
}

function pendingLifecycleIdentityMatches(
    record: TmuxPendingRuntimeBinding | TmuxPromotingRuntimeBinding
        | TmuxConsumedPendingBinding | TmuxAmbiguousRuntimeBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.pendingId === identity.pendingId && record.provider === identity.provider
        && record.projectKey === identity.projectKey && 'cwd' in record && record.cwd === identity.cwd;
}

function pendingIdentityConflictError(): Error {
    return new Error('The pending ID belongs to a different tmux runtime identity.');
}

function getFinalLocator(identity: AiSessionRuntimeIdentity, layout: AiSessionTmuxLayout): AiSessionTmuxLocator {
    return layout === 'project'
        ? new ProjectTmuxLayout().getLocator(identity)
        : new SessionTmuxLayout().getLocator(identity);
}

function requireLayout(value: unknown): asserts value is AiSessionTmuxLayout {
    if (value !== 'project' && value !== 'session') {
        throw new Error('The tmux runtime layout must be project or session.');
    }
}

function validateDispatchInputs(
    identity: AiSessionRuntimeIdentity,
    launch: AiSessionResumeRuntimeRequest['launch']
): void {
    if (!identity || !isLocalPath(identity.cwd)) {
        throw new Error('The tmux runtime cwd is invalid.');
    }
    const hasSessionId = identity.sessionId !== undefined;
    const hasPendingId = identity.pendingId !== undefined;
    if ((identity.provider !== 'codex' && identity.provider !== 'kimi' && identity.provider !== 'claude')
        || !isIdentityField(identity.projectKey) || hasSessionId === hasPendingId
        || !isIdentityField(hasSessionId ? identity.sessionId : identity.pendingId)) {
        throw new Error('The tmux runtime identity is invalid.');
    }
    if (!launch || typeof launch.executable !== 'string' || !launch.executable
        || launch.executable.length > MAX_EXECUTABLE_LENGTH
        || LOCAL_CONTROL_CHARACTERS.test(launch.executable)) {
        throw new Error('The provider executable is invalid.');
    }
    if (!Array.isArray(launch.args) || launch.args.length > MAX_LAUNCH_ARGUMENTS
        || launch.args.some(argument => typeof argument !== 'string'
            || Buffer.byteLength(argument, 'utf8') > MAX_LAUNCH_ARGUMENT_BYTES
            || argument.indexOf('\0') !== -1)) {
        throw new Error('A provider launch argument is invalid or too large.');
    }
    if (launch.cwd !== undefined && !isLocalPath(launch.cwd)) {
        throw new Error('The provider launch cwd is invalid.');
    }
    if (launch.markerPath !== undefined && !isLocalPath(launch.markerPath)) {
        throw new Error('The provider marker path is invalid.');
    }
    if (launch.windowsDirectShell !== undefined
        && launch.windowsDirectShell !== 'current' && launch.windowsDirectShell !== 'powershell') {
        throw new Error('The provider launch shell is invalid.');
    }
    const aggregateBytes = [
        identity.cwd,
        launch.executable,
        ...launch.args,
        launch.cwd || '',
        launch.markerPath || '',
    ].reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
    if (aggregateBytes > MAX_AGGREGATE_LAUNCH_BYTES) {
        throw new Error('The provider launch exceeds the aggregate launch budget.');
    }
    if (Buffer.byteLength(serializeTmuxLaunchCommand(launch), 'utf8')
        > MAX_SERIALIZED_TMUX_COMMAND_BYTES) {
        throw new Error('The serialized provider launch exceeds the tmux command budget.');
    }
}

function isIdentityField(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_FIELD_LENGTH
        && !LOCAL_CONTROL_CHARACTERS.test(value);
}

function isLocalPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_LOCAL_PATH_LENGTH
        && !LOCAL_CONTROL_CHARACTERS.test(value);
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

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function pendingRequestFingerprint(request: AiSessionCreateRuntimeRequest): string {
    return createHash('sha256').update(JSON.stringify([
        1,
        request.identity.provider,
        request.identity.projectKey,
        request.identity.pendingId,
        request.identity.cwd,
        request.createdAt,
        request.excludedSessionIds,
        request.title ?? null,
        request.launch.executable,
        request.launch.args,
        request.launch.cwd ?? null,
        request.launch.markerPath ?? null,
        request.launch.windowsDirectShell ?? null,
    ]), 'utf8').digest('hex');
}

function identityFromPendingBinding(binding: TmuxPendingRuntimeBinding): AiSessionRuntimeIdentity {
    return {
        provider: binding.provider,
        projectKey: binding.projectKey,
        cwd: binding.cwd,
        pendingId: binding.pendingId,
    };
}

function pendingSnapshotFromBinding(binding: TmuxPendingRuntimeBinding): AiSessionPendingRuntimeSnapshot {
    return {
        identity: identityFromPendingBinding(binding),
        backend: 'tmux',
        state: 'pending',
        markerPath: '',
        runStartedAtMs: Date.parse(binding.createdAt),
        attached: false,
        tmux: { ...binding.locator },
        createdAt: binding.createdAt,
        excludedSessionIds: [...binding.excludedSessionIds],
        ...(binding.title === undefined ? {} : { title: binding.title }),
    };
}

function pendingBindingsEqual(left: TmuxPendingRuntimeBinding, right: TmuxPendingRuntimeBinding): boolean {
    return left.pendingId === right.pendingId && left.provider === right.provider
        && left.projectKey === right.projectKey && left.cwd === right.cwd
        && left.createdAt === right.createdAt && left.title === right.title
        && left.acceptedAtMs === right.acceptedAtMs && left.layout === right.layout
        && locatorsEqual(left.locator, right.locator)
        && left.excludedSessionIds.length === right.excludedSessionIds.length
        && left.excludedSessionIds.every((value, index) => value === right.excludedSessionIds[index]);
}

function promotionIntent(
    binding: TmuxPendingRuntimeBinding,
    pending: AiSessionRuntimeSnapshot,
    finalIdentityValue: AiSessionRuntimeIdentity,
    finalLocator: AiSessionTmuxLocator,
    recordedAtMs: number
): TmuxPromotingRuntimeBinding {
    if (!finalIdentityValue.sessionId) {
        throw new Error('A promotion intent requires a final session ID.');
    }
    const requestFingerprint = promotionRequestFingerprint(binding, pending.markerPath);
    return {
        version: 1,
        state: 'promoting',
        pendingId: binding.pendingId,
        provider: binding.provider,
        projectKey: binding.projectKey,
        cwd: binding.cwd,
        createdAt: binding.createdAt,
        markerPath: pending.markerPath,
        pendingBinding: {
            ...binding,
            excludedSessionIds: [...binding.excludedSessionIds],
            locator: { ...binding.locator },
        },
        finalSessionId: finalIdentityValue.sessionId,
        layout: binding.layout,
        sourceLocator: { ...binding.locator },
        finalLocator: { ...finalLocator },
        requestFingerprint,
        recordedAtMs,
    };
}

function promotionRequestFingerprint(binding: TmuxPendingRuntimeBinding, markerPath: string): string {
    return createHash('sha256').update(JSON.stringify([
        1,
        binding.provider,
        binding.projectKey,
        binding.pendingId,
        binding.cwd,
        binding.createdAt,
        binding.excludedSessionIds,
        binding.title ?? null,
        binding.acceptedAtMs,
        binding.layout,
        binding.locator,
        markerPath,
    ]), 'utf8').digest('hex');
}

function promotionIntentMatchesLiveBinding(
    intent: TmuxPromotingRuntimeBinding,
    binding: TmuxPendingRuntimeBinding
): boolean {
    return pendingBindingsEqual(intent.pendingBinding, binding)
        && intent.requestFingerprint === promotionRequestFingerprint(binding, intent.markerPath);
}

function promotionIntentsMatch(
    left: TmuxPromotingRuntimeBinding,
    right: TmuxPromotingRuntimeBinding
): boolean {
    return left.pendingId === right.pendingId && left.provider === right.provider
        && left.projectKey === right.projectKey && left.cwd === right.cwd
        && left.createdAt === right.createdAt && left.markerPath === right.markerPath
        && pendingBindingsEqual(left.pendingBinding, right.pendingBinding)
        && left.finalSessionId === right.finalSessionId && left.layout === right.layout
        && locatorsEqual(left.sourceLocator, right.sourceLocator)
        && locatorsEqual(left.finalLocator, right.finalLocator)
        && left.requestFingerprint === right.requestFingerprint;
}

type PendingAmbiguousRuntimeBinding = TmuxAmbiguousRuntimeBinding & {
    pendingId: string;
    sessionId?: never;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
    markerPath?: string;
    requestFingerprint: string;
};

function pendingAmbiguityMatches(
    ambiguous: PendingAmbiguousRuntimeBinding,
    request: AiSessionCreateRuntimeRequest,
    binding: TmuxPendingRuntimeBinding,
    locator: AiSessionTmuxLocator
): boolean {
    return ambiguous.provider === binding.provider
        && ambiguous.projectKey === binding.projectKey
        && ambiguous.pendingId === binding.pendingId
        && ambiguous.cwd === binding.cwd
        && ambiguous.createdAt === binding.createdAt
        && ambiguous.title === binding.title
        && (ambiguous.markerPath || '') === (request.launch.markerPath || '')
        && ambiguous.layout === binding.layout
        && locatorsEqual(ambiguous.locator, locator)
        && ambiguous.excludedSessionIds.length === binding.excludedSessionIds.length
        && ambiguous.excludedSessionIds.every((value, index) => value === binding.excludedSessionIds[index])
        && ambiguous.requestFingerprint === pendingRequestFingerprint(request);
}

function isProvenNoCreate(error: unknown): boolean {
    return error instanceof TmuxClientError
        && (error.category === 'nonzero-exit' || error.category === 'argument-list-too-long')
        && (error.operation === 'create-session' || error.operation === 'create-window');
}

function unavailableReason(category: string): TmuxRuntimeUnavailableReason {
    switch (category) {
        case 'not-found':
            return 'not-found';
        case 'permission-denied':
            return 'permission-denied';
        case 'timeout':
            return 'probe-timeout';
        case 'invalid-version':
            return 'invalid-version';
        case 'missing-capability':
            return 'missing-capability';
        default:
            return 'probe-failed';
    }
}

function readOnlyRefreshUnavailableError(error: unknown): TmuxRuntimeUnavailableError | null {
    if (!(error instanceof TmuxClientError)
        || !isReadOnlyTmuxOperation(error.operation)
        || (error.category !== 'not-found'
            && error.category !== 'permission-denied'
            && error.category !== 'timeout')) {
        return null;
    }
    return new TmuxRuntimeUnavailableError(
        unavailableReason(error.category),
        error.message
    );
}

function isReadOnlyTmuxOperation(operation: string): boolean {
    return operation === 'check-version'
        || operation === 'list-commands'
        || operation === 'list-windows'
        || operation === 'has-session'
        || operation === 'get-session-options'
        || operation === 'get-window-options';
}

function consumedPendingError(record: TmuxConsumedPendingBinding): Error {
    return new Error(`The pending tmux runtime was already consumed by session ${record.finalSessionId}.`);
}

function asConflict(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot {
    return {
        ...runtime,
        identity: { ...runtime.identity },
        state: 'conflict',
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}
