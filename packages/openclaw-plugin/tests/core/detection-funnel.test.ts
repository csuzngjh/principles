import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DetectionFunnel } from '../../src/core/detection-funnel.js';

describe('DetectionFunnel', () => {
    const mockDictionary = {
        match: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });


    it('should skip protocol text before dictionary and queue checks', () => {
        const funnel = new DetectionFunnel(mockDictionary as any);
        const enqueueSpy = vi.spyOn(funnel as any, 'enqueueAsync');

        const result = funnel.detect('[EVOLUTION_ACK]');

        expect(result).toEqual({ detected: false, source: 'l1_exact' });
        expect(mockDictionary.match).not.toHaveBeenCalled();
        expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('L1: should return true immediately if dictionary matches', async () => {
        mockDictionary.match.mockReturnValue({ ruleId: 'P_CONFUSION', severity: 35 });
        const funnel = new DetectionFunnel(mockDictionary as any);

        const result = funnel.detect('I am confused');

        expect(result.detected).toBe(true);
        expect(result.source).toBe('l1_exact');
        expect(mockDictionary.match).toHaveBeenCalledWith('I am confused');
    });

    it('L2: should return true if found in cache after initial mismatch', async () => {
        mockDictionary.match.mockReturnValue(undefined);
        const funnel = new DetectionFunnel(mockDictionary as any);

        // Manually prime the cache for testing (or simulate a previous L3 hit)
        (funnel as any).cache.set('hash_123', { detected: true, severity: 40 });

        // We need a stable hash for the test
        vi.spyOn(funnel as any, 'computeHash').mockReturnValue('hash_123');

        const result = funnel.detect('Some repetitive text');

        expect(result.detected).toBe(true);
        expect(result.source).toBe('l2_cache');
    });

    it('L3: should enqueue for async detection if mismatch and not in cache', () => {
        mockDictionary.match.mockReturnValue(undefined);
        const funnel = new DetectionFunnel(mockDictionary as any);
        const enqueueSpy = vi.spyOn(funnel as any, 'enqueueAsync');

        const result = funnel.detect('New unknown expression');

        expect(result.detected).toBe(false);
        expect(result.source).toBe('l3_async_queued');
        expect(enqueueSpy).toHaveBeenCalledWith('New unknown expression');
    });
});
