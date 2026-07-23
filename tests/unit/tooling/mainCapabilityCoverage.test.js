'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    loadMainCapabilityCoverage,
    validateMainCapabilityCoverage,
} = require('../../../scripts/lib/mainCapabilityCoverage');

function validFixture(t) {
    const repositoryRoot = makeTempDirectory(t, 'main-capability-');
    fs.mkdirSync(path.join(repositoryRoot, 'tests/unit'), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(repositoryRoot, 'tests/unit/owner.test.js'),
        "test('MAIN-WORKSPACE-IDENTITY-001 preserves identity', () => {});\n"
    );
    fs.writeFileSync(path.join(repositoryRoot, 'src/identity.ts'), 'export const identity = 1;\n');
    return {
        repositoryRoot,
        manifest: {
            version: 1,
            audit: {
                base: 'a'.repeat(40),
                head: 'b'.repeat(40),
                ignoredDocumentationCommits: [],
            },
            capabilities: [{
                id: 'MAIN-WORKSPACE-IDENTITY',
                title: 'Workspace identity',
                requirement: 'Workspace identities remain stable.',
                commits: ['c'.repeat(40)],
                behaviors: ['MAIN-WORKSPACE-IDENTITY-001'],
                prGates: ['test:deterministic:run'],
                scheduledJobs: [],
                realEnvironmentRequired: false,
            }],
        },
        behaviors: [{
            id: 'MAIN-WORKSPACE-IDENTITY-001',
            status: 'automated',
            owners: ['tests/unit/owner.test.js'],
            evidence: ['src/identity.ts'],
        }],
        scripts: {
            'test:deterministic:run': "node --test 'tests/unit/**/*.test.js'",
        },
        workflows: {},
        auditedCommits: [{
            hash: 'c'.repeat(40),
            subject: 'feat: model workspace identity',
            files: ['src/identity.ts'],
        }],
    };
}

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 accepts complete reachable main lineage', t => {
    const fixture = validFixture(t);
    assert.deepEqual(validateMainCapabilityCoverage(fixture.manifest, fixture), []);
});

function assertMutationRejected(t, expectedSubstring, mutate) {
    const fixture = validFixture(t);
    mutate(fixture.manifest, fixture);
    const errors = validateMainCapabilityCoverage(fixture.manifest, fixture);
    assert.ok(
        errors.some(error => error.includes(expectedSubstring)),
        `expected "${expectedSubstring}" in:\n${errors.join('\n')}`
    );
}

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects duplicate capabilities', t => {
    assertMutationRejected(t, 'duplicate capability id MAIN-WORKSPACE-IDENTITY', manifest => {
        manifest.capabilities.push({ ...manifest.capabilities[0] });
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects missing commit assignments', t => {
    assertMutationRejected(t, 'unassigned audited commit', manifest => {
        manifest.capabilities[0].commits = [];
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects duplicate commit assignments', t => {
    assertMutationRejected(t, 'assigned to multiple capabilities', manifest => {
        manifest.capabilities.push({
            ...manifest.capabilities[0],
            id: 'MAIN-WORKSPACE-SCOPE',
        });
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects missing behaviors', t => {
    assertMutationRejected(t, 'references missing behavior MISSING-BEHAVIOR-001', manifest => {
        manifest.capabilities[0].behaviors = ['MISSING-BEHAVIOR-001'];
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects non-automated behaviors', t => {
    assertMutationRejected(t, 'behavior MAIN-WORKSPACE-IDENTITY-001 must be automated', (_manifest, fixture) => {
        fixture.behaviors[0].status = 'manual';
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects missing behavior owners', t => {
    assertMutationRejected(t, 'behavior MAIN-WORKSPACE-IDENTITY-001 must have an owner', (_manifest, fixture) => {
        fixture.behaviors[0].owners = [];
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects missing behavior evidence', t => {
    assertMutationRejected(t, 'behavior MAIN-WORKSPACE-IDENTITY-001 must have evidence', (_manifest, fixture) => {
        fixture.behaviors[0].evidence = [];
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects missing PR gates', t => {
    assertMutationRejected(t, 'references missing PR gate test:missing', manifest => {
        manifest.capabilities[0].prGates = ['test:missing'];
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects owners unreachable from PR gates', t => {
    assertMutationRejected(t, 'owner tests/unit/owner.test.js is not reachable', (_manifest, fixture) => {
        fixture.scripts['test:deterministic:run'] = 'node other.js';
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects missing scheduled jobs', t => {
    assertMutationRejected(t, 'references missing scheduled job missing-job', manifest => {
        manifest.capabilities[0].realEnvironmentRequired = true;
        manifest.capabilities[0].scheduledJobs = ['missing-job'];
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects real-only coverage', t => {
    assertMutationRejected(t, 'must retain deterministic automated behavior coverage', manifest => {
        manifest.capabilities[0].realEnvironmentRequired = true;
        manifest.capabilities[0].behaviors = [];
    });
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 ignores only unassigned documentation commits', t => {
    const fixture = validFixture(t);
    fixture.auditedCommits.push({
        hash: 'd'.repeat(40),
        subject: 'docs: explain identity',
        files: ['docs/identity.md', '.superpowers/notes/identity.md'],
    });
    assert.deepEqual(validateMainCapabilityCoverage(fixture.manifest, fixture), []);
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 rejects implementation commits disguised as documentation exemptions', t => {
    const fixture = validFixture(t);
    const hash = 'd'.repeat(40);
    fixture.manifest.audit.ignoredDocumentationCommits.push(hash);
    fixture.auditedCommits.push({
        hash,
        subject: 'feat: change identity',
        files: ['src/identity.ts'],
    });
    const errors = validateMainCapabilityCoverage(fixture.manifest, fixture);
    assert.ok(errors.some(error => error.includes(`documentation exemption ${hash} changes non-documentation path`)));
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 reports invalid JSON without masking the parser error', t => {
    const repositoryRoot = makeTempDirectory(t, 'main-capability-json-');
    const manifestPath = path.join(repositoryRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, '{"version": 1,');
    assert.throws(
        () => loadMainCapabilityCoverage(manifestPath),
        error => error instanceof SyntaxError
    );
});
