'use strict';

function createFakeVscode(overrides = {}) {
    const calls = [];
    const fakeVscode = { calls };

    for (const [surface, members] of Object.entries(overrides)) {
        if (typeof members === 'function') {
            fakeVscode[surface] = (...args) => {
                calls.push({ surface, method: null, args });
                return members(...args);
            };
            continue;
        }
        if (!members || typeof members !== 'object' || Array.isArray(members)) {
            fakeVscode[surface] = members;
            continue;
        }
        fakeVscode[surface] = {};
        for (const [method, implementation] of Object.entries(members)) {
            fakeVscode[surface][method] = typeof implementation === 'function'
                ? (...args) => {
                    calls.push({ surface, method, args });
                    return implementation(...args);
                }
                : implementation;
        }
    }

    return fakeVscode;
}

module.exports = {
    createFakeVscode,
};
