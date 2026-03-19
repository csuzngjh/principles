import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');
vi.mock('../../src/core/trajectory.js', () => ({
    TrajectoryRegistry: {
        get: vi.fn(() => ({
            dispose: vi.fn(),
        })),
        use: vi.fn(),
        dispose: vi.fn(),
        clear: vi.fn(),
    }
}));

describe('WorkspaceContext', () => {
    // Use path.resolve for cross-platform compatibility on Windows
    const workspaceDir = path.resolve('/mock/workspace');
    const stateDir = path.resolve('/mock/state');

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
        const mockCtx1 = { workspaceDir, stateDir: path.resolve('/state1') };
        const mockCtx2 = { workspaceDir, stateDir: path.resolve('/state2') };
        
        const wctx1 = WorkspaceContext.fromHookContext(mockCtx1);
        const wctx2 = WorkspaceContext.fromHookContext(mockCtx2);
        
        expect(wctx1).toBe(wctx2);
        expect(wctx1.stateDir).toBe(path.resolve('/state1'));
    });

    it('should use fallback workspace when workspaceDir is missing', () => {
        const mockCtx = { stateDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        expect(wctx).toBeDefined();
        expect(wctx.workspaceDir).toBeDefined();
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
        const { ConfigService } = await import('../../src/core/config-service.js');
        
        // Reset ConfigService singleton to ensure clean state
        ConfigService.reset();
        
        // Track file system state
        const files: Record<string, { exists: boolean; data: string }> = {};
        
        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const key = p.toString();
            return files[key]?.exists ?? false;
        });
        
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const key = p.toString();
            return files[key]?.data ?? '';
        });
        
        vi.mocked(fs.writeFileSync).mockImplementation((p, d) => {
            const key = p.toString();
            files[key] = { exists: true, data: d as string };
        });
        
        vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);

        // This should not throw and return a valid scorecard
        const scorecard = getAgentScorecard(workspaceDir);
        expect(scorecard).toBeDefined();
        expect(scorecard.trust_score).toBe(85); 

        recordSuccess(workspaceDir, 'success');
        const updatedScorecard = getAgentScorecard(workspaceDir);
        expect(updatedScorecard.trust_score).toBeGreaterThan(85);
    });
});
