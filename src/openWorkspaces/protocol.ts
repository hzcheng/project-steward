'use strict';

import * as crypto from 'crypto';
import { URL } from 'url';

import type { OpenWorkspaceEnvironment, OpenWorkspaceKind } from '../workspaces/types';

export const OPEN_WORKSPACE_PROTOCOL_VERSION = 2;
export const OPEN_WORKSPACE_HEARTBEAT_MS = 10_000;
export const OPEN_WORKSPACE_LEASE_MS = 30_000;
export const MAX_OPEN_WORKSPACE_ROOTS = 100;
export const MAX_OPEN_WORKSPACE_REGISTRATIONS = 100;
export const MAX_OPEN_WORKSPACE_STRING_LENGTH = 8192;
export const MAX_OPEN_WORKSPACE_RECORDS = MAX_OPEN_WORKSPACE_REGISTRATIONS;

const OPEN_WORKSPACE_INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;
const OPEN_WORKSPACE_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const INVALID_PERCENT_ESCAPE_PATTERN = /%(?![0-9a-fA-F]{2})/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const WHITESPACE_PATTERN = /\s/;

export interface OpenWorkspaceRootRecord {
    id: string;
    name: string;
    uri: string;
    ordinal: number;
}

export interface OpenWorkspaceRecord {
    navigationIdentity: string;
    scopeIdentity: string;
    kind: OpenWorkspaceKind;
    displayName: string;
    navigationUri: string;
    environment: OpenWorkspaceEnvironment;
    roots: OpenWorkspaceRootRecord[];
}

export interface OpenWorkspacePublicationV2 {
    protocolVersion: 2;
    instanceId: string;
    sequence: number;
    followsFocusEvent: boolean;
    workspace: OpenWorkspaceRecord | null;
}

export interface OpenWorkspaceRegistrationV2 {
    protocolVersion: 2;
    instanceId: string;
    sequence: number;
    lastFocusedAtMs: number;
    leaseUpdatedAtMs: number;
    workspace: OpenWorkspaceRecord | null;
}

export interface OpenWorkspaceAggregateV2 {
    protocolVersion: 2;
    semanticRevision: string;
    observedAtMs: number;
    registrations: OpenWorkspaceRegistrationV2[];
}

export type OpenWorkspacePublication = OpenWorkspacePublicationV2;
export type OpenWorkspaceRegistration = OpenWorkspaceRegistrationV2;
export type OpenWorkspaceAggregate = OpenWorkspaceAggregateV2;

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, label: string, requiredKeys: string[]): void {
    const actualKeys = Object.keys(value);
    const allowedKeys = new Set(requiredKeys);
    if (actualKeys.length !== requiredKeys.length
        || actualKeys.some(key => !allowedKeys.has(key))
        || requiredKeys.some(key => !actualKeys.includes(key))) {
        throw new Error(`${label} has unexpected fields`);
    }
}

function requireProtocolVersion(value: unknown): 2 {
    if (value !== OPEN_WORKSPACE_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must equal ${OPEN_WORKSPACE_PROTOCOL_VERSION}`);
    }
    return OPEN_WORKSPACE_PROTOCOL_VERSION;
}

function requireInstanceId(value: unknown): string {
    if (typeof value !== 'string' || !OPEN_WORKSPACE_INSTANCE_ID_PATTERN.test(value)) {
        throw new Error('instanceId must be 32 lowercase hexadecimal characters');
    }
    return value;
}

function requireIdentity(value: unknown, label: string): string {
    if (typeof value !== 'string' || !OPEN_WORKSPACE_IDENTITY_PATTERN.test(value)) {
        throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
    }
    return value;
}

function requireBoundedString(value: unknown, label: string): string {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_OPEN_WORKSPACE_STRING_LENGTH
        || CONTROL_CHARACTER_PATTERN.test(value)) {
        throw new Error(`${label} must contain 1-${MAX_OPEN_WORKSPACE_STRING_LENGTH} characters without controls`);
    }
    return value;
}

function requireUri(value: unknown, label: string): string {
    const uri = requireBoundedString(value, label);
    if (!URI_SCHEME_PATTERN.test(uri)
        || INVALID_PERCENT_ESCAPE_PATTERN.test(uri)
        || WHITESPACE_PATTERN.test(uri)) {
        throw new Error(`${label} must be a valid absolute URI`);
    }
    try {
        const parsedUri = new URL(uri);
        if (!parsedUri.protocol) {
            throw new Error('URI protocol is missing');
        }
    } catch (error) {
        throw new Error(`${label} must be a valid absolute URI`);
    }
    return uri;
}

function requireSafeNonNegativeInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function requireFiniteNonNegativeNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite non-negative number`);
    }
    return value;
}

function requireKind(value: unknown): OpenWorkspaceKind {
    if (value !== 'singleFolder' && value !== 'savedMultiRoot' && value !== 'untitledMultiRoot') {
        throw new Error('kind is invalid');
    }
    return value;
}

function requireEnvironment(value: unknown): OpenWorkspaceEnvironment {
    if (value !== 'local'
        && value !== 'ssh'
        && value !== 'wsl'
        && value !== 'devContainer'
        && value !== 'remote') {
        throw new Error('environment is invalid');
    }
    return value;
}

export function validateOpenWorkspaceRootRecord(value: unknown): OpenWorkspaceRootRecord {
    const root = requireObject(value, 'open workspace root');
    requireExactKeys(root, 'open workspace root', ['id', 'name', 'uri', 'ordinal']);
    return {
        id: requireIdentity(root.id, 'root id'),
        name: requireBoundedString(root.name, 'root name'),
        uri: requireUri(root.uri, 'root uri'),
        ordinal: requireSafeNonNegativeInteger(root.ordinal, 'ordinal'),
    };
}

function validateRoots(value: unknown): OpenWorkspaceRootRecord[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPEN_WORKSPACE_ROOTS) {
        throw new Error(`roots must be a non-empty array containing at most ${MAX_OPEN_WORKSPACE_ROOTS} records`);
    }
    const roots = Array.from(value, validateOpenWorkspaceRootRecord);
    const rootIds = new Set<string>();
    const rootUris = new Set<string>();
    const ordinals = new Set<number>();
    for (const root of roots) {
        if (rootIds.has(root.id) || rootUris.has(root.uri) || ordinals.has(root.ordinal)) {
            throw new Error('roots contain a duplicate id, uri, or ordinal');
        }
        rootIds.add(root.id);
        rootUris.add(root.uri);
        ordinals.add(root.ordinal);
    }
    if (roots.some((root, index) => root.ordinal !== index)) {
        throw new Error('root ordinals must be contiguous and match root order');
    }
    return roots;
}

export function validateOpenWorkspaceRecord(value: unknown): OpenWorkspaceRecord {
    const workspace = requireObject(value, 'open workspace record');
    requireExactKeys(workspace, 'open workspace record', [
        'navigationIdentity',
        'scopeIdentity',
        'kind',
        'displayName',
        'navigationUri',
        'environment',
        'roots',
    ]);
    const record = {
        navigationIdentity: requireIdentity(workspace.navigationIdentity, 'navigationIdentity'),
        scopeIdentity: requireIdentity(workspace.scopeIdentity, 'scopeIdentity'),
        kind: requireKind(workspace.kind),
        displayName: requireBoundedString(workspace.displayName, 'displayName'),
        navigationUri: requireUri(workspace.navigationUri, 'navigationUri'),
        environment: requireEnvironment(workspace.environment),
        roots: validateRoots(workspace.roots),
    };
    if (record.kind === 'singleFolder' && record.roots.length !== 1) {
        throw new Error('singleFolder must contain exactly one root');
    }
    if (record.kind === 'singleFolder' && record.navigationUri !== record.roots[0].uri) {
        throw new Error('singleFolder navigationUri must match its root uri');
    }
    return record;
}

function validateOptionalWorkspace(value: unknown): OpenWorkspaceRecord | null {
    return value === null ? null : validateOpenWorkspaceRecord(value);
}

export function validateOpenWorkspacePublication(value: unknown): OpenWorkspacePublicationV2 {
    const publication = requireObject(value, 'open workspace publication');
    requireExactKeys(publication, 'open workspace publication', [
        'protocolVersion',
        'instanceId',
        'sequence',
        'followsFocusEvent',
        'workspace',
    ]);
    requireProtocolVersion(publication.protocolVersion);
    if (typeof publication.followsFocusEvent !== 'boolean') {
        throw new Error('followsFocusEvent must be a boolean');
    }
    return {
        protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION,
        instanceId: requireInstanceId(publication.instanceId),
        sequence: requireSafeNonNegativeInteger(publication.sequence, 'sequence'),
        followsFocusEvent: publication.followsFocusEvent,
        workspace: validateOptionalWorkspace(publication.workspace),
    };
}

export function validateOpenWorkspaceRegistration(value: unknown): OpenWorkspaceRegistrationV2 {
    const registration = requireObject(value, 'open workspace registration');
    requireExactKeys(registration, 'open workspace registration', [
        'protocolVersion',
        'instanceId',
        'sequence',
        'lastFocusedAtMs',
        'leaseUpdatedAtMs',
        'workspace',
    ]);
    requireProtocolVersion(registration.protocolVersion);
    return {
        protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION,
        instanceId: requireInstanceId(registration.instanceId),
        sequence: requireSafeNonNegativeInteger(registration.sequence, 'sequence'),
        lastFocusedAtMs: requireFiniteNonNegativeNumber(registration.lastFocusedAtMs, 'lastFocusedAtMs'),
        leaseUpdatedAtMs: requireFiniteNonNegativeNumber(registration.leaseUpdatedAtMs, 'leaseUpdatedAtMs'),
        workspace: validateOptionalWorkspace(registration.workspace),
    };
}

export function validateOpenWorkspaceAggregate(value: unknown): OpenWorkspaceAggregateV2 {
    const aggregate = requireObject(value, 'open workspace aggregate');
    requireExactKeys(aggregate, 'open workspace aggregate', [
        'protocolVersion',
        'semanticRevision',
        'observedAtMs',
        'registrations',
    ]);
    requireProtocolVersion(aggregate.protocolVersion);
    if (!Array.isArray(aggregate.registrations)
        || aggregate.registrations.length > MAX_OPEN_WORKSPACE_REGISTRATIONS) {
        throw new Error(`registrations must be an array containing at most ${MAX_OPEN_WORKSPACE_REGISTRATIONS} records`);
    }
    const registrations = Array.from(aggregate.registrations, validateOpenWorkspaceRegistration);
    const instanceIds = new Set<string>();
    for (const registration of registrations) {
        if (instanceIds.has(registration.instanceId)) {
            throw new Error('registrations contain a duplicate instanceId');
        }
        instanceIds.add(registration.instanceId);
    }
    return {
        protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION,
        semanticRevision: requireIdentity(aggregate.semanticRevision, 'semanticRevision'),
        observedAtMs: requireFiniteNonNegativeNumber(aggregate.observedAtMs, 'observedAtMs'),
        registrations,
    };
}

function compareSemanticDescriptors(left: unknown[], right: unknown[]): number {
    const leftSerialized = JSON.stringify(left);
    const rightSerialized = JSON.stringify(right);
    return leftSerialized < rightSerialized ? -1 : leftSerialized > rightSerialized ? 1 : 0;
}

function createWorkspaceSemanticDescriptor(workspace: OpenWorkspaceRecord | null): unknown[] | null {
    if (!workspace) {
        return null;
    }
    return [
        workspace.navigationIdentity,
        workspace.scopeIdentity,
        workspace.kind,
        workspace.displayName,
        workspace.navigationUri,
        workspace.environment,
        workspace.roots
            .map(root => [root.id, root.name, root.uri, root.ordinal])
            .sort(compareSemanticDescriptors),
    ];
}

export function createOpenWorkspaceSemanticRevision(registrations: OpenWorkspaceRegistrationV2[]): string {
    const semanticRegistrations = (registrations || [])
        .map(validateOpenWorkspaceRegistration)
        .map(registration => [
            registration.instanceId,
            registration.lastFocusedAtMs,
            createWorkspaceSemanticDescriptor(registration.workspace),
        ])
        .sort(compareSemanticDescriptors);
    return crypto.createHash('sha256').update(JSON.stringify(semanticRegistrations)).digest('hex');
}
