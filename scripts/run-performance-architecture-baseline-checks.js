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
const terminalService = read('src/aiSessions/terminalService.ts');
const aiSessionReadCoordinator = read('src/aiSessions/readCoordinator.ts');
const dashboardDiagnostics = read('src/dashboard/diagnostics.ts');
const dashboardLines = dashboard.split(/\r?\n/).length;
const refreshCalls = (dashboard.match(/provider\.refresh\(/g) || []).length;
const webviewHtmlAssignments = ((dashboard + '\n' + viewProvider).match(/webview\.html/g) || []).length;
const providerDefinitions = read('src/aiSessions/providers.ts');
const providerRegistryCalls = (dashboard.match(/aiSessionProviderRegistry\.providers\(\)/g) || []).length;
const expectedModules = [
    'src/dashboard/viewProvider.ts',
    'src/dashboard/commandRegistration.ts',
    'src/dashboard/configuration.ts',
    'src/dashboard/diagnostics.ts',
    'src/dashboard/errorContent.ts',
    'src/dashboard/groupCollapseController.ts',
    'src/dashboard/lifecycleController.ts',
    'src/dashboard/messageRouter.ts',
    'src/dashboard/runtimeController.ts',
    'src/dashboard/startup.ts',
    'src/dashboard/startupController.ts',
    'src/dashboard/webviewOptions.ts',
    'src/dashboard/webviewUpdateMessages.ts',
    'src/openProjects/dashboardController.ts',
    'src/openProjects/workspaceController.ts',
    'src/projects/addProjectsFromFolderController.ts',
    'src/projects/currentProjectDetails.ts',
    'src/projects/favoriteProjectController.ts',
    'src/projects/groupCommandController.ts',
    'src/projects/groupPrompts.ts',
    'src/projects/projectManualEditController.ts',
    'src/projects/projectMutationController.ts',
    'src/projects/projectOpenController.ts',
    'src/projects/projectOrderController.ts',
    'src/projects/projectPromptController.ts',
    'src/projects/projectRemovalController.ts',
    'src/projects/workspaceHelpers.ts',
    'src/aiSessions/aliasController.ts',
    'src/aiSessions/aliasStore.ts',
    'src/aiSessions/attentionController.ts',
    'src/aiSessions/archiveController.ts',
    'src/aiSessions/commandController.ts',
    'src/aiSessions/creationController.ts',
    'src/aiSessions/resumeController.ts',
    'src/aiSessions/dashboardController.ts',
    'src/aiSessions/pendingTerminalResolver.ts',
    'src/aiSessions/pendingTerminals.ts',
    'src/aiSessions/pinController.ts',
    'src/aiSessions/projectCandidates.ts',
    'src/aiSessions/projectHydration.ts',
    'src/aiSessions/projectHydrationController.ts',
    'src/aiSessions/projectStateStore.ts',
    'src/aiSessions/readCoordinator.ts',
    'src/aiSessions/scanOptions.ts',
    'src/aiSessions/sessionPaths.ts',
    'src/aiSessions/terminalCandidates.ts',
    'src/aiSessions/terminalCwd.ts',
    'src/aiSessions/viewModels.ts',
];

assert.ok(dashboardLines > 0);
assert.ok(refreshCalls >= 1);
assert.ok(webviewHtmlAssignments >= 1);
assert.ok(providerDefinitions.includes('codex:'));
assert.ok(providerDefinitions.includes('kimi:'));
assert.ok(providerDefinitions.includes('claude:'));
assert.ok(providerDefinitions.includes('export function createAiSessionProviderRegistry('));
assert.ok(!dashboard.includes("event: 'ai-session-scan'"));
assert.ok(aiSessionReadCoordinator.includes("event: 'ai-session-scan'"));
assert.ok(aiSessionReadCoordinator.includes('scannedFileCount: result.scannedFiles'));
assert.ok(aiSessionReadCoordinator.includes('parsedFileCount: result.parsedFiles'));
assert.ok(aiSessionReadCoordinator.includes('scanBudget: normalizedOptions.maxFiles || null'));
const projectHydrationController = fs.readFileSync(path.join(root, 'src', 'aiSessions', 'projectHydrationController.ts'), 'utf8');
assert.ok(!dashboard.includes("from './aiSessions/scanOptions'"));
assert.ok(projectHydrationController.includes("from './scanOptions'"));
const dashboardRuntimeController = fs.readFileSync(path.join(root, 'src', 'dashboard', 'runtimeController.ts'), 'utf8');
assert.ok(dashboard.includes("function refreshStewardViews(reason = 'refresh')"));
assert.ok(dashboardRuntimeController.includes("event: 'full-refresh'"));
assert.ok(dashboard.includes('new DashboardDiagnostics({'));
assert.ok(!dashboard.includes('function logDashboardDiagnostic('));
assert.ok(!dashboard.includes('function logAiSessionDiagnostic('));
assert.ok(!dashboard.includes('function logOpenProjectDiagnostic('));
assert.ok(dashboardDiagnostics.includes('[Dashboard]'));
assert.ok(!dashboard.includes('AI_SESSION_PROVIDER_IDS'));
assert.ok(!terminalService.includes('AI_SESSION_PROVIDER_IDS'));
assert.ok(dashboard.includes('const aiSessionProviders = aiSessionProviderRegistry.providers();'));
assert.strictEqual(providerRegistryCalls, 1);
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
    providerRegistryCalls,
    providers: ['codex', 'kimi', 'claude'],
    modules: expectedModules,
}, null, 2));
