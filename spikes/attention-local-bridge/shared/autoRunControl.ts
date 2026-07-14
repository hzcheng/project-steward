import * as crypto from 'crypto';

export const AUTO_RUN_PROTOCOL_VERSION = 1;
export const AUTO_RUN_ROUTING_MODE = 'routing';
export const AUTO_RUN_SAME_WORKSPACE_MODE = 'same-workspace-routing';
export const AUTO_RUN_ROUTING_TOTAL = 1000;
export const AUTO_RUN_SAME_WORKSPACE_TOTAL = 200;
export const AUTO_RUN_MAX_EXPIRY_MS = 30 * 60 * 1000;
export const AUTO_RUN_FIXTURE_IDENTITIES = [
    '/tmp/project-steward-attention-fixture-a',
    '/tmp/project-steward-attention-fixture-b',
] as const;

const RUN_ID_PATTERN = /^[a-f0-9]{32}$/;
const CONTROL_KEYS = [
    'expiresAtMs',
    'fixtureIdentities',
    'mode',
    'protocolVersion',
    'runId',
    'total',
];

interface AutoRunControlBase {
    protocolVersion: 1;
    runId: string;
    expiresAtMs: number;
}

export interface RoutingAutoRunControl extends AutoRunControlBase {
    mode: 'routing';
    total: 1000;
    fixtureIdentities: [string, string];
}

export interface SameWorkspaceAutoRunControl extends AutoRunControlBase {
    mode: 'same-workspace-routing';
    total: 200;
    fixtureIdentities: [string];
}

export type AutoRunControl = RoutingAutoRunControl | SameWorkspaceAutoRunControl;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactFixtureIdentities(value: unknown): value is [string, string] {
    if (!Array.isArray(value) || value.length !== AUTO_RUN_FIXTURE_IDENTITIES.length) {
        return false;
    }

    const identities = new Set(value);
    return identities.size === AUTO_RUN_FIXTURE_IDENTITIES.length
        && AUTO_RUN_FIXTURE_IDENTITIES.every(identity => identities.has(identity));
}

function hasExactSameWorkspaceFixture(value: unknown): value is [string] {
    return Array.isArray(value)
        && value.length === 1
        && value[0] === AUTO_RUN_FIXTURE_IDENTITIES[0];
}

export function parseAutoRunControl(value: unknown, nowMs: number): AutoRunControl | null {
    if (!isRecord(value) || !Number.isFinite(nowMs)) {
        return null;
    }
    if (Object.keys(value).sort().join('\n') !== CONTROL_KEYS.join('\n')) {
        return null;
    }
    if (value.protocolVersion !== AUTO_RUN_PROTOCOL_VERSION
        || typeof value.runId !== 'string'
        || !RUN_ID_PATTERN.test(value.runId)
        || typeof value.expiresAtMs !== 'number'
        || !Number.isFinite(value.expiresAtMs)
        || !Number.isInteger(value.expiresAtMs)
        || value.expiresAtMs <= nowMs
        || value.expiresAtMs > nowMs + AUTO_RUN_MAX_EXPIRY_MS) {
        return null;
    }

    if (value.mode === AUTO_RUN_ROUTING_MODE
        && value.total === AUTO_RUN_ROUTING_TOTAL
        && hasExactFixtureIdentities(value.fixtureIdentities)) {
        return {
            protocolVersion: AUTO_RUN_PROTOCOL_VERSION,
            runId: value.runId,
            mode: AUTO_RUN_ROUTING_MODE,
            total: AUTO_RUN_ROUTING_TOTAL,
            expiresAtMs: value.expiresAtMs,
            fixtureIdentities: [value.fixtureIdentities[0], value.fixtureIdentities[1]],
        };
    }

    if (value.mode === AUTO_RUN_SAME_WORKSPACE_MODE
        && value.total === AUTO_RUN_SAME_WORKSPACE_TOTAL
        && hasExactSameWorkspaceFixture(value.fixtureIdentities)) {
        return {
            protocolVersion: AUTO_RUN_PROTOCOL_VERSION,
            runId: value.runId,
            mode: AUTO_RUN_SAME_WORKSPACE_MODE,
            total: AUTO_RUN_SAME_WORKSPACE_TOTAL,
            expiresAtMs: value.expiresAtMs,
            fixtureIdentities: [value.fixtureIdentities[0]],
        };
    }

    return null;
}

export function matchesAutoRunFixture(control: AutoRunControl, workspaceIdentity: string): boolean {
    return control.fixtureIdentities.includes(workspaceIdentity);
}

export function shouldStartAutoRun(
    control: AutoRunControl,
    workspaceIdentity: string,
    resultExists: boolean
): boolean {
    return !resultExists && matchesAutoRunFixture(control, workspaceIdentity);
}

export function createAutoRunResultFileName(workspaceIdentity: string, workspaceProcessId?: string): string {
    const resultIdentity = workspaceProcessId === undefined
        ? workspaceIdentity
        : `${workspaceIdentity}\0${workspaceProcessId}`;
    return `${crypto.createHash('sha256').update(resultIdentity, 'utf8').digest('hex')}.json`;
}
