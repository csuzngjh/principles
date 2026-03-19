import { describe, it, expect, vi, beforeEach } from 'vitest';
import { planStatus } from '../../src/utils/io.js';
import { resolvePdPath } from '../../src/core/paths.js';
import * as fs from 'fs';

vi.mock('fs');

describe('Path Anchoring Integration', () => {
    const workspaceDir = '/mock/workspace';

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should resolve PROFILE.json inside .principles/', () => {
        const expected = '/mock/workspace/.principles/PROFILE.json';
        expect(resolvePdPath(workspaceDir, 'PROFILE')).toBe(expected);
    });

    it('should resolve PLAN.md at the project root', () => {
        const expected = '/mock/workspace/PLAN.md';
        expect(resolvePdPath(workspaceDir, 'PLAN')).toBe(expected);
    });

    it('should resolve AGENT_SCORECARD.json inside .state/', () => {
        const expected = '/mock/workspace/.state/AGENT_SCORECARD.json';
        expect(resolvePdPath(workspaceDir, 'AGENT_SCORECARD')).toBe(expected);
    });

    it('planStatus should look for PLAN.md in the root', () => {
        const rootPlanPath = '/mock/workspace/PLAN.md';
        vi.mocked(fs.existsSync).mockImplementation((p) => p === rootPlanPath);
        vi.mocked(fs.readFileSync).mockReturnValue('STATUS: READY');

        const status = planStatus(workspaceDir);
        
        expect(status).toBe('READY');
        expect(fs.existsSync).toHaveBeenCalledWith(rootPlanPath);
        // Verify it does NOT look in docs/
        expect(fs.existsSync).not.toHaveBeenCalledWith(expect.stringContaining('docs/PLAN.md'));
    });
});
