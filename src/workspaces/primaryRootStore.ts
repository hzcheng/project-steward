'use strict';

import type { WorkspaceRoot } from './types';

export const WORKSPACE_PRIMARY_ROOTS_STATE_KEY = 'projectSteward.workspacePrimaryRoots';

interface MementoLike {
    get<T>(key: string): T;
    update(key: string, value: unknown): Thenable<void>;
}

export class WorkspacePrimaryRootStore {
    constructor(private readonly state: MementoLike) { }

    getPrimaryRootId(scopeIdentity: string, roots: readonly WorkspaceRoot[]): string | null {
        if (!scopeIdentity) {
            return null;
        }

        const primaryRoots = this.getAll();
        const rootId = primaryRoots[scopeIdentity];
        return rootId && (roots || []).some(root => root.id === rootId) ? rootId : null;
    }

    async setPrimaryRootId(scopeIdentity: string, rootId: string): Promise<void> {
        if (!scopeIdentity || !rootId) {
            return;
        }

        await this.state.update(WORKSPACE_PRIMARY_ROOTS_STATE_KEY, {
            ...this.getAll(),
            [scopeIdentity]: rootId,
        });
    }

    private getAll(): Record<string, string> {
        const value = this.state.get<unknown>(WORKSPACE_PRIMARY_ROOTS_STATE_KEY);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }

        return Object.keys(value as Record<string, unknown>).reduce((result, scopeIdentity) => {
            const rootId = (value as Record<string, unknown>)[scopeIdentity];
            if (scopeIdentity && typeof rootId === 'string' && rootId) {
                result[scopeIdentity] = rootId;
            }
            return result;
        }, {} as Record<string, string>);
    }
}
