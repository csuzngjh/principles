import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLlmOutput } from '../../src/hooks/llm';
import * as painFlags from '../../src/core/pain';
import * as sessionTracker from '../../src/core/session-tracker';

vi.mock('../../src/core/pain', () => ({
    writePainFlag: vi.fn(),
}));

describe('LLM Cognitive Distress Hook', () => {
    const workspaceDir = '/mock/workspace';
    const sessionId = 'test-session-auth';

    beforeEach(() => {
        vi.clearAllMocks();
        sessionTracker.clearSession(sessionId);
    });

    it('should detect English confusion patterns', () => {
        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            assistantTexts: ["I am currently struggling to figure out why this test is failing."],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(painFlags.writePainFlag).toHaveBeenCalledWith(
            workspaceDir,
            expect.objectContaining({ source: 'llm_confusion', score: '35' })
        );
    });

    it('should detect Chinese confusion patterns', () => {
        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            assistantTexts: ["这个问题看起来比我预期的要复杂得多。"],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(painFlags.writePainFlag).toHaveBeenCalledWith(
            workspaceDir,
            expect.objectContaining({ source: 'llm_confusion', score: '35' })
        );
    });

    it('should escalate score when looping matches with confusion in English', () => {
        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            model: 'test',
            assistantTexts: ["I am confused. It seems we are going in circles."],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(painFlags.writePainFlag).toHaveBeenCalledWith(
            workspaceDir,
            expect.objectContaining({ source: 'llm_confusion_loop', score: '45' })
        );
    });

    it('should escalate score when looping matches with confusion in Chinese', () => {
        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            assistantTexts: ["我不太清楚怎么做，似乎我们一直在原地打转。"],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(painFlags.writePainFlag).toHaveBeenCalledWith(
            workspaceDir,
            expect.objectContaining({ source: 'llm_confusion_loop', score: '45' })
        );
    });

    it('should not produce pain flag on confident output', () => {
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
});
