import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getAgentScorecard, saveAgentScorecard, adjustTrustScore } from '../../src/core/trust-engine.js';

vi.mock('fs');

describe('Trust Engine', () => {
    const workspaceDir = '/mock/workspace';

    beforeEach(() => {
        vi.clearAllMocks();
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

    it('should correctly adjust trust score', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ trust_score: 50 }));

        const newScore = adjustTrustScore(workspaceDir, 20);
        expect(newScore).toBe(70);

        const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
        const writtenData = JSON.parse(writeCall[1] as string);
        expect(writtenData.trust_score).toBe(70);
    });
});
