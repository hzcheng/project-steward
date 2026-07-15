'use strict';

import * as crypto from 'crypto';

export const OPEN_PROJECT_PROTOCOL_VERSION = 1;
export const OPEN_PROJECT_HEARTBEAT_MS = 10_000;
export const OPEN_PROJECT_LEASE_MS = 30_000;
export const MAX_OPEN_PROJECT_RECORDS = 100;
export type OpenProjectRemoteType = 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';

const OPEN_PROJECT_INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_OPEN_PROJECT_STRING_LENGTH = 8192;

export interface OpenProjectRecord {
    localProjectId: string;
    ordinal: number;
    name: string;
    description: string;
    uri: string;
    remoteType: OpenProjectRemoteType;
    color?: string;
}

export interface OpenProjectPublication {
    protocolVersion: 1;
    instanceId: string;
    sequence: number;
    followsFocusEvent: boolean;
    projects: OpenProjectRecord[];
}

export interface OpenProjectRegistration {
    protocolVersion: 1;
    instanceId: string;
    sequence: number;
    lastFocusedAtMs: number;
    leaseUpdatedAtMs: number;
    projects: OpenProjectRecord[];
}

export interface OpenProjectAggregate {
    protocolVersion: 1;
    semanticRevision: string;
    observedAtMs: number;
    registrations: OpenProjectRegistration[];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(
    value: Record<string, unknown>,
    label: string,
    requiredKeys: string[],
    optionalKeys: string[] = []
): void {
    const actualKeys = Object.keys(value);
    const allowedKeys = new Set(requiredKeys.concat(optionalKeys));
    if (actualKeys.some(key => !allowedKeys.has(key)) || requiredKeys.some(key => !actualKeys.includes(key))) {
        throw new Error(`${label} has unexpected fields`);
    }
}

function requireInstanceId(value: unknown): string {
    if (typeof value !== 'string' || !OPEN_PROJECT_INSTANCE_ID_PATTERN.test(value)) {
        throw new Error('instanceId must be 32 lowercase hexadecimal characters');
    }
    return value;
}

function requireBoundedString(value: unknown, label: string, allowEmpty = false): string {
    if (typeof value !== 'string'
        || (!allowEmpty && value.length === 0)
        || value.length > MAX_OPEN_PROJECT_STRING_LENGTH) {
        const minimum = allowEmpty ? 0 : 1;
        throw new Error(`${label} must contain ${minimum}-${MAX_OPEN_PROJECT_STRING_LENGTH} characters`);
    }
    return value;
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

function requireRemoteType(value: unknown): OpenProjectRemoteType {
    if (value !== 'local'
        && value !== 'ssh'
        && value !== 'wsl'
        && value !== 'devContainer'
        && value !== 'remote') {
        throw new Error('remoteType is invalid');
    }
    return value;
}

function validateOpenProjectRecord(value: unknown): OpenProjectRecord {
    const record = requireObject(value, 'open project record');
    requireExactKeys(
        record,
        'open project record',
        ['localProjectId', 'ordinal', 'name', 'description', 'uri', 'remoteType'],
        ['color']
    );
    const color = record.color === undefined ? undefined : requireBoundedString(record.color, 'color');
    const validated: OpenProjectRecord = {
        localProjectId: requireBoundedString(record.localProjectId, 'localProjectId'),
        ordinal: requireSafeNonNegativeInteger(record.ordinal, 'ordinal'),
        name: requireBoundedString(record.name, 'name'),
        description: requireBoundedString(record.description, 'description', true),
        uri: requireBoundedString(record.uri, 'uri'),
        remoteType: requireRemoteType(record.remoteType),
    };
    if (color !== undefined) {
        validated.color = color;
    }
    return validated;
}

function validateProjects(value: unknown): OpenProjectRecord[] {
    if (!Array.isArray(value) || value.length > MAX_OPEN_PROJECT_RECORDS) {
        throw new Error(`projects must be an array containing at most ${MAX_OPEN_PROJECT_RECORDS} records`);
    }
    return Array.from(value, validateOpenProjectRecord);
}

export function validateOpenProjectPublication(value: unknown): OpenProjectPublication {
    const publication = requireObject(value, 'open project publication');
    requireExactKeys(
        publication,
        'open project publication',
        ['protocolVersion', 'instanceId', 'sequence', 'followsFocusEvent', 'projects']
    );
    if (publication.protocolVersion !== OPEN_PROJECT_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must equal ${OPEN_PROJECT_PROTOCOL_VERSION}`);
    }
    if (typeof publication.followsFocusEvent !== 'boolean') {
        throw new Error('followsFocusEvent must be a boolean');
    }
    return {
        protocolVersion: OPEN_PROJECT_PROTOCOL_VERSION,
        instanceId: requireInstanceId(publication.instanceId),
        sequence: requireSafeNonNegativeInteger(publication.sequence, 'sequence'),
        followsFocusEvent: publication.followsFocusEvent,
        projects: validateProjects(publication.projects),
    };
}

export function validateOpenProjectRegistration(value: unknown): OpenProjectRegistration {
    const registration = requireObject(value, 'open project registration');
    requireExactKeys(
        registration,
        'open project registration',
        ['protocolVersion', 'instanceId', 'sequence', 'lastFocusedAtMs', 'leaseUpdatedAtMs', 'projects']
    );
    if (registration.protocolVersion !== OPEN_PROJECT_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must equal ${OPEN_PROJECT_PROTOCOL_VERSION}`);
    }
    return {
        protocolVersion: OPEN_PROJECT_PROTOCOL_VERSION,
        instanceId: requireInstanceId(registration.instanceId),
        sequence: requireSafeNonNegativeInteger(registration.sequence, 'sequence'),
        lastFocusedAtMs: requireFiniteNonNegativeNumber(registration.lastFocusedAtMs, 'lastFocusedAtMs'),
        leaseUpdatedAtMs: requireFiniteNonNegativeNumber(registration.leaseUpdatedAtMs, 'leaseUpdatedAtMs'),
        projects: validateProjects(registration.projects),
    };
}

export function validateOpenProjectAggregate(value: unknown): OpenProjectAggregate {
    const aggregate = requireObject(value, 'open project aggregate');
    requireExactKeys(
        aggregate,
        'open project aggregate',
        ['protocolVersion', 'semanticRevision', 'observedAtMs', 'registrations']
    );
    if (aggregate.protocolVersion !== OPEN_PROJECT_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must equal ${OPEN_PROJECT_PROTOCOL_VERSION}`);
    }
    if (!Array.isArray(aggregate.registrations) || aggregate.registrations.length > MAX_OPEN_PROJECT_RECORDS) {
        throw new Error(`registrations must be an array containing at most ${MAX_OPEN_PROJECT_RECORDS} records`);
    }
    const registrations = Array.from(aggregate.registrations, validateOpenProjectRegistration);
    const instanceIds = new Set<string>();
    for (const registration of registrations) {
        if (instanceIds.has(registration.instanceId)) {
            throw new Error('registrations contain a duplicate instanceId');
        }
        instanceIds.add(registration.instanceId);
    }
    return {
        protocolVersion: OPEN_PROJECT_PROTOCOL_VERSION,
        semanticRevision: requireBoundedString(aggregate.semanticRevision, 'semanticRevision'),
        observedAtMs: requireFiniteNonNegativeNumber(aggregate.observedAtMs, 'observedAtMs'),
        registrations,
    };
}

export function createOpenProjectSemanticRevision(registrations: OpenProjectRegistration[]): string {
    const semanticRegistrations = (registrations || [])
        .map(validateOpenProjectRegistration)
        .map(registration => [
            registration.instanceId,
            registration.lastFocusedAtMs,
            registration.projects
                .map(project => [
                    project.localProjectId,
                    project.ordinal,
                    project.name,
                    project.description,
                    project.uri,
                    project.remoteType,
                    project.color || '',
                ])
                .sort(compareSemanticDescriptors),
        ])
        .sort(compareSemanticDescriptors);
    return crypto.createHash('sha256').update(JSON.stringify(semanticRegistrations)).digest('hex');
}

function compareSemanticDescriptors(left: unknown[], right: unknown[]): number {
    const leftSerialized = JSON.stringify(left);
    const rightSerialized = JSON.stringify(right);
    return leftSerialized < rightSerialized ? -1 : leftSerialized > rightSerialized ? 1 : 0;
}
