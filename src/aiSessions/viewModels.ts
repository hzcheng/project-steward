'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';
import type { AiSessionProviderDefinition, AiSessionViewModel, OpenProjectAiSessionViewModel } from './types';

export interface BuildOpenProjectAiSessionViewModelInput {
    project: Project;
    providers: readonly Pick<AiSessionProviderDefinition, 'id' | 'label' | 'projectSessionsKey' | 'projectSessionsUnavailableKey'>[];
    getProjectKey: (project: Project) => string;
    getSearchText: (project: Project) => string;
    renderSessionSection: (project: Project) => string;
}

export function buildOpenProjectAiSessionViewModel(input: BuildOpenProjectAiSessionViewModelInput): OpenProjectAiSessionViewModel {
    const { project, providers } = input;
    let sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>> = {};
    let summaries = providers.map(provider => {
        let providerId = provider.id;
        let sessions = project[provider.projectSessionsKey] || [];
        sessionsByProvider[providerId] = sessions.map(session => ({
            ...session,
            provider: providerId,
        }));
        return {
            id: providerId,
            label: provider.label,
            count: sessions.length,
            unavailable: Boolean(project[provider.projectSessionsUnavailableKey]),
        };
    });

    return {
        projectId: project.id,
        projectKey: input.getProjectKey(project),
        activeProvider: project.activeAiSessionProvider,
        expanded: Boolean(project.codexSessionsExpanded),
        providers: summaries,
        sessionsByProvider,
        unavailableProviders: summaries.filter(item => item.unavailable).map(item => item.id),
        searchText: input.getSearchText(project),
        aiSessionCount: providers.reduce((count, provider) => {
            return count + (project[provider.projectSessionsKey] || []).length;
        }, 0),
        attentionCount: project.aiSessionAttentionCount ?? providers.reduce((count, provider) => {
            return count + (project[provider.projectSessionsKey] || []).filter((session: CodexSession) => session.attention?.unread).length;
        }, 0),
        sessionSectionHtml: input.renderSessionSection(project),
    };
}
