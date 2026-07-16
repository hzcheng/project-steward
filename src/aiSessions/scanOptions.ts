'use strict';

export function getAiSessionScanMaxFiles(reason: string, defaultMaxFiles: number): number {
    if (reason === 'alias-original-name' || reason === 'terminal-candidates') {
        return 0;
    }

    return defaultMaxFiles;
}
