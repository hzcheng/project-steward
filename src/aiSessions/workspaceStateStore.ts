'use strict';

import type { AiSessionProviderId } from '../models';
import {
    WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY,
    WORKSPACE_EXPANDED_AI_SESSIONS_KEY,
} from '../constants';

interface MementoLike {
    get<T>(key: string): T;
    update(key: string, value: unknown): Thenable<void>;
}

export default class AiSessionWorkspaceStateStore {
    constructor(
        private readonly state: MementoLike,
        private readonly isProviderId: (value: string) => value is AiSessionProviderId,
    ) { }

    getExpandedWorkspaces(): Set<string> {
        const expandedWorkspaces = this.state.get<unknown>(WORKSPACE_EXPANDED_AI_SESSIONS_KEY);
        return new Set(
            Array.isArray(expandedWorkspaces)
                ? expandedWorkspaces.filter((workspaceScopeIdentity): workspaceScopeIdentity is string =>
                    typeof workspaceScopeIdentity === 'string' && Boolean(workspaceScopeIdentity))
                : []
        );
    }

    async setExpanded(workspaceScopeIdentity: string, expanded: boolean): Promise<void> {
        if (!workspaceScopeIdentity) {
            return;
        }

        const expandedWorkspaces = this.getExpandedWorkspaces();
        if (expanded) {
            expandedWorkspaces.add(workspaceScopeIdentity);
        } else {
            expandedWorkspaces.delete(workspaceScopeIdentity);
        }

        await this.state.update(WORKSPACE_EXPANDED_AI_SESSIONS_KEY, Array.from(expandedWorkspaces));
    }

    getActiveProviders(): Record<string, AiSessionProviderId> {
        const selectedProviders = this.state.get<unknown>(WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY);
        if (!selectedProviders || typeof selectedProviders !== 'object' || Array.isArray(selectedProviders)) {
            return {};
        }

        return Object.keys(selectedProviders as Record<string, unknown>).reduce((result, workspaceScopeIdentity) => {
            const providerId = (selectedProviders as Record<string, unknown>)[workspaceScopeIdentity];
            if (typeof providerId === 'string' && this.isProviderId(providerId)) {
                result[workspaceScopeIdentity] = providerId;
            }
            return result;
        }, {} as Record<string, AiSessionProviderId>);
    }

    async setActiveProvider(
        workspaceScopeIdentity: string,
        providerId: AiSessionProviderId
    ): Promise<void> {
        if (!workspaceScopeIdentity || !this.isProviderId(providerId)) {
            return;
        }

        const selectedProviders = this.getActiveProviders();
        selectedProviders[workspaceScopeIdentity] = providerId;
        await this.state.update(WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY, selectedProviders);
    }
}
