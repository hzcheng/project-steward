'use strict';

import * as vscode from 'vscode';

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
            } catch (error) {
                this.options.logError('Failed to handle a Project Steward message.', error);
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

    private async prepareVisibility(webviewView: vscode.WebviewView): Promise<void> {
        try {
            await this.options.onVisibleChanged(webviewView.visible);
            if (webviewView.visible) {
                this.refresh();
            }
        } catch (error) {
            this.options.logError('Failed to prepare Project Steward view.', error);
            if (webviewView.visible) {
                webviewView.webview.html = this.options.renderError(error);
            }
        }
    }
}
