'use strict';

import * as path from 'path';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs';

export interface DashboardDiagnosticsOutputChannel {
    appendLine(value: string): void;
}

export interface DashboardDiagnosticsOptions {
    outputChannel: DashboardDiagnosticsOutputChannel;
    globalStoragePath: string;
    now?: () => Date;
    maxOpenWorkspaceDiagnosticBytes?: number;
}

export default class DashboardDiagnostics {
    private readonly now: () => Date;
    private readonly maxOpenWorkspaceDiagnosticBytes: number;
    private readonly openWorkspaceDiagnosticPath: string;

    constructor(private readonly options: DashboardDiagnosticsOptions) {
        this.now = options.now || (() => new Date());
        this.maxOpenWorkspaceDiagnosticBytes = options.maxOpenWorkspaceDiagnosticBytes || 2 * 1024 * 1024;
        this.openWorkspaceDiagnosticPath = path.join(options.globalStoragePath, 'open-workspace-diagnostics.jsonl');
    }

    logError(message: string, error: unknown) {
        this.options.outputChannel.appendLine(message);
        this.options.outputChannel.appendLine(error instanceof Error ? `${error.stack || error.message}` : String(error));
    }

    logAiSessionDiagnostic(event: Record<string, unknown>) {
        this.options.outputChannel.appendLine(`[AiSessions] ${JSON.stringify(event)}`);
    }

    logDashboardDiagnostic(event: Record<string, unknown>) {
        this.options.outputChannel.appendLine(`[Dashboard] ${JSON.stringify({
            loggedAt: this.now().toISOString(),
            ...event,
        })}`);
    }

    logOpenWorkspaceDiagnostic(component: string, event: unknown) {
        let line: string;
        try {
            line = `${JSON.stringify({
                loggedAt: this.now().toISOString(),
                component,
                event,
            })}\n`;
        } catch (error) {
            this.options.outputChannel.appendLine(`[OpenWorkspaces][${component}] Failed to serialize diagnostic: ${String(error)}`);
            return;
        }

        this.options.outputChannel.appendLine(`[OpenWorkspaces][${component}] ${JSON.stringify(event)}`);
        try {
            mkdirSync(this.options.globalStoragePath, { recursive: true });
            const existingBytes = existsSync(this.openWorkspaceDiagnosticPath)
                ? statSync(this.openWorkspaceDiagnosticPath).size
                : 0;
            if (existingBytes + Buffer.byteLength(line, 'utf8') > this.maxOpenWorkspaceDiagnosticBytes) {
                writeFileSync(this.openWorkspaceDiagnosticPath, line, 'utf8');
            } else {
                appendFileSync(this.openWorkspaceDiagnosticPath, line, 'utf8');
            }
        } catch (error) {
            this.options.outputChannel.appendLine(`[OpenWorkspaces][${component}] Failed to persist diagnostic: ${String(error)}`);
        }
    }
}
