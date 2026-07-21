'use strict';

import type { OpenWorkspace } from '../workspaces/types';
import { createOpenWorkspacePublication } from './projection';
import type { OpenWorkspaceRecord } from './protocol';

export interface OpenWorkspaceControllerOptions {
    getWorkspace: () => OpenWorkspace | null;
    getRunningAiSessionCount: (workspace: OpenWorkspace) => number;
    publishWorkspace: (workspace: OpenWorkspaceRecord | null, followsFocusEvent: boolean) => unknown;
}

export class OpenWorkspaceController {
    private currentWorkspace: OpenWorkspace | null | undefined;

    constructor(private readonly options: OpenWorkspaceControllerOptions) {
    }

    getCurrentWorkspace(): OpenWorkspace | null {
        if (this.currentWorkspace === undefined) {
            this.currentWorkspace = this.options.getWorkspace();
        }
        return this.currentWorkspace;
    }

    getPublication(): OpenWorkspaceRecord | null {
        const workspace = this.getCurrentWorkspace();
        return createOpenWorkspacePublication(
            workspace,
            workspace ? this.options.getRunningAiSessionCount(workspace) : 0,
        );
    }

    refresh(): OpenWorkspace | null {
        this.currentWorkspace = this.options.getWorkspace();
        return this.currentWorkspace;
    }

    publish(followsFocusEvent = false): void {
        const workspace = this.refresh();
        void this.options.publishWorkspace(
            createOpenWorkspacePublication(
                workspace,
                workspace ? this.options.getRunningAiSessionCount(workspace) : 0,
            ),
            followsFocusEvent,
        );
    }
}
