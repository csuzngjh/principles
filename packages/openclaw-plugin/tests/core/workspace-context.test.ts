import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
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
const { mockRuleHostCalls } = vi.hoisted(() => ({
    mockRuleHostCalls: [] as Array<{ stateDir: unknown; logger: unknown; options: unknown }>,
}));
vi.mock('../../src/core/rule-host.js', () => ({
    // Plain constructor (not vi.fn) so vi.resetAllMocks() in afterEach cannot
    // wipe the implementation and leave dispose-less instances behind.
    RuleHost: function RuleHostMock(stateDir: unknown, logger: unknown, options: unknown) {
        mockRuleHostCalls.push({ stateDir, logger, options });
        return { updateLogger: () => {}, dispose: () => {} };
    },
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
        EventLogService.disposeAll();
    });

    it('should bind the canonical workspace stateDir even when the host ctx carries a different stateDir (PRI-824 T824-1)', () => {
        const mockCtx = { workspaceDir, stateDir };
        const wctx = WorkspaceContext.fromHookContext(mockCtx);

        expect(wctx.workspaceDir).toBe(workspaceDir);
        expect(wctx.stateDir).toBe(path.join(workspaceDir, '.state'));
        expect(wctx.stateDir).not.toBe(stateDir);
    });

    it('should keep the cached instance on the canonical stateDir across differing host stateDirs (PRI-824 T824-2)', () => {
        const gatewayStartLike = { workspaceDir, stateDir: path.resolve('/host/home') };
        const beforeToolCallLike = { workspaceDir };

        const wctx1 = WorkspaceContext.fromHookContext(gatewayStartLike);
        const wctx2 = WorkspaceContext.fromHookContext(beforeToolCallLike);

        expect(wctx1).toBe(wctx2);
        expect(wctx1.stateDir).toBe(path.join(workspaceDir, '.state'));
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
        // THINKING_OS is at .principles/THINKING_OS.md
        expect(wctx.resolve('THINKING_OS')).toBe(path.join(workspaceDir, '.principles', 'THINKING_OS.md'));
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

    it('should construct RuleHost on the canonical workspace stateDir (PRI-824 T824-4)', () => {
        mockRuleHostCalls.length = 0;
        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, stateDir: path.resolve('/host/home') });

        wctx.getRuleHost({});

        expect(mockRuleHostCalls).toEqual([
            { stateDir: path.join(workspaceDir, '.state'), logger: {}, options: { workspaceDir } },
        ]);
    });

    it('should report a diverging host stateDir exactly once via the structured PRI-824 warning (rc-9)', () => {
        const warn = vi.fn();
        const wctx = WorkspaceContext.fromHookContext({
            workspaceDir,
            stateDir: path.resolve('/host/home'),
            logger: { warn },
        });

        expect(wctx.stateDir).toBe(path.join(workspaceDir, '.state'));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('PRI-824');
    });

    it('should not warn when the host stateDir already is the canonical path', () => {
        const warn = vi.fn();
        const canonical = path.join(workspaceDir, '.state');
        const wctx = WorkspaceContext.fromHookContext({
            workspaceDir,
            stateDir: canonical,
            logger: { warn },
        });

        expect(wctx.stateDir).toBe(canonical);
        expect(warn).not.toHaveBeenCalled();
    });

    it('should ignore non-string or blank host stateDir values without warning', () => {
        const warn = vi.fn();
        WorkspaceContext.fromHookContext({ workspaceDir, stateDir: '   ', logger: { warn } });
        WorkspaceContext.clearCache();
        WorkspaceContext.fromHookContext({ workspaceDir, stateDir: 42, logger: { warn } });

        expect(warn).not.toHaveBeenCalled();
    });

    it('should canonicalize through fromHookContextExplicit as well (PRI-824)', () => {
        const wctx = WorkspaceContext.fromHookContextExplicit({
            workspaceDir,
            logger: { warn: vi.fn() },
        });

        expect(wctx.stateDir).toBe(path.join(workspaceDir, '.state'));
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
        expect(principleTreeLedger.getPrincipleSubtree).toHaveBeenCalledWith(path.join(workspaceDir, '.state'), 'P-001');
        expect(activePrincipleSubtrees).toEqual([
            {
                principle: activePrinciples[0],
                subtree,
            },
        ]);
    });
});
