import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvolutionWorkerService, hasRecentDuplicateTask, hasEquivalentPromotedRule } from '../../src/service/evolution-worker.js';
import { DictionaryService } from '../../src/core/dictionary-service.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as eventLog from '../../src/core/event-log.js';
import * as path from 'path';

vi.mock('../../src/core/dictionary-service');
vi.mock('../../src/core/session-tracker', () => ({
    initPersistence: vi.fn(),
    flushAllSessions: vi.fn(),
}));
vi.mock('../../src/core/event-log', () => ({
    EventLogService: {
        get: vi.fn(() => ({
            recordEvolutionTask: vi.fn(),
            recordRulePromotion: vi.fn(),
            flush: vi.fn(),
        })),
    },
}));

describe('EvolutionWorkerService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });


    it('should detect recent duplicate tasks by source and preview', () => {
        const now = new Date('2026-03-18T00:30:00.000Z').getTime();
        const queue = [
            {
                id: 'a1',
                score: 50,
                source: 'llm_p_frustration_023',
                reason: 'pain',
                trigger_text_preview: '[EVOLUTION_ACK] 有失败记录',
                timestamp: '2026-03-18T00:10:00.000Z',
                status: 'pending',
            },
        ];

        expect(hasRecentDuplicateTask(queue as any, 'llm_p_frustration_023', '[EVOLUTION_ACK] 有失败记录', now)).toBe(true);
        expect(hasRecentDuplicateTask(queue as any, 'llm_p_frustration_023', 'different preview', now)).toBe(false);
    });

    it('should skip promoting duplicate exact-match rules', () => {
        const dictionary = {
            getAllRules: () => ({
                EXISTING: {
                    type: 'exact_match',
                    phrases: ['Need more evidence'],
                    status: 'active',
                },
            }),
        };

        expect(hasEquivalentPromotedRule(dictionary as any, 'Need more evidence')).toBe(true);
        expect(hasEquivalentPromotedRule(dictionary as any, 'Another phrase')).toBe(false);
    });

    it('should flush the dictionary on its interval', () => {
        const mockDict = {
            flush: vi.fn()
        };
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

        // Use path.resolve for cross-platform compatibility
        const workspaceDir = path.resolve('/mock/workspace');
        const expectedStateDir = path.join(workspaceDir, '.state');

        const ctx = {
            workspaceDir,
            stateDir: path.resolve('/mock/state'),
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
        };

        EvolutionWorkerService.start(ctx as any);

        // Advance by 15 minutes
        vi.advanceTimersByTime(15 * 60 * 1000);

        expect(mockDict.flush).toHaveBeenCalled();
        // Service now uses workspace-specific stateDir, not ctx.stateDir
        expect(sessionTracker.initPersistence).toHaveBeenCalledWith(expectedStateDir);
        expect(sessionTracker.flushAllSessions).toHaveBeenCalled();
        
        EvolutionWorkerService.stop(ctx as any);
    });
});
