'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionProviderDefinition } from './types';
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
