'use strict';

import type { AiSessionProviderId } from '../models';
import {
    OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY,
    OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY,
} from '../constants';

interface MementoLike {
    get<T>(key: string): T;
    update(key: string, value: unknown): Thenable<void>;
}

export default class AiSessionProjectStateStore {
    constructor(
        private readonly state: MementoLike,
        private readonly isProviderId: (value: string) => value is AiSessionProviderId,
    ) { }

    getExpandedProjects(): Set<string> {
        let expandedProjects = this.state.get<unknown>(OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY);
        return new Set(
            Array.isArray(expandedProjects)
                ? expandedProjects.filter((projectKey): projectKey is string => typeof projectKey === 'string' && Boolean(projectKey))
                : []
        );
    }

    async setExpanded(projectKey: string, expanded: boolean): Promise<void> {
        if (!projectKey) {
            return;
        }

        let expandedProjects = this.getExpandedProjects();
        if (expanded) {
            expandedProjects.add(projectKey);
        } else {
            expandedProjects.delete(projectKey);
        }

        await this.state.update(OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY, Array.from(expandedProjects));
    }

    getActiveProviders(): Record<string, AiSessionProviderId> {
        let selectedProviders = this.state.get<unknown>(OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY);
        if (!selectedProviders || typeof selectedProviders !== 'object' || Array.isArray(selectedProviders)) {
            return {};
        }

        return Object.keys(selectedProviders as Record<string, unknown>).reduce((result, projectKey) => {
            let providerId = (selectedProviders as Record<string, unknown>)[projectKey];
            if (typeof providerId === 'string' && this.isProviderId(providerId)) {
                result[projectKey] = providerId;
            }
            return result;
        }, {} as Record<string, AiSessionProviderId>);
    }

    async setActiveProvider(projectKey: string, providerId: AiSessionProviderId): Promise<void> {
        if (!projectKey || !this.isProviderId(providerId)) {
            return;
        }

        let selectedProviders = this.getActiveProviders();
        selectedProviders[projectKey] = providerId;
        await this.state.update(OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY, selectedProviders);
    }
}
