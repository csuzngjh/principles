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

    it('should lazy load ConfigService', () => {
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        
        const config = wctx.config;
        expect(config).toBeDefined();
        expect(wctx.config).toBe(config); // Should be cached
    });

    it('should lazy load EventLog', () => {
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        
        const eventLog = wctx.eventLog;
        expect(eventLog).toBeDefined();
        expect(wctx.eventLog).toBe(eventLog); // Should be cached
    });

    it('should lazy load Trust service', () => {
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        
        const trust = wctx.trust;
        expect(trust).toBeDefined();
        expect(trust.recordSuccess).toBeDefined();
        expect(wctx.trust).toBe(trust);
    });

    it('should lazy load Dictionary service', () => {
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        
        const dictionary = wctx.dictionary;
        expect(dictionary).toBeDefined();
        expect(wctx.dictionary).toBe(dictionary);
    });

    it('should maintain backward compatibility for legacy trust APIs', async () => {
        const { getAgentScorecard, recordSuccess } = await import('../../src/core/trust-engine.js');
        
        let exists = false;
        let data = '';
        
        vi.mocked(fs.existsSync).mockImplementation(() => exists);
        vi.mocked(fs.readFileSync).mockImplementation(() => data);
        vi.mocked(fs.writeFileSync).mockImplementation((_p, d) => {
            exists = true;
            data = d as string;
        });

        // This should not throw and return a valid scorecard
        const scorecard = getAgentScorecard(workspaceDir);
        expect(scorecard).toBeDefined();
        expect(scorecard.trust_score).toBe(85); 

        recordSuccess(workspaceDir, 'success');
        const updatedScorecard = getAgentScorecard(workspaceDir);
        expect(updatedScorecard.trust_score).toBeGreaterThan(85);
    });
});
