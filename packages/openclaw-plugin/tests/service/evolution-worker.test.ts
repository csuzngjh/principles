import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvolutionWorkerService } from '../../src/service/evolution-worker.js';
import { DictionaryService } from '../../src/core/dictionary-service.js';

vi.mock('../../src/core/dictionary-service');
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

        const ctx = {
            workspaceDir: '/mock/workspace',
            stateDir: '/mock/state',
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
        };

        EvolutionWorkerService.start(ctx as any);

        // Advance by 15 minutes
        vi.advanceTimersByTime(15 * 60 * 1000);

        expect(mockDict.flush).toHaveBeenCalled();
        
        EvolutionWorkerService.stop(ctx as any);
    });
});
