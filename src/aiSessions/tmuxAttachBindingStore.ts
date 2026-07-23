'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionRuntimeIdentity, AiSessionTmuxLayout } from './runtimeTypes';
import { cloneAiSessionRuntimeIdentity, isValidAiSessionRuntimeIdentity } from './runtimeTypes';

export const AI_SESSION_TMUX_ATTACH_PROCESS_BINDING_KEY_PREFIX = 'aiSessionTmuxAttachProcessBinding.v2.';
export const AI_SESSION_TMUX_ATTACH_RECOVERY_BINDING_KEY_PREFIX = 'aiSessionTmuxAttachRecoveryBinding.v1.';

const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RECOVERY_TOKEN = /^[0-9a-f]{32}$/;

export interface TmuxAttachBindingState {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

export interface TmuxAttachBinding {
    version: 2;
    layout: AiSessionTmuxLayout;
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
    sessionName: string;
    windowName?: string;
    provider: AiSessionProviderId;
    sessionId?: string;
    pendingId?: string;
    terminalNamePrefix: string;
}

export interface TmuxAttachRecoveryBinding {
    processId: number;
    binding: TmuxAttachBinding;
}

export type TmuxAttachProcessId = number | PromiseLike<number | undefined>;

export class TmuxAttachBindingStore {
    private writeQueue: Promise<void> = Promise.resolve();
    private errorReported = false;

    constructor(
        private readonly state: TmuxAttachBindingState,
        private readonly onError: (error: unknown) => void = () => undefined,
        private readonly processIdTimeoutMs = 2000
    ) { }

    get(processId: number): TmuxAttachBinding | null {
        if (!isProcessId(processId)) {
            return null;
        }
        try {
            const record = validateRecord(this.state.get(getBindingKey(processId), null as unknown));
            return record ? cloneBinding(record) : null;
        } catch (error) {
            this.reportErrorOnce(error);
            return null;
        }
    }

    getRecovery(token: string): TmuxAttachRecoveryBinding | null {
        if (!isRecoveryToken(token)) {
            return null;
        }
        try {
            const record = validateRecoveryRecord(
                this.state.get(getRecoveryBindingKey(token), null as unknown)
            );
            return record ? cloneRecoveryBinding(record) : null;
        } catch (error) {
            this.reportErrorOnce(error);
            return null;
        }
    }

    set(processId: TmuxAttachProcessId, input: TmuxAttachBinding): void {
        const record = validateRecord(input);
        if (!record) {
            return;
        }
        this.enqueueWrite(processId, cloneBinding(record));
    }

    remove(processId: TmuxAttachProcessId): void {
        this.enqueueWrite(processId, null);
    }

    setRecovery(
        token: string,
        processId: TmuxAttachProcessId,
        input: TmuxAttachBinding
    ): void {
        const binding = validateRecord(input);
        if (!isRecoveryToken(token) || !binding) {
            return;
        }
        const resolvedProcessId = this.resolveProcessId(processId);
        this.writeQueue = this.writeQueue.then(async () => {
            const pid = await resolvedProcessId;
            if (!isProcessId(pid)) {
                return;
            }
            const previous = this.getRecovery(token);
            await this.state.update(getBindingKey(pid), cloneBinding(binding));
            await this.state.update(getRecoveryBindingKey(token), {
                version: 1,
                processId: pid,
                binding: cloneBinding(binding),
            });
            if (previous && previous.processId !== pid) {
                await this.state.update(getBindingKey(previous.processId), undefined);
            }
        }).catch(error => this.reportErrorOnce(error));
    }

    removeRecovery(token: string): void {
        if (!isRecoveryToken(token)) {
            return;
        }
        this.writeQueue = this.writeQueue.then(async () => {
            const previous = this.getRecovery(token);
            await this.state.update(getRecoveryBindingKey(token), undefined);
            if (previous) {
                await this.state.update(getBindingKey(previous.processId), undefined);
            }
        }).catch(error => this.reportErrorOnce(error));
    }

    flush(): Promise<void> {
        return this.writeQueue;
    }

    private enqueueWrite(processId: TmuxAttachProcessId, record: TmuxAttachBinding | null): void {
        const resolvedProcessId = this.resolveProcessId(processId);
        this.writeQueue = this.writeQueue.then(async () => {
            const pid = await resolvedProcessId;
            if (!isProcessId(pid)) {
                return;
            }
            await this.state.update(getBindingKey(pid), record ? cloneBinding(record) : undefined);
        }).catch(error => this.reportErrorOnce(error));
    }

    private resolveProcessId(processId: TmuxAttachProcessId): Promise<number | undefined> {
        if (typeof processId === 'number') {
            return Promise.resolve(isProcessId(processId) ? processId : undefined);
        }
        return new Promise(resolve => {
            let settled = false;
            const settle = (value: number | undefined) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                resolve(isProcessId(value) ? value : undefined);
            };
            const timeout = setTimeout(() => settle(undefined), this.processIdTimeoutMs);
            Promise.resolve(processId).then(settle, error => {
                this.reportErrorOnce(error);
                settle(undefined);
            });
        });
    }

    private reportErrorOnce(error: unknown): void {
        if (!this.errorReported) {
            this.errorReported = true;
            this.onError(error);
        }
    }
}

function getBindingKey(processId: number): string {
    return `${AI_SESSION_TMUX_ATTACH_PROCESS_BINDING_KEY_PREFIX}${processId}`;
}

function getRecoveryBindingKey(token: string): string {
    return `${AI_SESSION_TMUX_ATTACH_RECOVERY_BINDING_KEY_PREFIX}${token}`;
}

function validateRecoveryRecord(value: unknown): TmuxAttachRecoveryBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (!hasExactKeys(record, ['version', 'processId', 'binding'])
        || record.version !== 1 || !isProcessId(record.processId)) {
        return null;
    }
    const binding = validateRecord(record.binding);
    return binding ? { processId: record.processId, binding } : null;
}

function validateRecord(value: unknown): TmuxAttachBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 2 || !isLayout(record.layout)
        || !hasExactKeys(record, [
            'version', 'layout', 'workspaceScopeIdentity', 'workspaceNavigationIdentity',
            'workspaceRootHostPaths', 'cwd', 'sessionName', 'provider',
            record.sessionId === undefined ? 'pendingId' : 'sessionId', 'terminalNamePrefix',
            ...(record.layout === 'project' || record.windowName !== undefined ? ['windowName'] : []),
        ])
        || !isBoundedString(record.sessionName, MAX_ID_LENGTH)
        || !isBoundedString(record.terminalNamePrefix, MAX_TITLE_LENGTH)
        || !isProviderId(record.provider)) {
        return null;
    }
    const identity = {
        provider: record.provider,
        workspaceScopeIdentity: record.workspaceScopeIdentity,
        workspaceNavigationIdentity: record.workspaceNavigationIdentity,
        workspaceRootHostPaths: record.workspaceRootHostPaths,
        cwd: record.cwd,
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        ...(record.pendingId === undefined ? {} : { pendingId: record.pendingId }),
    };
    if (!isValidAiSessionRuntimeIdentity(identity)) {
        return null;
    }
    if (record.windowName !== undefined
        && !isBoundedString(record.windowName, MAX_ID_LENGTH)) {
        return null;
    }
    return {
        version: 2,
        layout: record.layout,
        workspaceScopeIdentity: identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
        cwd: identity.cwd,
        sessionName: record.sessionName,
        ...(record.windowName === undefined ? {} : { windowName: record.windowName as string }),
        provider: identity.provider,
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId as string }),
        ...(record.pendingId === undefined ? {} : { pendingId: record.pendingId as string }),
        terminalNamePrefix: record.terminalNamePrefix,
    };
}

function hasExactKeys(record: Record<string, unknown>, required: readonly string[]): boolean {
    const allowed = new Set(required);
    return required.every(key => Object.prototype.hasOwnProperty.call(record, key))
        && Object.keys(record).every(key => allowed.has(key));
}

function cloneBinding(binding: TmuxAttachBinding): TmuxAttachBinding {
    const identity = cloneAiSessionRuntimeIdentity(binding as TmuxAttachBinding & AiSessionRuntimeIdentity);
    return { ...binding, workspaceRootHostPaths: [...identity.workspaceRootHostPaths] };
}

function cloneRecoveryBinding(record: TmuxAttachRecoveryBinding): TmuxAttachRecoveryBinding {
    return { processId: record.processId, binding: cloneBinding(record.binding) };
}

function isProcessId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecoveryToken(value: unknown): value is string {
    return typeof value === 'string' && RECOVERY_TOKEN.test(value);
}

function isProviderId(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isLayout(value: unknown): value is AiSessionTmuxLayout {
    return value === 'project' || value === 'session';
}

function isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength
        && !CONTROL_CHARACTERS.test(value);
}
