'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
    SELF,
    OTHER,
    createCommandRegistry,
    createFakeClock,
    createSyntheticOpenWorkspaceStore,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makeRecord,
    makeRegistration,
} = require('../../contract/openProjects/helpers');
const { projectOpenWorkspaceCards } = require('../../../out/openWorkspaces/projection');
const { OpenWorkspaceCoordinator } = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceCoordinator');

const OpenWorkspaceBridgeClient = loadWithFakeVscode(
    '../../../out/openWorkspaces/bridgeClient'
).default;

const repositoryRoot = path.join(__dirname, '..', '..', '..');
const projectWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewProjectScripts.js'
), 'utf8');
const filterWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewFilterScripts.js'
), 'utf8');

function hasClassTokens(value, ...tokens) {
    return tokens.every(token => value.split(/\s+/).includes(token));
}

function createClassList() {
    const values = new Set();
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        contains: value => values.has(value),
        toggle(value, force) {
            if (force === undefined ? !values.has(value) : force) values.add(value);
            else values.delete(value);
            return values.has(value);
        },
    };
}

function createOpenWorkspaceUpdateVm(wrapper, catalogs) {
    const document = {
        activeElement: null,
        body: {
            classList: createClassList(),
            style: { setProperty: () => undefined },
        },
        querySelector: selector => {
            if (selector === '.sticky-groups-wrapper') return wrapper;
            if (selector === '.sticky-groups-wrapper .open-other-windows-group[data-other-windows-status]'
                && wrapper.innerHTML.includes('data-other-windows-status="ready"')) {
                return { getAttribute: () => 'ready' };
            }
            return null;
        },
        querySelectorAll: selector => {
            const projectTags = Array.from(wrapper.innerHTML.matchAll(/<div class="([^"]*)"[^>]*data-id=[^>]*>/g))
                .filter(match => hasClassTokens(match[1], 'project', 'steward-item-card'))
                .map(match => match[0]);
            if (selector === '.sticky-groups-wrapper .workspace-card[data-current-workspace][data-workspace-scope-identity]') {
                return projectTags.filter(tag => tag.includes('data-current-workspace')
                    && tag.includes('data-workspace-scope-identity')).map(() => ({}));
            }
            if (selector === '.sticky-groups-wrapper .workspace-card[data-other-workspace][data-workspace-navigation-identity]') {
                return projectTags.filter(tag => tag.includes('data-other-workspace')
                    && tag.includes('data-workspace-navigation-identity')).map(tag => ({
                        getAttribute(name) {
                            const match = tag.match(new RegExp(`${name}="([^"]*)"`));
                            return match ? match[1] : null;
                        },
                    }));
            }
            if (selector === '.sticky-groups-wrapper .open-other-windows-group') {
                return wrapper.innerHTML.includes('open-other-windows-group') ? [{}] : [];
            }
            return [];
        },
    };
    const context = {
        document,
        normalizeDashboardSearchCatalog: value => value
            && value.version === 2
            && Array.isArray(value.sessions)
            && Array.isArray(value.openWorkspaces)
            && Array.isArray(value.savedProjects)
            && Array.isArray(value.todos)
            ? value
            : { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] },
        window: {
            __projectStewardDashboard: {
                replaceSearchCatalog: catalog => catalogs.push(catalog),
            },
        },
    };
    vm.runInNewContext(projectWebviewSource, context, {
        filename: 'webviewProjectScripts.js',
    });
    return context;
}

function createFilterVm(input) {
    const context = {
        document: {
            body: { classList: createClassList() },
            getElementById: id => id === 'filter' ? input : { addEventListener: () => undefined },
            querySelectorAll: () => [],
        },
        requestAnimationFrame: callback => callback(),
        sessionStorage: {
            getItem: () => '',
            setItem: () => undefined,
        },
        window: {
            addEventListener: () => undefined,
        },
    };
    vm.runInNewContext(filterWebviewSource, context, {
        filename: 'webviewFilterScripts.js',
    });
    return context;
}

test('ARCH-COORDINATOR-WIRING-001 carries sequenced publications through the bridge into dashboard cards', async t => {
    const clock = createFakeClock(1000);
    const commands = createCommandRegistry();
    const store = createSyntheticOpenWorkspaceStore();
    const aggregates = [];
    let fireWatcher;
    const coordinator = new OpenWorkspaceCoordinator('/synthetic-open-project-root', {
        now: () => clock.nowMs,
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        createStore: () => store,
        deliverAggregate: aggregate => commands.execute(
            '_projectStewardOpenWorkspaces.workspace.aggregate',
            aggregate
        ),
    });
    commands.register('_projectStewardOpenWorkspaces.bridge.publish', raw => coordinator.publish(raw));
    commands.register('_projectStewardOpenWorkspaces.bridge.unregister', raw => coordinator.unregister(raw));
    commands.register('_projectStewardOpenWorkspaces.bridge.handshake', () => ({
        accepted: true,
        protocolVersion: 3,
        bridgeExtensionVersion: '0.1.4',
        capabilities: { workspaces: true, atomicReplace: true, focusLeases: true },
    }));

    const client = new OpenWorkspaceBridgeClient(
        makeRecord({ name: 'Current', uri: '/work/current' }),
        aggregate => aggregates.push(aggregate),
        error => { throw error; },
        {
            instanceId: SELF,
            now: () => clock.nowMs,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: clock.setInterval,
            clearInterval: clock.clearInterval,
        }
    );
    t.after(() => coordinator.dispose());
    await flushAsync();

    clock.advanceBy(1000);
    await client.publish(makeRecord({ name: 'Current', uri: '/work/current' }), true);
    store.seed(makeRegistration(OTHER, 1500, 'vscode-remote://ssh-remote+host/work/shared'));
    fireWatcher();
    await flushAsync();

    const publications = commands.calls.filter(call =>
        call.command === '_projectStewardOpenWorkspaces.bridge.publish'
    );
    assert.deepEqual(publications.map(call => call.argument.sequence), [1, 2]);
    assert.equal(publications[1].argument.followsFocusEvent, true);
    assert.equal(aggregates.at(-1).registrations[0].lastFocusedAtMs, 2000);

    const cards = projectOpenWorkspaceCards(
        makeRecord({ name: 'Current', uri: '/work/current' }),
        aggregates.at(-1),
        SELF
    );
    assert.deepEqual(cards.map(card => card.name), ['Shared']);
    assert.equal(cards[0].kind, 'navigation');
});

test('OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001 excludes the current card and deduplicates peer windows by focus order', () => {
    const remoteUri = 'vscode-remote://dev-container%2Btarget/work/shared';
    const aggregate = makeAggregate([
        makeRegistration('2'.repeat(32), 2000, remoteUri),
        makeRegistration(OTHER, 3000, remoteUri),
        makeRegistration(SELF, 4000, '/work/current'),
    ]);

    const cards = projectOpenWorkspaceCards(
        makeRecord({ name: 'Current', uri: '/work/current' }),
        aggregate,
        SELF
    );

    assert.deepEqual(cards.map(card => card.name), ['Shared']);
    assert.equal(cards[0].kind, 'navigation');
    assert.equal(cards[0].navigationIdentity, makeRecord({ uri: remoteUri }).navigationIdentity);
});

test('OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001 applies consistent updates and rolls back DOM that loses peer cards', () => {
    const wrapper = { innerHTML: '<div>old</div>' };
    const catalogs = [];
    const context = createOpenWorkspaceUpdateVm(wrapper, catalogs);
    assert.equal(typeof context.applyOpenWorkspacesUpdate, 'function');
    const catalog = {
        version: 2,
        sessions: [],
        openWorkspaces: [
            { workspaceId: 'current', action: 'show-current-workspace' },
            { workspaceId: 'other-a', action: 'switch-open-workspace' },
            { workspaceId: 'other-b', action: 'switch-open-workspace' },
        ],
        savedProjects: [],
        todos: [{ todoId: 'preserved' }],
    };
    const validHtml = [
        '<div class="group open-current-workspace-group"><div class="workspace-card project steward-item-card" data-id="current" data-current-workspace data-workspace-scope-identity="scope"></div></div>',
        '<div class="group open-other-windows-group" data-other-windows-status="ready">',
        '<div class="workspace-card project steward-item-card" data-id="other-a" data-other-workspace data-workspace-navigation-identity="navigation-a"></div>',
        '<div class="workspace-card project steward-item-card" data-id="other-b" data-other-workspace data-workspace-navigation-identity="navigation-b"></div>',
        '</div>',
    ].join('');

    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'valid',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: validHtml,
        searchCatalog: catalog,
    }), true);
    assert.equal(catalogs[0].todos[0].todoId, 'preserved');

    const attentionHtml = validHtml.replace(
        'data-id="other-a"',
        'data-id="other-a" data-attention-count="1"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'attention-only',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: attentionHtml,
        searchCatalog: catalog,
    }), true);

    const runningHtml = attentionHtml.replace(
        'data-id="other-b"',
        'data-id="other-b" data-running-session-count="2"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'running-only',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: runningHtml,
        searchCatalog: catalog,
    }), true);
    assert.equal(catalogs.length, 3);
    assert.ok(catalogs.every(value => value.todos[0].todoId === 'preserved'));

    const duplicateIdentityHtml = runningHtml.replace(
        'data-workspace-navigation-identity="navigation-b"',
        'data-workspace-navigation-identity="navigation-a"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'duplicate-navigation',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: duplicateIdentityHtml,
        searchCatalog: catalog,
    }), false);
    assert.equal(wrapper.innerHTML, runningHtml);

    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'lost-peer',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: '<div class="workspace-card project steward-item-card" data-id="current" data-current-workspace data-workspace-scope-identity="scope"></div>',
        searchCatalog: catalog,
    }), false);
    assert.equal(wrapper.innerHTML, runningHtml);
});

test('WEBVIEW-WEBVIEW-REFRESH-FOCUS-001 focuses active search on initialization without blurring editor focus', () => {
    const calls = [];
    const input = {
        value: '',
        parentElement: { classList: createClassList() },
        focus: () => calls.push('focus'),
        blur: () => calls.push('blur'),
        select: () => calls.push('select'),
        addEventListener: () => undefined,
    };
    const context = createFilterVm(input);
    assert.equal(typeof context.initFiltering, 'function');

    context.initFiltering(true, {
        isSearchActive: () => false,
        setSearchQuery: () => undefined,
    });

    assert.deepEqual(calls, ['focus', 'select']);
});
