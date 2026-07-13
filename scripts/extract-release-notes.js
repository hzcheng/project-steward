'use strict';

const fs = require('fs');
const path = require('path');

function extractReleaseNotes(changelog, version) {
    const lines = changelog.replace(/\r\n/g, '\n').split('\n');
    const heading = `## [${version}]`;
    const startIndex = lines.findIndex(line => line === heading || line.startsWith(`${heading} `));

    if (startIndex === -1) {
        throw new Error(`No non-empty CHANGELOG.md section found for version ${version}.`);
    }

    const nextHeadingOffset = lines
        .slice(startIndex + 1)
        .findIndex(line => /^##\s+/.test(line));
    const endIndex = nextHeadingOffset === -1
        ? lines.length
        : startIndex + 1 + nextHeadingOffset;
    const notes = lines.slice(startIndex + 1, endIndex).join('\n').trim();

    if (!notes) {
        throw new Error(`No non-empty CHANGELOG.md section found for version ${version}.`);
    }

    return notes;
}

function main() {
    const version = process.argv[2];
    const changelogPath = process.argv[3]
        ? path.resolve(process.argv[3])
        : path.resolve(__dirname, '..', 'CHANGELOG.md');

    if (!version) {
        throw new Error('Usage: node scripts/extract-release-notes.js <version> [changelog-path]');
    }

    const changelog = fs.readFileSync(changelogPath, 'utf8');
    process.stdout.write(`${extractReleaseNotes(changelog, version)}\n`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = { extractReleaseNotes };
