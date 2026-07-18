'use strict';

import type { AiSessionProviderId, CodexSession, Project } from '../models';

export interface AiSessionResumeTerminal {
    show(): void;
}

export interface AiSessionResumeTerminalEntry<TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal> {
    terminal: TTerminal;
    markerPath: string;
}

export interface AiSessionResumeProvider {
    label: string;
    terminalEnvKey: string;
}

export interface AiSessionResumeCreateTerminalOptions {
    name: string;
    cwd: string | null;
    env: Record<string, string>;
    cwdFailureMessage: string;
    cwdWarningMessage: string;
    logError: (message: string, error: unknown) => void;
}

export interface AiSessionResumeCreateTerminalResult<TTerminal extends AiSessionResumeTerminal> {
    terminal: TTerminal;
    cwdAccepted: boolean;
}

export interface AiSessionResumePendingTerminal<TTerminal extends AiSessionResumeTerminal> {
    terminal: TTerminal;
    markerPath: string;
}

export interface AiSessionResumeTrackEntry<TTerminal extends AiSessionResumeTerminal> {
    terminal: TTerminal;
    markerPath: string;
    runStartedAtMs: number;
    cwd?: string;
}

export interface AiSessionResumeControllerOptions<
    TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal,
    TEntry extends AiSessionResumeTerminalEntry<TTerminal> = AiSessionResumeTerminalEntry<TTerminal>
> {
    getOpenProjects: () => Project[];
    getProvider: (providerId: AiSessionProviderId) => AiSessionResumeProvider | null;
    getProjectSession: (project: Project, providerId: AiSessionProviderId, sessionId: string) => CodexSession | null | undefined;
    getTerminalCwd: (providerId: AiSessionProviderId, session: CodexSession, project: Project) => string;
    getTerminalName: (providerId: AiSessionProviderId, session: CodexSession) => string;
    getComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string;
    getUsableTerminalCwd: (cwd: string) => string | null;
    normalizeProjectPath: (cwd: string) => string | null;
    getExistingTerminal: (providerId: AiSessionProviderId, session: CodexSession) => TEntry | null;
    isTerminalComplete: (entry: TEntry) => boolean;
    beginResume: (providerId: AiSessionProviderId, sessionId: string) => boolean;
    finishResume: (providerId: AiSessionProviderId, sessionId: string) => void;
    getMarkerPath: (providerId: AiSessionProviderId, sessionId: string) => string;
    findPendingTerminalForSession: (
        providerId: AiSessionProviderId,
        sessionId: string,
        cwd: string,
        updatedAt: string
    ) => AiSessionResumePendingTerminal<TTerminal> | null;
    createTerminal: (
        options: AiSessionResumeCreateTerminalOptions
    ) => AiSessionResumeCreateTerminalResult<TTerminal>;
    track: (
        providerId: AiSessionProviderId,
        sessionId: string,
        entry: AiSessionResumeTrackEntry<TTerminal>
    ) => void;
    claimPendingTerminal: (terminal: TTerminal) => void;
    sendResumeCommand: (
        providerId: AiSessionProviderId,
        terminal: TTerminal,
        sessionId: string,
        cwd: string | null,
        markerPath: string
    ) => Thenable<void> | Promise<void>;
    showWarningMessage: (message: string) => unknown;
    syncActiveTerminal: () => void;
    refresh: () => void;
    showActiveTab: (projectId: string) => unknown;
    logError: (message: string, error: unknown) => void;
    nowMs: () => number;
}

export class AiSessionResumeController<
    TTerminal extends AiSessionResumeTerminal = AiSessionResumeTerminal,
    TEntry extends AiSessionResumeTerminalEntry<TTerminal> = AiSessionResumeTerminalEntry<TTerminal>
> {
    constructor(private readonly options: AiSessionResumeControllerOptions<TTerminal, TEntry>) {
    }

    async resumeProjectSession(
        projectId: string,
        providerId: AiSessionProviderId | null,
        sessionId: string
    ): Promise<void> {
        if (!providerId) {
            return;
        }

        const sessionProvider = this.options.getProvider(providerId);
        if (!sessionProvider) {
            return;
        }

        const project = this.options.getOpenProjects().find(candidate => candidate.id === projectId);
        const session = project ? this.options.getProjectSession(project, providerId, sessionId) : null;
        if (!project || !session) {
            this.options.showWarningMessage(`Selected ${sessionProvider.label} session not found.`);
            return;
        }

        let cwd = this.options.getUsableTerminalCwd(this.options.getTerminalCwd(providerId, session, project));
        const existingTerminal = this.options.getExistingTerminal(providerId, session);
        if (existingTerminal && !this.options.isTerminalComplete(existingTerminal)) {
            existingTerminal.terminal.show();
            await this.options.showActiveTab(projectId);
            this.options.refresh();
            return;
        }

        if (!this.options.beginResume(providerId, session.id)) {
            return;
        }

        const terminalName = this.options.getTerminalName(providerId, session);
        let terminal = existingTerminal?.terminal;
        let usedPendingTerminal = false;
        const terminalEnv = { [sessionProvider.terminalEnvKey]: session.id };
        let markerPath = existingTerminal?.markerPath || this.options.getMarkerPath(providerId, session.id);

        try {
            if (!terminal) {
                const sessionCwd = this.options.normalizeProjectPath(this.options.getComparableCwd(providerId, session));
                const pendingTerminal = sessionCwd
                    ? this.options.findPendingTerminalForSession(providerId, session.id, sessionCwd, session.updatedAt)
                    : null;
                if (pendingTerminal) {
                    terminal = pendingTerminal.terminal;
                    markerPath = pendingTerminal.markerPath;
                    usedPendingTerminal = true;
                } else {
                    const createResult = this.options.createTerminal({
                        name: terminalName,
                        cwd,
                        env: terminalEnv,
                        cwdFailureMessage: `Failed to create ${sessionProvider.label} terminal with cwd.`,
                        cwdWarningMessage: `Could not open the ${sessionProvider.label} terminal at the session directory. Resuming without a working directory.`,
                        logError: this.options.logError,
                    });
                    terminal = createResult.terminal;
                    if (!createResult.cwdAccepted) {
                        cwd = null;
                    }
                }
            }

            terminal.show();
            await this.options.sendResumeCommand(providerId, terminal, session.id, cwd, markerPath);
            if (usedPendingTerminal) {
                this.options.claimPendingTerminal(terminal);
            }
            this.options.track(providerId, session.id, {
                terminal,
                markerPath,
                runStartedAtMs: this.options.nowMs(),
                cwd: this.options.normalizeProjectPath(
                    this.options.getComparableCwd(providerId, session)
                ) || undefined,
            });
            this.options.syncActiveTerminal();
            await this.options.showActiveTab(projectId);
            this.options.refresh();
        } finally {
            this.options.finishResume(providerId, session.id);
        }
    }
}
