'use strict';

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
    OPEN_PROJECT_HEARTBEAT_MS,
    OpenProjectAggregate,
    OpenProjectRecord,
    validateOpenProjectAggregate,
    validateOpenProjectPublication,
} from './protocol';

const PUBLISH_COMMAND = '_projectStewardOpenProjects.bridge.publish';
const UNREGISTER_COMMAND = '_projectStewardOpenProjects.bridge.unregister';
const AGGREGATE_COMMAND = '_projectStewardOpenProjects.workspace.aggregate';
const DIAGNOSTIC_COMMAND = '_projectStewardOpenProjects.workspace.diagnostic';
const ERROR_THROTTLE_MS = 60_000;
const MAX_FORWARDED_DIAGNOSTIC_BYTES = 64 * 1024;

interface DisposableLike {
    dispose(): void;
}

interface OpenProjectBridgeClientDependencies {
    instanceId?: string;
    now?: () => number;
    registerCommand?: (command: string, callback: (raw: unknown) => void) => DisposableLike;
    executeCommand?: (command: string, argument: unknown) => PromiseLike<unknown>;
    refreshProjects?: () => OpenProjectRecord[];
    setInterval?: (callback: () => void, intervalMs: number) => unknown;
    clearInterval?: (handle: unknown) => void;
    reportDiagnostic?: (event: OpenProjectClientDiagnosticEvent) => void;
    reportBridgeDiagnostic?: (event: unknown) => void;
}

export interface OpenProjectClientDiagnosticEvent {
    event: 'activate' | 'publish-success' | 'publish-failure' | 'aggregate' | 'dispose';
    atMs: number;
    instanceId: string;
    sequence?: number;
    reason?: 'change' | 'focus' | 'heartbeat';
    projectCount?: number;
    registrationCount?: number;
    semanticRevision?: string;
    error?: string;
    registrations?: Array<{
        instanceId: string;
        sequence: number;
        projectCount: number;
        leaseAgeMs: number;
    }>;
}

export default class OpenProjectBridgeClient implements vscode.Disposable {
    public readonly instanceId: string;

    private sequence = 0;
    private projects: OpenProjectRecord[] = [];
    private lastPublishedSemantic = '';
    private pendingSemantic = '';
    private lastAggregateRevision = '';
    private lastErrorAt = Number.NEGATIVE_INFINITY;
    private disposed = false;
    private readonly now: () => number;
    private readonly executeCommand: (command: string, argument: unknown) => PromiseLike<unknown>;
    private readonly refreshProjects: (() => OpenProjectRecord[]) | undefined;
    private readonly clearInterval: (handle: unknown) => void;
    private readonly reportDiagnostic: (event: OpenProjectClientDiagnosticEvent) => void;
    private readonly reportBridgeDiagnostic: (event: unknown) => void;
    private readonly aggregateRegistration: DisposableLike;
    private readonly diagnosticRegistration: DisposableLike;
    private readonly heartbeatHandle: unknown;

    constructor(
        initialProjects: OpenProjectRecord[],
        private readonly onAggregate: (aggregate: OpenProjectAggregate) => void,
        private readonly onError: (error: unknown) => void,
        dependencies: OpenProjectBridgeClientDependencies = {}
    ) {
        this.instanceId = dependencies.instanceId || crypto.randomBytes(16).toString('hex');
        this.now = dependencies.now || Date.now;
        this.executeCommand = dependencies.executeCommand
            || ((command, argument) => vscode.commands.executeCommand(command, argument));
        this.refreshProjects = dependencies.refreshProjects;
        const registerCommand = dependencies.registerCommand
            || ((command, callback) => vscode.commands.registerCommand(command, callback));
        const setHeartbeat = dependencies.setInterval
            || ((callback, intervalMs) => setInterval(callback, intervalMs));
        this.clearInterval = dependencies.clearInterval
            || (handle => clearInterval(handle as NodeJS.Timeout));
        this.reportDiagnostic = dependencies.reportDiagnostic || (() => undefined);
        this.reportBridgeDiagnostic = dependencies.reportBridgeDiagnostic || (() => undefined);

        this.aggregateRegistration = registerCommand(AGGREGATE_COMMAND, raw => this.receiveAggregate(raw));
        this.diagnosticRegistration = registerCommand(DIAGNOSTIC_COMMAND, raw => this.receiveBridgeDiagnostic(raw));
        this.heartbeatHandle = setHeartbeat(
            () => { void this.publishInternal(this.getHeartbeatProjects(), false, true); },
            OPEN_PROJECT_HEARTBEAT_MS
        );
        this.emitDiagnostic({
            event: 'activate',
            projectCount: initialProjects.length,
        });
        void this.publish(initialProjects);
    }

    publish(projects: OpenProjectRecord[], followsFocusEvent = false): Promise<boolean> {
        return this.publishInternal(projects, followsFocusEvent, false);
    }

    receiveAggregate(raw: unknown): void {
        try {
            const aggregate = validateOpenProjectAggregate(raw);
            if (aggregate.semanticRevision === this.lastAggregateRevision) {
                return;
            }
            this.lastAggregateRevision = aggregate.semanticRevision;
            const now = this.safeNow();
            this.emitDiagnostic({
                event: 'aggregate',
                registrationCount: aggregate.registrations.length,
                semanticRevision: aggregate.semanticRevision,
                registrations: aggregate.registrations.map(registration => ({
                    instanceId: registration.instanceId,
                    sequence: registration.sequence,
                    projectCount: registration.projects.length,
                    leaseAgeMs: Math.max(0, now - registration.leaseUpdatedAtMs),
                })),
            }, now);
            this.onAggregate(aggregate);
        } catch (error) {
            this.reportError(error);
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.aggregateRegistration.dispose();
        this.diagnosticRegistration.dispose();
        this.clearInterval(this.heartbeatHandle);
        this.emitDiagnostic({ event: 'dispose', sequence: this.sequence });
        try {
            Promise.resolve(this.executeCommand(UNREGISTER_COMMAND, {
                protocolVersion: 1,
                instanceId: this.instanceId,
            })).catch(error => this.reportError(error));
        } catch (error) {
            this.reportError(error);
        }
    }

    private async publishInternal(
        projects: OpenProjectRecord[],
        followsFocusEvent: boolean,
        forceHeartbeat: boolean
    ): Promise<boolean> {
        if (this.disposed) {
            return false;
        }
        if (this.sequence >= Number.MAX_SAFE_INTEGER) {
            this.reportError(new Error('open project publication sequence is exhausted'));
            return false;
        }

        let publication;
        try {
            publication = validateOpenProjectPublication({
                protocolVersion: 1,
                instanceId: this.instanceId,
                sequence: this.sequence + 1,
                followsFocusEvent,
                projects,
            });
        } catch (error) {
            this.reportError(error);
            return false;
        }

        this.projects = publication.projects;
        const semantic = JSON.stringify(publication.projects);
        if (!forceHeartbeat
            && !followsFocusEvent
            && (semantic === this.lastPublishedSemantic || semantic === this.pendingSemantic)) {
            return true;
        }

        this.sequence = publication.sequence;
        this.pendingSemantic = semantic;
        const reason = forceHeartbeat ? 'heartbeat' : followsFocusEvent ? 'focus' : 'change';
        try {
            await this.executeCommand(PUBLISH_COMMAND, publication);
            this.lastPublishedSemantic = semantic;
            this.emitDiagnostic({
                event: 'publish-success',
                sequence: publication.sequence,
                reason,
                projectCount: publication.projects.length,
            });
            return true;
        } catch (error) {
            this.emitDiagnostic({
                event: 'publish-failure',
                sequence: publication.sequence,
                reason,
                projectCount: publication.projects.length,
                error: (error instanceof Error ? error.stack || error.message : String(error)).slice(0, 4096),
            });
            this.reportError(error);
            return false;
        } finally {
            if (this.pendingSemantic === semantic) {
                this.pendingSemantic = '';
            }
        }
    }

    private getHeartbeatProjects(): OpenProjectRecord[] {
        if (!this.refreshProjects) {
            return this.projects;
        }
        try {
            return this.refreshProjects();
        } catch (error) {
            this.reportError(error);
            return this.projects;
        }
    }

    private reportError(error: unknown): void {
        const now = this.now();
        if (now - this.lastErrorAt < ERROR_THROTTLE_MS) {
            return;
        }
        this.lastErrorAt = now;
        this.onError(error);
    }

    private receiveBridgeDiagnostic(raw: unknown): void {
        try {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
                throw new Error('open project diagnostic must be an object');
            }
            const serialized = JSON.stringify(raw);
            if (Buffer.byteLength(serialized, 'utf8') > MAX_FORWARDED_DIAGNOSTIC_BYTES) {
                throw new Error('open project diagnostic exceeds 64 KiB');
            }
            this.reportBridgeDiagnostic(JSON.parse(serialized));
        } catch (error) {
            this.reportError(error);
        }
    }

    private emitDiagnostic(
        event: Omit<OpenProjectClientDiagnosticEvent, 'atMs' | 'instanceId'>,
        atMs?: number,
    ): void {
        try {
            this.reportDiagnostic({
                ...event,
                atMs: atMs === undefined ? this.safeNow() : atMs,
                instanceId: this.instanceId,
            });
        } catch (_error) {
            // Diagnostics must never change publication behavior.
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
