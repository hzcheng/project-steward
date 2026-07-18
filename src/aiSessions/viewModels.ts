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

export interface OpenProjectAiSessionViewModelBuilderOptions {
    maxEntries?: number;
}

export interface OpenProjectAiSessionViewModelBuilder {
    build(input: BuildOpenProjectAiSessionViewModelInput): OpenProjectAiSessionViewModel;
    clear(): void;
}

const DEFAULT_VIEW_MODEL_CACHE_MAX_ENTRIES = 500;

export function buildOpenProjectAiSessionViewModel(input: BuildOpenProjectAiSessionViewModelInput): OpenProjectAiSessionViewModel {
    const { project, providers } = input;
    const activeSessions = (project.activeAiSessions || []).map(session => ({ ...session }));
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
        defaultTab: project.activeAiSessionTab || (activeSessions.length ? 'active' : 'sessions'),
        activeSessions,
        activeSessionCount: activeSessions.length,
        activeAttentionCount: activeSessions.filter(session => session.needsAttention).length,
        sessionSectionHtml: input.renderSessionSection(project),
    };
}

export function createOpenProjectAiSessionViewModelBuilder(
    options: OpenProjectAiSessionViewModelBuilderOptions = {}
): OpenProjectAiSessionViewModelBuilder {
    const maxEntries = Math.max(1, options.maxEntries || DEFAULT_VIEW_MODEL_CACHE_MAX_ENTRIES);
    const cache = new Map<string, OpenProjectAiSessionViewModel>();
    const callbackIds = new WeakMap<object, number>();
    let nextCallbackId = 1;
    const getCallbackId = (callback: object): number => {
        let id = callbackIds.get(callback);
        if (!id) {
            id = nextCallbackId++;
            callbackIds.set(callback, id);
        }
        return id;
    };
    return {
        build(input: BuildOpenProjectAiSessionViewModelInput): OpenProjectAiSessionViewModel {
            const signature = getOpenProjectAiSessionViewModelSignature(input, getCallbackId);
            const cached = cache.get(signature);
            if (cached) {
                cache.delete(signature);
                cache.set(signature, cached);
                return cached;
            }

            const model = buildOpenProjectAiSessionViewModel(input);
            cache.set(signature, model);
            while (cache.size > maxEntries) {
                cache.delete(cache.keys().next().value);
            }
            return model;
        },
        clear(): void {
            cache.clear();
        },
    };
}

function getOpenProjectAiSessionViewModelSignature(
    input: BuildOpenProjectAiSessionViewModelInput,
    getCallbackId: (callback: object) => number
): string {
    return JSON.stringify({
        project: stableValue(input.project),
        providers: input.providers.map(provider => ({
            id: provider.id,
            label: provider.label,
            projectSessionsKey: provider.projectSessionsKey,
            projectSessionsUnavailableKey: provider.projectSessionsUnavailableKey,
        })),
        callbacks: {
            getProjectKey: getCallbackId(input.getProjectKey),
            getSearchText: getCallbackId(input.getSearchText),
            renderSessionSection: getCallbackId(input.renderSessionSection),
        },
    });
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(item => stableValue(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce((result, key) => {
            result[key] = stableValue((value as Record<string, unknown>)[key]);
            return result;
        }, {} as Record<string, unknown>);
}
