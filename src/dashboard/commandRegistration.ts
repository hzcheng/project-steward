'use strict';

export interface DisposableLike {
    dispose(): unknown;
}

export interface DashboardCommandHandlers {
    open: () => unknown;
    addProject: () => unknown;
    saveProject: () => unknown;
    removeProject: () => unknown;
    editProjects: () => unknown;
    addGroup: () => unknown;
    removeGroup: () => unknown;
    addProjectsFromFolder: () => unknown;
}

export interface DashboardCommandRegistrationOptions<TDisposable extends DisposableLike = DisposableLike> {
    registerCommand: (command: string, callback: () => unknown) => TDisposable;
    pushSubscription: (disposable: TDisposable) => void;
    handlers: DashboardCommandHandlers;
}

export class DashboardCommandRegistration<TDisposable extends DisposableLike = DisposableLike> {
    constructor(private readonly options: DashboardCommandRegistrationOptions<TDisposable>) {
    }

    register(): void {
        this.registerCommand('projectSteward.open', this.options.handlers.open);
        this.registerCommand('projectSteward.addProject', this.options.handlers.addProject);
        this.registerCommand('projectSteward.saveProject', this.options.handlers.saveProject);
        this.registerCommand('projectSteward.removeProject', this.options.handlers.removeProject);
        this.registerCommand('projectSteward.editProjects', this.options.handlers.editProjects);
        this.registerCommand('projectSteward.addGroup', this.options.handlers.addGroup);
        this.registerCommand('projectSteward.removeGroup', this.options.handlers.removeGroup);
        this.registerCommand('projectSteward.addProjectsFromFolder', this.options.handlers.addProjectsFromFolder);
    }

    private registerCommand(command: string, callback: () => unknown): void {
        this.options.pushSubscription(this.options.registerCommand(command, callback));
    }
}
