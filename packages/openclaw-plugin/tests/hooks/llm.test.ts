import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLlmOutput } from '../../src/hooks/llm';
import * as painFlags from '../../src/core/pain';
import * as sessionTracker from '../../src/core/session-tracker';
import { DetectionService } from '../../src/core/detection-service';
import { WorkspaceContext } from '../../src/core/workspace-context';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('../../src/core/pain', () => ({
    writePainFlag: vi.fn(),
}));
vi.mock('../../src/core/detection-service');
vi.mock('../../src/core/workspace-context');

describe('LLM Cognitive Distress Hook', () => {
    const workspaceDir = '/mock/workspace';
    const sessionId = 'test-session-auth';

    const mockConfig = {
        get: vi.fn((key) => {
            if (key === 'thresholds.stuck_loops_trigger') return 3;
            if (key === 'thresholds.cognitive_paralysis_input') return 4000;
            if (key === 'scores.paralysis') return 40;
            if (key === 'thresholds.pain_trigger') return 30;
            if (key === 'scores.default_confusion') return 35;
            return undefined;
        })
    };

    const mockEventLog = {
        recordRuleMatch: vi.fn(),
        recordPainSignal: vi.fn(),
    };

    const mockWctx = {
        workspaceDir,
        stateDir: '/mock/workspace/.state',
        config: mockConfig,
        eventLog: mockEventLog,
        resolve: vi.fn().mockImplementation((key) => {
            if (key === 'THINKING_OS_USAGE') return path.join(workspaceDir, '.state', 'thinking_os_usage.json');
            return '';
        }),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        sessionTracker.clearSession(sessionId);
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    });

    it('should detect confusion patterns via detection funnel (L1)', () => {
        const mockFunnel = {
            detect: vi.fn().mockReturnValue({ 
                detected: true, 
                severity: 35, 
                ruleId: 'P_CONFUSION_EN',
                source: 'l1_exact' 
            })
        };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);

        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            assistantTexts: ["I am currently struggling to figure out why this test is failing."],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(painFlags.writePainFlag).toHaveBeenCalledWith(
            workspaceDir,
            expect.objectContaining({ 
                source: 'llm_p_confusion_en', 
                score: '35',
                reason: expect.stringContaining('P_CONFUSION_EN')
            })
        );
    });

    it('should track Thinking OS mental model usage when signal is detected', () => {
        const mockFunnel = {
            detect: vi.fn().mockReturnValue({ detected: false, source: 'l3_async_queued' })
        };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);

        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            model: 'test',
            assistantTexts: ["According to Occam's Razor, the simplest approach is best."],
        };

        const usageLogPath = path.join(workspaceDir, '.state', 'thinking_os_usage.json');

        vi.mocked(fs.existsSync).mockReturnValue(false);
        const mockWrite = vi.fn();
        vi.mocked(fs.writeFileSync).mockImplementation(mockWrite);

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(mockWrite).toHaveBeenCalledWith(
            usageLogPath,
            expect.stringContaining('"T-06": 1'),
            'utf8'
        );
    });
});
