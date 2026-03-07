import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLlmOutput } from '../../src/hooks/llm';
import * as painFlags from '../../src/core/pain';
import * as sessionTracker from '../../src/core/session-tracker';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
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

    it('should track Thinking OS mental model usage when signal is detected', () => {
        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            model: 'test',
            assistantTexts: ["According to Occam's Razor, the simplest approach is best."],
        };

        const usageLogPath = path.join(workspaceDir, 'docs', '.thinking_os_usage.json');

        let writeCount = 0;
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
            if (p.toString().includes('.thinking_os_usage.json') && writeCount > 0) return true;
            return false;
        });

        const mockWrite = vi.fn();
        vi.mocked(fs.writeFileSync).mockImplementation(mockWrite);

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);
        console.log(JSON.stringify(mockWrite.mock.calls, null, 2));

        expect(mockWrite).toHaveBeenCalledWith(
            usageLogPath,
            expect.stringContaining('"T-06": 1'),
            'utf8'
        );
        expect(mockWrite).toHaveBeenCalledWith(
            usageLogPath,
            expect.stringContaining('"_total_turns": 1'),
            'utf8'
        );
    });
});
