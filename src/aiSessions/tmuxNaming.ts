'use strict';

import { createHash } from 'crypto';
import type {
    AiSessionRuntimeIdentity,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import { isValidAiSessionRuntimeIdentity } from './runtimeTypes';

const MAX_TMUX_NAME_LENGTH = 96;

export interface TmuxReadableNames {
    projectName: string;
    sessionName: string;
}

export function normalizeTmuxReadableComponent(
    value: unknown,
    fallback: 'workspace' | 'session' | 'new-session'
): string {
    return String(value || '').normalize('NFKC')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '') || fallback;
}

export function legacyTmuxLocator(
    identity: AiSessionRuntimeIdentity,
    layout: AiSessionTmuxLayout
): AiSessionTmuxLocator {
    validateIdentity(identity);
    validateLayout(layout);
    const suffix = legacyRuntimeSuffix(identity);
    if (layout === 'project') {
        return {
            layout,
            sessionName: `project-steward-p-${legacyWorkspaceSuffix(identity)}`,
            windowName: identity.sessionId !== undefined
                ? `ai-${identity.provider}-${suffix}`
                : `pending-${identity.provider}-${suffix}`,
        };
    }
    return {
        layout,
        sessionName: identity.sessionId !== undefined
            ? `project-steward-s-${identity.provider}-${suffix}`
            : `project-steward-pending-${identity.provider}-${suffix}`,
    };
}

export function buildReadableTmuxLocator(
    identity: AiSessionRuntimeIdentity,
    layout: AiSessionTmuxLayout,
    names: TmuxReadableNames
): AiSessionTmuxLocator {
    validateIdentity(identity);
    validateLayout(layout);
    const projectComponent = normalizeTmuxReadableComponent(names && names.projectName, 'workspace');
    const sessionComponent = normalizeTmuxReadableComponent(
        names && names.sessionName,
        identity.pendingId !== undefined ? 'new-session' : 'session'
    );
    const projectSession = boundedName(
        ['ps', projectComponent], readableWorkspaceSuffix(identity)
    );
    const runtimeWindow = boundedName(
        [identity.provider, sessionComponent], readableRuntimeSuffix(identity)
    );
    if (layout === 'project') {
        return {
            layout,
            sessionName: projectSession,
            windowName: runtimeWindow,
        };
    }
    return {
        layout,
        sessionName: boundedSessionName(
            projectComponent, sessionComponent, readableRuntimeSuffix(identity)
        ),
        windowName: runtimeWindow,
    };
}

export function tmuxLocatorMatchesIdentity(
    locator: AiSessionTmuxLocator,
    identity: AiSessionRuntimeIdentity
): boolean {
    if (!locator || typeof locator !== 'object'
        || (locator.layout !== 'project' && locator.layout !== 'session')
        || !isValidAiSessionRuntimeIdentity(identity)) {
        return false;
    }
    const legacy = legacyTmuxLocator(identity, locator.layout);
    if (locatorsEqual(locator, legacy)) {
        return true;
    }
    const runtimeSuffix = readableRuntimeSuffix(identity);
    const readableWindow = matchesReadableName(
        locator.windowName, `${identity.provider}-`, runtimeSuffix
    );
    if (locator.layout === 'project') {
        const legacyProjectWindow = legacy.windowName;
        const windowMatches = locator.windowName === legacyProjectWindow || readableWindow;
        return projectTmuxSessionMatchesWorkspace(locator.sessionName, identity) && windowMatches;
    }
    return locator.layout === 'session'
        && matchesReadableSessionName(locator.sessionName, runtimeSuffix)
        && readableWindow;
}

export function projectTmuxSessionMatchesWorkspace(
    sessionName: unknown,
    identity: AiSessionRuntimeIdentity
): sessionName is string {
    if (typeof sessionName !== 'string' || !isValidAiSessionRuntimeIdentity(identity)) {
        return false;
    }
    return sessionName === legacyTmuxLocator(identity, 'project').sessionName
        || matchesReadableName(sessionName, 'ps-', readableWorkspaceSuffix(identity));
}

function boundedName(components: string[], suffix: string): string {
    const suffixComponent = `-${suffix}`;
    const maxPrefixLength = MAX_TMUX_NAME_LENGTH - Array.from(suffixComponent).length;
    const prefix = Array.from(components.join('-')).slice(0, maxPrefixLength).join('')
        .replace(/-+$/g, '');
    return `${prefix}${suffixComponent}`;
}

function boundedSessionName(project: string, session: string, suffix: string): string {
    const suffixComponent = `-${suffix}`;
    const componentBudget = MAX_TMUX_NAME_LENGTH
        - Array.from(`ps--${suffixComponent}`).length;
    const projectPoints = Array.from(project);
    const sessionPoints = Array.from(session);
    const projectShare = Math.floor(componentBudget / 2);
    let projectLength = Math.min(projectPoints.length, projectShare);
    let sessionLength = Math.min(sessionPoints.length, componentBudget - projectShare);
    let remaining = componentBudget - projectLength - sessionLength;
    const projectExtra = Math.min(remaining, projectPoints.length - projectLength);
    projectLength += projectExtra;
    remaining -= projectExtra;
    sessionLength += Math.min(remaining, sessionPoints.length - sessionLength);
    const boundedProject = projectPoints.slice(0, projectLength).join('').replace(/-+$/g, '');
    const boundedSession = sessionPoints.slice(0, sessionLength).join('').replace(/-+$/g, '');
    return `ps-${boundedProject}-${boundedSession}${suffixComponent}`;
}

function matchesReadableSessionName(value: unknown, suffix: string): boolean {
    if (!matchesReadableName(value, 'ps-', suffix)) {
        return false;
    }
    const suffixComponent = `-${suffix}`;
    const readableComponent = (value as string).slice('ps-'.length, -suffixComponent.length);
    return readableComponent.includes('-');
}

function matchesReadableName(value: unknown, prefix: string, suffix: string): boolean {
    const suffixComponent = `-${suffix}`;
    if (typeof value !== 'string'
        || Array.from(value).length > MAX_TMUX_NAME_LENGTH
        || !value.startsWith(prefix)
        || !value.endsWith(suffixComponent)) {
        return false;
    }
    const readableComponent = value.slice(prefix.length, -suffixComponent.length);
    return readableComponent.normalize('NFKC') === readableComponent
        && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(readableComponent);
}

function legacyWorkspaceSuffix(identity: AiSessionRuntimeIdentity): string {
    return hash(identity.workspaceScopeIdentity, 16);
}

function legacyRuntimeSuffix(identity: AiSessionRuntimeIdentity): string {
    return hash(runtimeIdentityValue(identity), 16);
}

function readableWorkspaceSuffix(identity: AiSessionRuntimeIdentity): string {
    return hash(identity.workspaceScopeIdentity, 8);
}

function readableRuntimeSuffix(identity: AiSessionRuntimeIdentity): string {
    return hash(runtimeIdentityValue(identity), 8);
}

function runtimeIdentityValue(identity: AiSessionRuntimeIdentity): string {
    const id = identity.sessionId !== undefined ? identity.sessionId : identity.pendingId;
    return `${identity.workspaceScopeIdentity}:${identity.provider}:${id}`;
}

function hash(value: string, length: number): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);
}

function validateIdentity(identity: AiSessionRuntimeIdentity): void {
    if (!isValidAiSessionRuntimeIdentity(identity)) {
        throw new Error('The tmux runtime workspace identity is invalid.');
    }
}

function validateLayout(layout: AiSessionTmuxLayout): void {
    if (layout !== 'project' && layout !== 'session') {
        throw new Error('Unknown tmux layout.');
    }
}

function locatorsEqual(left: AiSessionTmuxLocator, right: AiSessionTmuxLocator): boolean {
    return left.layout === right.layout
        && left.sessionName === right.sessionName
        && left.windowName === right.windowName;
}
