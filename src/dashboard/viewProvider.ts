'use strict';

import * as vscode from 'vscode';

export interface SidebarStewardViewProviderOptions {
    getWebviewOptions: () => vscode.WebviewOptions;
    renderContent: (webview: vscode.Webview) => string;
    renderError: (error: unknown) => string;
    onMessage: (message: unknown) => Promise<void>;
    onVisibleChanged: (visible: boolean) => void;
    logError: (message: string, error: unknown) => void;
}

export class SidebarStewardViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'projectSteward.steward';

    private _view?: vscode.WebviewView;

    constructor(private readonly options: SidebarStewardViewProviderOptions) {
    }

    resolveWebviewView(webviewView: vscode.WebviewView, webviewContext: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): void | Thenable<void> {
        this._view = webviewView;
        webviewView.webview.options = this.options.getWebviewOptions();
        this.refresh();
        this.options.onVisibleChanged(webviewView.visible);

        webviewView.webview.onDidReceiveMessage(async message => {
            await this.options.onMessage(message);
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refresh();
            }
            this.options.onVisibleChanged(webviewView.visible);
        });
    }

    get visible() {
        return Boolean(this._view?.visible);
    }

    refresh() {
        if (this._view) {
            try {
                this._view.webview.html = this.options.renderContent(this._view.webview);
            } catch (error) {
                this.options.logError('Failed to render Project Steward view.', error);
                this._view.webview.html = this.options.renderError(error);
            }
        }
    }

    postMessage(message: unknown): Thenable<boolean> {
        if (!this._view) {
            return Promise.resolve(false);
        }

        return this._view.webview.postMessage(message);
    }
}
