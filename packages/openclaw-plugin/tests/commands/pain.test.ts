import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePainCommand } from '../../src/commands/pain.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('../../src/core/session-tracker.js');
vi.mock('../../src/core/workspace-context.js');

describe('Pain Command', () => {
    const workspaceDir = '/mock/workspace';
    const sessionId = 's1';

    const mockDictionary = {
        getStats: vi.fn().mockReturnValue({ totalRules: 10, totalHits: 5 })
    };

    const mockTrust = {
        getScore: vi.fn().mockReturnValue(85),
        getStage: vi.fn().mockReturnValue(3),
        resetTrust: vi.fn()
    };

    const mockEventLog = {
        getEmpathyStats: vi.fn().mockReturnValue({
            totalEvents: 0,
            dedupedCount: 0,
            dedupeHitRate: 0,
            totalPenaltyScore: 0,
            rolledBackScore: 0,
            rollbackCount: 0,
            bySeverity: { mild: 0, moderate: 0, severe: 0 },
            scoreBySeverity: { mild: 0, moderate: 0, severe: 0 },
            byDetectionMode: { structured: 0, legacy_tag: 0 },
            byOrigin: { assistant_self_report: 0, user_manual: 0, system_infer: 0 },
            confidenceDistribution: { high: 0, medium: 0, low: 0 },
            dailyTrend: [],
        })
    };

    const mockConfig = {
        get: vi.fn().mockImplementation((key: string) => {
            if (key === 'language') return 'en';
            return undefined;
        })
    };

    const mockWctx = {
        workspaceDir,
        dictionary: mockDictionary,
        trust: mockTrust,
        eventLog: mockEventLog,
        config: mockConfig
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    });

    it('should format a comprehensive pain report', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 45 } as any);
        
        const result = handlePainCommand({ 
            args: '', 
            config: { workspaceDir, language: 'en' },
            sessionId 
        } as any);

        expect(result.text).toContain('Friction (GFI)**: [');
        expect(result.text).toContain('] 45/100');
        expect(result.text).toContain('Trust Score**: [');
        expect(result.text).toContain('] 85/100');
        expect(result.text).toContain('Dictionary**: 10');
        expect(result.text).toContain('blocked 5');
    });

    it('should show 🟢 status for low GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 10 } as any);
        const result = handlePainCommand({ config: { workspaceDir }, sessionId } as any);
        expect(result.text).toContain('10/100');
    });

    it('should show 🔴 status for high GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);
        const result = handlePainCommand({ config: { workspaceDir }, sessionId } as any);
        expect(result.text).toContain('85/100');
    });

    it('should handle trust-reset subcommand', () => {
        const result = handlePainCommand({ 
            args: 'trust-reset', 
            config: { workspaceDir, language: 'en' },
            sessionId 
        } as any);
        
        expect(mockTrust.resetTrust).toHaveBeenCalled();
        expect(result.text).toContain('Agent trust score has been reset');
    });
});