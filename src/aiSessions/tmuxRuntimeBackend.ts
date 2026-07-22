'use strict';

import { createHash, randomBytes } from 'crypto';
import type * as vscode from 'vscode';
import { serializeTmuxLaunchCommand } from './launchSpec';
import type {
    AiSessionCreateRuntimeRequest,
    AiSessionDurablePendingPromotionCandidate,
    AiSessionExecutableRuntimeBackend,
    AiSessionPendingRuntimeSnapshot,
    AiSessionResumeRuntimeRequest,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
    TmuxRuntimeUnavailableReason,
} from './runtimeTypes';
import {
    aiSessionRuntimeIdentitiesEqual,
    AiSessionRuntimeConflictError,
    AiSessionRuntimeLifecycleBlockedError,
    AiSessionRuntimeTargetChangedError,
    cloneAiSessionRuntimeIdentity,
    isValidAiSessionPromotionDisplayName,
    isValidAiSessionRuntimeIdentity,
    TmuxRuntimeUnavailableError,
} from './runtimeTypes';
import {
    getTmuxRuntimeKey,
    parseManagedTmuxMetadata,
    ProjectTmuxLayout,
    SessionTmuxLayout,
} from './tmuxLayout';
import {
    TmuxAttachBinding,
    TmuxAttachBindingStore,
    TmuxAttachProcessId,
} from './tmuxAttachBindingStore';
import { TmuxClient, TmuxClientError } from './tmuxClient';
import {
    buildReadableTmuxLocator,
    projectTmuxSessionMatchesWorkspace,
    tmuxLocatorMatchesIdentity,
} from './tmuxNaming';
import {
    TmuxAmbiguousRuntimeBinding,
    TmuxConsumedPendingBinding,
    TmuxPromotingRuntimeBinding,
    TmuxRuntimeBindingStore,
    TmuxPendingRuntimeBinding,
    validateTmuxPendingRuntimeBinding,
} from './tmuxRuntimeBindingStore';
import { getTmuxCollisionRuntimes, TmuxRuntimeDiscovery } from './tmuxRuntimeDiscovery';

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
const TMUX_ATTACH_RECOVERY_ENV = 'PROJECT_STEWARD_TMUX_ATTACH_ID';
const TMUX_ATTACH_RECOVERY_TOKEN = /^[0-9a-f]{32}$/;

interface AttachTerminal {
    readonly name: string;
    readonly processId: number | PromiseLike<number | undefined>;
    readonly creationOptions?: Readonly<vscode.TerminalOptions | vscode.ExtensionTerminalOptions>;
    show(): void;
    dispose(): void;
}

interface AttachEntry<TTerminal> {
    terminal: TTerminal;
    binding: TmuxAttachBinding;
    recoveryToken?: string;
    focusedBinding?: TmuxAttachBinding | null;
    focusEpoch: number;
    explicitSelections: number;
}

export interface TmuxFocusedRuntimeSyncResult {
    monitored: boolean;
    changed: boolean;
    identity: AiSessionRuntimeIdentity | null;
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
    getAttachTerminalName?(runtime: AiSessionRuntimeSnapshot): string | undefined;
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

    getConflicts(): AiSessionRuntimeSnapshot<TTerminal>[] {
        const getDiagnostics = this.dependencies.discovery.getDiagnostics;
        const diagnostics = typeof getDiagnostics === 'function'
            ? getDiagnostics.call(this.dependencies.discovery)
            : [];
        return getTmuxCollisionRuntimes(diagnostics)
            .map(runtime => this.withAttach(runtime));
    }

    getLifecycleBlockers(): AiSessionRuntimeSnapshot<TTerminal>[] {
        const getInactive = this.dependencies.discovery.getInactive;
        return (typeof getInactive === 'function'
            ? getInactive.call(this.dependencies.discovery)
            : []).map(runtime => this.withAttach(runtime));
    }

    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[] {
        return this.dependencies.discovery.find(identity).map(runtime => this.withAttach(runtime));
    }

    async listRecoverablePending(): Promise<AiSessionDurablePendingPromotionCandidate<TTerminal>[]> {
        const candidates = await this.dependencies.runtimeStore.listRecoverablePending();
        return candidates.map(candidate => ({
            ...pendingSnapshotFromBinding(candidate.pendingBinding),
            promotionRecoveryDisplayName: candidate.promotionRecoveryDisplayName,
            recoverySessionId: candidate.recoverySessionId,
        }) as AiSessionDurablePendingPromotionCandidate<TTerminal>);
    }

    async getRecoverablePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string }
    ): Promise<AiSessionPendingRuntimeSnapshot<TTerminal> | null> {
        const pendingIdentityValue = pendingIdentity(identity);
        if (!isValidAiSessionRuntimeIdentity(pendingIdentityValue)) {
            return null;
        }
        const matches = (await this.listRecoverablePending()).filter(runtime =>
            aiSessionRuntimeIdentitiesEqual(runtime.identity, pendingIdentityValue));
        if (matches.length > 1) {
            throw new Error('Multiple durable tmux promotions target one pending runtime.');
        }
        return matches[0] || null;
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
        const preferredLocator = buildReadableTmuxLocator(identity, layout, {
            projectName: request.projectName,
            sessionName: request.sessionName,
        });
        const lockKey = getTmuxRuntimeKey(identity);
        const runtime = await this.withCreationLocks(identity, layout, lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            this.throwIfCollision(identity);
            this.throwIfLifecycleBlocked(identity);
            const existing = this.findVerified(identity);
            if (existing) {
                await this.dependencies.runtimeStore.removeAmbiguous(identity);
                return existing;
            }
            const ambiguous = await this.dependencies.runtimeStore.getAmbiguous(identity);
            if (ambiguous) {
                throw new Error('The prior tmux creation result is ambiguous; the provider command was not sent again.');
            }
            const locator = await this.resolveCreationLocator(identity, preferredLocator);
            return this.createFinalRuntime(request, layout, locator);
        });
        return this.attachAndFocus(runtime, this.getAttachTerminalName(runtime));
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
        const preferredLocator = buildReadableTmuxLocator(identity, layout, {
            projectName: request.projectName,
            sessionName: request.title?.trim() || 'new-session',
        });
        const binding = validateTmuxPendingRuntimeBinding({
            version: 2,
            state: 'pending',
            pendingId: identity.pendingId,
            provider: identity.provider,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            cwd: identity.cwd,
            createdAt: request.createdAt,
            excludedSessionIds: request.excludedSessionIds,
            projectName: request.projectName,
            ...(request.title === undefined ? {} : { title: request.title }),
            acceptedAtMs: Date.parse(request.createdAt),
            layout,
            locator: preferredLocator,
        }, this.dependencies.nowMs());
        if (!binding) {
            throw new Error('The pending runtime request is invalid or expired.');
        }
        await this.requireAvailable();
        const lockKey = pendingLifecycleLockKey(identity);
        const runtime = await this.withCreationLocks(identity, layout, lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            this.throwIfCollision(identity);
            const lifecycle = await this.auditPendingId(identity);
            const existing = this.findVerified(identity) as AiSessionPendingRuntimeSnapshot | undefined;
            if (existing) {
                await this.dependencies.runtimeStore.removeAmbiguous(identity);
                return existing;
            }
            const ambiguous = lifecycle.ambiguous;
            if (ambiguous) {
                const pendingAmbiguous = ambiguous as PendingAmbiguousRuntimeBinding;
                const acceptedBinding = validateTmuxPendingRuntimeBinding({
                    ...binding,
                    locator: { ...pendingAmbiguous.locator },
                    ...(pendingAmbiguous.projectName === undefined
                        ? {} : { projectName: pendingAmbiguous.projectName }),
                }, this.dependencies.nowMs());
                if (!acceptedBinding) {
                    throw new Error('The prior pending runtime binding is invalid or expired.');
                }
                return this.recoverPendingAmbiguity(
                    request, acceptedBinding, acceptedBinding.locator, pendingAmbiguous
                );
            }
            const locator = await this.resolveCreationLocator(identity, preferredLocator);
            const dispatchBinding = validateTmuxPendingRuntimeBinding({
                ...binding,
                locator,
                acceptedAtMs: this.dependencies.nowMs(),
            }, this.dependencies.nowMs());
            if (!dispatchBinding) {
                throw new Error('The pending runtime request expired before provider dispatch.');
            }
            return this.createPendingRuntime(request, dispatchBinding, locator);
        });
        return this.attachAndFocus(
            runtime, this.getAttachTerminalName(runtime)
        ) as Promise<AiSessionPendingRuntimeSnapshot<TTerminal>>;
    }

    private async auditPendingId(identity: AiSessionRuntimeIdentity): Promise<{
        ambiguous: TmuxAmbiguousRuntimeBinding | null;
        pending: TmuxPendingRuntimeBinding | null;
    }> {
        const promoting = await this.dependencies.runtimeStore.getPromoting(identity);
        if (promoting) {
            throw new Error('The pending tmux runtime has a promotion in progress.');
        }
        const consumed = await this.dependencies.runtimeStore.getConsumed(identity);
        if (consumed) {
            throw consumedPendingError(consumed);
        }
        const ambiguous = await this.dependencies.runtimeStore.getAmbiguous(identity);
        const pending = await this.dependencies.runtimeStore.getPending(identity);
        return { ambiguous, pending };
    }

    async promotePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string },
        sessionId: string,
        sessionName: string
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        const pendingIdentityValue = pendingIdentity(identity);
        if (!isValidAiSessionRuntimeIdentity(pendingIdentityValue) || !isIdentityField(sessionId)
            || !isValidAiSessionPromotionDisplayName(sessionName)) {
            return [];
        }
        return this.dependencies.withCreationLock<AiSessionRuntimeSnapshot<TTerminal>[]>(
            pendingLifecycleLockKey(pendingIdentityValue), async () => {
            const storedIntent = await this.dependencies.runtimeStore.getPromoting(pendingIdentityValue);
            const storedLiveBinding = await this.dependencies.runtimeStore.getPending(pendingIdentityValue);
            if (storedIntent && storedLiveBinding
                && !promotionIntentMatchesLiveBinding(storedIntent, storedLiveBinding)) {
                throw new Error('The pending tmux promotion intent conflicts with the live pending binding.');
            }
            const storedPending = storedIntent?.pendingBinding
                || storedLiveBinding;
            if (!storedPending) {
                return [];
            }
            if (!pendingLifecycleIdentityMatches(storedPending, pendingIdentityValue)) {
                return [];
            }
            if (storedIntent && storedIntent.finalSessionId !== sessionId) {
                throw new Error('The pending tmux runtime has a conflicting promotion in progress.');
            }
            await this.requireAvailable();
            await this.dependencies.discovery.refresh(true);
            if (!storedIntent) {
                this.throwIfCollision(pendingIdentityValue);
            }
            const consumed = await this.dependencies.runtimeStore.getConsumed(pendingIdentityValue);
            if (consumed && consumed.finalSessionId !== sessionId) {
                throw new Error('The pending tmux runtime was consumed by a different promotion.');
            }
            const ambiguous = await this.dependencies.runtimeStore.getAmbiguous(pendingIdentityValue);
            if (ambiguous) {
                throw new Error('The prior pending runtime creation result remains ambiguous.');
            }
            const currentIntent = await this.dependencies.runtimeStore.getPromoting(pendingIdentityValue);
            const freshBinding = await this.dependencies.runtimeStore.getPending(pendingIdentityValue);
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
                .find(runtime => aiSessionRuntimeIdentitiesEqual(
                    runtime.identity, pendingIdentityValue
                )
                    && !!runtime.tmux && locatorsEqual(runtime.tmux, currentBinding.locator));
            const pendingSnapshot = currentPending || pendingSnapshotFromBinding(currentBinding);
            const finalIdentityValue: AiSessionRuntimeIdentity = {
                provider: currentBinding.provider,
                workspaceScopeIdentity: currentBinding.workspaceScopeIdentity,
                workspaceNavigationIdentity: currentBinding.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...currentBinding.workspaceRootHostPaths],
                cwd: currentBinding.cwd,
                sessionId,
            };
            const preferredFinal = buildReadableTmuxLocator(finalIdentityValue, currentBinding.layout, {
                projectName: currentBinding.projectName || 'workspace',
                sessionName,
            });
            const finalLocator: AiSessionTmuxLocator = currentBinding.layout === 'project'
                ? { ...preferredFinal, sessionName: currentBinding.locator.sessionName }
                : preferredFinal;
            const finalLockKey = getTmuxRuntimeKey(finalIdentityValue);
            return this.dependencies.withCreationLock<AiSessionRuntimeSnapshot<TTerminal>[]>(
                finalLockKey,
                async () => {
                    await this.dependencies.discovery.refresh(true);
                    const intent = await this.dependencies.runtimeStore.getPromoting(pendingIdentityValue);
                    if (!intent) {
                        this.throwIfCollision(pendingIdentityValue);
                    }
                    this.throwIfCollision(finalIdentityValue);
                    const expectedIntent = promotionIntent(currentBinding, {
                        ...pendingSnapshot,
                        markerPath: intent?.markerPath ?? pendingSnapshot.markerPath,
                    }, finalIdentityValue, sessionName, finalLocator, this.dependencies.nowMs());
                    if (intent && !promotionIntentsMatch(intent, expectedIntent)) {
                        throw new Error('The pending tmux runtime has a conflicting promotion in progress.');
                    }
                    const consumed = await this.dependencies.runtimeStore.getConsumed(pendingIdentityValue);
                    if (consumed) {
                        if (consumed.finalSessionId !== sessionId
                            || consumed.finalSessionName !== sessionName
                            || !locatorsEqual(consumed.finalLocator, finalLocator)) {
                            throw new Error('The pending tmux runtime was consumed by a different promotion.');
                        }
                        const completed = this.findVerified(finalIdentityValue, finalLocator);
                        if (!completed) {
                            return [];
                        }
                        await this.finishPromotionCleanup(pendingSnapshot, completed, pendingIdentityValue);
                        return [this.withAttach(completed)];
                    }
                    const compatible = this.findVerified(finalIdentityValue, finalLocator);
                    if (compatible) {
                        if (!intent) {
                            return [this.withAttach(asConflict(compatible)), this.withAttach(asConflict(pendingSnapshot))];
                        }
                        return this.completePromotion(pendingSnapshot, finalIdentityValue, sessionName,
                            finalLocator, compatible, pendingIdentityValue);
                    }
                    const differentlyNamedFinal = this.findVerified(finalIdentityValue);
                    if (differentlyNamedFinal) {
                        return [
                            this.withAttach(asConflict(differentlyNamedFinal)),
                            this.withAttach(asConflict(pendingSnapshot)),
                        ];
                    }
                    if (intent && await this.promotionTransitionMatches(intent, finalIdentityValue)) {
                        await this.writeFinalMetadata(finalIdentityValue, finalLocator, {
                            createdAt: intent.createdAt,
                            markerPath: intent.markerPath,
                        });
                        await this.dependencies.client.clearPendingMetadata(finalLocator);
                        return this.verifyAndCompletePromotion(pendingSnapshot, finalIdentityValue,
                            sessionName, finalLocator, pendingIdentityValue);
                    }
                    if (intent && await this.sessionPromotionPartiallyRenamed(intent)) {
                        const sourceWindow = intent.sourceLocator.windowName || SESSION_WINDOW;
                        const finalWindow = intent.finalLocator.windowName;
                        if (!finalWindow) {
                            throw new Error('The pending tmux promotion state is ambiguous; no mutation was attempted.');
                        }
                        try {
                            await this.dependencies.client.renameWindow(
                                intent.finalLocator.sessionName, sourceWindow, finalWindow
                            );
                            await this.writeFinalMetadata(finalIdentityValue, finalLocator, {
                                createdAt: intent.createdAt,
                                markerPath: intent.markerPath,
                            });
                            await this.dependencies.client.clearPendingMetadata(finalLocator);
                        } catch (error) {
                            await this.dependencies.discovery.refresh(true);
                            if (!this.findVerified(finalIdentityValue, finalLocator)) {
                                throw error;
                            }
                        }
                        return this.verifyAndCompletePromotion(pendingSnapshot, finalIdentityValue,
                            sessionName, finalLocator, pendingIdentityValue);
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
                        await this.writeFinalMetadata(finalIdentityValue, finalLocator, {
                            createdAt: pendingSnapshot.createdAt,
                            markerPath: pendingSnapshot.markerPath,
                        });
                        await this.dependencies.client.clearPendingMetadata(finalLocator);
                    } catch (error) {
                        await this.dependencies.discovery.refresh(true);
                        const recovered = this.findVerified(finalIdentityValue, finalLocator);
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
                    return this.verifyAndCompletePromotion(pendingSnapshot, finalIdentityValue,
                        sessionName, finalLocator, pendingIdentityValue);
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
                : intent.finalLocator.windowName || SESSION_WINDOW;
            if (!windowName) {
                return false;
            }
            const windowOptions = await this.dependencies.client.getWindowOptions(
                intent.finalLocator.sessionName, windowName
            );
            const pendingIdentityValue: AiSessionRuntimeIdentity = {
                provider: intent.provider,
                workspaceScopeIdentity: intent.workspaceScopeIdentity,
                workspaceNavigationIdentity: intent.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...intent.workspaceRootHostPaths],
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
                ? projectSessionMetadata(pendingIdentityValue)
                : sessionWindowMetadata();
            return recordsEqual(baseOptions, expectedBase)
                && [pendingMetadata, finalMetadata, bothMetadata]
                    .some(expected => recordsEqual(identityOptions, expected));
        } catch (_error) {
            return false;
        }
    }

    private async sessionPromotionPartiallyRenamed(
        intent: TmuxPromotingRuntimeBinding
    ): Promise<boolean> {
        if (intent.layout !== 'session') {
            return false;
        }
        const sourceWindow = intent.sourceLocator.windowName || SESSION_WINDOW;
        const finalWindow = intent.finalLocator.windowName;
        if (!finalWindow || sourceWindow === finalWindow) {
            return false;
        }
        try {
            const rows = await this.dependencies.client.listWindows();
            const finalSessionRows = rows.filter(row =>
                row.sessionName === intent.finalLocator.sessionName);
            if (finalSessionRows.length !== 1 || finalSessionRows[0].windowName !== sourceWindow
                || rows.some(row => row.sessionName === intent.sourceLocator.sessionName)) {
                return false;
            }
            const sessionOptions = await this.dependencies.client.getSessionOptions(
                intent.finalLocator.sessionName
            );
            const windowOptions = await this.dependencies.client.getWindowOptions(
                intent.finalLocator.sessionName, sourceWindow
            );
            const pendingIdentityValue: AiSessionRuntimeIdentity = {
                provider: intent.provider,
                workspaceScopeIdentity: intent.workspaceScopeIdentity,
                workspaceNavigationIdentity: intent.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...intent.workspaceRootHostPaths],
                cwd: intent.cwd,
                pendingId: intent.pendingId,
            };
            return recordsEqual(sessionOptions, fullMetadata(
                pendingIdentityValue, intent.layout, intent.createdAt, intent.markerPath
            )) && recordsEqual(windowOptions, sessionWindowMetadata());
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
        finalSessionName: string,
        finalLocator: AiSessionTmuxLocator,
        pendingIdentityValue: AiSessionRuntimeIdentity
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        await this.dependencies.discovery.refresh(true);
        const promoted = this.findVerified(identity, finalLocator);
        if (!promoted) {
            throw new Error('The promoted tmux runtime could not be verified.');
        }
        return this.completePromotion(
            pending, identity, finalSessionName, finalLocator, promoted, pendingIdentityValue
        );
    }

    private async completePromotion(
        pending: AiSessionRuntimeSnapshot,
        identity: AiSessionRuntimeIdentity,
        finalSessionName: string,
        finalLocator: AiSessionTmuxLocator,
        promoted: AiSessionRuntimeSnapshot,
        pendingIdentityValue: AiSessionRuntimeIdentity
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        await this.persistKnown(identity, finalLocator, promoted);
        await this.persistConsumed(pending, identity, finalSessionName, finalLocator);
        await this.finishPromotionCleanup(pending, promoted, pendingIdentityValue);
        return [this.withAttach(promoted)];
    }

    private async finishPromotionCleanup(
        pending: AiSessionRuntimeSnapshot,
        promoted: AiSessionRuntimeSnapshot,
        pendingIdentityValue: AiSessionRuntimeIdentity
    ): Promise<void> {
        await this.migrateAttach(pending, promoted);
        await this.dependencies.runtimeStore.removePending(pendingIdentityValue);
        await this.dependencies.discovery.refresh(true);
        await this.dependencies.runtimeStore.removePromoting(pendingIdentityValue);
    }

    async focus(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (!runtime || runtime.backend !== 'tmux' || !runtime.tmux) {
            return;
        }
        await this.verifyFocusTarget(runtime);
        await this.attachAndFocus(runtime, this.getAttachTerminalName(runtime));
    }

    private async verifyFocusTarget(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (!runtime.tmux) {
            throw new AiSessionRuntimeTargetChangedError();
        }
        const target = await this.dependencies.client.getTargetWindow(runtime.tmux);
        const metadata = target ? parseManagedTmuxMetadata(target.metadata) : null;
        const actualLocator: AiSessionTmuxLocator | null = target && metadata ? {
            layout: metadata.layout,
            sessionName: target.sessionName,
            ...(metadata.layout === 'project' || runtime.tmux.windowName
                ? { windowName: target.windowName } : {}),
        } : null;
        if (!metadata || !actualLocator || !locatorsEqual(actualLocator, runtime.tmux)
            || !aiSessionRuntimeIdentitiesEqual(metadata, runtime.identity)) {
            throw new AiSessionRuntimeTargetChangedError();
        }
    }

    getFocusedRuntime(terminal: TTerminal | null | undefined): AiSessionRuntimeSnapshot<TTerminal> | null {
        if (!terminal) {
            return null;
        }
        const entry = [...this.attaches.values()].find(candidate => candidate.terminal === terminal);
        const binding = entry?.focusedBinding !== undefined
            ? entry.focusedBinding
            : entry?.binding;
        const runtime = binding ? this.runtimeForBinding(binding) : undefined;
        return runtime ? this.withAttach(runtime) : null;
    }

    async syncFocusedRuntime(
        terminal: TTerminal | null | undefined
    ): Promise<TmuxFocusedRuntimeSyncResult> {
        const registered = terminal
            ? [...this.attaches.entries()].find(([, candidate]) => candidate.terminal === terminal)
            : undefined;
        const key = registered?.[0];
        const entry = registered?.[1];
        const previous = this.getFocusedRuntime(terminal);
        if (!entry || entry.binding.layout !== 'project') {
            return {
                monitored: false, changed: false,
                identity: previous ? cloneAiSessionRuntimeIdentity(previous.identity) : null,
            };
        }
        const focusEpoch = entry.focusEpoch;
        const activeWindow = await this.dependencies.client.getActiveWindow(entry.binding.sessionName);
        if (!key || this.attaches.get(key) !== entry
            || entry.focusEpoch !== focusEpoch || entry.explicitSelections > 0) {
            const current = this.getFocusedRuntime(terminal);
            return {
                monitored: true, changed: false,
                identity: current ? cloneAiSessionRuntimeIdentity(current.identity) : null,
            };
        }
        const matches = activeWindow ? [
            ...this.dependencies.discovery.getActive(),
            ...this.dependencies.discovery.getPending(),
        ].filter(runtime => runtime.tmux?.layout === 'project'
            && runtime.identity.workspaceScopeIdentity === entry.binding.workspaceScopeIdentity
            && runtime.tmux.sessionName === activeWindow.sessionName
            && runtime.tmux.windowName === activeWindow.windowName) : [];
        if (matches.length > 1) {
            throw new Error('The active tmux window maps to multiple managed runtimes.');
        }
        const next = matches[0];
        entry.focusedBinding = next
            ? attachBinding(next, entry.binding.terminalNamePrefix)
            : null;
        entry.focusEpoch++;
        return {
            monitored: true,
            changed: !runtimeIdentityEquals(previous?.identity || null, next?.identity || null),
            identity: next ? cloneAiSessionRuntimeIdentity(next.identity) : null,
        };
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
        entry.focusEpoch++;
        this.attaches.delete(key);
        const terminal = attachTerminal(entry.terminal);
        this.removePersistedAttach(entry.recoveryToken || null, terminal.processId);
        terminal.dispose();
    }

    isAttachTerminalCandidate(terminal: TTerminal): boolean {
        const attach = attachTerminal(terminal);
        return getTmuxAttachRecoveryToken(attach.creationOptions) !== null
            || getTmuxAttachSessionName(
                attach.creationOptions,
                this.dependencies.client.getExecutablePath()
            ) !== null;
    }

    async restoreAttachTerminals(terminals: readonly TTerminal[]): Promise<void> {
        await this.dependencies.discovery.refresh(true);
        for (const terminal of terminals || []) {
            const attach = attachTerminal(terminal);
            if ([...this.attaches.values()].some(entry => entry.terminal === terminal)) {
                continue;
            }
            const processId = await resolveProcessId(attach.processId);
            if (processId === null) {
                continue;
            }
            const recoveryToken = getTmuxAttachRecoveryToken(attach.creationOptions);
            const recovery = recoveryToken
                ? this.dependencies.attachStore.getRecovery(recoveryToken)
                : null;
            let binding = recovery?.binding || this.dependencies.attachStore.get(processId);
            const launchSessionName = getTmuxAttachSessionName(
                attach.creationOptions, this.dependencies.client.getExecutablePath()
            );
            const bindingMatchesTerminal = binding
                ? Boolean(recovery) || terminalMatchesBinding(attach, binding, launchSessionName)
                : false;
            let runtime = bindingMatchesTerminal ? this.runtimeForBinding(binding as TmuxAttachBinding)
                : await this.runtimeForAttachSession(launchSessionName);
            if (!bindingMatchesTerminal && runtime) {
                binding = attachBinding(runtime, getTerminalCreationName(attach)
                    || this.getAttachTerminalName(runtime));
            }
            if (binding?.pendingId && bindingMatchesTerminal && !runtime) {
                const pendingIdentityValue: AiSessionRuntimeIdentity = {
                    provider: binding.provider,
                    workspaceScopeIdentity: binding.workspaceScopeIdentity,
                    workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
                    workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
                    cwd: binding.cwd,
                    pendingId: binding.pendingId,
                };
                const consumed = await this.dependencies.runtimeStore.getConsumed(pendingIdentityValue);
                if (consumed) {
                    const finalIdentityValue: AiSessionRuntimeIdentity = {
                        ...pendingIdentityValue,
                        pendingId: undefined,
                        sessionId: consumed.finalSessionId,
                    };
                    const promoted = this.findVerified(finalIdentityValue, consumed.finalLocator);
                    if (promoted) {
                        binding = attachBinding(promoted, binding.terminalNamePrefix);
                        runtime = promoted;
                    } else {
                        const intent = await this.dependencies.runtimeStore.getPromoting(
                            pendingIdentityValue
                        );
                        const intentPending = intent
                            && consumedMatchesPromotionIntent(consumed, intent)
                            ? pendingSnapshotFromBinding(intent.pendingBinding) : null;
                        if (intentPending && bindingTargetsRuntime(binding, intentPending)) {
                            const key = registryKey(intentPending);
                            if (!this.attaches.has(key)) {
                                this.attaches.set(key, {
                                    terminal, binding, focusedBinding: binding,
                                    ...(recoveryToken ? { recoveryToken } : {}),
                                    focusEpoch: 0, explicitSelections: 0,
                                });
                                this.persistAttachBinding(
                                    attach.processId, binding, recoveryToken
                                );
                            }
                        } else {
                            this.removePersistedAttach(recoveryToken, processId);
                        }
                        continue;
                    }
                } else {
                    const intent = await this.dependencies.runtimeStore.getPromoting(pendingIdentityValue);
                    const intentPending = intent ? pendingSnapshotFromBinding(intent.pendingBinding) : null;
                    if (intentPending && bindingTargetsRuntime(binding, intentPending)) {
                        const key = registryKey(intentPending);
                        if (!this.attaches.has(key)) {
                            this.attaches.set(key, {
                                terminal, binding, focusedBinding: binding,
                                ...(recoveryToken ? { recoveryToken } : {}),
                                focusEpoch: 0, explicitSelections: 0,
                            });
                            this.persistAttachBinding(
                                attach.processId, binding, recoveryToken
                            );
                        }
                        continue;
                    }
                }
            }
            if (!binding || !runtime) {
                this.removePersistedAttach(recoveryToken, processId);
                continue;
            }
            const key = registryKey(runtime);
            const existing = this.attaches.get(key);
            if (existing) {
                if (existing.terminal !== terminal) {
                    this.removePersistedAttach(recoveryToken, processId);
                }
                continue;
            }
            this.attaches.set(key, {
                terminal, binding, focusedBinding: binding,
                ...(recoveryToken ? { recoveryToken } : {}),
                focusEpoch: 0, explicitSelections: 0,
            });
            this.persistAttachBinding(attach.processId, binding, recoveryToken);
        }
        await this.dependencies.attachStore.flush();
    }

    handleClosedTerminal(terminal: TTerminal): void {
        for (const [key, entry] of this.attaches) {
            if (entry.terminal !== terminal) {
                continue;
            }
            entry.focusEpoch++;
            this.attaches.delete(key);
            this.removePersistedAttach(
                entry.recoveryToken || null, attachTerminal(terminal).processId
            );
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
                serializeTmuxLaunchCommand(request.launch), request.identity,
                async () => {
                    await this.persistAmbiguous(request.identity, locator);
                    providerLaunchAttempted = true;
                });
            await this.writeFinalMetadata(request.identity, locator, {
                createdAt,
                markerPath: request.launch.markerPath || '',
            });
            await this.persistKnown(request.identity, locator, {
                identity: request.identity,
                markerPath: request.launch.markerPath || '',
                runStartedAtMs: Date.parse(createdAt),
            });
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
                serializeTmuxLaunchCommand(request.launch), request.identity,
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
        identity: AiSessionRuntimeIdentity,
        onProviderLaunch: () => Promise<void>
    ): Promise<void> {
        if (layout === 'session') {
            if (await this.dependencies.client.hasSession(locator.sessionName)) {
                throw new Error('The requested tmux session name is already occupied by an unverified target.');
            }
            const windowName = locator.windowName || SESSION_WINDOW;
            await onProviderLaunch();
            await this.dependencies.client.createSession(locator.sessionName, windowName, cwd, command);
            await this.dependencies.client.configureManagedWindow(locator.sessionName, windowName);
            return;
        }

        if (!projectTmuxSessionMatchesWorkspace(locator.sessionName, identity)) {
            throw new Error('The requested project tmux session is an unverified target.');
        }
        const hasSession = await this.dependencies.client.hasSession(locator.sessionName);
        const compatibleContainer = this.projectContainerIsVerified(locator, identity.workspaceScopeIdentity)
            || (hasSession && recordsEqual(
                await this.dependencies.client.getSessionOptions(locator.sessionName),
                projectSessionMetadata(identity)
            ));
        if (hasSession && !compatibleContainer) {
            throw new Error('The requested project tmux session is occupied by an unverified target.');
        }
        if (!hasSession) {
            await this.dependencies.client.createSession(
                locator.sessionName, PROJECT_BOOTSTRAP_WINDOW, cwd, PROJECT_BOOTSTRAP_COMMAND
            );
            await this.dependencies.client.setSessionOptions(locator.sessionName,
                projectSessionMetadata(identity));
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

    private projectContainerIsVerified(locator: AiSessionTmuxLocator, workspaceScopeIdentity: string): boolean {
        return [...this.dependencies.discovery.getActive(), ...this.dependencies.discovery.getPending()]
            .some(runtime => runtime.tmux?.layout === 'project'
                && runtime.tmux.sessionName === locator.sessionName
                && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity);
    }

    private async resolveCreationLocator(
        identity: AiSessionRuntimeIdentity,
        preferred: AiSessionTmuxLocator
    ): Promise<AiSessionTmuxLocator> {
        if (preferred.layout !== 'project') {
            return { ...preferred };
        }
        const rows = await this.dependencies.client.listWindows();
        const expected = projectSessionMetadata(identity);
        const containers = new Map<string, string>();
        for (const row of rows) {
            if (recordsEqual(row.sessionMetadata, expected) && !containers.has(row.sessionName)) {
                containers.set(row.sessionName, row.windowName);
            }
        }
        if (containers.size === 0) {
            return { ...preferred };
        }
        const hasInvalidContainer = [...containers.keys()].some(sessionName =>
            !projectTmuxSessionMatchesWorkspace(sessionName, identity));
        if (containers.size === 1 && !hasInvalidContainer) {
            return { ...preferred, sessionName: containers.keys().next().value as string };
        }
        const conflicts = [...containers].map(([sessionName, windowName]) => ({
            identity: cloneAiSessionRuntimeIdentity(identity),
            backend: 'tmux' as const,
            state: 'conflict' as const,
            markerPath: '',
            runStartedAtMs: 0,
            attached: false,
            tmux: { layout: 'project' as const, sessionName, windowName },
        }));
        throw new AiSessionRuntimeConflictError(conflicts);
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
        return this.dependencies.withCreationLock(`project:${identity.workspaceScopeIdentity}`, () =>
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
                projectSessionMetadata(identity));
            await this.dependencies.client.setWindowOptions(locator.sessionName, locator.windowName, full);
            return;
        }
        await this.dependencies.client.setSessionOptions(locator.sessionName, full);
        await this.dependencies.client.setWindowOptions(locator.sessionName,
            locator.windowName || SESSION_WINDOW,
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
        const windowName = locator.layout === 'project'
            ? locator.windowName
            : locator.windowName || SESSION_WINDOW;
        if (!windowName) {
            throw new Error('The pending tmux metadata could not be verified.');
        }
        const windowOptions = await this.dependencies.client.getWindowOptions(locator.sessionName, windowName);
        const expectedSession = locator.layout === 'project'
            ? projectSessionMetadata(identity)
            : fullMetadata(identity, locator.layout, createdAt, markerPath);
        const expectedWindow = locator.layout === 'project'
            ? fullMetadata(identity, locator.layout, createdAt, markerPath)
            : sessionWindowMetadata();
        if (!recordsEqual(sessionOptions, expectedSession) || !recordsEqual(windowOptions, expectedWindow)) {
            throw new Error('The pending tmux metadata could not be verified.');
        }
    }

    private async persistKnown(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        lifecycle?: Pick<AiSessionRuntimeSnapshot, 'identity' | 'markerPath' | 'runStartedAtMs'>
    ): Promise<void> {
        if (!identity.sessionId) {
            throw new Error('A known tmux runtime requires a session ID.');
        }
        const hasLifecycleEvidence = !!lifecycle
            && isLocalPath(identity.cwd)
            && isBoundedOptionalLocalPath(lifecycle.markerPath)
            && Number.isFinite(lifecycle.runStartedAtMs)
            && lifecycle.runStartedAtMs > 0;
        await this.dependencies.runtimeStore.setKnown({
            version: 2,
            state: 'known',
            provider: identity.provider,
            sessionId: identity.sessionId,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            cwd: identity.cwd,
            layout: locator.layout,
            locator: { ...locator },
            lastSeenAtMs: this.dependencies.nowMs(),
            ...(hasLifecycleEvidence ? {
                markerPath: lifecycle.markerPath,
                runStartedAtMs: lifecycle.runStartedAtMs,
            } : {}),
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
        await this.persistKnown(identity, locator, recovered);
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
            version: 2,
            state: 'ambiguous',
            provider: identity.provider,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            cwd: identity.cwd,
            ...(identity.sessionId !== undefined
                ? { sessionId: identity.sessionId }
                : {
                    pendingId: identity.pendingId as string,
                    createdAt: pendingBinding?.createdAt as string,
                    excludedSessionIds: [...pendingBinding?.excludedSessionIds || []],
                    ...(pendingBinding?.projectName === undefined
                        ? {} : { projectName: pendingBinding.projectName }),
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
        finalSessionName: string,
        finalLocator: AiSessionTmuxLocator
    ): Promise<void> {
        if (!pending.identity.pendingId || !finalIdentityValue.sessionId) {
            throw new Error('A consumed pending runtime requires pending and final IDs.');
        }
        if (await this.dependencies.runtimeStore.setConsumed({
            version: 2,
            state: 'consumed',
            pendingId: pending.identity.pendingId,
            provider: pending.identity.provider,
            workspaceScopeIdentity: pending.identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: pending.identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...pending.identity.workspaceRootHostPaths],
            cwd: pending.identity.cwd,
            finalSessionId: finalIdentityValue.sessionId,
            finalSessionName,
            layout: finalLocator.layout,
            finalLocator: { ...finalLocator },
            consumedAtMs: this.dependencies.nowMs(),
        }) !== true) {
            throw new Error('The consumed pending tmux binding could not be persisted.');
        }
    }

    private findVerified(
        identity: AiSessionRuntimeIdentity,
        requiredLocator?: AiSessionTmuxLocator
    ): AiSessionRuntimeSnapshot | undefined {
        const matches = this.dependencies.discovery.find(identity)
            .filter(runtime => !!runtime.tmux
                && tmuxLocatorMatchesIdentity(runtime.tmux as AiSessionTmuxLocator, identity)
                && (!requiredLocator || locatorsEqual(
                    runtime.tmux as AiSessionTmuxLocator, requiredLocator
                )));
        return matches.length === 1 ? matches[0] : undefined;
    }

    private throwIfCollision(identity: AiSessionRuntimeIdentity): void {
        const conflicts = this.getConflicts().filter(runtime =>
            runtimeIdentitiesMatch(runtime.identity, identity));
        if (conflicts.length) {
            throw new AiSessionRuntimeConflictError(conflicts);
        }
    }

    private throwIfLifecycleBlocked(identity: AiSessionRuntimeIdentity): void {
        const blockers = this.getLifecycleBlockers().filter(runtime =>
            runtime.identity.provider === identity.provider
            && runtime.identity.workspaceScopeIdentity === identity.workspaceScopeIdentity
            && runtime.identity.sessionId === identity.sessionId);
        if (blockers.length) {
            throw new AiSessionRuntimeLifecycleBlockedError(blockers);
        }
    }

    private async attachAndFocus<T extends AiSessionRuntimeSnapshot>(
        runtime: T,
        terminalName: string
    ): Promise<T & AiSessionRuntimeSnapshot<TTerminal>> {
        if (!runtime.tmux) {
            throw new Error('A tmux runtime must include a locator.');
        }
        const key = registryKey(runtime);
        const selectingEntry = this.attaches.get(key);
        if (selectingEntry) {
            selectingEntry.focusEpoch++;
            selectingEntry.explicitSelections++;
        }
        try {
            await this.dependencies.client.selectWindow(runtime.tmux);
            let entry = this.attaches.get(key);
            if (!entry) {
                const binding = attachBinding(runtime, terminalName);
                const recoveryToken = createAttachRecoveryToken();
                const terminal = this.dependencies.createTerminal({
                    name: terminalName,
                    shellPath: this.dependencies.client.getExecutablePath(),
                    shellArgs: ['attach-session', '-t', runtime.tmux.sessionName],
                    env: { TMUX: null, [TMUX_ATTACH_RECOVERY_ENV]: recoveryToken },
                });
                entry = {
                    terminal, binding, recoveryToken, focusedBinding: binding,
                    focusEpoch: 0, explicitSelections: 0,
                };
                this.attaches.set(key, entry);
                this.persistAttachBinding(
                    attachTerminal(terminal).processId, binding, recoveryToken
                );
            } else {
                const binding = attachBinding(runtime, entry.binding.terminalNamePrefix);
                entry.binding = binding;
                entry.focusedBinding = binding;
                entry.focusEpoch++;
                this.persistAttachBinding(
                    attachTerminal(entry.terminal).processId,
                    entry.binding,
                    entry.recoveryToken || null
                );
            }
            try {
                attachTerminal(entry.terminal).show();
            } catch (error) {
                entry.focusEpoch++;
                this.attaches.delete(key);
                this.removePersistedAttach(
                    entry.recoveryToken || null, attachTerminal(entry.terminal).processId
                );
                try {
                    attachTerminal(entry.terminal).dispose();
                } catch (_disposeError) {
                    // Preserve the original show failure.
                }
                throw error;
            }
            await this.dependencies.attachStore.flush();
            return this.withAttach(runtime) as T & AiSessionRuntimeSnapshot<TTerminal>;
        } finally {
            if (selectingEntry) {
                selectingEntry.focusEpoch++;
                selectingEntry.explicitSelections--;
            }
        }
    }

    private getAttachTerminalName(runtime: AiSessionRuntimeSnapshot): string {
        const candidate = this.dependencies.getAttachTerminalName?.({
            ...runtime,
            identity: cloneAiSessionRuntimeIdentity(runtime.identity),
            ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        });
        return isSafeAttachTerminalName(candidate)
            ? candidate
            : getRestoredAttachTerminalName(runtime);
    }

    private withAttach(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot<TTerminal> {
        const entry = this.attaches.get(registryKey(runtime));
        const { terminal: _terminal, ...base } = runtime;
        return {
            ...base,
            identity: cloneAiSessionRuntimeIdentity(runtime.identity),
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
        const availability = await this.dependencies.client.checkAvailability();
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
                && runtime.identity.workspaceScopeIdentity === binding.workspaceScopeIdentity
                && runtime.tmux.sessionName === binding.sessionName
                && (!binding.windowName || runtime.tmux.windowName === binding.windowName));
        }
        return runtimes.find(runtime => runtime.tmux?.layout === 'session'
            && runtime.identity.workspaceScopeIdentity === binding.workspaceScopeIdentity
            && runtime.tmux.sessionName === binding.sessionName
            && (!binding.windowName || runtime.tmux.windowName === binding.windowName)
            && (!binding.provider || runtime.identity.provider === binding.provider)
            && (!binding.sessionId || runtime.identity.sessionId === binding.sessionId));
    }

    private persistAttachBinding(
        processId: AttachTerminal['processId'],
        binding: TmuxAttachBinding,
        recoveryToken: string | null
    ): void {
        if (recoveryToken) {
            this.dependencies.attachStore.setRecovery(recoveryToken, processId, binding);
            return;
        }
        this.dependencies.attachStore.set(processId, binding);
    }

    private removePersistedAttach(
        recoveryToken: string | null,
        processId: TmuxAttachProcessId
    ): void {
        if (recoveryToken) {
            this.dependencies.attachStore.removeRecovery(recoveryToken);
            return;
        }
        this.dependencies.attachStore.remove(processId);
    }

    private async runtimeForAttachSession(
        sessionName: string | null
    ): Promise<AiSessionRuntimeSnapshot | undefined> {
        if (!sessionName) {
            return undefined;
        }
        const matches = [
            ...this.dependencies.discovery.getActive(),
            ...this.dependencies.discovery.getPending(),
        ].filter(runtime => runtime.tmux?.sessionName === sessionName);
        if (matches.length <= 1) {
            return matches[0];
        }
        const registryKeys = new Set(matches.map(registryKey));
        if (registryKeys.size !== 1 || matches.some(runtime => runtime.tmux?.layout !== 'project')) {
            return undefined;
        }
        const activeWindow = await this.dependencies.client.getActiveWindow(sessionName);
        const activeMatches = activeWindow
            ? matches.filter(runtime => runtime.tmux?.windowName === activeWindow.windowName)
            : [];
        return activeMatches.length === 1 ? activeMatches[0] : matches[0];
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
        const sourceWindow = from.windowName || SESSION_WINDOW;
        if (!to.windowName) {
            throw new Error('A session tmux promotion requires a final managed window name.');
        }
        await this.dependencies.client.renameWindow(to.sessionName, sourceWindow, to.windowName);
    }

    private async migrateAttach(
        pending: AiSessionRuntimeSnapshot,
        promoted: AiSessionRuntimeSnapshot
    ): Promise<void> {
        const oldKey = registryKey(pending);
        const newKey = registryKey(promoted);
        const entry = this.attaches.get(oldKey);
        if (!entry) {
            return;
        }
        const nextBinding = attachBinding(promoted, entry.binding.terminalNamePrefix);
        const updatePersisted = bindingTargetsRuntime(entry.binding, pending);
        const updateFocused = entry.focusedBinding !== undefined
            && bindingTargetsRuntime(entry.focusedBinding, pending);
        const changesRegistry = oldKey !== newKey;
        if (changesRegistry) {
            this.attaches.delete(oldKey);
            this.attaches.set(newKey, entry);
        }
        if (updatePersisted) {
            entry.binding = nextBinding;
            this.persistAttachBinding(
                attachTerminal(entry.terminal).processId,
                nextBinding,
                entry.recoveryToken || null
            );
        }
        if (updateFocused) {
            entry.focusedBinding = nextBinding;
        }
        if (changesRegistry || updatePersisted || updateFocused) {
            entry.focusEpoch++;
        }
        if (updatePersisted) {
            await this.dependencies.attachStore.flush();
        }
    }
}

function finalIdentity(identity: AiSessionRuntimeIdentity & { sessionId: string }): AiSessionRuntimeIdentity {
    return {
        ...cloneAiSessionRuntimeIdentity(identity),
        sessionId: identity.sessionId,
        pendingId: undefined,
    };
}

function runtimeIdentitiesMatch(
    left: AiSessionRuntimeIdentity,
    right: AiSessionRuntimeIdentity
): boolean {
    if (!left || !right || left.provider !== right.provider
        || left.workspaceScopeIdentity !== right.workspaceScopeIdentity) {
        return false;
    }
    if (right.sessionId !== undefined) {
        return left.sessionId === right.sessionId;
    }
    return left.pendingId === right.pendingId
        && (!right.cwd || left.cwd === right.cwd);
}

function runtimeIdentityEquals(
    left: AiSessionRuntimeIdentity | null,
    right: AiSessionRuntimeIdentity | null
): boolean {
    if (!left || !right) {
        return left === right;
    }
    return aiSessionRuntimeIdentitiesEqual(left, right);
}

function bindingTargetsRuntime(
    binding: TmuxAttachBinding | null | undefined,
    runtime: AiSessionRuntimeSnapshot
): boolean {
    if (!binding || !runtime.tmux
        || binding.layout !== runtime.tmux.layout
        || !aiSessionRuntimeIdentitiesEqual(binding, runtime.identity)
        || binding.sessionName !== runtime.tmux.sessionName) {
        return false;
    }
    if (binding.layout === 'project') {
        return binding.windowName === runtime.tmux.windowName;
    }
    return (!binding.provider || binding.provider === runtime.identity.provider)
        && (!binding.sessionId || binding.sessionId === runtime.identity.sessionId)
        && (!binding.windowName || binding.windowName === runtime.tmux.windowName);
}

function getRestoredAttachTerminalName(runtime: AiSessionRuntimeSnapshot): string {
    const identityId = runtime.identity.sessionId || runtime.identity.pendingId || 'runtime';
    const digest = createHash('sha256').update(JSON.stringify([
        runtime.tmux?.layout,
        runtime.identity.provider,
        runtime.identity.workspaceScopeIdentity,
        identityId,
        runtime.tmux?.sessionName,
        runtime.tmux?.windowName || '',
    ]), 'utf8').digest('hex').slice(0, 12);
    return runtime.tmux?.layout === 'project'
        ? `Project Steward: tmux project ${digest} [tmux]`
        : `Project Steward: ${runtime.identity.provider} ${digest} [tmux]`;
}

function isSafeAttachTerminalName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 200
        && !LOCAL_CONTROL_CHARACTERS.test(value);
}

function snapshotResumeRequest(request: AiSessionResumeRuntimeRequest): AiSessionResumeRuntimeRequest {
    if (!isRecordShape(request)) {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    const identity = snapshotResumeIdentity(request.identity);
    const projectName = snapshotRequiredString(request.projectName, 'The tmux runtime request');
    const sessionName = snapshotDisplayName(
        request.sessionName, identity.sessionId, 'The tmux runtime request'
    );
    const terminalName = snapshotRequiredString(request.terminalName, 'The tmux runtime request');
    const launch = snapshotLaunch(request.launch);
    return {
        identity,
        projectName,
        sessionName,
        terminalName,
        launch,
        directoryScope: request.directoryScope,
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
        directoryScope: request.directoryScope,
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
    const workspaceScopeIdentity = snapshotRequiredString(value.workspaceScopeIdentity, 'The tmux runtime request');
    const workspaceNavigationIdentity = snapshotRequiredString(
        value.workspaceNavigationIdentity, 'The tmux runtime request'
    );
    const workspaceRootHostPaths = snapshotDenseStringArray(value.workspaceRootHostPaths,
        MAX_EXCLUDED_SESSION_IDS, 'workspace root paths', 'The tmux runtime request');
    const cwd = snapshotRequiredString(value.cwd, 'The tmux runtime request');
    const sessionId = snapshotRequiredString(value.sessionId, 'The tmux runtime request');
    return {
        provider: provider as AiSessionResumeRuntimeRequest['identity']['provider'],
        workspaceScopeIdentity,
        workspaceNavigationIdentity,
        workspaceRootHostPaths,
        cwd,
        sessionId,
    };
}

function snapshotPendingIdentity(value: unknown): AiSessionCreateRuntimeRequest['identity'] {
    if (!isRecordShape(value)) {
        throw new Error('The pending runtime request shape is invalid.');
    }
    const provider = snapshotRequiredString(value.provider, 'The pending runtime request');
    const workspaceScopeIdentity = snapshotRequiredString(value.workspaceScopeIdentity, 'The pending runtime request');
    const workspaceNavigationIdentity = snapshotRequiredString(
        value.workspaceNavigationIdentity, 'The pending runtime request'
    );
    const workspaceRootHostPaths = snapshotDenseStringArray(value.workspaceRootHostPaths,
        MAX_EXCLUDED_SESSION_IDS, 'workspace root paths', 'The pending runtime request');
    const cwd = snapshotRequiredString(value.cwd, 'The pending runtime request');
    const pendingId = snapshotRequiredString(value.pendingId, 'The pending runtime request');
    return {
        provider: provider as AiSessionCreateRuntimeRequest['identity']['provider'],
        workspaceScopeIdentity,
        workspaceNavigationIdentity,
        workspaceRootHostPaths,
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

function snapshotDisplayName(value: unknown, fallback: string, owner: string): string {
    const candidate = value === undefined ? fallback : snapshotRequiredString(value, owner);
    if (candidate.length > 200 || LOCAL_CONTROL_CHARACTERS.test(candidate)) {
        throw new Error(`${owner} display name is invalid.`);
    }
    return candidate;
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
        ...cloneAiSessionRuntimeIdentity(identity),
        pendingId: identity.pendingId,
        sessionId: undefined,
    };
}

function pendingLifecycleLockKey(identity: AiSessionRuntimeIdentity): string {
    return `pending:${getTmuxRuntimeKey(identity)}`;
}

function pendingLifecycleIdentityMatches(
    record: TmuxPendingRuntimeBinding | TmuxPromotingRuntimeBinding
        | TmuxConsumedPendingBinding | TmuxAmbiguousRuntimeBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.pendingId === identity.pendingId && record.provider === identity.provider
        && aiSessionRuntimeIdentitiesEqual({
            ...cloneAiSessionRuntimeIdentity(identity),
            sessionId: undefined,
            pendingId: record.pendingId,
        }, {
            provider: record.provider,
            workspaceScopeIdentity: record.workspaceScopeIdentity,
            workspaceNavigationIdentity: record.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...record.workspaceRootHostPaths],
            cwd: record.cwd,
            pendingId: record.pendingId,
        });
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
    if (!identity || !isValidAiSessionRuntimeIdentity(identity)) {
        throw new Error('The tmux runtime cwd is invalid.');
    }
    const hasSessionId = identity.sessionId !== undefined;
    const hasPendingId = identity.pendingId !== undefined;
    if ((identity.provider !== 'codex' && identity.provider !== 'kimi' && identity.provider !== 'claude')
        || hasSessionId === hasPendingId
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

function isBoundedOptionalLocalPath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_LOCAL_PATH_LENGTH
        && !LOCAL_CONTROL_CHARACTERS.test(value);
}

function projectSessionMetadata(identity: AiSessionRuntimeIdentity): Record<string, string> {
    return {
        managed: '1',
        version: '2',
        layout: 'project',
        workspaceScopeIdentity: identity.workspaceScopeIdentity,
    };
}

function sessionWindowMetadata(): Record<string, string> {
    return { managed: '1', version: '2', layout: 'session' };
}

function fullMetadata(
    identity: AiSessionRuntimeIdentity,
    layout: AiSessionTmuxLayout,
    createdAt: string,
    markerPath: string
): Record<string, string> {
    return {
        managed: '1',
        version: '2',
        layout,
        workspaceScopeIdentity: identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: JSON.stringify(identity.workspaceRootHostPaths),
        cwd: identity.cwd,
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
        version: 2,
        layout: runtime.tmux.layout,
        workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: runtime.identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...runtime.identity.workspaceRootHostPaths],
        cwd: runtime.identity.cwd,
        sessionName: runtime.tmux.sessionName,
        ...(runtime.tmux.windowName
            ? { windowName: runtime.tmux.windowName }
            : {}),
        provider: runtime.identity.provider,
        ...(runtime.identity.sessionId
            ? { sessionId: runtime.identity.sessionId }
            : { pendingId: runtime.identity.pendingId as string }),
        terminalNamePrefix: terminalName,
    };
}

function registryKey(runtime: AiSessionRuntimeSnapshot): string {
    if (runtime.tmux?.layout === 'project') {
        return `project:${runtime.identity.workspaceScopeIdentity}`;
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

function terminalMatchesBinding(
    terminal: AttachTerminal,
    binding: TmuxAttachBinding,
    launchSessionName: string | null
): boolean {
    if (launchSessionName !== null) {
        return launchSessionName === binding.sessionName
            || terminalTitleMatches(terminal.name, binding);
    }
    if (hasExplicitTerminalLaunch(terminal.creationOptions)) {
        return false;
    }
    return terminalTitleMatches(terminal.name, binding);
}

function getTmuxAttachSessionName(
    creationOptions: AttachTerminal['creationOptions'],
    tmuxExecutablePath: string
): string | null {
    if (!creationOptions || !('shellPath' in creationOptions)
        || creationOptions.shellPath !== tmuxExecutablePath
        || !Array.isArray(creationOptions.shellArgs)
        || creationOptions.shellArgs.length !== 3
        || creationOptions.shellArgs[0] !== 'attach-session'
        || creationOptions.shellArgs[1] !== '-t') {
        return null;
    }
    const sessionName = creationOptions.shellArgs[2];
    return typeof sessionName === 'string' && sessionName.length > 0
        ? sessionName
        : null;
}

function getTmuxAttachRecoveryToken(
    creationOptions: AttachTerminal['creationOptions']
): string | null {
    if (!creationOptions || !('env' in creationOptions) || !creationOptions.env) {
        return null;
    }
    const token = creationOptions.env[TMUX_ATTACH_RECOVERY_ENV];
    return typeof token === 'string' && TMUX_ATTACH_RECOVERY_TOKEN.test(token)
        ? token
        : null;
}

function createAttachRecoveryToken(): string {
    return randomBytes(16).toString('hex');
}

function hasExplicitTerminalLaunch(
    creationOptions: AttachTerminal['creationOptions']
): boolean {
    return Boolean(creationOptions && 'shellPath' in creationOptions
        && (creationOptions.shellPath !== undefined || creationOptions.shellArgs !== undefined));
}

function getTerminalCreationName(terminal: AttachTerminal): string | null {
    const creationOptions = terminal.creationOptions;
    return creationOptions && typeof creationOptions.name === 'string'
        && isSafeAttachTerminalName(creationOptions.name)
        ? creationOptions.name
        : null;
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
        2,
        request.identity.provider,
        request.identity.workspaceScopeIdentity,
        request.identity.workspaceNavigationIdentity,
        request.identity.workspaceRootHostPaths.slice().sort(),
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
        workspaceScopeIdentity: binding.workspaceScopeIdentity,
        workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
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
        ...(binding.projectName === undefined ? {} : { projectName: binding.projectName }),
        ...(binding.title === undefined ? {} : { title: binding.title }),
    };
}

function pendingBindingsEqual(left: TmuxPendingRuntimeBinding, right: TmuxPendingRuntimeBinding): boolean {
    return left.pendingId === right.pendingId && left.provider === right.provider
        && left.workspaceScopeIdentity === right.workspaceScopeIdentity
        && left.workspaceNavigationIdentity === right.workspaceNavigationIdentity
        && JSON.stringify(left.workspaceRootHostPaths.slice().sort())
            === JSON.stringify(right.workspaceRootHostPaths.slice().sort())
        && left.cwd === right.cwd
        && left.createdAt === right.createdAt && left.projectName === right.projectName
        && left.title === right.title
        && left.acceptedAtMs === right.acceptedAtMs && left.layout === right.layout
        && locatorsEqual(left.locator, right.locator)
        && left.excludedSessionIds.length === right.excludedSessionIds.length
        && left.excludedSessionIds.every((value, index) => value === right.excludedSessionIds[index]);
}

function promotionIntent(
    binding: TmuxPendingRuntimeBinding,
    pending: AiSessionRuntimeSnapshot,
    finalIdentityValue: AiSessionRuntimeIdentity,
    finalSessionName: string,
    finalLocator: AiSessionTmuxLocator,
    recordedAtMs: number
): TmuxPromotingRuntimeBinding {
    if (!finalIdentityValue.sessionId) {
        throw new Error('A promotion intent requires a final session ID.');
    }
    const requestFingerprint = promotionRequestFingerprint(
        binding, pending.markerPath, finalSessionName, finalLocator
    );
    return {
        version: 2,
        state: 'promoting',
        pendingId: binding.pendingId,
        provider: binding.provider,
        workspaceScopeIdentity: binding.workspaceScopeIdentity,
        workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
        cwd: binding.cwd,
        createdAt: binding.createdAt,
        markerPath: pending.markerPath,
        pendingBinding: {
            ...binding,
            workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
            excludedSessionIds: [...binding.excludedSessionIds],
            locator: { ...binding.locator },
        },
        finalSessionId: finalIdentityValue.sessionId,
        finalSessionName,
        layout: binding.layout,
        sourceLocator: { ...binding.locator },
        finalLocator: { ...finalLocator },
        requestFingerprint,
        recordedAtMs,
    };
}

function promotionRequestFingerprint(
    binding: TmuxPendingRuntimeBinding,
    markerPath: string,
    finalSessionName: string,
    finalLocator: AiSessionTmuxLocator
): string {
    return createHash('sha256').update(JSON.stringify([
        2,
        binding.provider,
        binding.workspaceScopeIdentity,
        binding.workspaceNavigationIdentity,
        binding.workspaceRootHostPaths.slice().sort(),
        binding.pendingId,
        binding.cwd,
        binding.createdAt,
        binding.excludedSessionIds,
        binding.title ?? null,
        binding.acceptedAtMs,
        binding.layout,
        binding.locator,
        markerPath,
        finalSessionName,
        finalLocator,
    ]), 'utf8').digest('hex');
}

function promotionIntentMatchesLiveBinding(
    intent: TmuxPromotingRuntimeBinding,
    binding: TmuxPendingRuntimeBinding
): boolean {
    return pendingBindingsEqual(intent.pendingBinding, binding)
        && intent.requestFingerprint === promotionRequestFingerprint(
            binding, intent.markerPath, intent.finalSessionName, intent.finalLocator
        );
}

function promotionIntentsMatch(
    left: TmuxPromotingRuntimeBinding,
    right: TmuxPromotingRuntimeBinding
): boolean {
    return left.pendingId === right.pendingId && left.provider === right.provider
        && left.workspaceScopeIdentity === right.workspaceScopeIdentity
        && left.workspaceNavigationIdentity === right.workspaceNavigationIdentity
        && JSON.stringify(left.workspaceRootHostPaths.slice().sort())
            === JSON.stringify(right.workspaceRootHostPaths.slice().sort())
        && left.cwd === right.cwd
        && left.createdAt === right.createdAt && left.markerPath === right.markerPath
        && pendingBindingsEqual(left.pendingBinding, right.pendingBinding)
        && left.finalSessionId === right.finalSessionId
        && left.finalSessionName === right.finalSessionName && left.layout === right.layout
        && locatorsEqual(left.sourceLocator, right.sourceLocator)
        && locatorsEqual(left.finalLocator, right.finalLocator)
        && left.requestFingerprint === right.requestFingerprint;
}

function consumedMatchesPromotionIntent(
    consumed: TmuxConsumedPendingBinding,
    intent: TmuxPromotingRuntimeBinding
): boolean {
    return consumed.finalSessionName !== undefined
        && pendingLifecycleIdentityMatches(consumed, intent)
        && consumed.finalSessionId === intent.finalSessionId
        && consumed.finalSessionName === intent.finalSessionName
        && consumed.layout === intent.layout
        && locatorsEqual(consumed.finalLocator, intent.finalLocator);
}

type PendingAmbiguousRuntimeBinding = TmuxAmbiguousRuntimeBinding & {
    pendingId: string;
    sessionId?: never;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    projectName?: string;
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
        && ambiguous.workspaceScopeIdentity === binding.workspaceScopeIdentity
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
        identity: cloneAiSessionRuntimeIdentity(runtime.identity),
        state: 'conflict',
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}
