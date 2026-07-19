'use strict';

import * as vscode from 'vscode';

const VISIBLE_VIEW_FAILURE_MESSAGE = 'Unexpected Project Steward view failure.';

export interface SidebarStewardViewProviderOptions {
    getWebviewOptions: () => vscode.WebviewOptions;
    renderContent: (webview: vscode.Webview) => string;
    renderError: (error: unknown) => string;
    onMessage: (message: unknown) => Promise<void>;
    onVisibleChanged: (visible: boolean) => void | Thenable<void> | Promise<void>;
    logError: (message: string, error: unknown) => void;
}

export class SidebarStewardViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'projectSteward.steward';

    private _view?: vscode.WebviewView;

    constructor(private readonly options: SidebarStewardViewProviderOptions) {
    }

    async resolveWebviewView(webviewView: vscode.WebviewView, webviewContext: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): Promise<void> {
        this._view = webviewView;
        webviewView.webview.options = this.options.getWebviewOptions();

        webviewView.webview.onDidReceiveMessage(async message => {
            try {
                await this.options.onMessage(message);
            } catch (_error) {
                this.options.logError(
                    'Failed to handle a Project Steward message.', sanitizedViewFailure()
                );
            }
        });

        webviewView.onDidChangeVisibility(async () => {
            await this.prepareVisibility(webviewView);
        });
        await this.prepareVisibility(webviewView);
    }

    get visible() {
        return Boolean(this._view?.visible);
    }

    refresh() {
        if (this._view) {
            try {
                this._view.webview.html = this.options.renderContent(this._view.webview);
            } catch (_error) {
                const failure = sanitizedViewFailure();
                this.options.logError('Failed to render Project Steward view.', failure);
                this._view.webview.html = this.options.renderError(failure);
            }
        }
    }

    postMessage(message: unknown): Thenable<boolean> {
        if (!this._view) {
            return Promise.resolve(false);
        }

        return this._view.webview.postMessage(message);
    }

    private async prepareVisibility(webviewView: vscode.WebviewView): Promise<void> {
        try {
            await this.options.onVisibleChanged(webviewView.visible);
            if (webviewView.visible) {
                this.refresh();
            }
        } catch (_error) {
            const failure = sanitizedViewFailure();
            this.options.logError('Failed to prepare Project Steward view.', failure);
            if (webviewView.visible) {
                webviewView.webview.html = this.options.renderError(failure);
            }
        }
    }
}

function sanitizedViewFailure(): Error {
    return new Error(VISIBLE_VIEW_FAILURE_MESSAGE);
}
