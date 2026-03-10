import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getAgentScorecard, saveAgentScorecard, adjustTrustScore } from '../../src/core/trust-engine.js';
import { EventLogService } from '../../src/core/event-log.js';

vi.mock('fs');
vi.mock('../../src/core/event-log.js');

describe('Trust Engine', () => {
    const workspaceDir = '/mock/workspace';
    const mockEventLog = {
        recordTrustChange: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(EventLogService.get).mockReturnValue(mockEventLog as any);
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    it('should return default scorecard if file does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        const scorecard = getAgentScorecard(workspaceDir);
        expect(scorecard.trust_score).toBe(50);
    });

    it('should read existing scorecard', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ trust_score: 85, wins: 10 }));
        
        const scorecard = getAgentScorecard(workspaceDir);
        expect(scorecard.trust_score).toBe(85);
        expect(scorecard.wins).toBe(10);
    });

    it('should save scorecard and bound trust_score', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true); // directory exists
        
        saveAgentScorecard(workspaceDir, { trust_score: 150 }); // Above bounds
        
        expect(fs.writeFileSync).toHaveBeenCalled();
        const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
        const writtenData = JSON.parse(writeCall[1] as string);
        expect(writtenData.trust_score).toBe(100);

        saveAgentScorecard(workspaceDir, { trust_score: -20 }); // Below bounds
        const writeCall2 = vi.mocked(fs.writeFileSync).mock.calls[1];
        const writtenData2 = JSON.parse(writeCall2[1] as string);
        expect(writtenData2.trust_score).toBe(0);
    });

    it('should correctly adjust trust score and record event', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ trust_score: 50 }));

        const ctx = { sessionId: 's1', api: { logger: {} } as any };
        const newScore = adjustTrustScore(workspaceDir, 20, 'test_reason', ctx);
        
        expect(newScore).toBe(70);
        expect(mockEventLog.recordTrustChange).toHaveBeenCalledWith('s1', {
            previousScore: 50,
            newScore: 70,
            delta: 20,
            reason: 'test_reason'
        });

        const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
        const writtenData = JSON.parse(writeCall[1] as string);
        expect(writtenData.trust_score).toBe(70);
    });
});
