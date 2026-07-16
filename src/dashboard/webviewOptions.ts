'use strict';

import * as path from 'path';
import type * as vscode from 'vscode';

export function getDashboardWebviewOptions(
    extensionPath: string,
    createFileUri: (filePath: string) => vscode.Uri
): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            createFileUri(path.join(extensionPath, 'media')),
        ],
    };
}
