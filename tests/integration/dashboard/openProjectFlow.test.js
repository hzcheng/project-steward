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
    createSyntheticOpenProjectStore,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makeRecord,
    makeRegistration,
} = require('../../contract/openProjects/helpers');
const { projectOpenProjectCards } = require('../../../out/openProjects/projection');
const { OpenProjectCoordinator } = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectCoordinator');

const OpenProjectBridgeClient = loadWithFakeVscode(
    '../../../out/openProjects/bridgeClient'
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

function createOpenProjectUpdateVm(wrapper, catalogs) {
    const document = {
        activeElement: null,
        body: {
            classList: createClassList(),
            style: { setProperty: () => undefined },
        },
        querySelector: selector => selector === '.sticky-groups-wrapper' ? wrapper : null,
        querySelectorAll: selector => {
            const projectTags = Array.from(wrapper.innerHTML.matchAll(/<div class="([^"]*)"[^>]*data-id=[^>]*>/g))
                .filter(match => hasClassTokens(match[1], 'project', 'steward-item-card'))
                .map(match => match[0]);
            if (selector === '.sticky-groups-wrapper .project[data-id]') {
                return projectTags.map(() => ({}));
            }
            if (selector === '.sticky-groups-wrapper .project[data-project-navigation][data-id]') {
                return projectTags.filter(tag => tag.includes('data-project-navigation')).map(() => ({}));
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
            && Array.isArray(value.sessions)
            && Array.isArray(value.openProjects)
            && Array.isArray(value.savedProjects)
            && Array.isArray(value.todos)
            ? value
            : { sessions: [], openProjects: [], savedProjects: [], todos: [] },
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
    const store = createSyntheticOpenProjectStore();
    const aggregates = [];
    let fireWatcher;
    const coordinator = new OpenProjectCoordinator('/synthetic-open-project-root', {
        now: () => clock.nowMs,
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        createStore: () => store,
        deliverAggregate: aggregate => commands.execute(
            '_projectStewardOpenProjects.workspace.aggregate',
            aggregate
        ),
    });
    commands.register('_projectStewardOpenProjects.bridge.publish', raw => coordinator.publish(raw));
    commands.register('_projectStewardOpenProjects.bridge.unregister', raw => coordinator.unregister(raw));

    const client = new OpenProjectBridgeClient(
        [makeRecord({ name: 'Current', uri: '/work/current' })],
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
    await client.publish([makeRecord({ name: 'Current', uri: '/work/current' })], true);
    store.seed(makeRegistration(OTHER, 1500, 'vscode-remote://ssh-remote+host/work/shared'));
    fireWatcher();
    await flushAsync();

    const publications = commands.calls.filter(call =>
        call.command === '_projectStewardOpenProjects.bridge.publish'
    );
    assert.deepEqual(publications.map(call => call.argument.sequence), [1, 2]);
    assert.equal(publications[1].argument.followsFocusEvent, true);
    assert.equal(aggregates.at(-1).registrations[0].lastFocusedAtMs, 2000);

    const cards = projectOpenProjectCards([{
        id: '__openProjects-0',
        name: 'Current',
        description: 'Workspace folder',
        path: '/work/current',
    }], aggregates.at(-1), SELF);
    assert.deepEqual(cards.map(card => card.name), ['Current', 'Shared']);
    assert.equal(cards[1].path, 'vscode-remote://ssh-remote+host/work/shared');
});

test('OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001 excludes the current card and deduplicates peer windows by focus order', () => {
    const remoteUri = 'vscode-remote://dev-container%2Btarget/work/shared';
    const aggregate = makeAggregate([
        makeRegistration('2'.repeat(32), 2000, remoteUri),
        makeRegistration(OTHER, 3000, remoteUri),
        makeRegistration(SELF, 4000, '/work/current'),
    ]);

    const cards = projectOpenProjectCards([{
        id: '__openProjects-0',
        name: 'Current',
        description: 'Workspace folder',
        path: '/work/current/',
    }], aggregate, SELF);

    assert.deepEqual(cards.map(card => card.name), ['Current', 'Shared']);
    assert.equal(cards[1].openProjectSourceInstanceId, OTHER);
    assert.equal(cards[1].path, remoteUri);
});

test('OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001 applies consistent updates and rolls back DOM that loses peer cards', () => {
    const wrapper = { innerHTML: '<div>old</div>' };
    const catalogs = [];
    const context = createOpenProjectUpdateVm(wrapper, catalogs);
    assert.equal(typeof context.applyOpenProjectsUpdate, 'function');
    const catalog = {
        sessions: [],
        openProjects: [
            { projectId: 'current', action: 'open-current' },
            { projectId: 'other', action: 'switch-open' },
        ],
        savedProjects: [],
        todos: [{ todoId: 'preserved' }],
    };
    const validHtml = [
        '<div class="group open-current-workspace-group"><div class="project steward-item-card" data-id="current"></div></div>',
        '<div class="group open-other-windows-group"><div class="project steward-item-card" data-project-navigation data-id="other"></div></div>',
    ].join('');

    assert.equal(context.applyOpenProjectsUpdate({
        type: 'open-projects-updated',
        version: 1,
        semanticRevision: 'valid',
        projectCount: 2,
        html: validHtml,
        searchCatalog: catalog,
    }), true);
    assert.equal(catalogs[0].todos[0].todoId, 'preserved');

    assert.equal(context.applyOpenProjectsUpdate({
        type: 'open-projects-updated',
        version: 1,
        semanticRevision: 'lost-peer',
        projectCount: 2,
        html: '<div class="project steward-item-card" data-id="current"></div>',
        searchCatalog: catalog,
    }), false);
    assert.equal(wrapper.innerHTML, validHtml);
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
