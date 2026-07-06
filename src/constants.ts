export const USE_PROJECT_COLOR = true;
export const PREDEFINED_COLORS = [
    { label: 'Green', value: 'var(--vscode-gitDecoration-untrackedResourceForeground)' },
    { label: 'Brown', value: 'var(--vscode-gitDecoration-modifiedResourceForeground)' },
    { label: 'Red', value: 'var(--vscode-gitDecoration-deletedResourceForeground)' },
    { label: 'Grey', value: 'var(--vscode-gitDecoration-ignoredResourceForeground)' },
    { label: 'Dark Blue', value: '#6c6cc4' }, // Color was changed in https://github.com/microsoft/vscode/commit/2fda718ad7136a145668dad783b7ee41c58b6737
    { label: 'Light Blue', value: 'var(--vscode-terminal-submoduleResourceForeground)' },
];

export const INBUILT_COLOR_DEFAULTS = [
    { name: '--vscode-gitDecoration-untrackedResourceForeground', defaultValue: '#73c991' },
    { name: '--vscode-gitDecoration-modifiedResourceForeground', defaultValue: '#e2c08d' },
    { name: '--vscode-gitDecoration-deletedResourceForeground', defaultValue: '#c74e39' },
    { name: '--vscode-gitDecoration-ignoredResourceForeground', defaultValue: '#8c8c8c' },
    { name: '--vscode-gitDecoration-submoduleResourceForeground', defaultValue: '#8db9e2' },
    { name: '--vscode-terminal-submoduleResourceForeground', defaultValue: '#8db9e2' },
];

export const PROJECTS_KEY = 'projects';
export const RECENT_COLORS_KEY = 'recentColors';
export const PROJECT_STEWARD_CONFIG_SECTION = 'projectSteward';
export const LEGACY_DASHBOARD_CONFIG_SECTION = 'dashboard';
export const REOPEN_KEY = 'reopenProjectStewardReason';
export const FAVORITES_GROUP_ID = '__favorites';
export const FAVORITES_GROUP_COLLAPSED_KEY = 'favoritesGroupCollapsed';
export const OPEN_PROJECTS_GROUP_ID = '__openProjects';
export const OPEN_PROJECTS_GROUP_COLLAPSED_KEY = 'openProjectsGroupCollapsed';
export const OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY = 'openProjectsExpandedCodexSessions';
export const OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY = 'openProjectsActiveAiSessionProvider';
export const OPEN_PROJECTS_PINNED_AI_SESSIONS_KEY = 'openProjectsPinnedAiSessions';

export enum StorageOption {
    GlobalState,
    Settings,
}

export const FITTY_OPTIONS = {
    maxSize: '24',
    // minSize: '20', // Apparently, fitty has a problem with our setup and will overflow text if minSize is set...
}

export const USER_CANCELED = "CanceledByUser"; // A symbol would be nice, but throw new Error(Symbol) does not work
export const SAVE_CURRENT_PROJECT = "SaveCurrentProject";
export const ADD_NEW_PROJECT_TO_FRONT = false;

export const SSH_REMOTE_PREFIX = "vscode-remote://ssh-remote+";
export const DEV_CONTAINER_REMOTE_PREFIX = "vscode-remote://dev-container+";
export const ATTACHED_CONTAINER_REMOTE_PREFIX = "vscode-remote://attached-container+";
export const VSCODE_REMOTE_PREFIX = "vscode-remote://";
export const REMOTE_REGEX = /^vscode-remote:\/\/[^\+]+\+/;
export const SSH_REGEX = /^((?<user>[^@\/]+)(\@))?(?<hostname>[^@\/\. ]+[^@\/ ]*)(?<folder>\/.*)*$/;
export const WSL_DEFAULT_REGEX = /\\+wsl\$\\/i;

export const StartupOptions = Object.freeze({
    always: "always",
    emptyWorkSpace: "empty workspace",
    never: "never",
});

export const FixedColorOptions = Object.freeze({
    random: 'Random',
    none: 'None',
    custom: 'Custom',
    recent: 'Recent',
});

export const RelevantExtensions = Object.freeze({
    remoteSSH: 'ms-vscode-remote.remote-ssh',
    remoteContainers: 'ms-vscode-remote.remote-containers',
});
