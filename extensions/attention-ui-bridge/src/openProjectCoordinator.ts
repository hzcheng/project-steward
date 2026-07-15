import * as path from 'path';

import {
    createOpenProjectSemanticRevision,
    MAX_OPEN_PROJECT_RECORDS,
    OPEN_PROJECT_HEARTBEAT_MS,
    OPEN_PROJECT_PROTOCOL_VERSION,
    OpenProjectAggregate,
    OpenProjectPublication,
    OpenProjectRegistration,
    validateOpenProjectAggregate,
    validateOpenProjectPublication,
} from '../../../src/openProjects/protocol';
import { OpenProjectStore, OpenProjectStoreScan } from './openProjectStore';

const FALLBACK_SCAN_INTERVAL_MS = 5_000;

interface OpenProjectStoreLike {
    write(registration: OpenProjectRegistration): Promise<void>;
    remove(instanceId: string): Promise<void>;
    scan(nowMs: number): Promise<OpenProjectStoreScan>;
}

interface OpenProjectWatcher {
    close(): void;
}

export interface OpenProjectCoordinatorDependencies {
    now(): number;
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
    createWatcher(directory: string, onDidChange: () => void): OpenProjectWatcher;
    deliverAggregate(aggregate: OpenProjectAggregate): PromiseLike<unknown> | unknown;
    reportDiagnostic?(event: OpenProjectDiagnosticEvent): void;
    createStore?(rootDirectory: string, instanceId: string): OpenProjectStoreLike;
}

export interface OpenProjectDiagnosticEvent {
    event: 'publish' | 'renew' | 'unregister' | 'scan' | 'deliver' | 'error';
    atMs: number;
    instanceId?: string;
    sequence?: number;
    projectCount?: number;
    registrationCount?: number;
    semanticRevision?: string;
    operation?: string;
    error?: string;
    registrations?: Array<{
        instanceId: string;
        sequence: number;
        projectCount: number;
        lastFocusedAtMs: number;
        leaseAgeMs: number;
    }>;
    counters?: OpenProjectStoreScan['counters'];
}

function validateTimestamp(timestamp: number): number {
    if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new Error('desktop timestamp must be a finite non-negative number');
    }
    return timestamp;
}

function validateUnregisterRequest(raw: unknown): string {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('open project unregister request must be an object');
    }
    const request = raw as Record<string, unknown>;
    const keys = Object.keys(request);
    if (keys.length !== 2 || !keys.includes('protocolVersion') || !keys.includes('instanceId')) {
        throw new Error('open project unregister request has unexpected fields');
    }
    const validated = validateOpenProjectPublication({
        protocolVersion: request.protocolVersion,
        instanceId: request.instanceId,
        sequence: 0,
        followsFocusEvent: false,
        projects: [],
    });
    return validated.instanceId;
}

function compareRegistrationPriority(
    left: OpenProjectRegistration,
    right: OpenProjectRegistration,
): number {
    if (left.lastFocusedAtMs !== right.lastFocusedAtMs) {
        return left.lastFocusedAtMs > right.lastFocusedAtMs ? -1 : 1;
    }
    return left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0;
}

export class OpenProjectCoordinator {
    private readonly watcher: OpenProjectWatcher;
    private readonly intervalHandle: unknown;
    private boundInstanceId: string | undefined;
    private store: OpenProjectStoreLike | undefined;
    private currentRegistration: OpenProjectRegistration | undefined;
    private lastFocusedAtMs: number | undefined;
    private lastDeliveredRevision: string | undefined;
    private mutationQueue: Promise<void> = Promise.resolve();
    private scanPromise: Promise<void> | undefined;
    private scanRequested = false;
    private lastScanDiagnostic = '';
    private lastScanDiagnosticAtMs = Number.NEGATIVE_INFINITY;
    private disposed = false;

    public constructor(
        private readonly rootDirectory: string,
        private readonly dependencies: OpenProjectCoordinatorDependencies,
    ) {
        const instancesDirectory = path.join(rootDirectory, 'open-projects', 'v1', 'instances');
        this.watcher = dependencies.createWatcher(instancesDirectory, () => {
            void this.scanAndDeliver().catch(error => this.reportError('watcher', error));
        });
        this.intervalHandle = dependencies.setInterval(() => {
            void this.renewLeaseAndScan().catch(error => this.reportError('interval', error));
        }, FALLBACK_SCAN_INTERVAL_MS);
    }

    public publish(raw: unknown): Promise<void> {
        const mutation = this.enqueueMutation(async () => {
            this.ensureActive();
            const publication = validateOpenProjectPublication(raw);
            const store = this.bind(publication);
            const timestamp = validateTimestamp(this.dependencies.now());
            const lastFocusedAtMs = publication.followsFocusEvent
                ? timestamp
                : this.lastFocusedAtMs ?? 0;
            const registration: OpenProjectRegistration = {
                protocolVersion: OPEN_PROJECT_PROTOCOL_VERSION,
                instanceId: publication.instanceId,
                sequence: publication.sequence,
                lastFocusedAtMs,
                leaseUpdatedAtMs: timestamp,
                projects: publication.projects,
            };
            await store.write(registration);
            this.currentRegistration = registration;
            this.lastFocusedAtMs = lastFocusedAtMs;
            this.reportDiagnostic({
                event: 'publish',
                instanceId: registration.instanceId,
                sequence: registration.sequence,
                projectCount: registration.projects.length,
            });
        });
        const result = mutation.then(() => this.scanAndDeliver());
        return result.catch(error => {
            this.reportError('publish', error);
            throw error;
        });
    }

    public unregister(raw: unknown): Promise<void> {
        const mutation = this.enqueueMutation(async () => {
            this.ensureActive();
            const instanceId = validateUnregisterRequest(raw);
            if (this.boundInstanceId === undefined || this.store === undefined) {
                throw new Error('open project coordinator has no bound instanceId');
            }
            if (instanceId !== this.boundInstanceId) {
                throw new Error('open project coordinator received a different instanceId');
            }
            await this.store.remove(instanceId);
            this.currentRegistration = undefined;
            this.reportDiagnostic({ event: 'unregister', instanceId });
        });
        const result = mutation.then(() => this.scanAndDeliver());
        return result.catch(error => {
            this.reportError('unregister', error);
            throw error;
        });
    }

    public scanAndDeliver(): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        if (this.scanPromise !== undefined) {
            this.scanRequested = true;
            return this.scanPromise;
        }

        const scanPromise = this.runQueuedScans();
        this.scanPromise = scanPromise;
        void scanPromise.then(
            () => {
                if (this.scanPromise === scanPromise) {
                    this.scanPromise = undefined;
                }
            },
            () => {
                if (this.scanPromise === scanPromise) {
                    this.scanPromise = undefined;
                }
            },
        );
        return scanPromise;
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.dependencies.clearInterval(this.intervalHandle);
        this.watcher.close();
    }

    private bind(publication: OpenProjectPublication): OpenProjectStoreLike {
        if (this.boundInstanceId !== undefined && publication.instanceId !== this.boundInstanceId) {
            throw new Error('open project coordinator received a different instanceId');
        }
        if (this.store === undefined) {
            this.boundInstanceId = publication.instanceId;
            this.store = this.dependencies.createStore
                ? this.dependencies.createStore(this.rootDirectory, publication.instanceId)
                : new OpenProjectStore(this.rootDirectory, publication.instanceId);
        }
        return this.store;
    }

    private async runQueuedScans(): Promise<void> {
        do {
            this.scanRequested = false;
            await this.scanOnce();
        } while (this.scanRequested && !this.disposed);
    }

    private async scanOnce(): Promise<void> {
        if (this.store === undefined || this.disposed) {
            return;
        }
        const observedAtMs = validateTimestamp(this.dependencies.now());
        const scan = await this.store.scan(observedAtMs);
        const registrations = scan.registrations
            .slice()
            .sort(compareRegistrationPriority)
            .slice(0, MAX_OPEN_PROJECT_RECORDS);
        const registrationSummaries = registrations.map(registration => ({
            instanceId: registration.instanceId,
            sequence: registration.sequence,
            projectCount: registration.projects.length,
            lastFocusedAtMs: registration.lastFocusedAtMs,
            leaseAgeMs: Math.max(0, observedAtMs - registration.leaseUpdatedAtMs),
        }));
        const scanDiagnostic = JSON.stringify({
            registrations: registrationSummaries.map(registration => ({
                instanceId: registration.instanceId,
                sequence: registration.sequence,
                projectCount: registration.projectCount,
                lastFocusedAtMs: registration.lastFocusedAtMs,
            })),
            counters: scan.counters,
        });
        if (scanDiagnostic !== this.lastScanDiagnostic
            || observedAtMs - this.lastScanDiagnosticAtMs >= 30_000) {
            this.reportDiagnostic({
                event: 'scan',
                registrationCount: registrations.length,
                registrations: registrationSummaries,
                counters: scan.counters,
            }, observedAtMs);
            this.lastScanDiagnostic = scanDiagnostic;
            this.lastScanDiagnosticAtMs = observedAtMs;
        }
        const semanticRevision = createOpenProjectSemanticRevision(registrations);
        if (semanticRevision === this.lastDeliveredRevision) {
            return;
        }
        const aggregate = validateOpenProjectAggregate({
            protocolVersion: OPEN_PROJECT_PROTOCOL_VERSION,
            semanticRevision,
            observedAtMs,
            registrations,
        });
        await this.dependencies.deliverAggregate(aggregate);
        this.reportDiagnostic({
            event: 'deliver',
            registrationCount: registrations.length,
            semanticRevision,
        }, observedAtMs);
        this.lastDeliveredRevision = semanticRevision;
    }

    private renewLeaseAndScan(): Promise<void> {
        const mutation = this.enqueueMutation(async () => {
            if (this.disposed) {
                return;
            }
            if (this.store !== undefined && this.currentRegistration !== undefined) {
                const timestamp = validateTimestamp(this.dependencies.now());
                if (timestamp - this.currentRegistration.leaseUpdatedAtMs >= OPEN_PROJECT_HEARTBEAT_MS) {
                    const registration = {
                        ...this.currentRegistration,
                        leaseUpdatedAtMs: timestamp,
                    };
                    await this.store.write(registration);
                    this.currentRegistration = registration;
                    this.reportDiagnostic({
                        event: 'renew',
                        instanceId: registration.instanceId,
                        sequence: registration.sequence,
                        projectCount: registration.projects.length,
                    }, timestamp);
                }
            }
        });
        return mutation.then(() => this.scanAndDeliver());
    }

    private enqueueMutation(mutation: () => Promise<void>): Promise<void> {
        const result = this.mutationQueue.then(mutation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private ensureActive(): void {
        if (this.disposed) {
            throw new Error('open project coordinator is disposed');
        }
    }

    private reportError(operation: string, error: unknown): void {
        this.reportDiagnostic({
            event: 'error',
            operation,
            error: (error instanceof Error ? error.stack || error.message : String(error)).slice(0, 4096),
        });
    }

    private reportDiagnostic(
        event: Omit<OpenProjectDiagnosticEvent, 'atMs'>,
        atMs: number = this.safeNow(),
    ): void {
        try {
            this.dependencies.reportDiagnostic?.({ ...event, atMs });
        } catch (_error) {
            // Diagnostics must never change registry behavior.
        }
    }

    private safeNow(): number {
        try {
            const timestamp = this.dependencies.now();
            return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
        } catch (_error) {
            return Date.now();
        }
    }
}
