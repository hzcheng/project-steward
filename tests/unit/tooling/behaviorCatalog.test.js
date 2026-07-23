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
    const evidencePath = path.join(root, 'src', 'projects', 'projectPathUtils.ts');
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, 'export const normalizePath = value => value;\n');
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

test('CATALOG-INTEGRITY-010 rejects Windows drive-absolute owner paths', t => {
    const root = createRoot(t);
    const owner = 'C:\\outside\\owner.js';
    const errors = validateBehaviorCatalog([automatedEntry({ owners: [owner] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.includes(`entry 1 owner path must be repository-relative: ${owner}`));
});

test('CATALOG-INTEGRITY-011 rejects missing evidence files', t => {
    const root = createRoot(t);
    const evidence = 'src/projects/missing.ts';
    const errors = validateBehaviorCatalog([automatedEntry({ evidence: [evidence] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.includes(`entry 1 has missing evidence path ${evidence}`));
});

test('CATALOG-INTEGRITY-012 rejects absolute evidence paths across platforms', t => {
    const root = createRoot(t);
    for (const evidence of [
        '/outside/evidence.ts',
        'C:\\outside\\evidence.ts',
        '\\\\server\\share\\evidence.ts',
    ]) {
        const errors = validateBehaviorCatalog([automatedEntry({ evidence: [evidence] })], {
            repositoryRoot: root,
        });
        assert.ok(errors.includes(`entry 1 evidence path must be repository-relative: ${evidence}`), evidence);
    }
});

test('CATALOG-INTEGRITY-013 rejects evidence paths that lexically escape the repository', t => {
    const root = createRoot(t);
    const evidence = '../outside/evidence.ts';
    const errors = validateBehaviorCatalog([automatedEntry({ evidence: [evidence] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.includes(`entry 1 evidence path must be repository-relative: ${evidence}`));
});

test('CATALOG-INTEGRITY-014 rejects evidence directories', t => {
    const root = createRoot(t);
    const evidence = 'src/projects';
    const errors = validateBehaviorCatalog([automatedEntry({ evidence: [evidence] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.includes(`entry 1 evidence path must be a regular file: ${evidence}`));
});

test('CATALOG-INTEGRITY-015 rejects evidence symlinks that resolve outside the repository', t => {
    const root = createRoot(t);
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-catalog-outside-'));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const outsideFile = path.join(outsideRoot, 'evidence.ts');
    fs.writeFileSync(outsideFile, 'export const outside = true;\n');
    const evidence = 'src/projects/outside-link.ts';
    try {
        fs.symlinkSync(outsideFile, path.join(root, evidence));
    } catch (error) {
        if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
            t.skip(`symlinks unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    const errors = validateBehaviorCatalog([automatedEntry({ evidence: [evidence] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.includes(`entry 1 evidence path resolves outside repository: ${evidence}`));
});

test('CATALOG-INTEGRITY-016 accepts an inspectable repository-relative regular evidence file', t => {
    const root = createRoot(t);
    const errors = validateBehaviorCatalog([automatedEntry()], { repositoryRoot: root });
    assert.ok(!errors.some(error => error.includes('evidence path')));
});

test('CATALOG-INTEGRITY-017 rejects owner symlinks that resolve outside the repository', t => {
    const root = createRoot(t);
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-owner-outside-'));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const outsideFile = path.join(outsideRoot, 'owner.test.js');
    fs.writeFileSync(outsideFile, '// PROJECT-PATH-001\n');
    const owner = 'tests/unit/outside-owner.test.js';
    try {
        fs.symlinkSync(outsideFile, path.join(root, owner));
    } catch (error) {
        if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
            t.skip(`symlinks unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    const errors = validateBehaviorCatalog([automatedEntry({ owners: [owner] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.includes(`entry 1 owner path resolves outside repository: ${owner}`));
});

test('CATALOG-INTEGRITY-018 audits an in-repository owner symlink by its canonical legacy target', t => {
    const root = createRoot(t);
    const legacyOwner = 'scripts/run-ai-session-safety-checks.js';
    const legacyPath = path.join(root, legacyOwner);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '// PROJECT-PATH-001\n');
    const owner = 'tests/unit/legacy-owner-link.test.js';
    try {
        fs.symlinkSync(legacyPath, path.join(root, owner));
    } catch (error) {
        if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
            t.skip(`symlinks unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    const errors = validateBehaviorCatalog([automatedEntry({ owners: [owner] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.includes(
        `entry 1 legacy compatibility script cannot own automated behavior: ${owner}`,
    ));
});

test('CATALOG-INTEGRITY-019 accepts an in-repository owner symlink to an ordinary ID owner', t => {
    const root = createRoot(t);
    const ownerTarget = path.join(root, 'tests', 'unit', 'ordinary-owner.test.js');
    fs.writeFileSync(ownerTarget, '// PROJECT-PATH-001\n');
    const owner = 'tests/unit/ordinary-owner-link.test.js';
    try {
        fs.symlinkSync(ownerTarget, path.join(root, owner));
    } catch (error) {
        if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
            t.skip(`symlinks unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    const errors = validateBehaviorCatalog([automatedEntry({ owners: [owner] })], {
        repositoryRoot: root,
    });
    assert.deepEqual(errors, []);
});

test('CATALOG-INTEGRITY-020 rejects Win32 drive-relative owner and evidence paths', t => {
    const root = createRoot(t);
    for (const { field, value } of [
        { field: 'owner', value: 'C:owner.test.js' },
        { field: 'evidence', value: 'D:evidence.ts' },
    ]) {
        const overrides = field === 'owner' ? { owners: [value] } : { evidence: [value] };
        const errors = validateBehaviorCatalog([automatedEntry(overrides)], { repositoryRoot: root });
        assert.ok(errors.includes(
            `entry 1 ${field} path must be repository-relative: ${value}`,
        ));
    }
});

test('CATALOG-INTEGRITY-021 rejects canonical paths in a repository-name prefix sibling', t => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-prefix-parent-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'repository');
    fs.mkdirSync(root);
    const ownerPath = path.join(root, 'tests', 'unit', 'sample.test.js');
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(ownerPath, '// PROJECT-PATH-001\n');
    const sibling = path.join(parent, 'repository-evil');
    fs.mkdirSync(sibling);
    const outsideFile = path.join(sibling, 'evidence.ts');
    fs.writeFileSync(outsideFile, 'export const outside = true;\n');
    const evidence = 'evidence-link.ts';
    try {
        fs.symlinkSync(outsideFile, path.join(root, evidence));
    } catch (error) {
        if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
            t.skip(`symlinks unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    const errors = validateBehaviorCatalog([automatedEntry({ evidence: [evidence] })], {
        repositoryRoot: root,
    });
    assert.ok(errors.includes(`entry 1 evidence path resolves outside repository: ${evidence}`));
});

test('CATALOG-INTEGRITY-022 converts non-ENOENT inspection failures into stable errors', t => {
    const root = createRoot(t);
    const evidence = 'src/projects/projectPathUtils.ts';
    const controlledPath = path.join(root, evidence);
    const originalStatSync = fs.statSync;
    let errors;
    try {
        fs.statSync = function statSyncWithControlledFailure(filePath, ...args) {
            if (filePath === controlledPath) {
                const error = new Error('controlled inspection denial');
                error.code = 'EACCES';
                throw error;
            }
            return originalStatSync.call(fs, filePath, ...args);
        };
        assert.doesNotThrow(() => {
            errors = validateBehaviorCatalog([automatedEntry()], { repositoryRoot: root });
        });
    } finally {
        fs.statSync = originalStatSync;
    }
    assert.ok(errors.includes(
        `entry 1 cannot inspect evidence path ${evidence}: controlled inspection denial`,
    ));
});
