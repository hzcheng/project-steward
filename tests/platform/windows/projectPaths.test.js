'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');

class FakeUri {
    constructor(scheme, authority, uriPath, fsPath, raw) {
        this.scheme = scheme;
        this.authority = authority || '';
        this.path = uriPath;
        this.fsPath = fsPath;
        this.raw = raw;
    }

    toString() {
        return this.raw;
    }

    static file(filePath) {
        const uriPath = String(filePath).replace(/\\/g, '/');
        return new FakeUri('file', '', uriPath, filePath, `file:///${uriPath}`);
    }

    static parse(value) {
        const text = String(value);
        const match = text.match(/^([^:]+):\/\/([^/]*)(\/[^?#]*)?/);
        if (!match) {
            throw new Error(`Unsupported fixture URI: ${text}`);
        }
        const scheme = match[1];
        const authority = match[2];
        const uriPath = match[3] || '/';
        const fsPath = scheme === 'file' ? uriPath.replace(/^\/([A-Za-z]:)/, '$1') : uriPath;
        return new FakeUri(scheme, authority, uriPath, fsPath, text);
    }
}

function loadMatcher() {
    const fakeVscode = createFakeVscode({});
    fakeVscode.Uri = FakeUri;
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return fakeVscode;
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/projects/openProjectMatcher');
    } finally {
        Module._load = previousLoad;
    }
}

const matcher = loadMatcher();

test('PROJECT-WORKSPACE-HELPER-001 matches Windows drive paths across slash styles', () => {
    const workspaceUri = FakeUri.file('C:\\Users\\fixture\\project');

    assert.equal(
        matcher.projectPathMatchesWorkspaceUri('C:/Users/fixture/project/', workspaceUri),
        true
    );
    assert.equal(
        matcher.projectPathMatchesWorkspaceUri('D:/Users/fixture/project', workspaceUri),
        false
    );
});

test('PROJECT-WORKSPACE-HELPER-001 resolves Windows file workspace URIs to drive paths', () => {
    const workspaceUri = FakeUri.file('C:\\Users\\fixture\\project.code-workspace');

    assert.equal(
        matcher.projectPathMatchesWorkspaceUri('file:///C:/Users/fixture/project.code-workspace', workspaceUri),
        true
    );
    assert.equal(matcher.uriToProjectPath(workspaceUri), 'C:\\Users\\fixture\\project.code-workspace');
});
