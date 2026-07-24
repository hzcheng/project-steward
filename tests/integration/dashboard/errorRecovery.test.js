'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDashboardMessageRouter } = require('../../../out/dashboard/messageRouter');
const { getErrorContent } = require('../../../out/dashboard/errorContent');
const { DashboardLifecycleController } = require('../../../out/dashboard/lifecycleController');
const { DashboardStartupController } = require('../../../out/dashboard/startupController');
const { SidebarStewardViewProvider } = require('../../../out/dashboard/viewProvider');
const { TmuxRuntimeDiscovery } = require('../../../out/aiSessions/tmuxRuntimeDiscovery');
const {
    createSyntheticTmuxStore,
    makeTmuxDiscoveryRow,
} = require('../../helpers/runtimeContract');
const {
    OpenWorkspaceCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceCoordinator');
const {
    createSyntheticOpenWorkspaceStore,
    makePublication,
} = require('../../contract/openProjects/helpers');

function makeConfigurationEvent(...sections) {
    return {
        affectsConfiguration(candidate) {
            return sections.some(section => (
                section === candidate || section.startsWith(`${candidate}.`)
            ));
        },
    };
}

function makeStartupController(migrateDataIfNeeded, events) {
    return new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded,
        refreshDashboard: async () => events.push('refresh'),
        publishOpenWorkspace: () => events.push('publish'),
        showInformationMessage: () => events.push('information'),
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error]),
        showSteward: () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'fixture',
        getVisibleEditorLanguageIds: () => [],
    });
}

test('ERROR-ERROR-CONTENT-001 escapes hostile render failures and never emits executable HTML', () => {
    const raw = '<script>steal("credential")</script>';
    const html = getErrorContent(new Error(raw));
    assert.match(html, /Project Steward could not render this view/);
    assert.equal(html.includes(raw), false);
    assert.match(html, /&lt;script&gt;steal\(&quot;credential&quot;\)&lt;\/script&gt;/);
});

test('SESSION-SIDEBAR-STEWARD-VIEW-PROVIDER-ORDERING-001 keeps view and message failures generic', async () => {
    const logs = [];
    let receiveMessage;
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage(callback) {
                receiveMessage = callback;
                return { dispose() {} };
            },
            postMessage: async () => true,
        },
        onDidChangeVisibility() {
            return { dispose() {} };
        },
    };
    const provider = new SidebarStewardViewProvider({
        getWebviewOptions: () => ({ enableScripts: true }),
        renderContent: () => { throw new Error('private render credential'); },
        renderError: getErrorContent,
        onMessage: async () => { throw new Error('private message credential'); },
        onVisibleChanged: async () => undefined,
        logError: (message, error) => logs.push([message, error]),
    });

    await provider.resolveWebviewView(view, {}, {});
    await receiveMessage({ type: 'private-message' });

    assert.match(view.webview.html, /Unexpected Project Steward view failure/);
    assert.equal(view.webview.html.includes('private render credential'), false);
    assert.deepEqual(logs.map(([message]) => message), [
        'Failed to render Project Steward view.',
        'Failed to handle a Project Steward message.',
    ]);
    assert.ok(logs.every(([, error]) => error.message === 'Unexpected Project Steward view failure.'));
});

test('SESSION-SIDEBAR-STEWARD-VIEW-PROVIDER-ORDERING-001 awaits visible refreshes and never renders hidden or failed state', async () => {
    const order = [];
    let visibilityChanged;
    let rejectVisibility = false;
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility(callback) {
            visibilityChanged = callback;
            return { dispose() {} };
        },
    };
    const provider = new SidebarStewardViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => { order.push('render'); return '<main>fresh</main>'; },
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async visible => {
            order.push(`visible:${visible}:start`);
            await Promise.resolve();
            if (rejectVisibility) throw new Error('private refresh failure');
            order.push(`visible:${visible}:end`);
        },
        logError: message => order.push(`log:${message}`),
    });

    await provider.resolveWebviewView(view, {}, {});
    assert.deepEqual(order, ['visible:true:start', 'visible:true:end', 'render']);
    view.visible = false;
    await visibilityChanged();
    assert.deepEqual(order.slice(-2), ['visible:false:start', 'visible:false:end']);

    view.visible = true;
    rejectVisibility = true;
    await visibilityChanged();
    assert.equal(order.filter(item => item === 'render').length, 1);
    assert.equal(view.webview.html, '<main>safe error</main>');
    assert.ok(order.includes('log:Failed to prepare Project Steward view.'));
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 ignores invalid Webview messages without mutating host state', async () => {
    const mutations = [];
    const router = createDashboardMessageRouter({
        handlers: {
            'request-projects-panel': message => mutations.push(message),
        },
        getAiSessionProviderIds: () => ['codex'],
        resumeAiSession: message => mutations.push(message),
    });

    for (const message of [null, undefined, 'message', [], {}, { type: '' }, { type: 'unknown' }]) {
        await assert.doesNotReject(router(message));
    }
    assert.deepEqual(mutations, []);
});

test('ARCH-COORDINATOR-001 retries bridge delivery after an unchanged publication fails', async t => {
    let fireWatcher;
    let resolveSecondAttempt;
    const secondAttempt = new Promise(resolve => { resolveSecondAttempt = resolve; });
    const attempts = [];
    const coordinator = new OpenWorkspaceCoordinator('/synthetic-error-recovery', {
        now: () => 1000,
        setInterval: () => 'error-recovery-interval',
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close() {} };
        },
        createStore: () => createSyntheticOpenWorkspaceStore(),
        deliverAggregate: aggregate => {
            attempts.push(aggregate);
            if (attempts.length === 1) throw new Error('bridge unavailable');
            resolveSecondAttempt();
        },
    });
    t.after(() => coordinator.dispose());

    await assert.rejects(coordinator.publish(makePublication()), /bridge unavailable/);
    fireWatcher();
    await secondAttempt;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].semanticRevision, attempts[0].semanticRevision);
});

test('RUNTIME-TMUX-DISCOVERY-001 retains a safe stopped record when a runtime resource disappears', async () => {
    let rows = [makeTmuxDiscoveryRow({ sessionId: 'disappearing' })];
    const discovery = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => rows },
        bindingStore: createSyntheticTmuxStore(),
        markerIsCurrent: () => false,
        nowMs: () => 2000,
        cacheTtlMs: 0,
    });

    await discovery.refresh(true);
    rows = [];
    await discovery.refresh(true);
    assert.deepEqual(discovery.getActive(), []);
    assert.deepEqual(discovery.getInactive().map(runtime => ({
        sessionId: runtime.identity.sessionId,
        state: runtime.state,
    })), [{ sessionId: 'disappearing', state: 'stopped' }]);
});

test('PERSIST-DASHBOARD-LIFECYCLE-CONTROLLER-001 allows a later configuration migration after one failure', async () => {
    const events = [];
    let attempts = 0;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async openAfter => {
            attempts += 1;
            events.push(['migrate', openAfter]);
            if (attempts === 1) throw new Error('migration unavailable');
        },
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
    });
    const change = makeConfigurationEvent('projectSteward.storeProjectsInSettings');

    await assert.rejects(controller.handleConfigurationChanged(change), /migration unavailable/);
    assert.deepEqual(events, [['migrate', false]]);
    await controller.handleConfigurationChanged(change);
    assert.deepEqual(events.slice(1), [
        ['migrate', false],
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);
});

test('PERSIST-DASHBOARD-LIFECYCLE-CONTROLLER-001 routes workspace, configuration, and focus changes once', async () => {
    const events = [];
    const controller = new DashboardLifecycleController({
        checkDataMigration: async openAfter => events.push(['migrate', openAfter]),
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: followsFocus => events.push(['publish', followsFocus]),
        evaluateAiSessionAttention: () => events.push('attention'),
    });

    await controller.handleConfigurationChanged(
        makeConfigurationEvent('dashboard.storeProjectsInSettings')
    );
    assert.deepEqual(events, [
        ['migrate', false],
        'color',
        ['refresh', 'configuration-changed'],
        ['publish', undefined],
    ]);
    events.length = 0;
    controller.handleWorkspaceFoldersChanged();
    controller.handleWindowStateChanged({ focused: true });
    controller.handleWindowStateChanged({ focused: false });
    assert.deepEqual(events, [
        'color',
        ['refresh', 'workspace-folders-changed'],
        ['publish', undefined],
        ['publish', true],
        'attention',
        'attention',
    ]);
});

test('TODO-COMPLETION-INCREMENTAL-001 suppresses only a local todoData configuration echo', async () => {
    const events = [];
    let localEcho = true;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => events.push('migrate'),
        reconcileProjectCatalog: async () => events.push('reconcile'),
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
        consumeTodoDataWriteEcho: () => localEcho,
    });
    const todoDataChange = makeConfigurationEvent('projectSteward.todoData');

    await controller.handleConfigurationChanged(todoDataChange);
    assert.deepEqual(events, []);

    localEcho = false;
    await controller.handleConfigurationChanged(todoDataChange);
    assert.deepEqual(events, [
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);

    events.length = 0;
    localEcho = true;
    await controller.handleConfigurationChanged(makeConfigurationEvent(
        'projectSteward.todoData',
        'projectSteward.storeProjectsInSettings',
        'projectSteward.projectSyncData',
        'projectSteward.customCss'
    ));
    assert.deepEqual(events, [
        'migrate',
        'reconcile',
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 reconciles synchronized project data before dashboard publication', async () => {
    const events = [];
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => undefined,
        reconcileProjectCatalog: async () => {
            events.push('reconcile:start');
            await Promise.resolve();
            events.push('reconcile:end');
        },
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
    });

    await controller.handleConfigurationChanged(
        makeConfigurationEvent('projectSteward.projectSyncData')
    );

    assert.deepEqual(events, [
        'reconcile:start',
        'reconcile:end',
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);
});

test('PROJECT-INCREMENTAL-REFRESH-001 suppresses local catalog echoes and routes external catalog changes partially', async () => {
    const events = [];
    let localEcho = true;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => events.push('migrate'),
        reconcileProjectCatalog: async () => events.push('reconcile'),
        consumeProjectCatalogWriteEcho: change => {
            events.push(['consume', change]);
            return localEcho;
        },
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        refreshProjects: reason => events.push(['projects', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
    });
    const catalogChange = makeConfigurationEvent(
        'projectSteward.projectSyncData',
        'projectSteward.projectData'
    );

    await controller.handleConfigurationChanged(catalogChange);
    assert.deepEqual(events, [[
        'consume',
        { syncData: true, legacyGroups: true },
    ]]);

    events.length = 0;
    localEcho = false;
    await controller.handleConfigurationChanged(catalogChange);
    assert.deepEqual(events, [
        ['consume', { syncData: true, legacyGroups: true }],
        'reconcile',
        ['projects', 'configuration-changed'],
        'color',
        'publish',
    ]);

    events.length = 0;
    await controller.handleConfigurationChanged(makeConfigurationEvent(
        'projectSteward.projectSyncData',
        'projectSteward.customCss'
    ));
    assert.deepEqual(events, [
        ['consume', { syncData: true, legacyGroups: false }],
        'reconcile',
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);
});

test('WEBVIEW-DASHBOARD-STARTUP-CONTROLLER-001 retries a failed migration without stale refresh or publication', async () => {
    const events = [];
    let attempt = 0;
    const controller = makeStartupController(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('destination unavailable');
        return { projects: { migrated: true }, todos: { migrated: false } };
    }, events);

    await controller.checkDataMigration();
    assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), ['log', 'error']);
    await controller.checkDataMigration();
    assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), [
        'log', 'error', 'refresh', 'publish', 'information',
    ]);
});
