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
const ERROR_THROTTLE_MS = 60_000;

interface DisposableLike {
    dispose(): void;
}

interface OpenProjectBridgeClientDependencies {
    instanceId?: string;
    now?: () => number;
    registerCommand?: (command: string, callback: (raw: unknown) => void) => DisposableLike;
    executeCommand?: (command: string, argument: unknown) => PromiseLike<unknown>;
    setInterval?: (callback: () => void, intervalMs: number) => unknown;
    clearInterval?: (handle: unknown) => void;
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
    private readonly clearInterval: (handle: unknown) => void;
    private readonly aggregateRegistration: DisposableLike;
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
        const registerCommand = dependencies.registerCommand
            || ((command, callback) => vscode.commands.registerCommand(command, callback));
        const setHeartbeat = dependencies.setInterval
            || ((callback, intervalMs) => setInterval(callback, intervalMs));
        this.clearInterval = dependencies.clearInterval
            || (handle => clearInterval(handle as NodeJS.Timeout));

        this.aggregateRegistration = registerCommand(AGGREGATE_COMMAND, raw => this.receiveAggregate(raw));
        this.heartbeatHandle = setHeartbeat(
            () => { void this.publishInternal(this.projects, false, true); },
            OPEN_PROJECT_HEARTBEAT_MS
        );
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
        this.clearInterval(this.heartbeatHandle);
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
        try {
            await this.executeCommand(PUBLISH_COMMAND, publication);
            this.lastPublishedSemantic = semantic;
            return true;
        } catch (error) {
            this.reportError(error);
            return false;
        } finally {
            if (this.pendingSemantic === semantic) {
                this.pendingSemantic = '';
            }
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
}
