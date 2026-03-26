import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceContext } from '../src/core/workspace-context.js';

/**
 * Creates a WorkspaceContext for testing purposes.
 * If no workspaceDir is provided, a temporary directory is created.
 */
export function createTestContext(overrides: { workspaceDir?: string, stateDir?: string } = {}): WorkspaceContext {
    let workspaceDir = overrides.workspaceDir;

    if (!workspaceDir) {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'));
    }

    // Ensure it's absolute
    workspaceDir = path.resolve(workspaceDir);

    const mockCtx = {
        workspaceDir,
        stateDir: overrides.stateDir
    };

    // We use fromHookContext but bypass the cache for tests to ensure isolation
    // Actually, clearCache might be better
    WorkspaceContext.clearCache();
    return WorkspaceContext.fromHookContext(mockCtx);
}

/**
 * Safely removes a directory, ignoring Windows EPERM/ENOTEMPTY errors.
 * Windows file locks can cause these errors when file handles are still held.
 * The OS will eventually clean up temp directories, so it's safe to ignore.
 */
export function safeRmDir(dir: string): void {
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch (err: any) {
        // On Windows, ignore EPERM/ENOTEMPTY errors (file handle still held)
        // The OS will clean up temp directories eventually
        if (process.platform !== 'win32' || (err?.code !== 'EPERM' && err?.code !== 'ENOTEMPTY')) {
            throw err;
        }
    }
}
