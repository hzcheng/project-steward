'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { AiSessionReadResult } from './types';

export interface AiSessionTerminalCandidateReader {
    getProviderResult(providerId: AiSessionProviderId, options: { reason: string }): AiSessionReadResult;
}

export function getAiSessionTerminalCandidates(
    providerId: AiSessionProviderId,
    reader: AiSessionTerminalCandidateReader
): readonly CodexSession[] {
    return reader.getProviderResult(providerId, { reason: 'terminal-candidates' }).sessions;
}
