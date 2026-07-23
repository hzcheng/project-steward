'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CAPABILITY_ID = /^MAIN-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const COMMIT_ID = /^[a-f0-9]{40}$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;

function loadMainCapabilityCoverage(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isDocumentationPath(filePath) {
    return filePath === 'docs'
        || filePath.startsWith('docs/')
        || filePath === '.superpowers'
        || filePath.startsWith('.superpowers/');
}

function inspectRepositoryFile(repositoryRoot, filePath) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        return 'must be a non-empty repository-relative path';
    }
    const normalizedPath = filePath.replaceAll('\\', '/');
    const resolvedPath = path.resolve(repositoryRoot, normalizedPath);
    const relativePath = path.relative(repositoryRoot, resolvedPath);
    if (path.isAbsolute(normalizedPath)
        || path.win32.isAbsolute(normalizedPath)
        || WINDOWS_DRIVE_PATH_PATTERN.test(normalizedPath)
        || relativePath === '..'
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)) {
        return 'must be repository-relative';
    }

    let stats;
    try {
        stats = fs.statSync(resolvedPath);
    } catch (error) {
        return error && error.code === 'ENOENT' ? 'is missing' : 'cannot be inspected';
    }
    if (!stats.isFile()) {
        return 'must be a regular file';
    }

    let canonicalRepositoryRoot;
    let canonicalPath;
    try {
        canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
        canonicalPath = fs.realpathSync(resolvedPath);
    } catch {
        return 'cannot be inspected';
    }
    const canonicalRelativePath = path.relative(canonicalRepositoryRoot, canonicalPath);
    if (canonicalRelativePath === '..'
        || canonicalRelativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(canonicalRelativePath)) {
        return 'resolves outside repository';
    }
    return null;
}

function collectWorkflowJobIds(workflows) {
    const jobIds = new Set();
    for (const source of Object.values(workflows || {})) {
        if (typeof source !== 'string') {
            continue;
        }
        let insideJobs = false;
        for (const line of source.split(/\r?\n/u)) {
            if (/^jobs:\s*(?:#.*)?$/u.test(line)) {
                insideJobs = true;
                continue;
            }
            if (insideJobs && /^[^\s#][^:]*:/u.test(line)) {
                insideJobs = false;
            }
            const match = insideJobs
                ? /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/u.exec(line)
                : null;
            if (match) {
                jobIds.add(match[1]);
            }
        }
    }
    return jobIds;
}

function collectReachableScriptText(scriptNames, scripts) {
    const pending = [...scriptNames];
    const visited = new Set();
    const commands = [];
    while (pending.length > 0) {
        const scriptName = pending.pop();
        if (visited.has(scriptName)) {
            continue;
        }
        visited.add(scriptName);
        const command = scripts[scriptName];
        if (typeof command !== 'string') {
            continue;
        }
        commands.push(command);
        for (const match of command.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:._-]+)/gu)) {
            pending.push(match[1]);
        }
    }
    return commands.join('\n');
}

function escapeRegularExpression(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
}

function globMatches(pattern, filePath) {
    let source = escapeRegularExpression(pattern.replaceAll('\\', '/'));
    source = source
        .replaceAll('**/', '(?:.*/)?')
        .replaceAll('**', '.*')
        .replaceAll('*', '[^/]*');
    return new RegExp(`^${source}$`, 'u').test(filePath.replaceAll('\\', '/'));
}

function ownerIsReachable(owner, commandText) {
    const normalizedOwner = owner.replaceAll('\\', '/');
    if (commandText.includes(normalizedOwner)) {
        return true;
    }
    const tokens = commandText
        .split(/[\s"'`]+/u)
        .map(token => token.replace(/[;,]+$/u, ''))
        .filter(Boolean);
    return tokens.some(token => token.includes('*') && globMatches(token, normalizedOwner));
}

function collectUnassignedAuditedCommits(manifest, auditedCommits) {
    const assigned = new Set(
        manifest.capabilities.flatMap(item => Array.isArray(item.commits) ? item.commits : [])
    );
    const ignored = new Set(manifest.audit?.ignoredDocumentationCommits || []);
    return auditedCommits.filter(commit =>
        !assigned.has(commit.hash)
        && !ignored.has(commit.hash)
        && commit.files.some(file => !isDocumentationPath(file))
    );
}

function validateMainCapabilityCoverage(manifest, options) {
    const errors = [];
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.capabilities)) {
        return ['main capability manifest must use version 1 with a capabilities array'];
    }
    if (!options || !path.isAbsolute(options.repositoryRoot || '')) {
        return ['repositoryRoot must be an absolute path'];
    }
    const behaviors = Array.isArray(options.behaviors) ? options.behaviors : [];
    const scripts = options.scripts && typeof options.scripts === 'object'
        ? options.scripts
        : {};
    const auditedCommits = Array.isArray(options.auditedCommits) ? options.auditedCommits : [];
    const auditedByHash = new Map(auditedCommits.map(commit => [commit.hash, commit]));
    const workflowJobIds = collectWorkflowJobIds(options.workflows);
    const ignoredDocumentationCommits = manifest.audit?.ignoredDocumentationCommits;
    if (!manifest.audit
        || !COMMIT_ID.test(manifest.audit.base || '')
        || !COMMIT_ID.test(manifest.audit.head || '')
        || !Array.isArray(ignoredDocumentationCommits)) {
        errors.push('audit must define full base/head hashes and ignoredDocumentationCommits');
    }

    const ignoredIds = new Set();
    for (const hash of Array.isArray(ignoredDocumentationCommits)
        ? ignoredDocumentationCommits
        : []) {
        if (!COMMIT_ID.test(hash)) {
            errors.push(`invalid documentation exemption ${hash}`);
            continue;
        }
        if (ignoredIds.has(hash)) {
            errors.push(`duplicate documentation exemption ${hash}`);
        }
        ignoredIds.add(hash);
        const auditedCommit = auditedByHash.get(hash);
        if (!auditedCommit) {
            errors.push(`documentation exemption ${hash} is outside the audited range`);
        } else if (auditedCommit.files.some(file => !isDocumentationPath(file))) {
            errors.push(`documentation exemption ${hash} changes non-documentation path`);
        }
    }

    const ids = new Set();
    const commitOwners = new Map();
    for (const [index, capability] of manifest.capabilities.entries()) {
        if (!CAPABILITY_ID.test(capability?.id || '')) {
            errors.push(`capability ${index + 1} has invalid id ${capability?.id || ''}`);
            continue;
        }
        if (ids.has(capability.id)) {
            errors.push(`duplicate capability id ${capability.id}`);
        }
        ids.add(capability.id);
        if (typeof capability.title !== 'string' || capability.title.trim() === '') {
            errors.push(`${capability.id} title must be a non-empty string`);
        }
        if (typeof capability.requirement !== 'string' || capability.requirement.trim() === '') {
            errors.push(`${capability.id} requirement must be a non-empty string`);
        }
        if (!Array.isArray(capability.commits) || capability.commits.length === 0) {
            errors.push(`${capability.id} must assign at least one audited commit`);
        }
        for (const commit of Array.isArray(capability.commits) ? capability.commits : []) {
            if (!COMMIT_ID.test(commit)) {
                errors.push(`${capability.id} has invalid commit ${commit}`);
                continue;
            }
            const existingOwner = commitOwners.get(commit);
            if (existingOwner) {
                errors.push(`audited commit ${commit} is assigned to multiple capabilities: ${existingOwner}, ${capability.id}`);
            } else {
                commitOwners.set(commit, capability.id);
            }
            if (!auditedByHash.has(commit)) {
                errors.push(`${capability.id} assigns commit outside audited range ${commit}`);
            }
        }
        if (!Array.isArray(capability.behaviors) || capability.behaviors.length === 0) {
            errors.push(`${capability.id} must retain deterministic automated behavior coverage`);
        }
        const prGates = Array.isArray(capability.prGates) ? capability.prGates : [];
        if (prGates.length === 0) {
            errors.push(`${capability.id} must define at least one PR gate`);
        }
        const reachableCommands = collectReachableScriptText(prGates, scripts);
        for (const behaviorId of Array.isArray(capability.behaviors) ? capability.behaviors : []) {
            const behavior = behaviors.find(item => item.id === behaviorId);
            if (!behavior) {
                errors.push(`${capability.id} references missing behavior ${behaviorId}`);
            } else if (behavior.status !== 'automated') {
                errors.push(`${capability.id} behavior ${behaviorId} must be automated`);
            } else {
                if (!Array.isArray(behavior.owners) || behavior.owners.length === 0) {
                    errors.push(`${capability.id} behavior ${behaviorId} must have an owner`);
                }
                if (!Array.isArray(behavior.evidence) || behavior.evidence.length === 0) {
                    errors.push(`${capability.id} behavior ${behaviorId} must have evidence`);
                }
                for (const owner of Array.isArray(behavior.owners) ? behavior.owners : []) {
                    const inspectionError = inspectRepositoryFile(options.repositoryRoot, owner);
                    if (inspectionError) {
                        errors.push(`${capability.id} behavior ${behaviorId} owner ${owner} ${inspectionError}`);
                    } else if (!ownerIsReachable(owner, reachableCommands)) {
                        errors.push(`${capability.id} behavior ${behaviorId} owner ${owner} is not reachable from its PR gates`);
                    }
                }
                for (const evidence of Array.isArray(behavior.evidence) ? behavior.evidence : []) {
                    const inspectionError = inspectRepositoryFile(options.repositoryRoot, evidence);
                    if (inspectionError) {
                        errors.push(`${capability.id} behavior ${behaviorId} evidence ${evidence} ${inspectionError}`);
                    }
                }
            }
        }
        for (const gate of prGates) {
            if (typeof scripts[gate] !== 'string') {
                errors.push(`${capability.id} references missing PR gate ${gate}`);
            }
        }
        const scheduledJobs = Array.isArray(capability.scheduledJobs)
            ? capability.scheduledJobs
            : [];
        if (capability.realEnvironmentRequired === true && scheduledJobs.length === 0) {
            errors.push(`${capability.id} requires at least one scheduled job`);
        }
        for (const job of scheduledJobs) {
            if (!workflowJobIds.has(job)) {
                errors.push(`${capability.id} references missing scheduled job ${job}`);
            }
        }
    }

    for (const commit of collectUnassignedAuditedCommits(manifest, auditedCommits)) {
        errors.push(`unassigned audited commit ${commit.hash}: ${commit.subject}`);
    }
    return errors;
}

module.exports = {
    collectUnassignedAuditedCommits,
    loadMainCapabilityCoverage,
    validateMainCapabilityCoverage,
};
