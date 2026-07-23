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
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const LEGACY_COMPATIBILITY_OWNERS = new Set([
    'scripts/run-ai-session-safety-checks.js',
    'scripts/run-ai-session-tmux-checks.js',
    'scripts/run-dashboard-webview-checks.js',
    'scripts/run-open-project-safety-checks.js',
]);

function loadBehaviorCatalog(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function inspectRepositoryFile(repositoryRoot, canonicalRepositoryRoot, catalogPath) {
    const normalizedPath = catalogPath.replaceAll('\\', '/');
    const resolvedPath = path.resolve(repositoryRoot, normalizedPath);
    const relativePath = path.relative(repositoryRoot, resolvedPath);
    if (path.isAbsolute(normalizedPath)
        || path.win32.isAbsolute(normalizedPath)
        || WINDOWS_DRIVE_PATH_PATTERN.test(normalizedPath)
        || relativePath === '..'
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)) {
        return { error: 'relative' };
    }

    let stats;
    try {
        stats = fs.statSync(resolvedPath);
    } catch (error) {
        return error && error.code === 'ENOENT'
            ? { error: 'missing' }
            : { error: 'inspect', detail: error.message };
    }
    if (!stats.isFile()) {
        return { error: 'regular-file' };
    }

    let canonicalPath;
    try {
        canonicalPath = fs.realpathSync(resolvedPath);
    } catch (error) {
        return { error: 'inspect', detail: error.message };
    }
    const canonicalRelativePath = path.relative(canonicalRepositoryRoot, canonicalPath);
    if (canonicalRelativePath === '..'
        || canonicalRelativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(canonicalRelativePath)) {
        return { error: 'outside' };
    }

    return {
        canonicalCatalogPath: canonicalRelativePath.split(path.sep).join('/'),
        resolvedPath,
    };
}

function appendRepositoryFileError(errors, label, field, catalogPath, inspection) {
    switch (inspection.error) {
        case 'relative':
            errors.push(`${label} ${field} path must be repository-relative: ${catalogPath}`);
            break;
        case 'missing':
            errors.push(`${label} has missing ${field} path ${catalogPath}`);
            break;
        case 'inspect':
            errors.push(`${label} cannot inspect ${field} path ${catalogPath}: ${inspection.detail}`);
            break;
        case 'regular-file':
            errors.push(`${label} ${field} path must be a regular file: ${catalogPath}`);
            break;
        case 'outside':
            errors.push(`${label} ${field} path resolves outside repository: ${catalogPath}`);
            break;
        default:
            throw new Error(`Unsupported repository file inspection error: ${inspection.error}`);
    }
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
    let canonicalRepositoryRoot;
    try {
        canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
    } catch (error) {
        return [`cannot inspect repositoryRoot: ${error.message}`];
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
        } else {
            for (const evidence of entry.evidence) {
                const inspection = inspectRepositoryFile(
                    repositoryRoot, canonicalRepositoryRoot, evidence,
                );
                if (inspection.error) {
                    appendRepositoryFileError(errors, label, 'evidence', evidence, inspection);
                }
            }
        }
        if (!Array.isArray(entry.owners) || entry.owners.length === 0) {
            errors.push(`${label} owners must contain at least one path`);
        } else {
            for (const owner of entry.owners) {
                if (typeof owner !== 'string' || owner.trim() === '') {
                    errors.push(`${label} has an invalid owner path`);
                    continue;
                }
                const inspection = inspectRepositoryFile(
                    repositoryRoot, canonicalRepositoryRoot, owner,
                );
                if (inspection.error) {
                    appendRepositoryFileError(errors, label, 'owner', owner, inspection);
                    continue;
                }
                const canonicalOwner = inspection.canonicalCatalogPath;
                if (entry.status === 'automated' && LEGACY_COMPATIBILITY_OWNERS.has(canonicalOwner)) {
                    errors.push(`${label} legacy compatibility script cannot own automated behavior: ${owner}`);
                }
                if (entry.status === 'automated') {
                    let ownerContents;
                    try {
                        ownerContents = fs.readFileSync(inspection.resolvedPath, 'utf8');
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
