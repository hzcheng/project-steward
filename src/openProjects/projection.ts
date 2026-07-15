'use strict';

import * as crypto from 'crypto';

import { getRemoteType, Project, ProjectRemoteType } from '../models';
import {
    OpenProjectAggregate,
    OpenProjectRecord,
    OpenProjectRemoteType,
} from './protocol';

interface NavigationCandidate {
    identity: string;
    instanceId: string;
    lastFocusedAtMs: number;
    project: OpenProjectRecord;
}

function removeTrailingSeparators(value: string): string {
    if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
        return value;
    }
    return value.replace(/\/+$/g, '');
}

function normalizeUriAuthority(authority: string): string {
    return authority
        .replace(/%[0-9a-fA-F]{2}/g, escape => escape.toUpperCase())
        .replace(/%2B/g, '+');
}

export function normalizeOpenProjectIdentity(uri: string): string {
    const value = uri || '';
    const uriMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(.*)$/.exec(value);
    if (!uriMatch) {
        if (/^[A-Za-z]:[\\/]/.test(value)) {
            return removeTrailingSeparators(value.replace(/\\/g, '/'));
        }
        return removeTrailingSeparators(value);
    }
    const scheme = uriMatch[1].toLowerCase();
    const authority = normalizeUriAuthority(uriMatch[2]);
    const uriPath = removeTrailingSeparators(uriMatch[3]);
    return `${scheme}://${authority}${uriPath}`;
}

function toProtocolRemoteType(remoteType: ProjectRemoteType): OpenProjectRemoteType {
    switch (remoteType) {
        case ProjectRemoteType.SSH:
            return 'ssh';
        case ProjectRemoteType.WSL:
            return 'wsl';
        case ProjectRemoteType.DevContainer:
            return 'devContainer';
        case ProjectRemoteType.Remote:
            return 'remote';
        case ProjectRemoteType.None:
        default:
            return 'local';
    }
}

function fromProtocolRemoteType(remoteType: OpenProjectRemoteType): ProjectRemoteType {
    switch (remoteType) {
        case 'ssh':
            return ProjectRemoteType.SSH;
        case 'wsl':
            return ProjectRemoteType.WSL;
        case 'devContainer':
            return ProjectRemoteType.DevContainer;
        case 'remote':
            return ProjectRemoteType.Remote;
        case 'local':
        default:
            return ProjectRemoteType.None;
    }
}

function getEnvironmentLabel(remoteType: OpenProjectRemoteType): string {
    switch (remoteType) {
        case 'ssh':
            return 'SSH';
        case 'wsl':
            return 'WSL';
        case 'devContainer':
            return 'Dev Container';
        case 'remote':
            return 'Remote';
        case 'local':
        default:
            return 'Local';
    }
}

export function createOpenProjectRecords(projects: Project[]): OpenProjectRecord[] {
    return (projects || []).map((project, ordinal) => {
        const record: OpenProjectRecord = {
            localProjectId: project.id,
            ordinal,
            name: project.name,
            description: project.description || '',
            uri: project.path,
            remoteType: toProtocolRemoteType(getRemoteType(project)),
        };
        if (project.color) {
            record.color = project.color;
        }
        return record;
    });
}

function candidateWins(candidate: NavigationCandidate, previous: NavigationCandidate): boolean {
    if (candidate.lastFocusedAtMs !== previous.lastFocusedAtMs) {
        return candidate.lastFocusedAtMs > previous.lastFocusedAtMs;
    }
    if (candidate.project.ordinal !== previous.project.ordinal) {
        return candidate.project.ordinal < previous.project.ordinal;
    }
    const instanceComparison = compareText(candidate.instanceId, previous.instanceId);
    if (instanceComparison !== 0) {
        return instanceComparison < 0;
    }
    return compareText(createProjectDescriptorKey(candidate.project), createProjectDescriptorKey(previous.project)) < 0;
}

function compareCandidates(left: NavigationCandidate, right: NavigationCandidate): number {
    return right.lastFocusedAtMs - left.lastFocusedAtMs
        || left.project.ordinal - right.project.ordinal
        || compareText(left.identity, right.identity);
}

function createProjectDescriptorKey(project: OpenProjectRecord): string {
    return JSON.stringify([
        project.localProjectId,
        project.ordinal,
        project.name,
        project.description,
        project.uri,
        project.remoteType,
        project.color || '',
    ]);
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function createNavigationCard(candidate: NavigationCandidate): Project {
    const digest = crypto.createHash('sha256').update(candidate.identity).digest('hex').slice(0, 24);
    const project: Project = {
        id: `__openProjectNavigation-${digest}`,
        name: candidate.project.name,
        description: candidate.project.description,
        path: candidate.project.uri,
        remoteType: fromProtocolRemoteType(candidate.project.remoteType),
        color: candidate.project.color,
        openProjectCardKind: 'projectNavigation',
        openProjectSourceInstanceId: candidate.instanceId,
        openProjectEnvironmentLabel: getEnvironmentLabel(candidate.project.remoteType),
    } as Project;
    return project;
}

export function projectOpenProjectCards(
    currentProjects: Project[],
    aggregate: OpenProjectAggregate | null,
    ownInstanceId: string
): Project[] {
    const currentCards: Project[] = (currentProjects || []).map(project => ({
        ...project,
        openProjectCardKind: 'current' as 'current',
    } as Project));
    if (!aggregate) {
        return currentCards;
    }

    const reservedIdentities = new Set(currentCards.map(project => normalizeOpenProjectIdentity(project.path)));
    const navigationByIdentity = new Map<string, NavigationCandidate>();
    for (const registration of aggregate.registrations || []) {
        if (registration.instanceId === ownInstanceId) {
            continue;
        }
        for (const project of registration.projects || []) {
            const identity = normalizeOpenProjectIdentity(project.uri);
            if (!identity || reservedIdentities.has(identity)) {
                continue;
            }
            const candidate: NavigationCandidate = {
                identity,
                instanceId: registration.instanceId,
                lastFocusedAtMs: registration.lastFocusedAtMs,
                project,
            };
            const previous = navigationByIdentity.get(identity);
            if (!previous || candidateWins(candidate, previous)) {
                navigationByIdentity.set(identity, candidate);
            }
        }
    }

    const navigationCards = Array.from(navigationByIdentity.values())
        .sort(compareCandidates)
        .map(createNavigationCard);
    return currentCards.concat(navigationCards);
}
