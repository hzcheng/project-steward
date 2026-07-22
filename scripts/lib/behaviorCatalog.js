'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ID_PATTERN = /^[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}$/;
const ALLOWED_DOMAINS = new Set([
    'project', 'todo', 'open-project', 'webview', 'session', 'runtime', 'attention',
    'persistence', 'error', 'release', 'architecture',
]);
const ALLOWED_PRIORITIES = new Set(['P0', 'P1', 'P2']);
const ALLOWED_STATUSES = new Set(['automated', 'scheduled', 'manual']);
const LEGACY_COMPATIBILITY_OWNERS = new Set([
    'scripts/run-ai-session-safety-checks.js',
    'scripts/run-ai-session-tmux-checks.js',
    'scripts/run-dashboard-webview-checks.js',
    'scripts/run-open-project-safety-checks.js',
]);

function loadBehaviorCatalog(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateBehaviorCatalog(entries, options) {
    const errors = [];
    const repositoryRoot = options && options.repositoryRoot;
    if (!path.isAbsolute(repositoryRoot || '')) {
        return ['repositoryRoot must be an absolute path'];
    }
    if (!Array.isArray(entries)) {
        return ['behavior catalog must be an array'];
    }

    const seenIds = new Set();
    for (const [index, entry] of entries.entries()) {
        const label = `entry ${index + 1}`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
            errors.push(`${label} has invalid id ${String(entry.id)}`);
        } else if (seenIds.has(entry.id)) {
            errors.push(`${label} has duplicate id ${entry.id}`);
        } else {
            seenIds.add(entry.id);
        }
        if (!ALLOWED_DOMAINS.has(entry.domain)) {
            errors.push(`${label} has invalid domain ${String(entry.domain)}`);
        }
        if (typeof entry.title !== 'string' || entry.title.trim() === '') {
            errors.push(`${label} title must be a non-empty string`);
        }
        if (!ALLOWED_PRIORITIES.has(entry.priority)) {
            errors.push(`${label} has invalid priority ${String(entry.priority)}`);
        }
        if (!ALLOWED_STATUSES.has(entry.status)) {
            errors.push(`${label} has invalid status ${String(entry.status)}`);
        }
        if (!Array.isArray(entry.evidence) || entry.evidence.length === 0
            || entry.evidence.some(item => typeof item !== 'string' || item.trim() === '')) {
            errors.push(`${label} evidence must contain at least one path`);
        }
        if (!Array.isArray(entry.owners) || entry.owners.length === 0) {
            errors.push(`${label} owners must contain at least one path`);
        } else {
            for (const owner of entry.owners) {
                if (typeof owner !== 'string' || owner.trim() === '') {
                    errors.push(`${label} has an invalid owner path`);
                    continue;
                }
                const ownerPath = path.resolve(repositoryRoot, owner);
                const relativeOwnerPath = path.relative(repositoryRoot, ownerPath);
                if (path.isAbsolute(owner) || relativeOwnerPath.startsWith('..') || path.isAbsolute(relativeOwnerPath)) {
                    errors.push(`${label} owner path must be repository-relative: ${owner}`);
                    continue;
                }
                if (entry.status === 'automated' && LEGACY_COMPATIBILITY_OWNERS.has(owner)) {
                    errors.push(`${label} legacy compatibility script cannot own automated behavior: ${owner}`);
                }
                let ownerStats;
                try {
                    ownerStats = fs.statSync(ownerPath);
                } catch (error) {
                    if (error && error.code === 'ENOENT') {
                        errors.push(`${label} has missing owner path ${owner}`);
                    } else {
                        errors.push(`${label} cannot inspect owner path ${owner}: ${error.message}`);
                    }
                    continue;
                }
                if (!ownerStats.isFile()) {
                    errors.push(`${label} owner path must be a regular file: ${owner}`);
                    continue;
                }
                if (entry.status === 'automated') {
                    let ownerContents;
                    try {
                        ownerContents = fs.readFileSync(ownerPath, 'utf8');
                    } catch (error) {
                        errors.push(`${label} cannot read owner path ${owner}: ${error.message}`);
                        continue;
                    }
                    if (!ownerContents.includes(entry.id)) {
                        errors.push(`${label} owner path ${owner} does not reference id ${entry.id}`);
                    }
                }
            }
        }
        if (entry.status === 'manual'
            && (typeof entry.manualReason !== 'string' || entry.manualReason.trim() === '')) {
            errors.push(`${label} manualReason must be a non-empty string`);
        }
    }
    return errors;
}

module.exports = {
    loadBehaviorCatalog,
    validateBehaviorCatalog,
};
