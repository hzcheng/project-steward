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
    maxOpenProjectDiagnosticBytes?: number;
}

export default class DashboardDiagnostics {
    private readonly now: () => Date;
    private readonly maxOpenProjectDiagnosticBytes: number;
    private readonly openProjectDiagnosticPath: string;

    constructor(private readonly options: DashboardDiagnosticsOptions) {
        this.now = options.now || (() => new Date());
        this.maxOpenProjectDiagnosticBytes = options.maxOpenProjectDiagnosticBytes || 2 * 1024 * 1024;
        this.openProjectDiagnosticPath = path.join(options.globalStoragePath, 'open-project-diagnostics.jsonl');
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

    logOpenProjectDiagnostic(component: string, event: unknown) {
        let line: string;
        try {
            line = `${JSON.stringify({
                loggedAt: this.now().toISOString(),
                component,
                event,
            })}\n`;
        } catch (error) {
            this.options.outputChannel.appendLine(`[OpenProjects][${component}] Failed to serialize diagnostic: ${String(error)}`);
            return;
        }

        this.options.outputChannel.appendLine(`[OpenProjects][${component}] ${JSON.stringify(event)}`);
        try {
            mkdirSync(this.options.globalStoragePath, { recursive: true });
            const existingBytes = existsSync(this.openProjectDiagnosticPath)
                ? statSync(this.openProjectDiagnosticPath).size
                : 0;
            if (existingBytes + Buffer.byteLength(line, 'utf8') > this.maxOpenProjectDiagnosticBytes) {
                writeFileSync(this.openProjectDiagnosticPath, line, 'utf8');
            } else {
                appendFileSync(this.openProjectDiagnosticPath, line, 'utf8');
            }
        } catch (error) {
            this.options.outputChannel.appendLine(`[OpenProjects][${component}] Failed to persist diagnostic: ${String(error)}`);
        }
    }
}
