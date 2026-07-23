'use strict';

const path = require('node:path');
const { defineProviderContract } = require('../../helpers/providerContract');
const { AI_SESSION_PROVIDER_DEFINITIONS } = require('../../../out/aiSessions/providers');
const lifecycle = require('../../../out/aiSessions/lifecycle');
const CodexSessionService = require('../../../out/services/codexSessionService').default;
const KimiSessionService = require('../../../out/services/kimiSessionService').default;
const ClaudeSessionService = require('../../../out/services/claudeSessionService').default;

// SESSION-PROVIDER-001
// SESSION-AI-SESSION-PROVIDER-MAX-FILES-001
// PERSIST-PROVIDER-LIFECYCLE-SERVICE-001
// PERSIST-LIFECYCLE-PARSER-001
const fixturesRoot = path.resolve(__dirname, '../../fixtures/providers');
const contracts = [{
    id: 'codex',
    serviceFactory: () => new CodexSessionService(),
    parser: lifecycle.parseCodexLifecycleLines,
}, {
    id: 'kimi',
    serviceFactory: () => new KimiSessionService(),
    parser: lifecycle.parseKimiLifecycleLines,
}, {
    id: 'claude',
    serviceFactory: () => new ClaudeSessionService(),
    parser: lifecycle.parseClaudeLifecycleLines,
}];

for (const contract of contracts) {
    defineProviderContract({
        id: contract.id,
        serviceFactory: contract.serviceFactory,
        fixtures: {
            root: path.join(fixturesRoot, contract.id),
            parseLifecycleLines: contract.parser,
        },
        definition: AI_SESSION_PROVIDER_DEFINITIONS[contract.id],
    });
}
