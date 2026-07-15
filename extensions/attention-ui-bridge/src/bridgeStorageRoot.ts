import * as path from 'path';

export function resolveBridgeStorageRoot(globalStoragePath: string, globalStorageUriScheme: string): string {
    if (!globalStoragePath || !path.isAbsolute(globalStoragePath)) {
        throw new Error(`globalStoragePath must be an absolute path for ${globalStorageUriScheme || 'unknown'} storage`);
    }

    return path.join(globalStoragePath, 'attention-local-bridge-spike', 'v1');
}
