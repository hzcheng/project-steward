'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionProvider, AiSessionProviderDefinition, AiSessionService } from './types';
import {
    buildClaudeNewSessionCommand,
    buildClaudeResumeCommand,
    buildCodexNewSessionCommand,
    buildCodexResumeCommand,
    buildKimiNewSessionCommand,
    buildKimiResumeCommand,
} from './commandBuilders';

export const AI_SESSION_PROVIDER_IDS: AiSessionProviderId[] = ['codex', 'kimi', 'claude'];

export const AI_SESSION_PROVIDER_DEFINITIONS: Record<AiSessionProviderId, AiSessionProviderDefinition> = {
    codex: {
        id: 'codex',
        label: 'Codex',
        commandName: 'codex',
        terminalNamePrefix: 'Codex',
        terminalEnvKey: 'PROJECT_STEWARD_CODEX_SESSION_ID',
        markerDirName: 'codex-session-terminals',
        projectSessionsKey: 'codexSessions',
        projectSessionsUnavailableKey: 'codexSessionsUnavailable',
        terminalCwdFields: ['cwd'],
        buildResumeCommand: buildCodexResumeCommand,
        buildNewSessionCommand: (cwd, _title, markerPath) => buildCodexNewSessionCommand(cwd, null, markerPath),
    },
    kimi: {
        id: 'kimi',
        label: 'Kimi',
        commandName: 'kimi',
        terminalNamePrefix: 'Kimi',
        terminalEnvKey: 'PROJECT_STEWARD_KIMI_SESSION_ID',
        markerDirName: 'kimi-session-terminals',
        projectSessionsKey: 'kimiSessions',
        projectSessionsUnavailableKey: 'kimiSessionsUnavailable',
        terminalCwdFields: ['workDir', 'cwd'],
        buildResumeCommand: buildKimiResumeCommand,
        buildNewSessionCommand: (cwd, _title, markerPath) => buildKimiNewSessionCommand(cwd, null, markerPath),
    },
    claude: {
        id: 'claude',
        label: 'Claude',
        commandName: 'claude',
        terminalNamePrefix: 'Claude',
        terminalEnvKey: 'PROJECT_STEWARD_CLAUDE_SESSION_ID',
        markerDirName: 'claude-session-terminals',
        projectSessionsKey: 'claudeSessions',
        projectSessionsUnavailableKey: 'claudeSessionsUnavailable',
        terminalCwdFields: ['workDir', 'cwd'],
        buildResumeCommand: buildClaudeResumeCommand,
        buildNewSessionCommand: buildClaudeNewSessionCommand,
    },
};

export function getAiSessionProviderDefinition(providerId: AiSessionProviderId): AiSessionProviderDefinition | null {
    return AI_SESSION_PROVIDER_DEFINITIONS[providerId] || null;
}

export function getAiSessionProviderLabel(providerId: AiSessionProviderId): string {
    return getAiSessionProviderDefinition(providerId)?.label || 'AI';
}

export interface AiSessionProviderRegistry {
    get(providerId: AiSessionProviderId): AiSessionProvider | null;
    providers(): AiSessionProvider[];
}

export function createAiSessionProviderRegistry(services: Record<AiSessionProviderId, AiSessionService>): AiSessionProviderRegistry {
    const providers = AI_SESSION_PROVIDER_IDS.map(id => ({
        ...AI_SESSION_PROVIDER_DEFINITIONS[id],
        service: services[id],
    }));
    const byId = new Map(providers.map(provider => [provider.id, provider] as [AiSessionProviderId, AiSessionProvider]));
    return {
        get: providerId => byId.get(providerId) || null,
        providers: () => providers.slice(),
    };
}
