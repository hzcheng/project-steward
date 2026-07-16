'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type { AggregatedAttentionSession } from './attentionAggregate';
import type { AiSessionAttentionSnapshot } from './attentionMonitor';
import type { AiSessionProviderDefinition, AiSessionReadResult } from './types';
import { getAttentionProjectKey, getAttentionSessionLookupKey } from './attentionProject';
import { getAiSessionKey, prepareAiSessionsForDisplay } from './sessionHelpers';

export interface HydrateOpenProjectsWithAiSessionsInput {
    projects: Project[];
    providers: readonly Pick<AiSessionProviderDefinition, 'id' | 'projectSessionsKey' | 'projectSessionsUnavailableKey'>[];
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>;
    assignments: Record<AiSessionProviderId, Map<string, CodexSession[]>>;
    expandedProjects: ReadonlySet<string>;
    activeProviders: Record<string, AiSessionProviderId>;
    pinnedSessions: Set<string>;
    aliases: Record<string, string>;
    aggregateByProjectAndSession: ReadonlyMap<string, AggregatedAttentionSession>;
    localAttentionBySession: Record<string, AiSessionAttentionSnapshot>;
    includeLocalAttention: boolean;
    getProjectKey: (project: Project) => string;
}

export function hydrateOpenProjectsWithAiSessions(input: HydrateOpenProjectsWithAiSessionsInput): Project[] {
    return input.projects.map(project => {
        const projectAttentionKey = getAttentionProjectKey(project.path);
        for (let provider of input.providers) {
            const providerId = provider.id;
            const sessionResult = input.sessionResults[providerId];
            const projectAssignments = input.assignments[providerId] || new Map<string, CodexSession[]>();
            project[provider.projectSessionsKey] = prepareAiSessionsForDisplay(
                projectAssignments.get(project.id) || [],
                providerId,
                input.pinnedSessions,
                input.aliases
            ).map(session => applyAttention({
                session,
                providerId,
                projectAttentionKey,
                aggregateByProjectAndSession: input.aggregateByProjectAndSession,
                localAttentionBySession: input.localAttentionBySession,
                includeLocalAttention: input.includeLocalAttention,
            }));
            project[provider.projectSessionsUnavailableKey] = !sessionResult.available;
        }
        project.codexSessionsExpanded = input.expandedProjects.has(input.getProjectKey(project));
        project.activeAiSessionProvider = getActiveAiSessionProvider(project, input.providers, input.activeProviders, input.getProjectKey);
        return project;
    });
}

function getActiveAiSessionProvider(
    project: Project,
    providers: readonly Pick<AiSessionProviderDefinition, 'id' | 'projectSessionsKey'>[],
    activeProviders: Record<string, AiSessionProviderId>,
    getProjectKey: (project: Project) => string,
): AiSessionProviderId {
    let selectedProvider = activeProviders[getProjectKey(project)];
    if (providers.some(provider => provider.id === selectedProvider)) {
        return selectedProvider;
    }

    for (let provider of providers) {
        if (project[provider.projectSessionsKey]?.length) {
            return provider.id;
        }
    }

    return 'codex';
}

interface ApplyAttentionInput {
    session: CodexSession;
    providerId: AiSessionProviderId;
    projectAttentionKey: string;
    aggregateByProjectAndSession: ReadonlyMap<string, AggregatedAttentionSession>;
    localAttentionBySession: Record<string, AiSessionAttentionSnapshot>;
    includeLocalAttention: boolean;
}

function applyAttention(input: ApplyAttentionInput): CodexSession {
    const sessionKey = getAiSessionKey(input.providerId, input.session.id);
    const aggregateAttention = input.aggregateByProjectAndSession.get(
        getAttentionSessionLookupKey(input.projectAttentionKey, sessionKey)
    );
    const localAttention = input.includeLocalAttention ? input.localAttentionBySession[sessionKey] : null;
    const event = aggregateAttention ? {
        eventId: aggregateAttention.eventIds[0] || `${aggregateAttention.sessionKey}:${aggregateAttention.observedAtMs}`,
        reason: aggregateAttention.reasons[0] || 'input-required' as const,
    } : localAttention?.event;

    return event ? {
        ...input.session,
        attention: {
            eventId: event.eventId,
            reason: event.reason,
            unread: aggregateAttention ? true : localAttention?.state === 'needsAttention',
        },
    } : input.session;
}
