import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DetectionService } from '../../src/core/detection-service.js';
import { DictionaryService } from '../../src/core/dictionary-service.js';
import { DetectionFunnel } from '../../src/core/detection-funnel.js';

vi.mock('../../src/core/dictionary-service.js');
vi.mock('../../src/core/detection-funnel.js');

describe('DetectionService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        DetectionService.reset();
    });

    it('should create a new instance on first get', () => {
        const mockDict = {};
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

        const funnel1 = DetectionService.get('/dir1');
        
        expect(DictionaryService.get).toHaveBeenCalledWith('/dir1');
        expect(DetectionFunnel).toHaveBeenCalledWith(mockDict);
        expect(funnel1).toBeDefined();
    });

    it('should return the same instance for the same stateDir', () => {
        const funnel1 = DetectionService.get('/dir1');
        const funnel2 = DetectionService.get('/dir1');

        expect(funnel1).toBe(funnel2);
        expect(DictionaryService.get).toHaveBeenCalledTimes(1);
    });

    it('should create a new instance if stateDir changes', () => {
        const funnel1 = DetectionService.get('/dir1');
        const funnel2 = DetectionService.get('/dir2');

        expect(funnel1).not.toBe(funnel2);
        expect(DictionaryService.get).toHaveBeenCalledTimes(2);
        expect(DictionaryService.get).toHaveBeenNthCalledWith(2, '/dir2');
    });

    it('should reset the instance correctly', () => {
        DetectionService.get('/dir1');
        DetectionService.reset();
        DetectionService.get('/dir1');

        expect(DictionaryService.get).toHaveBeenCalledTimes(2);
    });
});
