import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTrustCommand } from '../../src/commands/trust.js';
import * as trustEngine from '../../src/core/trust-engine.js';

vi.mock('../../src/core/trust-engine.js');

describe('Trust Command', () => {
    const workspaceDir = '/mock/workspace';

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return correct scorecard message for Stage 2', () => {
        vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 55 });
        const result = handleTrustCommand({ workspaceDir } as any);
        expect(result).toContain('Current Score**: 55/100');
        expect(result).toContain('Security Stage**: 2 (Editor)');
    });

    it('should return correct scorecard message for Stage 4', () => {
        vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 95 });
        const result = handleTrustCommand({ workspaceDir } as any);
        expect(result).toContain('Current Score**: 95/100');
        expect(result).toContain('Security Stage**: 4 (Architect)');
        expect(result).toContain('MAX LEVEL REACHED');
    });

    it('should return error if workspaceDir is missing', () => {
        const result = handleTrustCommand({} as any);
        expect(result).toContain('Error');
    });
});
