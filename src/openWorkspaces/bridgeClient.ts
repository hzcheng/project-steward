'use strict';

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
    OPEN_WORKSPACE_HEARTBEAT_MS,
    OpenWorkspaceAggregate,
    OpenWorkspaceRecord,
    validateOpenWorkspaceAggregate,
    validateOpenWorkspacePublication,
    validateOpenWorkspaceRecord,
} from './protocol';

export const OPEN_WORKSPACE_PUBLISH_COMMAND = '_projectStewardOpenWorkspaces.bridge.publish';
export const OPEN_WORKSPACE_UNREGISTER_COMMAND = '_projectStewardOpenWorkspaces.bridge.unregister';
export const OPEN_WORKSPACE_HANDSHAKE_COMMAND = '_projectStewardOpenWorkspaces.bridge.handshake';
export const OPEN_WORKSPACE_AGGREGATE_COMMAND = '_projectStewardOpenWorkspaces.workspace.aggregate';
export const OPEN_WORKSPACE_DIAGNOSTIC_COMMAND = '_projectStewardOpenWorkspaces.workspace.diagnostic';

export type OpenWorkspaceBridgeStatus = 'ready' | 'unavailable' | 'update-required';

const RETRY_DELAYS_MS = [100, 500, 2_000, 10_000, 30_000];
const MAX_FORWARDED_DIAGNOSTIC_BYTES = 64 * 1024;

interface DisposableLike {
    dispose(): void;
}

export interface OpenWorkspaceBridgeClientDependencies {
    instanceId?: string;
    now?: () => number;
    mainExtensionVersion?: string;
    registerCommand?: (command: string, callback: (raw: unknown) => void) => DisposableLike;
    executeCommand?: (command: string, argument: unknown) => PromiseLike<unknown>;
    setInterval?: (callback: () => void, intervalMs: number) => unknown;
    clearInterval?: (handle: unknown) => void;
    setTimeout?: (callback: () => void, delayMs: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    reportDiagnostic?: (event: OpenWorkspaceClientDiagnosticEvent) => void;
    reportBridgeDiagnostic?: (event: unknown) => void;
    onStatusChange?: (status: OpenWorkspaceBridgeStatus) => void;
}

export interface OpenWorkspaceClientDiagnosticEvent {
    event: 'activate' | 'handshake' | 'publish-success' | 'publish-failure' | 'aggregate' | 'dispose';
    atMs: number;
    instanceId: string;
    sequence?: number;
    reason?: 'change' | 'focus' | 'heartbeat';
    workspaceCount?: number;
    registrationCount?: number;
    semanticRevision?: string;
    accepted?: boolean;
    errorCode?: string;
}

interface OpenWorkspaceHandshakeResponse {
    accepted: boolean;
    protocolVersion: 2;
    bridgeExtensionVersion: string;
    capabilities: { workspaces: true; atomicReplace: true; focusLeases: true };
    errorCode?: 'update-required';
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
    return Object.keys(value).sort().join('\n') === expected.slice().sort().join('\n');
}

function validateHandshakeResponse(raw: unknown): OpenWorkspaceHandshakeResponse {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('open workspace handshake response must be an object');
    }
    const response = raw as Record<string, unknown>;
    const expected = response.errorCode === undefined
        ? ['accepted', 'protocolVersion', 'bridgeExtensionVersion', 'capabilities']
        : ['accepted', 'protocolVersion', 'bridgeExtensionVersion', 'capabilities', 'errorCode'];
    if (!exactKeys(response, expected)
        || response.protocolVersion !== 2
        || typeof response.accepted !== 'boolean'
        || typeof response.bridgeExtensionVersion !== 'string'
        || !response.bridgeExtensionVersion
        || response.bridgeExtensionVersion.length > 64) {
        throw new Error('open workspace handshake response is incompatible');
    }
    const capabilities = response.capabilities as Record<string, unknown>;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
        || !exactKeys(capabilities, ['workspaces', 'atomicReplace', 'focusLeases'])
        || capabilities.workspaces !== true
        || capabilities.atomicReplace !== true
        || capabilities.focusLeases !== true) {
        throw new Error('open workspace handshake capabilities are incompatible');
    }
    if (response.errorCode !== undefined && response.errorCode !== 'update-required') {
        throw new Error('open workspace handshake error code is invalid');
    }
    if (response.accepted !== true) {
        throw new Error(`open workspace handshake rejected: ${String(response.errorCode || 'update-required')}`);
    }
    return response as unknown as OpenWorkspaceHandshakeResponse;
}

export default class OpenWorkspaceBridgeClient implements vscode.Disposable {
    public readonly instanceId: string;

    private sequence = 0;
    private latestWorkspace: OpenWorkspaceRecord | null;
    private lastSemantic = '';
    private lastAggregateRevision = '';
    private connected = false;
    private incompatible = false;
    private disposed = false;
    private retryAttempt = 0;
    private retryTimer: unknown = null;
    private handshakeFlight: Promise<boolean> | null = null;
    private publishCommandFlight: Promise<void> | null = null;
    private publicationQueue: Promise<void> = Promise.resolve();
    private status: OpenWorkspaceBridgeStatus | null = null;
    private readonly now: () => number;
    private readonly executeCommand: (command: string, argument: unknown) => PromiseLike<unknown>;
    private readonly clearInterval: (handle: unknown) => void;
    private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
    private readonly cancelTimeout: (handle: unknown) => void;
    private readonly mainExtensionVersion: string;
    private readonly reportDiagnostic: (event: OpenWorkspaceClientDiagnosticEvent) => void;
    private readonly reportBridgeDiagnostic: (event: unknown) => void;
    private readonly onStatusChange: (status: OpenWorkspaceBridgeStatus) => void;
    private readonly aggregateRegistration: DisposableLike;
    private readonly diagnosticRegistration: DisposableLike;
    private readonly heartbeatHandle: unknown;

    constructor(
        initialWorkspace: OpenWorkspaceRecord | null,
        private readonly onAggregate: (aggregate: OpenWorkspaceAggregate) => void,
        private readonly onError: (error: unknown) => void,
        dependencies: OpenWorkspaceBridgeClientDependencies = {},
    ) {
        this.instanceId = dependencies.instanceId || crypto.randomBytes(16).toString('hex');
        this.latestWorkspace = initialWorkspace ? validateOpenWorkspaceRecord(initialWorkspace) : null;
        this.now = dependencies.now || Date.now;
        this.mainExtensionVersion = dependencies.mainExtensionVersion || 'unknown';
        this.executeCommand = dependencies.executeCommand
            || ((command, argument) => vscode.commands.executeCommand(command, argument));
        const registerCommand = dependencies.registerCommand
            || ((command, callback) => vscode.commands.registerCommand(command, callback));
        const setHeartbeat = dependencies.setInterval
            || ((callback, intervalMs) => setInterval(callback, intervalMs));
        this.clearInterval = dependencies.clearInterval
            || (handle => clearInterval(handle as NodeJS.Timeout));
        this.scheduleTimeout = dependencies.setTimeout
            || ((callback, delayMs) => setTimeout(callback, delayMs));
        this.cancelTimeout = dependencies.clearTimeout
            || (handle => clearTimeout(handle as NodeJS.Timeout));
        this.reportDiagnostic = dependencies.reportDiagnostic || (() => undefined);
        this.reportBridgeDiagnostic = dependencies.reportBridgeDiagnostic || (() => undefined);
        this.onStatusChange = dependencies.onStatusChange || (() => undefined);
        this.aggregateRegistration = registerCommand(
            OPEN_WORKSPACE_AGGREGATE_COMMAND,
            raw => this.receiveAggregate(raw),
        );
        this.diagnosticRegistration = registerCommand(
            OPEN_WORKSPACE_DIAGNOSTIC_COMMAND,
            raw => this.receiveBridgeDiagnostic(raw),
        );
        this.heartbeatHandle = setHeartbeat(
            () => { void this.enqueuePublication(this.latestWorkspace, false, true); },
            OPEN_WORKSPACE_HEARTBEAT_MS,
        );
        this.emitDiagnostic({ event: 'activate', workspaceCount: this.latestWorkspace ? 1 : 0 });
        void this.publish(this.latestWorkspace);
    }

    publish(workspace: OpenWorkspaceRecord | null, followsFocusEvent = false): Promise<boolean> {
        if (this.disposed) { return Promise.resolve(false); }
        this.latestWorkspace = workspace ? validateOpenWorkspaceRecord(workspace) : null;
        return this.enqueuePublication(this.latestWorkspace, followsFocusEvent, false);
    }

    receiveAggregate(raw: unknown): void {
        if (this.disposed) { return; }
        try {
            const aggregate = validateOpenWorkspaceAggregate(raw);
            if (aggregate.semanticRevision === this.lastAggregateRevision) { return; }
            this.emitDiagnostic({
                event: 'aggregate',
                registrationCount: aggregate.registrations.length,
                semanticRevision: aggregate.semanticRevision,
            });
            this.onAggregate(aggregate);
            this.lastAggregateRevision = aggregate.semanticRevision;
        } catch (error) {
            this.onError(error);
        }
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.aggregateRegistration.dispose();
        this.diagnosticRegistration.dispose();
        this.clearInterval(this.heartbeatHandle);
        if (this.retryTimer !== null) { this.cancelTimeout(this.retryTimer); }
        this.retryTimer = null;
        this.emitDiagnostic({ event: 'dispose', sequence: this.sequence });
        const unregister = () => Promise.resolve().then(() => this.executeCommand(
            OPEN_WORKSPACE_UNREGISTER_COMMAND,
            { protocolVersion: 2, instanceId: this.instanceId },
        )).then(() => undefined, error => { this.onError(error); });
        if (this.publishCommandFlight) {
            void this.publishCommandFlight.then(unregister, unregister);
        } else {
            void unregister();
        }
    }

    private enqueuePublication(
        workspace: OpenWorkspaceRecord | null,
        followsFocusEvent: boolean,
        forceHeartbeat: boolean,
    ): Promise<boolean> {
        if (this.disposed) { return Promise.resolve(false); }
        let accepted = false;
        const operation = async () => {
            if (this.disposed || !await this.ensureHandshake() || this.disposed) { return; }
            accepted = await this.publishNow(workspace, followsFocusEvent, forceHeartbeat);
        };
        const result = this.publicationQueue.then(operation, operation);
        this.publicationQueue = result.then(() => undefined, () => undefined);
        return result.then(() => accepted);
    }

    private async publishNow(
        workspace: OpenWorkspaceRecord | null,
        followsFocusEvent: boolean,
        forceHeartbeat: boolean,
    ): Promise<boolean> {
        if (this.disposed) { return false; }
        if (this.sequence >= Number.MAX_SAFE_INTEGER) {
            this.onError(new Error('open workspace publication sequence is exhausted'));
            return false;
        }
        const semantic = JSON.stringify(workspace);
        if (!forceHeartbeat && !followsFocusEvent && semantic === this.lastSemantic) { return true; }
        const publication = validateOpenWorkspacePublication({
            protocolVersion: 2,
            instanceId: this.instanceId,
            sequence: ++this.sequence,
            followsFocusEvent,
            workspace,
        });
        const reason = forceHeartbeat ? 'heartbeat' : followsFocusEvent ? 'focus' : 'change';
        const commandFlight = Promise.resolve()
            .then(() => this.executeCommand(OPEN_WORKSPACE_PUBLISH_COMMAND, publication))
            .then(() => undefined);
        this.publishCommandFlight = commandFlight;
        try {
            await commandFlight;
            this.lastSemantic = semantic;
            if (!this.disposed) { this.setStatus('ready'); }
            this.emitDiagnostic({
                event: 'publish-success',
                sequence: publication.sequence,
                reason,
                workspaceCount: publication.workspace ? 1 : 0,
            });
            return true;
        } catch (error) {
            if (this.disposed) { return false; }
            this.connected = false;
            this.setStatus('unavailable');
            this.emitDiagnostic({
                event: 'publish-failure',
                sequence: publication.sequence,
                reason,
                workspaceCount: publication.workspace ? 1 : 0,
            });
            this.onError(error);
            this.scheduleRetry();
            return false;
        } finally {
            if (this.publishCommandFlight === commandFlight) {
                this.publishCommandFlight = null;
            }
        }
    }

    private ensureHandshake(): Promise<boolean> {
        if (this.disposed || this.incompatible) { return Promise.resolve(false); }
        if (this.connected) { return Promise.resolve(true); }
        if (this.handshakeFlight) { return this.handshakeFlight; }
        if (this.retryTimer !== null) { return Promise.resolve(false); }
        this.handshakeFlight = this.handshake().then(result => {
            this.handshakeFlight = null;
            return result;
        }, error => {
            this.handshakeFlight = null;
            throw error;
        });
        return this.handshakeFlight;
    }

    private async handshake(): Promise<boolean> {
        try {
            const response = validateHandshakeResponse(await this.executeCommand(
                OPEN_WORKSPACE_HANDSHAKE_COMMAND,
                {
                    protocolVersion: 2,
                    mainExtensionVersion: this.mainExtensionVersion,
                    instanceId: this.instanceId,
                    capabilities: { workspaces: true, atomicReplace: true, focusLeases: true },
                },
            ));
            if (this.disposed) { return false; }
            this.connected = true;
            this.retryAttempt = 0;
            if (this.retryTimer !== null) { this.cancelTimeout(this.retryTimer); }
            this.retryTimer = null;
            this.setStatus('ready');
            this.emitDiagnostic({ event: 'handshake', accepted: response.accepted });
            return true;
        } catch (error) {
            if (this.disposed) { return false; }
            const message = error instanceof Error ? error.message : String(error);
            if (/update-required|protocol|capabilit/i.test(message)) {
                this.incompatible = true;
                this.setStatus('update-required');
                this.emitDiagnostic({ event: 'handshake', accepted: false, errorCode: 'update-required' });
            } else {
                this.setStatus('unavailable');
                this.scheduleRetry();
            }
            this.onError(error);
            return false;
        }
    }

    private scheduleRetry(): void {
        if (this.disposed || this.incompatible || this.retryTimer !== null) { return; }
        const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)];
        this.retryAttempt += 1;
        this.retryTimer = this.scheduleTimeout(() => {
            this.retryTimer = null;
            void this.ensureHandshake().then(ready => {
                if (ready) { void this.enqueuePublication(this.latestWorkspace, false, true); }
            });
        }, delay);
    }

    private setStatus(status: OpenWorkspaceBridgeStatus): void {
        if (this.disposed || this.status === status) { return; }
        this.status = status;
        try {
            this.onStatusChange(status);
        } catch (error) {
            this.onError(error);
        }
    }

    private receiveBridgeDiagnostic(raw: unknown): void {
        try {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new Error('open workspace diagnostic must be an object');
            }
            const serialized = JSON.stringify(raw);
            if (Buffer.byteLength(serialized, 'utf8') > MAX_FORWARDED_DIAGNOSTIC_BYTES) {
                throw new Error('open workspace diagnostic exceeds 64 KiB');
            }
            this.reportBridgeDiagnostic(JSON.parse(serialized));
        } catch (error) {
            this.onError(error);
        }
    }

    private emitDiagnostic(
        event: Omit<OpenWorkspaceClientDiagnosticEvent, 'atMs' | 'instanceId'>,
    ): void {
        try {
            this.reportDiagnostic({ ...event, atMs: this.safeNow(), instanceId: this.instanceId });
        } catch (_error) {
            // Diagnostics must never change bridge behavior.
        }
    }

    private safeNow(): number {
        try {
            const timestamp = this.now();
            return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
        } catch (_error) {
            return Date.now();
        }
    }
}
