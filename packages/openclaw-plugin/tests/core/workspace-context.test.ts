import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('WorkspaceContext', () => {
    const workspaceDir = '/mock/workspace';
    const stateDir = '/mock/state';

    beforeEach(() => {
        vi.clearAllMocks();
        WorkspaceContext.clearCache();
    });

    afterEach(() => {
        vi.resetAllMocks();
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
        expect(wctx1.stateDir).toBe('/state1');
    });

    it('should throw error if workspaceDir is missing', () => {
        const mockCtx = { stateDir };
        expect(() => WorkspaceContext.fromHookContext(mockCtx)).toThrow('workspaceDir is required');
    });

    it('should resolve paths using PD_FILES keys', () => {
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        
        // PROFILE is at .principles/PROFILE.json
        expect(wctx.resolve('PROFILE')).toBe(path.join(workspaceDir, '.principles', 'PROFILE.json'));
        // PLAN is at root
        expect(wctx.resolve('PLAN')).toBe(path.join(workspaceDir, 'PLAN.md'));
    });

    it('should support explicit disposal from cache', () => {
        const mockCtx = { workspaceDir };
        const wctx1 = WorkspaceContext.fromHookContext(mockCtx);
        
        WorkspaceContext.dispose(workspaceDir);
        
        const wctx2 = WorkspaceContext.fromHookContext(mockCtx);
        expect(wctx1).not.toBe(wctx2);
    });

    it('should allow invalidation of internal state', () => {
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        
        expect(() => wctx.invalidate()).not.toThrow();
    });
});
