'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDashboardMessageRouter } = require('../../../out/dashboard/messageRouter');

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 routes a valid generic message once and ignores non-object or typeless messages', async () => {
    const calls = [];
    const router = createDashboardMessageRouter({
        handlers: {
            'request-projects-panel': message => calls.push(message.requestId),
        },
    });

    await router(null);
    await router({});
    await router({ type: 'request-projects-panel', requestId: 7 });

    assert.deepEqual(calls, [7]);
});
