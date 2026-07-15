'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {};
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const protocol = require('../out/openProjects/protocol');
const projection = require('../out/openProjects/projection');
const models = require('../out/models');
const { OpenProjectStore } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectStore');
const { OpenProjectCoordinator } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectCoordinator');
Module._load = originalModuleLoad;

const SELF = '1'.repeat(32);
const OLDER = '2'.repeat(32);
const NEWER = '3'.repeat(32);
const OTHER = '4'.repeat(32);

function makeRecord(overrides = {}) {
    return {
        localProjectId: '__openProjects-0',
        ordinal: 0,
        name: 'Shared',
        description: 'Workspace folder',
        uri: '/work/shared',
        remoteType: 'local',
        color: '#222',
        ...overrides,
    };
}

function makePublication(overrides = {}) {
    return {
        protocolVersion: 1,
        instanceId: SELF,
        sequence: 1,
        followsFocusEvent: false,
        projects: [makeRecord()],
        ...overrides,
    };
}

function makeRegistration(instanceId = SELF, lastFocusedAtMs = 4000, uri = '/work/shared', overrides = {}) {
    return {
        protocolVersion: 1,
        instanceId,
        sequence: 1,
        lastFocusedAtMs,
        leaseUpdatedAtMs: 4500,
        projects: [makeRecord({ uri })],
        ...overrides,
    };
}

function makeAggregate(registrations, overrides = {}) {
    return {
        protocolVersion: 1,
        semanticRevision: 'revision',
        observedAtMs: 5000,
        registrations,
        ...overrides,
    };
}

function assertRejectsValidation(callback, pattern) {
    assert.throws(callback, pattern);
}

function runProtocolChecks() {
    const publication = makePublication();
    const registration = makeRegistration();
    const aggregate = makeAggregate([registration]);

    assert.deepStrictEqual(protocol.validateOpenProjectPublication(publication), publication);
    assert.deepStrictEqual(protocol.validateOpenProjectRegistration(registration), registration);
    assert.deepStrictEqual(protocol.validateOpenProjectAggregate(aggregate), aggregate);

    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({ ...publication, unexpected: true }),
        /unexpected fields/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [{ ...publication.projects[0], unexpected: true }],
        }),
        /unexpected fields/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectRegistration({ ...registration, unexpected: true }),
        /unexpected fields/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({ ...aggregate, unexpected: true }),
        /unexpected fields/
    );

    for (const instanceId of ['short', 'A'.repeat(32), 'g'.repeat(32), `${SELF}0`]) {
        assertRejectsValidation(
            () => protocol.validateOpenProjectPublication({ ...publication, instanceId }),
            /instanceId/
        );
    }
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({ ...publication, projects: Array(101).fill(makeRecord()) }),
        /projects/
    );
    const sparseProjects = [makeRecord()];
    sparseProjects.length = 2;
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({ ...publication, projects: sparseProjects }),
        /open project record/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [makeRecord({ remoteType: 'codespaces' })],
        }),
        /remoteType/
    );
    for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assertRejectsValidation(
            () => protocol.validateOpenProjectPublication({ ...publication, sequence }),
            /sequence/
        );
    }
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [makeRecord({ ordinal: Number.MAX_SAFE_INTEGER + 1 })],
        }),
        /ordinal/
    );
    for (const timestamp of [NaN, Infinity, -Infinity]) {
        assertRejectsValidation(
            () => protocol.validateOpenProjectRegistration({ ...registration, lastFocusedAtMs: timestamp }),
            /lastFocusedAtMs/
        );
        assertRejectsValidation(
            () => protocol.validateOpenProjectAggregate({ ...aggregate, observedAtMs: timestamp }),
            /observedAtMs/
        );
    }
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({ ...publication, instanceId: '' }),
        /instanceId/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [makeRecord({ name: '' })],
        }),
        /name/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [makeRecord({ uri: 'x'.repeat(8193) })],
        }),
        /uri/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate(null),
        /aggregate/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({ ...aggregate, registrations: {} }),
        /registrations/
    );
    const sparseRegistrations = [registration];
    sparseRegistrations.length = 2;
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({ ...aggregate, registrations: sparseRegistrations }),
        /open project registration/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({ ...aggregate, semanticRevision: '' }),
        /semanticRevision/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({
            ...aggregate,
            registrations: [registration, { ...registration, sequence: registration.sequence + 1 }],
        }),
        /duplicate instanceId/
    );

    const baseRevision = protocol.createOpenProjectSemanticRevision([registration]);
    assert.strictEqual(
        protocol.createOpenProjectSemanticRevision([{ ...registration, sequence: 99, leaseUpdatedAtMs: 9999 }]),
        baseRevision
    );
    assert.notStrictEqual(
        protocol.createOpenProjectSemanticRevision([{ ...registration, lastFocusedAtMs: registration.lastFocusedAtMs + 1 }]),
        baseRevision
    );
    assert.notStrictEqual(
        protocol.createOpenProjectSemanticRevision([{
            ...registration,
            projects: [{ ...registration.projects[0], name: 'Changed' }],
        }]),
        baseRevision
    );
    assert.strictEqual(
        protocol.createOpenProjectSemanticRevision([
            makeRegistration(OLDER, 2000),
            makeRegistration(NEWER, 3000),
        ]),
        protocol.createOpenProjectSemanticRevision([
            makeRegistration(NEWER, 3000),
            makeRegistration(OLDER, 2000),
        ])
    );
    const tiedProjectAlpha = makeRecord({
        name: 'Alpha',
        description: 'First',
        remoteType: 'ssh',
        color: '#111',
    });
    const tiedProjectBeta = makeRecord({
        name: 'Beta',
        description: 'Second',
        remoteType: 'remote',
        color: '#222',
    });
    assert.strictEqual(
        protocol.createOpenProjectSemanticRevision([makeRegistration(SELF, 4000, '/work/shared', {
            projects: [tiedProjectAlpha, tiedProjectBeta],
        })]),
        protocol.createOpenProjectSemanticRevision([makeRegistration(SELF, 4000, '/work/shared', {
            projects: [tiedProjectBeta, tiedProjectAlpha],
        })])
    );
}

function runIdentityChecks() {
    assert.strictEqual(projection.normalizeOpenProjectIdentity('/work/shared/'), '/work/shared');
    assert.strictEqual(projection.normalizeOpenProjectIdentity('C:\\work\\shared\\'), 'C:/work/shared');
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('/work/project '),
        projection.normalizeOpenProjectIdentity('/work/project')
    );
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('/work/a\\b'),
        projection.normalizeOpenProjectIdentity('/work/a/b')
    );
    assert.strictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared/'),
        'vscode-remote://ssh-remote+one/work/shared'
    );
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared'),
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/other')
    );
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared'),
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+two/work/shared')
    );
    assert.strictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote%2Bone/work/shared'),
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared')
    );
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://authority%2Fsegment/work/shared'),
        projection.normalizeOpenProjectIdentity('vscode-remote://authority/segment/work/shared')
    );
}

function runRecordChecks() {
    const records = projection.createOpenProjectRecords([
        { id: 'local', name: 'Local', description: 'Folder', path: '/local', remoteType: models.ProjectRemoteType.None, color: '#111' },
        { id: 'ssh', name: 'SSH', description: 'Folder', path: 'vscode-remote://ssh-remote+host/ssh', remoteType: models.ProjectRemoteType.SSH },
        { id: 'wsl', name: 'WSL', description: 'Folder', path: 'vscode-remote://wsl+Ubuntu/wsl', remoteType: models.ProjectRemoteType.WSL },
        { id: 'container', name: 'Container', description: 'Folder', path: 'vscode-remote://dev-container+abc/container', remoteType: models.ProjectRemoteType.DevContainer },
        { id: 'remote', name: 'Remote', description: 'Folder', path: 'vscode-remote://tunnel+host/remote', remoteType: models.ProjectRemoteType.Remote },
    ]);

    assert.deepStrictEqual(records.map(record => record.remoteType), ['local', 'ssh', 'wsl', 'devContainer', 'remote']);
    assert.deepStrictEqual(records.map(record => record.ordinal), [0, 1, 2, 3, 4]);
    assert.strictEqual(records[0].color, '#111');
    assert.strictEqual(records[1].color, undefined);
}

function runProjectionChecks() {
    const current = [{
        id: '__openProjects-0', name: 'Current', description: 'Workspace folder',
        path: '/work/current', color: '#111', openProjectCardKind: 'current',
        codexSessions: [{ id: 'current-session', name: 'Current Session' }],
    }];
    const aggregate = makeAggregate([
        makeRegistration(SELF, 4000, '/work/current'),
        makeRegistration(OLDER, 2000, '/work/shared/'),
        makeRegistration(NEWER, 3000, '/work/shared'),
    ]);
    const cards = projection.projectOpenProjectCards(current, aggregate, SELF);
    assert.deepStrictEqual(cards.map(card => card.name), ['Current', 'Shared']);
    assert.strictEqual(cards[0].openProjectCardKind, 'current');
    assert.strictEqual(cards[0].codexSessions[0].id, 'current-session');
    assert.notStrictEqual(cards[0], current[0]);
    assert.strictEqual(cards[1].openProjectCardKind, 'projectNavigation');
    assert.strictEqual(cards[1].openProjectSourceInstanceId, NEWER);
    assert.strictEqual(cards[1].codexSessions, undefined);
    assert.strictEqual(cards[1].path, '/work/shared');
    assert.match(cards[1].id, /^__openProjectNavigation-[a-f0-9]{24}$/);

    const currentRemote = [{
        id: '__openProjects-0',
        name: 'Current Remote',
        description: 'Workspace folder',
        path: 'vscode-remote://ssh-remote+one/work/shared/',
    }];
    const remoteCards = projection.projectOpenProjectCards(currentRemote, makeAggregate([
        makeRegistration(OLDER, 2000, 'vscode-remote://ssh-remote+one/work/shared'),
        makeRegistration(NEWER, 3000, 'vscode-remote://ssh-remote+two/work/shared'),
    ]), SELF);
    assert.deepStrictEqual(remoteCards.map(card => card.name), ['Current Remote', 'Shared']);
    assert.strictEqual(remoteCards[1].path, 'vscode-remote://ssh-remote+two/work/shared');

    const ordered = projection.projectOpenProjectCards([], makeAggregate([
        makeRegistration(OLDER, 2000, '/work/zulu', {
            projects: [makeRecord({ ordinal: 1, name: 'Zulu', uri: '/work/zulu' })],
        }),
        makeRegistration(NEWER, 3000, '/work/bravo', {
            projects: [
                makeRecord({ ordinal: 2, name: 'Charlie', uri: '/work/charlie' }),
                makeRecord({ ordinal: 1, name: 'Bravo', uri: '/work/bravo' }),
                makeRecord({ ordinal: 1, name: 'Alpha', uri: '/work/alpha' }),
            ],
        }),
    ]), SELF);
    assert.deepStrictEqual(ordered.map(card => card.name), ['Alpha', 'Bravo', 'Charlie', 'Zulu']);

    const dirtyRecord = makeRecord({
        uri: 'vscode-remote://dev-container+abc/work/app/',
        remoteType: 'devContainer',
    });
    const dirtyRegistration = makeRegistration(OTHER, 1000, dirtyRecord.uri, { projects: [dirtyRecord] });
    const dirtyCards = projection.projectOpenProjectCards([], makeAggregate([dirtyRegistration]), SELF);
    const dirtyCard = dirtyCards[0];
    assert.strictEqual(dirtyCard.remoteType, models.ProjectRemoteType.DevContainer);
    assert.strictEqual(dirtyCard.openProjectEnvironmentLabel, 'Dev Container');
    for (const field of [
        'attentionProjectPath',
        'favorite',
        'favoriteOrder',
        'showSaveAction',
        'isCurrentWorkspace',
        'codexSessions',
        'kimiSessions',
        'claudeSessions',
        'codexSessionsExpanded',
        'codexSessionsUnavailable',
        'kimiSessionsUnavailable',
        'claudeSessionsUnavailable',
        'activeAiSessionProvider',
        'aiSessionAttentionCount',
        'aiSessionAttentionEventIds',
        'isGitRepo',
    ]) {
        assert.strictEqual(dirtyCard[field], undefined, `${field} leaked into a navigation card`);
    }

    assert.deepStrictEqual(
        projection.projectOpenProjectCards(current, null, SELF).map(card => card.name),
        ['Current']
    );

    const duplicateAlpha = makeRegistration(OLDER, 2000, '/work/duplicate', {
        projects: [makeRecord({ name: 'Alpha', uri: '/work/duplicate' })],
    });
    const duplicateBeta = makeRegistration(OLDER, 2000, '/work/duplicate', {
        projects: [makeRecord({ name: 'Beta', uri: '/work/duplicate' })],
    });
    const duplicateForward = projection.projectOpenProjectCards(
        [],
        makeAggregate([duplicateAlpha, duplicateBeta]),
        SELF
    );
    const duplicateReverse = projection.projectOpenProjectCards(
        [],
        makeAggregate([duplicateBeta, duplicateAlpha]),
        SELF
    );
    assert.deepStrictEqual(duplicateForward.map(card => card.name), ['Alpha']);
    assert.deepStrictEqual(duplicateReverse, duplicateForward);
}

async function runStoreChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-projects-'));
    const ownInstanceId = 'b'.repeat(32);
    const instancesDirectory = path.join(tempRoot, 'open-projects', 'v1', 'instances');
    const registration = makeRegistration(ownInstanceId, 900, '/work/owned', {
        sequence: 1,
        leaseUpdatedAtMs: 1000,
    });
    const filePath = path.join(instancesDirectory, `${ownInstanceId}.json`);
    const writeRegistration = async (instanceId, value) => {
        await fs.promises.writeFile(path.join(instancesDirectory, `${instanceId}.json`), `${JSON.stringify(value)}\n`);
    };

    try {
        const oversizedWriteRoot = path.join(tempRoot, 'oversized-write');
        const oversizedWriteStore = new OpenProjectStore(oversizedWriteRoot, ownInstanceId);
        const oversizedWrite = {
            ...registration,
            projects: Array.from({ length: 100 }, (_, ordinal) => makeRecord({
                localProjectId: `oversized-${ordinal}`,
                ordinal,
                description: 'x'.repeat(4000),
                uri: `/work/oversized/${ordinal}`,
            })),
        };
        assert.ok(Buffer.byteLength(`${JSON.stringify(oversizedWrite)}\n`, 'utf8') > 256 * 1024);
        await assert.rejects(oversizedWriteStore.write(oversizedWrite), /256 KiB/);
        assert.deepStrictEqual((await oversizedWriteStore.scan(1200)).registrations, []);
        await assert.rejects(
            fs.promises.access(path.join(oversizedWriteRoot, 'open-projects', 'v1', 'instances')),
            /ENOENT/
        );

        const concurrentRoot = path.join(tempRoot, 'concurrent');
        const concurrentStore = new OpenProjectStore(concurrentRoot, ownInstanceId);
        const originalRename = fs.promises.rename;
        let releaseLowerRename;
        let lowerRenameReachedResolve;
        const lowerRenameReached = new Promise(resolve => {
            lowerRenameReachedResolve = resolve;
        });
        fs.promises.rename = async (source, destination) => {
            const pending = JSON.parse(await fs.promises.readFile(source, 'utf8'));
            if (pending.sequence === 1) {
                lowerRenameReachedResolve();
                await new Promise(resolve => {
                    const fallback = setTimeout(resolve, 100);
                    releaseLowerRename = () => {
                        clearTimeout(fallback);
                        resolve();
                    };
                });
            }
            const result = await originalRename(source, destination);
            if (pending.sequence === 2 && releaseLowerRename) {
                releaseLowerRename();
            }
            return result;
        };
        try {
            const lowerWrite = concurrentStore.write({ ...registration, sequence: 1 });
            await lowerRenameReached;
            const higherWrite = concurrentStore.write({ ...registration, sequence: 2 });
            assert.deepStrictEqual(
                (await Promise.allSettled([lowerWrite, higherWrite])).map(result => result.status),
                ['fulfilled', 'fulfilled']
            );
        } finally {
            fs.promises.rename = originalRename;
        }
        assert.strictEqual((await concurrentStore.read(ownInstanceId, 1200)).sequence, 2);

        fs.promises.rename = async (source, destination) => {
            const pending = JSON.parse(await fs.promises.readFile(source, 'utf8'));
            if (pending.sequence === 4) {
                throw new Error('forced higher write failure');
            }
            return originalRename(source, destination);
        };
        try {
            await assert.rejects(
                concurrentStore.write({ ...registration, sequence: 4 }),
                /forced higher write failure/
            );
        } finally {
            fs.promises.rename = originalRename;
        }
        await concurrentStore.write({ ...registration, sequence: 3 });
        assert.strictEqual((await concurrentStore.read(ownInstanceId, 1200)).sequence, 3);

        const removalRoot = path.join(tempRoot, 'cross-store-removal');
        const producerInstanceId = 'd'.repeat(32);
        const observerInstanceId = 'e'.repeat(32);
        const removalDirectory = path.join(removalRoot, 'open-projects', 'v1', 'instances');
        const producerRegistration = makeRegistration(producerInstanceId, 900, '/work/producer', {
            sequence: 5,
            leaseUpdatedAtMs: 1000,
        });
        const producerStore = new OpenProjectStore(removalRoot, producerInstanceId);
        const observerStore = new OpenProjectStore(removalRoot, observerInstanceId);
        await producerStore.write(producerRegistration);
        assert.deepStrictEqual((await observerStore.scan(1200)).registrations, [producerRegistration]);
        await producerStore.remove(producerInstanceId);
        assert.deepStrictEqual((await observerStore.scan(1200)).registrations, []);
        await fs.promises.writeFile(
            path.join(removalDirectory, `${producerInstanceId}.json`),
            `${JSON.stringify({ ...producerRegistration, sequence: 4, leaseUpdatedAtMs: 1200 })}\n`
        );
        const removedRollback = await observerStore.scan(1200);
        assert.deepStrictEqual(removedRollback.registrations, []);
        assert.strictEqual(removedRollback.counters.rollbackCount, 1);

        const isolationRoot = path.join(tempRoot, 'cache-isolation');
        const isolationDirectory = path.join(isolationRoot, 'open-projects', 'v1', 'instances');
        const isolationInstanceId = 'f'.repeat(32);
        const isolationPath = path.join(isolationDirectory, `${isolationInstanceId}.json`);
        const isolationRegistration = makeRegistration(isolationInstanceId, 900, '/work/isolation', {
            sequence: 10,
            leaseUpdatedAtMs: 1000,
        });
        const isolationStore = new OpenProjectStore(isolationRoot, '0'.repeat(32));
        const assertIsolatedCache = async (counter) => {
            const isolated = await isolationStore.scan(1200);
            assert.deepStrictEqual(isolated.registrations, [isolationRegistration]);
            assert.strictEqual(isolated.counters[counter], 1);
        };
        await fs.promises.mkdir(isolationDirectory, { recursive: true });
        await fs.promises.writeFile(isolationPath, `${JSON.stringify(isolationRegistration)}\n`);
        assert.deepStrictEqual((await isolationStore.scan(1200)).registrations, [isolationRegistration]);

        await fs.promises.writeFile(isolationPath, '{malformed');
        await assertIsolatedCache('parseErrors');

        await fs.promises.writeFile(isolationPath, Buffer.alloc(256 * 1024 + 1));
        await assertIsolatedCache('oversizedFiles');

        const isolationTarget = path.join(isolationRoot, 'symlink-target.json');
        await fs.promises.writeFile(isolationTarget, `${JSON.stringify(isolationRegistration)}\n`);
        await fs.promises.unlink(isolationPath);
        await fs.promises.symlink(isolationTarget, isolationPath);
        await assertIsolatedCache('symlinkFiles');

        await fs.promises.unlink(isolationPath);
        await fs.promises.mkdir(isolationPath);
        await assertIsolatedCache('readErrors');

        await fs.promises.rmdir(isolationPath);
        await fs.promises.writeFile(isolationPath, `${JSON.stringify({
            ...isolationRegistration,
            instanceId: OTHER,
        })}\n`);
        await assertIsolatedCache('parseErrors');

        await fs.promises.writeFile(isolationPath, `${JSON.stringify({
            ...isolationRegistration,
            sequence: 9,
        })}\n`);
        await assertIsolatedCache('rollbackCount');

        const highWaterRoot = path.join(tempRoot, 'high-water');
        const highWaterDirectory = path.join(highWaterRoot, 'open-projects', 'v1', 'instances');
        const highWaterInstanceId = 'c'.repeat(32);
        const highWaterPath = path.join(highWaterDirectory, `${highWaterInstanceId}.json`);
        const highWaterStore = new OpenProjectStore(highWaterRoot, ownInstanceId);
        await fs.promises.mkdir(highWaterDirectory, { recursive: true });
        await fs.promises.writeFile(highWaterPath, `${JSON.stringify(makeRegistration(
            highWaterInstanceId,
            900,
            '/work/high-water',
            { sequence: 5, leaseUpdatedAtMs: 1000 }
        ))}\n`);
        assert.deepStrictEqual((await highWaterStore.scan(1000)).registrations.map(value => value.sequence), [5]);
        assert.deepStrictEqual((await highWaterStore.scan(31_001)).registrations, []);
        await fs.promises.writeFile(highWaterPath, `${JSON.stringify(makeRegistration(
            highWaterInstanceId,
            900,
            '/work/high-water',
            { sequence: 4, leaseUpdatedAtMs: 31_001 }
        ))}\n`);
        const highWaterRollback = await highWaterStore.scan(31_001);
        assert.deepStrictEqual(highWaterRollback.registrations, []);
        assert.strictEqual(highWaterRollback.counters.rollbackCount, 1);

        const store = new OpenProjectStore(tempRoot, ownInstanceId);
        await store.write(registration);
        assert.deepStrictEqual((await store.scan(1200)).registrations, [registration]);
        await assert.rejects(
            store.write({ ...registration, sequence: registration.sequence - 1 }),
            /sequence/
        );
        assert.deepStrictEqual(await store.read(registration.instanceId, 1200), registration);
        assert.strictEqual((await fs.promises.stat(instancesDirectory)).mode & 0o777, 0o700);
        assert.strictEqual((await fs.promises.stat(filePath)).mode & 0o777, 0o600);

        const malformedId = '5'.repeat(32);
        const oversizedId = '6'.repeat(32);
        const symlinkId = '7'.repeat(32);
        const directoryId = '8'.repeat(32);
        const mismatchId = '9'.repeat(32);
        const expiredId = 'a'.repeat(32);

        await fs.promises.writeFile(path.join(instancesDirectory, `${malformedId}.json`), '{not json');
        await fs.promises.writeFile(path.join(instancesDirectory, `${oversizedId}.json`), Buffer.alloc(256 * 1024 + 1));
        await fs.promises.symlink(filePath, path.join(instancesDirectory, `${symlinkId}.json`));
        await fs.promises.mkdir(path.join(instancesDirectory, `${directoryId}.json`));
        await writeRegistration(mismatchId, makeRegistration(OTHER, 900, '/work/mismatch', {
            leaseUpdatedAtMs: 1000,
        }));
        await writeRegistration(ownInstanceId, { ...registration, sequence: 0 });
        await writeRegistration(expiredId, makeRegistration(expiredId, 800, '/work/expired', {
            leaseUpdatedAtMs: 0,
        }));

        const scan = await store.scan(31_000);
        assert.deepStrictEqual(scan.registrations, [registration]);
        assert.deepStrictEqual(scan.counters, {
            active: 1,
            parseErrors: 2,
            oversizedFiles: 1,
            symlinkFiles: 1,
            readErrors: 1,
            rollbackCount: 1,
            expired: 1,
        });
        assert.deepStrictEqual(await store.read(registration.instanceId, 31_000), registration);

        await store.remove(registration.instanceId);
        assert.deepStrictEqual((await store.scan(31_000)).registrations, []);
        assert.strictEqual(await store.read(registration.instanceId, 31_000), undefined);
    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

async function runCoordinatorChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-project-coordinator-'));
    let currentNow = 1000;
    let watcherCallback;
    let watcherClosed = false;
    let intervalCallback;
    let intervalMs;
    let clearedInterval;
    const intervalHandle = { kind: 'coordinator-interval' };
    const delivered = [];
    const coordinator = new OpenProjectCoordinator(tempRoot, {
        now: () => currentNow,
        setInterval: (callback, milliseconds) => {
            intervalCallback = callback;
            intervalMs = milliseconds;
            return intervalHandle;
        },
        clearInterval: handle => {
            clearedInterval = handle;
        },
        createWatcher: (directory, callback) => {
            assert.strictEqual(directory, path.join(tempRoot, 'open-projects', 'v1', 'instances'));
            watcherCallback = callback;
            return { close: () => { watcherClosed = true; } };
        },
        deliverAggregate: async aggregate => {
            delivered.push(aggregate);
        },
    });
    const observer = new OpenProjectStore(tempRoot, OTHER);

    try {
        assert.strictEqual(intervalMs, 5000);
        assert.strictEqual(typeof watcherCallback, 'function');
        assert.strictEqual(typeof intervalCallback, 'function');

        await assert.rejects(
            coordinator.publish({ ...makePublication(), leaseUpdatedAtMs: 1000 }),
            /unexpected fields/
        );
        assert.deepStrictEqual((await observer.scan(currentNow)).registrations, []);

        await coordinator.publish(makePublication());
        const initialHeartbeat = (await observer.scan(currentNow)).registrations[0];
        assert.strictEqual(initialHeartbeat.lastFocusedAtMs, 0);
        assert.strictEqual(initialHeartbeat.leaseUpdatedAtMs, 1000);
        assert.strictEqual(delivered.length, 1);
        assert.strictEqual(delivered[0].observedAtMs, 1000);

        currentNow = 2000;
        await coordinator.publish(makePublication({ sequence: 2, followsFocusEvent: true }));
        const firstFocus = (await observer.scan(currentNow)).registrations[0];
        assert.strictEqual(firstFocus.lastFocusedAtMs, 2000);
        assert.strictEqual(firstFocus.leaseUpdatedAtMs, 2000);
        assert.strictEqual(delivered.length, 2);

        currentNow = 3000;
        await coordinator.publish(makePublication({ sequence: 3, followsFocusEvent: false }));
        const heartbeat = (await observer.scan(currentNow)).registrations[0];
        assert.strictEqual(heartbeat.lastFocusedAtMs, 2000);
        assert.strictEqual(heartbeat.leaseUpdatedAtMs, 3000);
        assert.strictEqual(delivered.length, 2);

        await assert.rejects(
            coordinator.publish(makePublication({ instanceId: OLDER, sequence: 4 })),
            /different instanceId/
        );

        currentNow = 4000;
        await coordinator.publish(makePublication({
            sequence: 4,
            projects: [makeRecord({ name: 'Changed' })],
        }));
        assert.strictEqual(delivered.length, 3);

        currentNow = 5000;
        await coordinator.publish(makePublication({
            sequence: 5,
            followsFocusEvent: true,
            projects: [makeRecord({ name: 'Changed' })],
        }));
        assert.strictEqual(delivered.length, 4);
        assert.strictEqual(delivered[3].observedAtMs, 5000);

        currentNow = 36_001;
        await coordinator.scanAndDeliver();
        assert.strictEqual(delivered.length, 5);
        assert.deepStrictEqual(delivered[4].registrations, []);

        currentNow = 37_000;
        await coordinator.unregister({ protocolVersion: 1, instanceId: SELF });
        assert.deepStrictEqual((await observer.scan(currentNow)).registrations, []);
        await assert.rejects(
            coordinator.unregister({ protocolVersion: 1, instanceId: OLDER }),
            /different instanceId/
        );
    } finally {
        coordinator.dispose();
        assert.strictEqual(watcherClosed, true);
        assert.strictEqual(clearedInterval, intervalHandle);
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }

    let releaseFocusWrite;
    let focusWriteEnteredResolve;
    const focusWriteEntered = new Promise(resolve => { focusWriteEnteredResolve = resolve; });
    const focusWriteGate = new Promise(resolve => { releaseFocusWrite = resolve; });
    let mutationQueue = Promise.resolve();
    let persistedRegistration;
    const concurrentStore = {
        write: registration => {
            const write = mutationQueue.then(async () => {
                if (registration.sequence === 1) {
                    focusWriteEnteredResolve();
                    await focusWriteGate;
                }
                persistedRegistration = registration;
            });
            mutationQueue = write.then(() => undefined, () => undefined);
            return write;
        },
        remove: async () => { persistedRegistration = undefined; },
        scan: async () => {
            await mutationQueue;
            return {
                registrations: persistedRegistration ? [persistedRegistration] : [],
                counters: {},
            };
        },
    };
    const concurrentCoordinator = new OpenProjectCoordinator('/unused-concurrent-root', {
        now: () => 1000,
        setInterval: () => 'concurrent-interval',
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
        deliverAggregate: async () => undefined,
        createStore: () => concurrentStore,
    });
    try {
        const focusPublish = concurrentCoordinator.publish(makePublication({ followsFocusEvent: true }));
        await focusWriteEntered;
        const heartbeatPublish = concurrentCoordinator.publish(makePublication({
            sequence: 2,
            followsFocusEvent: false,
        }));
        await new Promise(resolve => setImmediate(resolve));
        releaseFocusWrite();
        await Promise.all([focusPublish, heartbeatPublish]);
        assert.strictEqual(
            persistedRegistration.lastFocusedAtMs,
            1000,
            'an overlapping heartbeat must preserve the pending focus publication timestamp'
        );
    } finally {
        concurrentCoordinator.dispose();
    }

    const eventRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-project-events-'));
    let eventNow = 1000;
    let fireWatcher;
    let fireInterval;
    let coordinatorStore;
    let scanCalls = 0;
    let blockNextScan = false;
    const scanBlocked = { promise: undefined, resolve: undefined };
    scanBlocked.promise = new Promise(resolve => { scanBlocked.resolve = resolve; });
    const eventDeliveries = [];
    const eventCoordinator = new OpenProjectCoordinator(eventRoot, {
        now: () => eventNow,
        setInterval: callback => {
            fireInterval = callback;
            return 'event-interval';
        },
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        deliverAggregate: async aggregate => {
            eventDeliveries.push(aggregate);
        },
        createStore: (rootDirectory, instanceId) => {
            coordinatorStore = new OpenProjectStore(rootDirectory, instanceId);
            const originalScan = coordinatorStore.scan.bind(coordinatorStore);
            coordinatorStore.scan = async nowMs => {
                scanCalls += 1;
                if (blockNextScan) {
                    blockNextScan = false;
                    await scanBlocked.promise;
                }
                return originalScan(nowMs);
            };
            return coordinatorStore;
        },
    });

    try {
        await eventCoordinator.publish(makePublication());
        const baselineScans = scanCalls;
        blockNextScan = true;
        const inFlight = eventCoordinator.scanAndDeliver();
        await new Promise(resolve => setImmediate(resolve));
        fireWatcher();
        fireWatcher();
        fireWatcher();
        scanBlocked.resolve();
        await inFlight;
        assert.strictEqual(scanCalls, baselineScans + 2, 'watcher events should coalesce into one follow-up scan');

        const peerStore = new OpenProjectStore(eventRoot, OTHER);
        eventNow = 2000;
        await peerStore.write(makeRegistration(OTHER, 1900, '/work/peer', {
            sequence: 1,
            leaseUpdatedAtMs: 2000,
        }));
        const beforePolling = eventDeliveries.length;
        fireInterval();
        for (let attempt = 0; attempt < 50 && eventDeliveries.length === beforePolling; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.strictEqual(eventDeliveries.length, beforePolling + 1, 'fallback polling should recover a missed watcher event');
        assert.deepStrictEqual(
            eventDeliveries[eventDeliveries.length - 1].registrations.map(value => value.instanceId),
            [OTHER, SELF]
        );
    } finally {
        eventCoordinator.dispose();
        await fs.promises.rm(eventRoot, { recursive: true, force: true });
    }
}

async function runCoordinatorAggregateBoundaryChecks() {
    const registrations = Array.from({ length: 101 }, (_, index) => makeRegistration(
        index.toString(16).padStart(32, '0'),
        index >= 99 ? 1000 : index,
        `/work/project-${index}`,
        { sequence: index + 1, leaseUpdatedAtMs: 5000 }
    ));
    const expectedInstanceIds = registrations.slice()
        .sort((left, right) => right.lastFocusedAtMs - left.lastFocusedAtMs
            || (left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0))
        .slice(0, 100)
        .map(registration => registration.instanceId);

    const deliverFromScan = async scanRegistrations => {
        const deliveries = [];
        const coordinator = new OpenProjectCoordinator('/unused-bounded-root', {
            now: () => 5000,
            setInterval: () => 'bounded-interval',
            clearInterval: () => undefined,
            createWatcher: () => ({ close: () => undefined }),
            deliverAggregate: async aggregate => { deliveries.push(aggregate); },
            createStore: () => ({
                write: async () => undefined,
                remove: async () => undefined,
                scan: async () => ({ registrations: scanRegistrations, counters: {} }),
            }),
        });
        try {
            await coordinator.publish(makePublication());
            assert.strictEqual(deliveries.length, 1);
            return deliveries[0];
        } finally {
            coordinator.dispose();
        }
    };

    const forwardAggregate = await deliverFromScan(registrations);
    const reverseAggregate = await deliverFromScan(registrations.slice().reverse());
    assert.strictEqual(forwardAggregate.registrations.length, 100);
    assert.deepStrictEqual(protocol.validateOpenProjectAggregate(forwardAggregate), forwardAggregate);
    assert.deepStrictEqual(
        forwardAggregate.registrations.map(registration => registration.instanceId),
        expectedInstanceIds
    );
    assert.deepStrictEqual(reverseAggregate, forwardAggregate);
    assert.ok(forwardAggregate.registrations.some(registration => registration.instanceId === registrations[100].instanceId));
    assert.ok(!forwardAggregate.registrations.some(registration => registration.instanceId === registrations[0].instanceId));

    let fireWatcher;
    let deliveryAttempts = 0;
    const attemptedRevisions = [];
    const successfulDeliveries = [];
    const retryCoordinator = new OpenProjectCoordinator('/unused-retry-root', {
        now: () => 6000,
        setInterval: () => 'retry-interval',
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        deliverAggregate: async aggregate => {
            deliveryAttempts += 1;
            attemptedRevisions.push(aggregate.semanticRevision);
            if (deliveryAttempts === 1) {
                throw new Error('forced aggregate delivery failure');
            }
            successfulDeliveries.push(aggregate);
        },
        createStore: () => ({
            write: async () => undefined,
            remove: async () => undefined,
            scan: async () => ({ registrations: [makeRegistration()], counters: {} }),
        }),
    });
    try {
        await assert.rejects(
            retryCoordinator.publish(makePublication()),
            /forced aggregate delivery failure/
        );
        fireWatcher();
        for (let attempt = 0; attempt < 50 && successfulDeliveries.length === 0; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.strictEqual(deliveryAttempts, 2);
        assert.strictEqual(attemptedRevisions[1], attemptedRevisions[0]);
        assert.strictEqual(successfulDeliveries.length, 1);
        assert.deepStrictEqual(
            protocol.validateOpenProjectAggregate(successfulDeliveries[0]),
            successfulDeliveries[0]
        );
    } finally {
        retryCoordinator.dispose();
    }
}

async function runCoordinatorWiringChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-project-wiring-'));
    const registeredCommands = new Map();
    const executedCommands = [];
    const vscode = {
        workspace: { workspaceFolders: [] },
        commands: {
            registerCommand: (command, callback) => {
                registeredCommands.set(command, callback);
                return { dispose: () => registeredCommands.delete(command) };
            },
            executeCommand: async (command, argument) => {
                executedCommands.push({ command, argument });
                return undefined;
            },
        },
    };
    const previousModuleLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return vscode;
        }
        return previousModuleLoad.call(this, request, parent, isMain);
    };

    const context = {
        globalStoragePath: tempRoot,
        globalStorageUri: { scheme: 'file' },
        subscriptions: [],
    };
    try {
        const extension = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/extension');
        await extension.activate(context);
        const publish = registeredCommands.get('_projectStewardOpenProjects.bridge.publish');
        const unregister = registeredCommands.get('_projectStewardOpenProjects.bridge.unregister');
        assert.strictEqual(typeof publish, 'function');
        assert.strictEqual(typeof unregister, 'function');

        await publish(makePublication({ followsFocusEvent: true }));
        const aggregateDelivery = executedCommands.filter(
            value => value.command === '_projectStewardOpenProjects.workspace.aggregate'
        ).pop();
        assert.ok(aggregateDelivery, 'production wiring should deliver an open-project aggregate');
        assert.strictEqual(aggregateDelivery.argument.registrations[0].instanceId, SELF);
        await unregister({ protocolVersion: 1, instanceId: SELF });
    } finally {
        Module._load = previousModuleLoad;
        for (const disposable of context.subscriptions.slice().reverse()) {
            disposable.dispose();
        }
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

async function main() {
    runProtocolChecks();
    runIdentityChecks();
    runRecordChecks();
    runProjectionChecks();
    await runStoreChecks();
    await runCoordinatorChecks();
    await runCoordinatorAggregateBoundaryChecks();
    await runCoordinatorWiringChecks();
    console.log('Open project safety checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
