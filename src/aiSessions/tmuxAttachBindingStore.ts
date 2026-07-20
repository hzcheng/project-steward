'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionTmuxLayout } from './runtimeTypes';

export const AI_SESSION_TMUX_ATTACH_PROCESS_BINDING_KEY_PREFIX = 'aiSessionTmuxAttachProcessBinding.v1.';

const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface TmuxAttachBindingState {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

export interface TmuxAttachBinding {
    version: 1;
    layout: AiSessionTmuxLayout;
    projectKey: string;
    sessionName: string;
    windowName?: string;
    provider?: AiSessionProviderId;
    sessionId?: string;
    terminalNamePrefix: string;
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
            return record ? { ...record } : null;
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
        this.enqueueWrite(processId, record);
    }

    remove(processId: TmuxAttachProcessId): void {
        this.enqueueWrite(processId, null);
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
            await this.state.update(getBindingKey(pid), record ? { ...record } : undefined);
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

function validateRecord(value: unknown): TmuxAttachBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !isLayout(record.layout)
        || !isBoundedString(record.projectKey, MAX_ID_LENGTH)
        || !isBoundedString(record.sessionName, MAX_ID_LENGTH)
        || !isBoundedString(record.terminalNamePrefix, MAX_TITLE_LENGTH)
        || (record.provider !== undefined && !isProviderId(record.provider))
        || (record.sessionId !== undefined && !isBoundedString(record.sessionId, MAX_ID_LENGTH))) {
        return null;
    }
    if (record.layout === 'project' && record.windowName !== undefined
        && !isBoundedString(record.windowName, MAX_ID_LENGTH)) {
        return null;
    }
    if (record.layout === 'session' && record.windowName !== undefined) {
        return null;
    }
    return {
        version: 1,
        layout: record.layout,
        projectKey: record.projectKey,
        sessionName: record.sessionName,
        ...(record.windowName === undefined ? {} : { windowName: record.windowName as string }),
        ...(record.provider === undefined ? {} : { provider: record.provider as AiSessionProviderId }),
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId as string }),
        terminalNamePrefix: record.terminalNamePrefix,
    };
}

function isProcessId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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
