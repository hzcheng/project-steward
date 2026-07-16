'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const dashboard = read('src/dashboard.ts');
const viewProvider = read('src/dashboard/viewProvider.ts');
const aiSessionController = read('src/aiSessions/dashboardController.ts');
const openProjectController = read('src/openProjects/dashboardController.ts');
const dashboardLines = dashboard.split(/\r?\n/).length;
const refreshCalls = (dashboard.match(/provider\.refresh\(/g) || []).length;
const webviewHtmlAssignments = ((dashboard + '\n' + viewProvider).match(/webview\.html/g) || []).length;
const providerDefinitions = read('src/aiSessions/providers.ts');
const expectedModules = [
    'src/dashboard/viewProvider.ts',
    'src/dashboard/messageRouter.ts',
    'src/dashboard/webviewUpdateMessages.ts',
    'src/openProjects/dashboardController.ts',
    'src/aiSessions/dashboardController.ts',
];

assert.ok(dashboardLines > 0);
assert.ok(refreshCalls >= 1);
assert.ok(webviewHtmlAssignments >= 1);
assert.ok(providerDefinitions.includes('codex:'));
assert.ok(providerDefinitions.includes('kimi:'));
assert.ok(providerDefinitions.includes('claude:'));
assert.ok(providerDefinitions.includes('export function createAiSessionProviderRegistry('));
assert.ok(dashboard.includes("event: 'ai-session-scan'"));
assert.ok(dashboard.includes('scannedFileCount: result.scannedFiles'));
assert.ok(dashboard.includes('parsedFileCount: result.parsedFiles'));
assert.ok(dashboard.includes('scanBudget: normalizedOptions.maxFiles || null'));
assert.ok(dashboard.includes('function getAiSessionScanMaxFiles('));
assert.ok(dashboard.includes("function refreshStewardViews(reason = 'refresh')"));
assert.ok(dashboard.includes("event: 'full-refresh'"));
assert.ok(dashboard.includes('function logDashboardDiagnostic('));
assert.ok(dashboard.includes('[Dashboard]'));
assert.ok(aiSessionController.includes('refresh: (reason: string) => void;'));
assert.ok(aiSessionController.includes("this.options.refresh('ai-session-update-not-delivered');"));
assert.ok(openProjectController.includes('refresh: (reason: string) => void;'));
assert.ok(openProjectController.includes("this.options.refresh('open-project-update-not-delivered');"));
for (const expectedModule of expectedModules) {
    assert.ok(fs.existsSync(path.join(root, expectedModule)), `missing ${expectedModule}`);
}

console.log(JSON.stringify({
    dashboardLines,
    refreshCalls,
    webviewHtmlAssignments,
    providers: ['codex', 'kimi', 'claude'],
    modules: expectedModules,
}, null, 2));
