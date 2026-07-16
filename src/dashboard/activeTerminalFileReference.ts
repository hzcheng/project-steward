'use strict';

export interface FileReferenceUriLike {
    scheme?: string;
    fsPath?: string;
    path?: string;
}

export interface TextEditorSelectionLike {
    isEmpty: boolean;
    start: { line: number };
    end: { line: number };
}

export interface TextEditorLike {
    document: {
        uri: FileReferenceUriLike;
    };
    selection: TextEditorSelectionLike;
}

export interface TerminalLike {
    sendText(text: string, addNewLine?: boolean): void;
    show?(): void;
}

export interface FileLineRange {
    startLine: number;
    endLine: number;
}

export interface ActiveTerminalFileReferenceControllerOptions {
    getActiveTextEditor: () => TextEditorLike | null | undefined;
    getActiveTerminal: () => TerminalLike | null | undefined;
    asRelativePath: (uri: FileReferenceUriLike) => string;
    showWarningMessage: (message: string) => unknown;
}

export function formatFileReference(filePath: string, range: FileLineRange | null): string {
    if (!range) {
        return filePath;
    }
    if (range.startLine === range.endLine) {
        return `${filePath}:${range.startLine}`;
    }
    return `${filePath}:${range.startLine}-${range.endLine}`;
}

export function getPrimarySelectionLineRange(selection: TextEditorSelectionLike | null | undefined): FileLineRange | null {
    if (!selection || selection.isEmpty) {
        return null;
    }
    const startLine = Math.min(selection.start.line, selection.end.line) + 1;
    const endLine = Math.max(selection.start.line, selection.end.line) + 1;
    return { startLine, endLine };
}

export class ActiveTerminalFileReferenceController {
    constructor(private readonly options: ActiveTerminalFileReferenceControllerOptions) {
    }

    async addFileToActiveTerminal(): Promise<void> {
        const editor = this.options.getActiveTextEditor();
        if (!editor || !this.isSavedFile(editor.document.uri)) {
            this.options.showWarningMessage('Open a saved file before adding it to the active terminal.');
            return;
        }

        const terminal = this.options.getActiveTerminal();
        if (!terminal) {
            this.options.showWarningMessage('No active terminal to receive the file reference.');
            return;
        }

        const filePath = this.getReferencePath(editor.document.uri);
        const reference = formatFileReference(filePath, getPrimarySelectionLineRange(editor.selection));
        terminal.sendText(reference, false);
        terminal.show?.();
    }

    private isSavedFile(uri: FileReferenceUriLike): boolean {
        return uri?.scheme !== 'untitled' && Boolean(uri?.fsPath || uri?.path);
    }

    private getReferencePath(uri: FileReferenceUriLike): string {
        const relativePath = this.options.asRelativePath(uri);
        return relativePath || uri.fsPath || uri.path || '';
    }
}
