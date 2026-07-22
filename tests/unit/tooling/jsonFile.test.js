'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { writeJsonFileAtomically } = require('../../../scripts/lib/jsonFile');

function createFileSystem(options = {}) {
    const files = new Map();
    const operations = [];
    return {
        files,
        operations,
        closeSync(descriptor) {
            operations.push(`close:${descriptor}`);
        },
        fsyncSync(descriptor) {
            operations.push(`fsync:${descriptor}`);
        },
        mkdirSync(directory) {
            operations.push(`mkdir:${directory}`);
        },
        openSync(fileName) {
            operations.push(`open:${fileName}`);
            return 7;
        },
        renameSync(from, to) {
            operations.push(`rename:${from}:${to}`);
            if (options.failRename) {
                throw new Error('replace failed');
            }
            files.set(to, files.get(from));
            files.delete(from);
        },
        unlinkSync(fileName) {
            operations.push(`unlink:${fileName}`);
            files.delete(fileName);
        },
        writeFileSync(descriptor, contents) {
            operations.push(`write:${descriptor}`);
            files.set(operations.find(operation => operation.startsWith('open:')).slice(5), contents);
        },
    };
}

test('JSON-FILE-001 flushes and closes a unique temporary JSON file before replacing the destination', () => {
    const fileSystem = createFileSystem();
    const destination = path.join('/repository', '.ci', 'baseline.json');

    writeJsonFileAtomically(destination, { lines: 80 }, fileSystem);

    assert.equal(fileSystem.files.get(destination), '{\n  "lines": 80\n}\n');
    assert.deepEqual(fileSystem.operations.map(operation => operation.split(':')[0]), [
        'mkdir', 'open', 'write', 'fsync', 'close', 'rename',
    ]);
    assert.equal([...fileSystem.files.keys()].some(fileName => fileName.endsWith('.tmp')), false);
});

test('JSON-FILE-002 removes the temporary file when atomic replacement fails', () => {
    const fileSystem = createFileSystem({ failRename: true });
    const destination = path.join('/repository', '.ci', 'baseline.json');

    assert.throws(() => writeJsonFileAtomically(destination, { lines: 80 }, fileSystem), /replace failed/);

    assert.deepEqual(fileSystem.operations.map(operation => operation.split(':')[0]), [
        'mkdir', 'open', 'write', 'fsync', 'close', 'rename', 'unlink',
    ]);
    assert.equal([...fileSystem.files.keys()].some(fileName => fileName.endsWith('.tmp')), false);
});
