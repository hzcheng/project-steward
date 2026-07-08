'use strict';

import * as path from 'path';
import { existsSync, lstatSync } from 'fs';

export default class GitRepositoryDetector {
    private readonly cache = new Map<string, boolean>();

    isGitRepositoryPath(projectPath: string): boolean {
        let startDir = this.getLocalStartDir(projectPath);
        if (!startDir) {
            return false;
        }

        let cached = this.cache.get(startDir);
        if (cached !== undefined) {
            return cached;
        }

        let result = this.hasGitMetadataInAncestors(startDir);
        if (result) {
            this.cache.set(startDir, result);
        }

        return result;
    }

    clearCache() {
        this.cache.clear();
    }

    private getLocalStartDir(projectPath: string): string {
        if (!projectPath || this.isUriString(projectPath)) {
            return null;
        }

        try {
            return lstatSync(projectPath).isDirectory() ? projectPath : path.dirname(projectPath);
        } catch (e) {
            return null;
        }
    }

    private hasGitMetadataInAncestors(startDir: string): boolean {
        let currentDir = path.resolve(startDir);

        while (currentDir) {
            if (existsSync(path.join(currentDir, '.git'))) {
                return true;
            }

            let parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) {
                return false;
            }

            currentDir = parentDir;
        }

        return false;
    }

    private isUriString(projectPath: string): boolean {
        return projectPath && projectPath.includes("://");
    }
}
