import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvolutionWorkerService } from '../../src/service/evolution-worker.js';
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
// Mocking checkPainFlag and processEvolutionQueue to avoid complex setup
vi.mock('../../src/service/evolution-worker', async () => {
    const actual = await vi.importActual('../../src/service/evolution-worker') as any;
    return {
        ...actual
    };
});

describe('EvolutionWorkerService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
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
