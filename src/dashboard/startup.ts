'use strict';

import { StartupOptions } from '../constants';

export interface ShouldOpenStewardOnStartupInput {
    reopenReason?: unknown;
    openOnStartup: string;
    workspaceName?: string;
    visibleEditorLanguageIds?: readonly string[];
    reopenNoneValue?: unknown;
}

export function shouldOpenStewardOnStartup(input: ShouldOpenStewardOnStartupInput): boolean {
    const reopenNoneValue = input.reopenNoneValue === undefined ? 0 : input.reopenNoneValue;
    const reopenReason = input.reopenReason === undefined ? reopenNoneValue : input.reopenReason;
    if (reopenReason !== reopenNoneValue) {
        return true;
    }

    switch (input.openOnStartup) {
        case StartupOptions.always:
            return true;
        case StartupOptions.never:
            return false;
        case StartupOptions.emptyWorkSpace:
        default:
            return isEmptyWorkspaceStartup(input.workspaceName, input.visibleEditorLanguageIds || []);
    }
}

function isEmptyWorkspaceStartup(workspaceName: string, visibleEditorLanguageIds: readonly string[]): boolean {
    return !workspaceName && (
        visibleEditorLanguageIds.length === 0
        || visibleEditorLanguageIds.length === 1 && visibleEditorLanguageIds[0] === 'code-runner-output'
    );
}
