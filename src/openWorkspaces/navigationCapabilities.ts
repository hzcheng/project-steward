'use strict';

import type { OpenWorkspaceEnvironment, OpenWorkspaceKind } from '../workspaces/types';

export const DIRECT_WORKSPACE_NAVIGATION_CAPABILITIES: Readonly<Record<string, boolean>> = {
    'local/singleFolder': false,
    'local/savedMultiRoot': false,
    'local/untitledMultiRoot': false,
    'ssh/singleFolder': false,
    'ssh/savedMultiRoot': false,
    'ssh/untitledMultiRoot': false,
    'wsl/singleFolder': false,
    'wsl/savedMultiRoot': false,
    'wsl/untitledMultiRoot': false,
    'devContainer/singleFolder': false,
    'devContainer/savedMultiRoot': false,
    'devContainer/untitledMultiRoot': false,
};

export function isDirectWorkspaceNavigationSupported(
    environment: OpenWorkspaceEnvironment,
    kind: OpenWorkspaceKind,
): boolean {
    if (environment === 'remote') { return false; }
    return DIRECT_WORKSPACE_NAVIGATION_CAPABILITIES[`${environment}/${kind}`];
}
