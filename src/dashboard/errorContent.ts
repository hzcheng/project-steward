'use strict';

export function getErrorContent(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            padding: 12px;
        }
        code {
            color: var(--vscode-errorForeground);
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <p>Project Steward could not render this view.</p>
    <code>${escapeHtml(message)}</code>
</body>
</html>`;
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
