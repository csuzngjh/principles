import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLlmOutput } from '../../src/hooks/llm';
import * as painFlags from '../../src/core/pain';
import * as sessionTracker from '../../src/core/session-tracker';
import { DictionaryService } from '../../src/core/dictionary-service';
import { ConfigService } from '../../src/core/config-service';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('../../src/core/pain', () => ({
    writePainFlag: vi.fn(),
}));
vi.mock('../../src/core/dictionary-service');
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
                return undefined;
            })
        };
        vi.mocked(ConfigService.get).mockReturnValue(mockConfig as any);
    });

    it('should detect confusion patterns via dictionary', () => {
        const mockDict = {
            match: vi.fn().mockReturnValue({ ruleId: 'P_CONFUSION_EN', severity: 35 })
        };
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

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
                reason: 'Agent triggered pain rule: P_CONFUSION_EN'
            })
        );
    });

    it('should detect loop patterns via dictionary', () => {
        const mockDict = {
            match: vi.fn().mockReturnValue({ ruleId: 'P_LOOP_ZH', severity: 45 })
        };
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

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
        const mockDict = {
            match: vi.fn().mockReturnValue(undefined)
        };
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

        // Simulate paralysis in session tracker
        // Needs > 3 turns to start counting stuckLoops, and then 3 consecutive stuck turns
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

    it('should not produce pain flag on confident output', () => {
        const mockDict = {
            match: vi.fn().mockReturnValue(undefined)
        };
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

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
        const mockDict = {
            match: vi.fn().mockReturnValue(undefined)
        };
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

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
