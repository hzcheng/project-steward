'use strict';

import type { AiSessionProviderId } from '../models';
import type {
    ActiveAiSessionViewModel,
    AiSessionProviderDefinition,
    AiSessionViewModel,
    WorkspaceAiSessionViewModel,
} from '../aiSessions/types';
import type { OpenWorkspace } from './types';

export interface BuildWorkspaceAiSessionViewModelInput {
    workspace: OpenWorkspace;
    providers: readonly Pick<AiSessionProviderDefinition, 'id' | 'label'>[];
    sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>>;
    unavailableProviders: readonly AiSessionProviderId[];
    activeSessions: readonly ActiveAiSessionViewModel[];
    activeProvider?: AiSessionProviderId;
    expanded?: boolean;
}

export function buildWorkspaceAiSessionViewModel(
    input: BuildWorkspaceAiSessionViewModelInput
): WorkspaceAiSessionViewModel {
    const unavailableProviders = new Set(input.unavailableProviders);
    const sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>> = {};
    const providers = input.providers.map(provider => {
        const sessions = (input.sessionsByProvider[provider.id] || []).map(session => ({ ...session }));
        sessionsByProvider[provider.id] = sessions;
        return {
            id: provider.id,
            label: provider.label,
            count: sessions.length,
            ...(unavailableProviders.has(provider.id) ? { unavailable: true } : {}),
        };
    });
    const activeSessions = input.activeSessions.map(session => ({ ...session }));
    const activeProvider = input.providers.some(provider => provider.id === input.activeProvider)
        ? input.activeProvider
        : providers.find(provider => provider.count > 0)?.id || input.providers[0]?.id || 'codex';

    return {
        workspaceScopeIdentity: input.workspace.scopeIdentity,
        workspaceNavigationIdentity: input.workspace.navigationIdentity,
        activeProvider,
        expanded: Boolean(input.expanded),
        providers,
        sessionsByProvider,
        unavailableProviders: input.providers
            .filter(provider => unavailableProviders.has(provider.id))
            .map(provider => provider.id),
        aiSessionCount: providers.reduce((count, provider) => count + provider.count, 0),
        attentionCount: Object.values(sessionsByProvider)
            .reduce((count, sessions) => count + (sessions || [])
                .filter(session => session.attention?.unread).length, 0),
        defaultTab: activeSessions.length ? 'active' : 'sessions',
        activeSessions,
        activeSessionCount: activeSessions.length,
        activeAttentionCount: activeSessions.filter(session => session.needsAttention).length,
    };
}
