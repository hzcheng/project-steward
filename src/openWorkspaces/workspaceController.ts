'use strict';

import type { OpenWorkspace } from '../workspaces/types';
import { createOpenWorkspacePublication } from './projection';
import type { OpenWorkspaceRecord } from './protocol';

export interface OpenWorkspaceControllerOptions {
    getWorkspace: () => OpenWorkspace | null;
    publishWorkspace: (workspace: OpenWorkspaceRecord | null, followsFocusEvent: boolean) => unknown;
}

export class OpenWorkspaceController {
    constructor(private readonly options: OpenWorkspaceControllerOptions) {
    }

    getCurrentWorkspace(): OpenWorkspace | null {
        return this.options.getWorkspace();
    }

    getPublication(): OpenWorkspaceRecord | null {
        return createOpenWorkspacePublication(this.getCurrentWorkspace());
    }

    publish(followsFocusEvent = false): void {
        void this.options.publishWorkspace(this.getPublication(), followsFocusEvent);
    }
}
