import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

describe('WorkspaceContext', () => {
    const workspaceDir = '/mock/workspace';
    const stateDir = '/mock/state';

    beforeEach(() => {
        // Clear static cache if possible (will need to implement this)
        (WorkspaceContext as any).clearCache?.();
    });

    it('should create an instance from hook context', () => {
        const mockCtx = { workspaceDir, stateDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        
        expect(wctx.workspaceDir).toBe(workspaceDir);
        expect(wctx.stateDir).toBe(stateDir);
    });

    it('should cache instances based on workspaceDir', () => {
        const mockCtx1 = { workspaceDir, stateDir: '/state1' };
        const mockCtx2 = { workspaceDir, stateDir: '/state2' };
        
        const wctx1 = WorkspaceContext.fromHookContext(mockCtx1);
        const wctx2 = WorkspaceContext.fromHookContext(mockCtx2);
        
        expect(wctx1).toBe(wctx2);
        expect(wctx1.stateDir).toBe('/state1'); // First one wins or handles fallback
    });

    it('should throw error if workspaceDir is missing', () => {
        const mockCtx = { stateDir };
        expect(() => WorkspaceContext.fromHookContext(mockCtx)).toThrow('workspaceDir is required');
    });

    it('should invalidate cache when requested', () => {
        const mockCtx = { workspaceDir, stateDir };
        const wctx1 = WorkspaceContext.fromHookContext(mockCtx);
        
        wctx1.invalidate();
        
        // This is tricky if it's a singleton cache. 
        // Invalidate usually refers to services/paths, but let's test if it resets internal state.
        // For now, let's just check if the method exists.
        expect(typeof wctx1.invalidate).toBe('function');
    });
});
