import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLlmOutput } from '../../src/hooks/llm';
import * as painFlags from '../../src/core/pain';
import * as sessionTracker from '../../src/core/session-tracker';
import { DetectionService } from '../../src/core/detection-service';
import { ConfigService } from '../../src/core/config-service';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('../../src/core/pain', () => ({
    writePainFlag: vi.fn(),
}));
vi.mock('../../src/core/detection-service');
vi.mock('../../src/core/config-service');

describe('LLM Cognitive Distress Hook', () => {
    const workspaceDir = '/mock/workspace';
    const sessionId = 'test-session-auth';

    beforeEach(() => {
        vi.clearAllMocks();
        sessionTracker.clearSession(sessionId);

        // Mock config behavior
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
        vi.mocked(ConfigService.get).mockReturnValue(mockConfig as any);
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

    it('should detect loop patterns via detection funnel (L1)', () => {
        const mockFunnel = {
            detect: vi.fn().mockReturnValue({ 
                detected: true, 
                severity: 45, 
                ruleId: 'P_LOOP_ZH',
                source: 'l1_exact' 
            })
        };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);

        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            assistantTexts: ["似乎我们一直在原地打转。"],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(painFlags.writePainFlag).toHaveBeenCalledWith(
            workspaceDir,
            expect.objectContaining({ source: 'llm_p_loop_zh', score: '45' })
        );
    });

    it('should detect cognitive paralysis even without dictionary match', () => {
        const mockFunnel = {
            detect: vi.fn().mockReturnValue({ detected: false, source: 'l3_async_queued' })
        };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);

        // Simulate paralysis in session tracker
        sessionTracker.trackLlmOutput(sessionId, { input: 5000, output: 10 }); // turn 1
        sessionTracker.trackLlmOutput(sessionId, { input: 5000, output: 10 }); // turn 2
        sessionTracker.trackLlmOutput(sessionId, { input: 5000, output: 10 }); // turn 3
        sessionTracker.trackLlmOutput(sessionId, { input: 5000, output: 10 }); // turn 4 (stuckLoops = 1)
        sessionTracker.trackLlmOutput(sessionId, { input: 5000, output: 10 }); // turn 5 (stuckLoops = 2)
        sessionTracker.trackLlmOutput(sessionId, { input: 5000, output: 10 }); // turn 6 (stuckLoops = 3)

        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            assistantTexts: ["..."],
            usage: { input: 5000, output: 10 }
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(painFlags.writePainFlag).toHaveBeenCalledWith(
            workspaceDir,
            expect.objectContaining({ source: 'llm_paralysis', score: '40' })
        );
    });

    it('should not produce pain flag on confident output (async queued)', () => {
        const mockFunnel = {
            detect: vi.fn().mockReturnValue({ detected: false, source: 'l3_async_queued' })
        };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);

        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            model: 'test',
            assistantTexts: ["Here is the fixed code. I have verified the test passes."],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(painFlags.writePainFlag).not.toHaveBeenCalled();
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

        const stateDir = path.join(workspaceDir, 'memory', '.state');
        const usageLogPath = path.join(stateDir, 'thinking_os_usage.json');

        let writeCount = 0;
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
            const pStr = p.toString();
            if (pStr === stateDir) return true;
            if (pStr === usageLogPath && writeCount > 0) return true;
            return false;
        });

        const mockWrite = vi.fn();
        vi.mocked(fs.writeFileSync).mockImplementation(mockWrite);

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId, stateDir } as any);

        expect(mockWrite).toHaveBeenCalledWith(
            usageLogPath,
            expect.stringContaining('"T-06": 1'),
            'utf8'
        );
    });
});
