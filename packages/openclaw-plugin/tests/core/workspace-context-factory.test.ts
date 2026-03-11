import { describe, it, expect, vi } from 'vitest';
import { createTestContext } from '../test-utils.js';

describe('WorkspaceContext Factory (Test Utils)', () => {
    it('should create a test context with a temporary directory', () => {
        const wctx = createTestContext();
        
        expect(wctx.workspaceDir).toContain('pd-test-');
        expect(wctx.stateDir).toContain('.state');
    });

    it('should allow overriding workspaceDir', () => {
        const wctx = createTestContext({ workspaceDir: '/custom/test' });
        expect(wctx.workspaceDir).toBe('/custom/test');
    });
});
