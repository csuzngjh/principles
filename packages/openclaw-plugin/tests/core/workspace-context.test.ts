import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as fs from 'fs';
import * as path from 'path';
import * as principleTreeLedger from '../../src/core/principle-tree-ledger.js';

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
vi.mock('../../src/core/principle-tree-ledger.js', () => ({
    getPrincipleSubtree: vi.fn(),
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

    it('should pass trajectory settings from config into the registry', async () => {
        const { TrajectoryRegistry } = await import('../../src/core/trajectory.js');
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);

        (wctx as any)._config = {
            get: vi.fn((key: string) => {
                if (key === 'trajectory.blob_inline_threshold_bytes') return 2048;
                if (key === 'trajectory.busy_timeout_ms') return 1500;
                if (key === 'trajectory.orphan_blob_grace_days') return 2;
                return undefined;
            }),
        };

        const trajectory = wctx.trajectory;
        expect(trajectory).toBeDefined();
        expect(TrajectoryRegistry.get).toHaveBeenCalledWith(workspaceDir, {
            blobInlineThresholdBytes: 2048,
            busyTimeoutMs: 1500,
            orphanBlobGraceDays: 2,
        });
    });

    it('should lazy load Dictionary service', () => {
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        
        const dictionary = wctx.dictionary;
        expect(dictionary).toBeDefined();
        expect(wctx.dictionary).toBe(dictionary);
    });

    it('should cache a workspace-scoped principle tree ledger accessor', () => {
        const mockCtx = { workspaceDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);

        const principleTreeLedgerAccessor = (wctx as any).principleTreeLedger;

        expect(principleTreeLedgerAccessor).toBeDefined();
        expect((wctx as any).principleTreeLedger).toBe(principleTreeLedgerAccessor);
        expect(typeof principleTreeLedgerAccessor.getPrincipleSubtree).toBe('function');
    });

    it('should retrieve active principle subtrees through the workspace boundary', () => {
        const mockCtx = { workspaceDir, stateDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);
        const activePrinciples = [
            {
                id: 'P-001',
                trigger: 'delete',
                contextTags: ['write'],
                valueMetrics: undefined,
            },
        ];
        const subtree = {
            principle: { id: 'P-001', ruleIds: ['R-001'] },
            rules: [
                {
                    rule: { id: 'R-001', implementationIds: ['IMPL-001'] },
                    implementations: [{ id: 'IMPL-001', ruleId: 'R-001', type: 'prompt' }],
                },
            ],
        };

        vi.mocked(principleTreeLedger.getPrincipleSubtree).mockReturnValue(subtree as any);
        (wctx as any)._evolutionReducer = {
            getActivePrinciples: vi.fn().mockReturnValue(activePrinciples),
        };

        const activePrincipleSubtrees = (wctx as any).getActivePrincipleSubtrees();

        expect((wctx as any)._evolutionReducer.getActivePrinciples).toHaveBeenCalled();
        expect(principleTreeLedger.getPrincipleSubtree).toHaveBeenCalledWith(stateDir, 'P-001');
        expect(activePrincipleSubtrees).toEqual([
            {
                principle: activePrinciples[0],
                subtree,
            },
        ]);
    });
});
