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
