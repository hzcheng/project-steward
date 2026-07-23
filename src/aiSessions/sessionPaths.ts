'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { AiSessionProviderDefinition } from './types';

type AiSessionPathProvider = Pick<
    AiSessionProviderDefinition,
    'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'
>;

export function getAiSessionComparableCwd(
    providerId: AiSessionProviderId,
    session: CodexSession,
    providers: readonly AiSessionPathProvider[]
): string {
    let sessionProvider = getAiSessionPathProvider(providerId, providers);
    if (!sessionProvider) {
        return session.workDir || session.cwd || null;
    }

    for (let field of sessionProvider.terminalCwdFields) {
        if (session[field]) {
            return session[field];
        }
    }

    return null;
}

export function getAiSessionTerminalName(
    providerId: AiSessionProviderId,
    session: CodexSession,
    providers: readonly AiSessionPathProvider[]
): string {
    let provider = getAiSessionPathProvider(providerId, providers);
    let prefix = provider?.terminalNamePrefix || 'AI';
    return `${prefix}: ${session.name || session.id} [${session.id.substring(0, 8)}]`;
}

function getAiSessionPathProvider(
    providerId: AiSessionProviderId,
    providers: readonly AiSessionPathProvider[]
): AiSessionPathProvider | null {
    return providers.find(provider => provider.id === providerId) || null;
}
