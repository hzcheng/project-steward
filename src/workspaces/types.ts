export type OpenWorkspaceKind = 'singleFolder' | 'savedMultiRoot' | 'untitledMultiRoot';
export type OpenWorkspaceEnvironment = 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';

export interface WorkspaceRoot {
    id: string;
    name: string;
    uri: string;
    hostPath: string;
    ordinal: number;
}

export interface OpenWorkspace {
    navigationIdentity: string;
    scopeIdentity: string;
    kind: OpenWorkspaceKind;
    displayName: string;
    navigationUri: string;
    environment: OpenWorkspaceEnvironment;
    roots: WorkspaceRoot[];
}
