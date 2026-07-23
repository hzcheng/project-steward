'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildReadableTmuxLocator,
    legacyTmuxLocator,
    normalizeTmuxReadableComponent,
    projectTmuxSessionMatchesWorkspace,
    tmuxLocatorMatchesIdentity,
} = require('../../../out/aiSessions/tmuxNaming');

function identity(overrides = {}) {
    return {
        provider: 'codex',
        workspaceScopeIdentity: 'scope-a',
        workspaceNavigationIdentity: 'navigation-a',
        workspaceRootHostPaths: ['/work/a'],
        cwd: '/work/a',
        sessionId: 'session-123456789',
        ...overrides,
    };
}

test('RUNTIME-TMUX-NAMING-001 normalizes readable Unicode and removes control characters', () => {
    assert.equal(
        normalizeTmuxReadableComponent(' ＲｅｄＤＢ DTS / 双活 ', 'workspace'),
        'RedDB-DTS-双活'
    );
    assert.equal(normalizeTmuxReadableComponent(' : . ', 'session'), 'session');
    assert.equal(normalizeTmuxReadableComponent('', 'new-session'), 'new-session');
    assert.equal(
        normalizeTmuxReadableComponent('Fix\u0000replication\u001fnow', 'session'),
        'Fix-replication-now'
    );
});

test('RUNTIME-TMUX-NAMING-001 builds deterministic project, session, pending, and distinct locators', () => {
    const current = identity();
    const names = { projectName: ' RedDB DTS / 双活 ', sessionName: 'Fix: replication.timeout' };
    const project = buildReadableTmuxLocator(current, 'project', names);
    const session = buildReadableTmuxLocator(current, 'session', names);

    assert.match(project.sessionName, /^ps-RedDB-DTS-双活-[0-9a-f]{8}$/u);
    assert.match(project.windowName, /^codex-Fix-replication-timeout-[0-9a-f]{8}$/);
    assert.match(session.sessionName, /^ps-RedDB-DTS-双活-Fix-replication-timeout-[0-9a-f]{8}$/u);
    assert.match(session.windowName, /^codex-Fix-replication-timeout-[0-9a-f]{8}$/);
    assert.deepEqual(buildReadableTmuxLocator(current, 'project', names), project);
    assert.notEqual(
        buildReadableTmuxLocator(identity({ sessionId: 'different-session' }), 'project', names).windowName,
        project.windowName
    );
    assert.notEqual(
        buildReadableTmuxLocator(identity({ workspaceScopeIdentity: 'scope-b' }), 'project', names).sessionName,
        project.sessionName
    );

    const pendingIdentity = identity({ sessionId: undefined, pendingId: 'pending-1' });
    const pendingProject = buildReadableTmuxLocator(pendingIdentity, 'project', {
        projectName: 'RedDB',
        sessionName: '',
    });
    const pendingSession = buildReadableTmuxLocator(pendingIdentity, 'session', {
        projectName: 'RedDB',
        sessionName: '',
    });
    assert.match(pendingProject.windowName, /^codex-new-session-[0-9a-f]{8}$/);
    assert.match(pendingSession.sessionName, /^ps-RedDB-new-session-[0-9a-f]{8}$/);
    assert.equal(tmuxLocatorMatchesIdentity(pendingProject, pendingIdentity), true);
    assert.equal(tmuxLocatorMatchesIdentity(pendingSession, pendingIdentity), true);
});

test('RUNTIME-TMUX-NAMING-001 accepts exact and legacy locators but rejects foreign encoded identities', () => {
    const current = identity();
    const readable = buildReadableTmuxLocator(current, 'project', {
        projectName: 'RedDB',
        sessionName: 'Repair replication',
    });
    assert.equal(tmuxLocatorMatchesIdentity(readable, current), true);
    assert.equal(tmuxLocatorMatchesIdentity(legacyTmuxLocator(current, 'project'), current), true);
    assert.equal(tmuxLocatorMatchesIdentity(legacyTmuxLocator(current, 'session'), current), true);

    const workspaceSuffix = readable.sessionName.match(/([0-9a-f]{8})$/)[1];
    assert.equal(projectTmuxSessionMatchesWorkspace(
        `ps-Renamed-Card-${workspaceSuffix}`,
        current
    ), true);
    assert.equal(projectTmuxSessionMatchesWorkspace(
        `ps-Renamed-Card-00000000`,
        current
    ), false);

    for (const foreign of [
        identity({ provider: 'kimi' }),
        identity({ workspaceScopeIdentity: 'other-scope' }),
        identity({ sessionId: 'other-session' }),
    ]) {
        assert.equal(tmuxLocatorMatchesIdentity(readable, foreign), false);
    }
    const runtimeSuffix = readable.windowName.match(/([0-9a-f]{8})$/)[1];
    for (const locator of [
        { ...readable, windowName: `codex-bad:name-${runtimeSuffix}` },
        { ...readable, windowName: `codex-bad--name-${runtimeSuffix}` },
        { ...readable, windowName: `codex-bad\u0000name-${runtimeSuffix}` },
        { ...readable, sessionName: `ps-bad:name-${workspaceSuffix}` },
        { ...readable, layout: 'other' },
    ]) {
        assert.equal(tmuxLocatorMatchesIdentity(locator, current), false);
    }
});

test('RUNTIME-TMUX-NAMING-001 bounds names by Unicode code points', () => {
    const current = identity();
    const boundary = buildReadableTmuxLocator(current, 'session', {
        projectName: 'p'.repeat(41),
        sessionName: 's'.repeat(41),
    });
    assert.equal(Array.from(boundary.sessionName).length, 95);

    const astral = buildReadableTmuxLocator(current, 'session', {
        projectName: '𐐀'.repeat(100),
        sessionName: '𐐀'.repeat(100),
    });
    assert.equal(Array.from(astral.sessionName).length, 96);
    assert.equal(Array.from(astral.windowName).length, 96);
    assert.match(astral.sessionName, /^ps-𐐀+-𐐀+-[0-9a-f]{8}$/u);
    assert.equal(tmuxLocatorMatchesIdentity(astral, current), true);
});
