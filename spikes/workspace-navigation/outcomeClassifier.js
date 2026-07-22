'use strict';

/**
 * @typedef {'opened-duplicate' | 'replaced-source' | 'unsupported' | 'not-runnable'} ProbeOutcome
 */

/**
 * Classify only outcomes that the workspace-host probe can observe itself.
 * `focused-existing` is deliberately reserved for a future trusted importer.
 *
 * @param {{
 *   commandError: string | null,
 *   registrationCountBefore: number,
 *   registrationCountAfter: number,
 *   startedAtMs: number,
 *   sourceHeartbeatBeforeMs: number,
 *   sourceHeartbeatAfterMs: number | null
 * }} input
 * @returns {{ outcome: ProbeOutcome, reason: string }}
 */
function classifyProbeOutcome(input) {
    if (input.commandError !== null) {
        return { outcome: 'unsupported', reason: input.commandError };
    }
    if (input.registrationCountAfter > input.registrationCountBefore) {
        return {
            outcome: 'opened-duplicate',
            reason: `Probe registration count increased from ${input.registrationCountBefore} to ${input.registrationCountAfter}.`,
        };
    }
    if (input.sourceHeartbeatAfterMs === null
        || input.sourceHeartbeatAfterMs <= input.sourceHeartbeatBeforeMs
        || input.sourceHeartbeatAfterMs <= input.startedAtMs) {
        return {
            outcome: 'replaced-source',
            reason: 'The source registration heartbeat was missing or did not advance after the navigation action.',
        };
    }
    return {
        outcome: 'not-runnable',
        reason: [
            'No authoritative VS Code UI window-count channel is available.',
            `Probe registration count ${input.registrationCountBefore} -> ${input.registrationCountAfter} is diagnostic only.`,
            'Probe registrations and process counts cannot prove an unchanged desktop window count.',
        ].join(' '),
    };
}

module.exports = { classifyProbeOutcome };
