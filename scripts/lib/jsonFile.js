'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeJsonFileAtomically(filePath, value, fileSystem = fs) {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    let descriptor;

    fileSystem.mkdirSync(directory, { recursive: true });
    try {
        descriptor = fileSystem.openSync(temporaryPath, 'w', 0o600);
        fileSystem.writeFileSync(descriptor, contents, 'utf8');
        fileSystem.fsyncSync(descriptor);
        fileSystem.closeSync(descriptor);
        descriptor = undefined;
        fileSystem.renameSync(temporaryPath, filePath);
    } catch (error) {
        if (descriptor !== undefined) {
            try {
                fileSystem.closeSync(descriptor);
            } catch (closeError) {
                // The replacement error remains the actionable failure.
            }
        }
        try {
            fileSystem.unlinkSync(temporaryPath);
        } catch (cleanupError) {
            // The temporary file may not have been created.
        }
        throw error;
    }
}

module.exports = {
    writeJsonFileAtomically,
};
