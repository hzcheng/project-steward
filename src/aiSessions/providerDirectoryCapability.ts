'use strict';

import type { AiSessionProviderId } from '../models';

export type ProviderDirectoryCapabilityStatus = 'supported' | 'unsupported' | 'unavailable';

export interface ProviderDirectoryCapabilityProvider {
    id: AiSessionProviderId;
    commandName: string;
}

export interface BoundedChildProcessOptions {
    timeoutMs: number;
    maxOutputBytes: number;
}

export interface BoundedChildProcessResult {
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
}

export interface ProviderDirectoryCapabilityChildProcessAdapter {
    resolveExecutable(commandName: string): string | null;
    run(
        executable: string,
        args: readonly string[],
        options: BoundedChildProcessOptions
    ): Promise<BoundedChildProcessResult>;
}

export interface ProviderDirectoryCapabilityResult {
    status: ProviderDirectoryCapabilityStatus;
}

const HELP_TIMEOUT_MS = 5_000;
const HELP_OUTPUT_MAX_BYTES = 64 * 1024;
const ADD_DIRECTORY_OPTION = /(?:^|\s)--add-dir(?=$|[\s=<\[(])/m;

function boundedHelpOutput(help: BoundedChildProcessResult): string {
    const stdout = typeof help.stdout === 'string' ? help.stdout : '';
    const stderr = typeof help.stderr === 'string' ? help.stderr : '';
    return Buffer.from(`${stdout}\n${stderr}`, 'utf8')
        .slice(0, HELP_OUTPUT_MAX_BYTES)
        .toString('utf8');
}

function result(status: ProviderDirectoryCapabilityStatus): ProviderDirectoryCapabilityResult {
    return Object.freeze({ status });
}

export class ProviderDirectoryCapabilityProbe {
    private readonly cache = new Map<string, Promise<ProviderDirectoryCapabilityResult>>();

    constructor(
        private readonly childProcess: ProviderDirectoryCapabilityChildProcessAdapter,
        private readonly logDiagnostic: (message: string) => void = () => undefined,
    ) { }

    probe(provider: ProviderDirectoryCapabilityProvider): Promise<ProviderDirectoryCapabilityResult> {
        const resolvedExecutable = this.childProcess.resolveExecutable(provider.commandName);
        if (!resolvedExecutable) {
            const cacheKey = `${provider.id}:missing:${provider.commandName}`;
            const cached = this.cache.get(cacheKey);
            if (cached) {
                return cached;
            }
            const missing = Promise.resolve(result('unavailable'));
            this.cache.set(cacheKey, missing);
            this.logDiagnostic(`AI provider directory capability unavailable (${provider.id}: executable missing).`);
            return missing;
        }

        const cacheKey = `${provider.id}:${resolvedExecutable}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const pending = this.execute(provider, resolvedExecutable);
        this.cache.set(cacheKey, pending);
        return pending;
    }

    private async execute(
        provider: ProviderDirectoryCapabilityProvider,
        executable: string,
    ): Promise<ProviderDirectoryCapabilityResult> {
        let help: BoundedChildProcessResult;
        try {
            help = await this.childProcess.run(executable, ['--help'], {
                timeoutMs: HELP_TIMEOUT_MS,
                maxOutputBytes: HELP_OUTPUT_MAX_BYTES,
            });
        } catch (error) {
            this.logDiagnostic(`AI provider directory capability unavailable (${provider.id}: help execution failed).`);
            return result('unavailable');
        }

        if (help?.timedOut) {
            this.logDiagnostic(`AI provider directory capability unavailable (${provider.id}: help execution timed out).`);
            return result('unavailable');
        }
        if (!help || help.exitCode !== 0) {
            this.logDiagnostic(`AI provider directory capability unavailable (${provider.id}: help exited unsuccessfully).`);
            return result('unavailable');
        }

        const output = boundedHelpOutput(help);
        return result(ADD_DIRECTORY_OPTION.test(output) ? 'supported' : 'unsupported');
    }
}
