import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePdPath } from '../../src/core/paths.js';

describe('Path Anchoring Integration', () => {
    const workspaceDir = '/mock/workspace';

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should resolve PROFILE.json inside .principles/', () => {
        const expected = '/mock/workspace/.principles/PROFILE.json';
        expect(resolvePdPath(workspaceDir, 'PROFILE')).toBe(expected);
    });

    it('should resolve AGENT_SCORECARD.json inside .state/', () => {
        const expected = '/mock/workspace/.state/AGENT_SCORECARD.json';
        expect(resolvePdPath(workspaceDir, 'AGENT_SCORECARD')).toBe(expected);
    });
});
