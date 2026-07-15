'use strict';

import * as fs from 'fs';

export function readJsonlTailLines(filePath: string, maxBytes = 512 * 1024): string[] {
    if (!filePath || !Number.isFinite(maxBytes) || maxBytes <= 0) {
        return [];
    }

    let fd: number = null;
    try {
        let stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size <= 0) {
            return [];
        }

        let offset = Math.max(0, stat.size - Math.floor(maxBytes));
        let length = stat.size - offset;
        let buffer = Buffer.alloc(length);
        fd = fs.openSync(filePath, 'r');
        let bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        let lines = buffer.slice(0, bytesRead).toString('utf8').split(/\r?\n/g);
        if (offset > 0) {
            lines.shift();
        }
        if (lines.length && lines[lines.length - 1] === '') {
            lines.pop();
        }
        return lines;
    } catch (e) {
        return [];
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch (e) {
                // Best effort only.
            }
        }
    }
}
