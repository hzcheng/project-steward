'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateBehaviorCatalog } = require('../../../scripts/lib/behaviorCatalog');

function createRoot(t, contents = "test('PROJECT-PATH-001 normalizes paths', () => {});\n") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-catalog-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const testPath = path.join(root, 'tests', 'unit', 'sample.test.js');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, contents);
    return root;
}

function automatedEntry(overrides = {}) {
    return {
        id: 'PROJECT-PATH-001',
        domain: 'project',
        title: 'Normalize saved paths',
        priority: 'P0',
        status: 'automated',
        owners: ['tests/unit/sample.test.js'],
        evidence: ['src/projects/projectPathUtils.ts'],
        ...overrides,
    };
}

test('CATALOG-INTEGRITY-001 accepts a referenced automated behavior', t => {
    const root = createRoot(t);
    const errors = validateBehaviorCatalog([automatedEntry()], { repositoryRoot: root });
    assert.deepEqual(errors, []);
});

test('CATALOG-INTEGRITY-002 rejects duplicate behavior IDs', t => {
    const root = createRoot(t);
    const errors = validateBehaviorCatalog([
        automatedEntry(),
        automatedEntry({ title: 'Duplicate path behavior' }),
    ], { repositoryRoot: root });
    assert.ok(errors.some(error => error.includes('duplicate id PROJECT-PATH-001')));
});

test('CATALOG-INTEGRITY-003 rejects invalid behavior ID shapes', t => {
    const root = createRoot(t);
    const errors = validateBehaviorCatalog([automatedEntry({ id: 'project-path-1' })], {
        repositoryRoot: root,
    });
    assert.ok(errors.some(error => error.includes('invalid id project-path-1')));
});

test('CATALOG-INTEGRITY-004 rejects automated behaviors with missing owner files', t => {
    const root = createRoot(t);
    const errors = validateBehaviorCatalog([automatedEntry({ owners: ['tests/unit/missing.test.js'] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.some(error => error.includes('missing owner path tests/unit/missing.test.js')));
});

test('CATALOG-INTEGRITY-005 rejects automated owners without the behavior ID', t => {
    const root = createRoot(t, "test('different behavior', () => {});\n");
    const errors = validateBehaviorCatalog([automatedEntry()], { repositoryRoot: root });
    assert.ok(errors.some(error => error.includes('does not reference id PROJECT-PATH-001')));
});

test('CATALOG-INTEGRITY-006 rejects manual behaviors without a manual reason', t => {
    const root = createRoot(t);
    const errors = validateBehaviorCatalog([automatedEntry({ status: 'manual', owners: [] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.some(error => error.includes('manualReason must be a non-empty string')));
});

test('CATALOG-INTEGRITY-007 rejects automated owner directories without throwing', t => {
    const root = createRoot(t);
    const owner = 'tests/unit/automated-owner-directory';
    fs.mkdirSync(path.join(root, owner));
    let errors;
    assert.doesNotThrow(() => {
        errors = validateBehaviorCatalog([automatedEntry({ owners: [owner] })], { repositoryRoot: root });
    });
    assert.ok(errors.some(error => error.includes(`owner path must be a regular file: ${owner}`)));
});

test('CATALOG-INTEGRITY-008 rejects manual owner directories without throwing', t => {
    const root = createRoot(t);
    const owner = 'tests/unit/manual-owner-directory';
    fs.mkdirSync(path.join(root, owner));
    let errors;
    assert.doesNotThrow(() => {
        errors = validateBehaviorCatalog([automatedEntry({
            status: 'manual',
            owners: [owner],
            manualReason: 'Requires a human review.',
        })], { repositoryRoot: root });
    });
    assert.ok(errors.some(error => error.includes(`owner path must be a regular file: ${owner}`)));
});

test('CATALOG-INTEGRITY-009 rejects legacy compatibility scripts as automated owners', t => {
    const root = createRoot(t);
    const legacyOwner = 'scripts/run-ai-session-safety-checks.js';
    const legacyPath = path.join(root, legacyOwner);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '// PROJECT-PATH-001\n');
    const resemblingOwner = 'scripts/run-ai-session-safety-checks-helper.js';
    fs.writeFileSync(path.join(root, resemblingOwner), '// PROJECT-PATH-001\n');

    for (const { owner, legacy } of [
        { owner: legacyOwner, legacy: true },
        { owner: `./${legacyOwner}`, legacy: true },
        { owner: 'scripts/../scripts/run-ai-session-safety-checks.js', legacy: true },
        { owner: 'scripts\\run-ai-session-safety-checks.js', legacy: true },
        { owner: resemblingOwner, legacy: false },
    ]) {
        const errors = validateBehaviorCatalog([automatedEntry({ owners: [owner] })], {
            repositoryRoot: root,
        });
        const legacyError = `legacy compatibility script cannot own automated behavior: ${owner}`;
        assert.equal(errors.some(error => error.includes(legacyError)), legacy, owner);
        assert.ok(!errors.some(error => error.includes(`missing owner path ${owner}`)), owner);
        if (!legacy) {
            assert.deepEqual(errors, [], owner);
        }
    }
});
