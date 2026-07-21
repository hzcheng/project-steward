'use strict';

import { normalizeAiSessionComparablePath } from './sessionHelpers';

export { getWorkspaceAiSessionCandidatePaths } from '../workspaces/sessionHydration';

export function normalizeAiSessionProjectPath(projectPath: string): string {
    return projectPath ? normalizeAiSessionComparablePath(projectPath) : '';
}
