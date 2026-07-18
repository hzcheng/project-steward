'use strict';

import * as path from 'path';

export function isCommandAvailableOnPath(
    commandName: string,
    environment: Record<string, string | undefined>,
    platform: NodeJS.Platform,
    exists: (candidate: string) => boolean
): boolean {
    if (!commandName || !environment || typeof exists !== 'function') {
        return false;
    }
    const windows = platform === 'win32';
    const pathValue = environment.PATH || environment.Path || '';
    const pathApi = windows ? path.win32 : path.posix;
    const pathSeparator = windows ? ';' : ':';
    const extensions = windows
        ? (environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];

    for (const directory of pathValue.split(pathSeparator).filter(Boolean)) {
        for (const extension of extensions) {
            const suffix = windows && path.extname(commandName) ? '' : extension;
            if (exists(pathApi.join(directory, `${commandName}${suffix}`))) {
                return true;
            }
        }
    }
    return false;
}
