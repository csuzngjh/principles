import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleLlmOutput, extractEmpathySignal, isEmpathyAuditPayload } from '../../src/hooks/llm';
import * as painFlags from '../../src/core/pain';
import * as sessionTracker from '../../src/core/session-tracker';
import { ControlUiDatabase } from '../../src/core/control-ui-db';
import { DetectionService } from '../../src/core/detection-service';
import { WorkspaceContext } from '../../src/core/workspace-context';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('../../src/core/pain', () => ({
    writePainFlag: vi.fn(),
}));
vi.mock('../../src/core/control-ui-db');
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
            if (key === 'empathy_engine.enabled') return true;
            if (key === 'empathy_engine.dedupe_window_ms') return 60000;
            if (key === 'empathy_engine.penalties.mild') return 10;
            if (key === 'empathy_engine.penalties.moderate') return 25;
            if (key === 'empathy_engine.penalties.severe') return 40;
            if (key === 'empathy_engine.rate_limit.max_per_turn') return 40;
            if (key === 'empathy_engine.rate_limit.max_per_hour') return 120;
            if (key === 'empathy_engine.model_calibration') return { 'test/test': 0.5 };
            return undefined;
        })
    };

    const mockEventLog = {
        recordRuleMatch: vi.fn(),
        recordPainSignal: vi.fn(),
    };
    const mockControlUiDb = {
        getRecentThinkingContext: vi.fn().mockReturnValue({
            toolCalls: [{ toolName: 'edit', outcome: 'failure', errorType: 'EACCES' }],
            painEvents: [{ source: 'user_empathy', score: 13 }],
            gateBlocks: [],
            userCorrections: [],
            principleEvents: [],
        }),
        recordThinkingModelEvent: vi.fn(),
        dispose: vi.fn(),
    };

    const mockWctx = {
        workspaceDir,
        stateDir: '/mock/workspace/.state',
        config: mockConfig,
        eventLog: mockEventLog,
        trajectory: {
            recordAssistantTurn: vi.fn().mockReturnValue(101),
            recordPainEvent: vi.fn(),
        },
        resolve: vi.fn().mockImplementation((key) => {
            if (key === 'THINKING_OS_USAGE') return path.join(workspaceDir, '.state', 'thinking_os_usage.json');
            return '';
        }),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        sessionTracker.clearSession(sessionId);
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
        vi.mocked(ControlUiDatabase).mockImplementation(function MockControlUiDatabase() {
            return mockControlUiDb as any;
        } as any);
    });

    afterEach(() => {
        vi.useRealTimers();
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
            assistantTexts: ['I am currently struggling to figure out why this test is failing.'],
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
        expect(mockControlUiDb.recordThinkingModelEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                modelId: 'T-06',
                assistantTurnId: expect.any(Number),
            })
        );
    });

    it('should parse structured empathy signal', () => {
        const result = extractEmpathySignal('<empathy signal="damage" severity="severe" confidence="0.75" reason="ignored constraints"/>');
        expect(result).toEqual(expect.objectContaining({
            detected: true,
            severity: 'severe',
            confidence: 0.75,
            mode: 'structured'
        }));
    });


    it('should reject legacy empathy tag when embedded in regular assistant text', () => {
        const result = extractEmpathySignal('User asked me to print [EMOTIONAL_DAMAGE_DETECTED:severe], so I echoed it.');
        expect(result).toEqual(expect.objectContaining({
            detected: false
        }));
    });

    it('should NOT produce user_empathy from empathy JSON in main model output (Path 1 disabled)', () => {
        vi.spyOn(sessionTracker, 'trackFriction').mockImplementation(() => ({ currentGfi: 0 } as any));
        const mockFunnel = { detect: vi.fn().mockReturnValue({ detected: false, source: 'l3_async_queued' }) };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);

        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            model: 'test',
            assistantTexts: ['[EMOTIONAL_DAMAGE_DETECTED:moderate]'],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(sessionTracker.trackFriction).not.toHaveBeenCalledWith(
            sessionId,
            expect.anything(),
            expect.stringContaining('user_empathy'),
            expect.anything(),
            expect.anything()
        );
    });

    it('should NOT produce user_empathy from structured empathy tag in main model output', () => {
        vi.spyOn(sessionTracker, 'trackFriction').mockImplementation(() => ({ currentGfi: 0 } as any));
        const mockFunnel = { detect: vi.fn().mockReturnValue({ detected: false, source: 'l3_async_queued' }) };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);

        const event = {
            runId: 'same-run',
            sessionId,
            provider: 'test',
            model: 'test',
            assistantTexts: ['<empathy signal="damage" severity="severe" confidence="1" reason="reason-a"/>'],
        };

        handleLlmOutput(event as any, { workspaceDir, sessionId } as any);

        expect(sessionTracker.trackFriction).not.toHaveBeenCalledWith(
            sessionId,
            expect.anything(),
            expect.stringContaining('user_empathy'),
            expect.anything(),
            expect.anything()
        );
    });

    it('should filter empathy audit payloads before detection to prevent rule_match pollution', () => {
        const mockFunnel = {
            detect: vi.fn().mockReturnValue({ detected: false, source: 'l3_async_queued' })
        };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);

        const mockEvent = {
            runId: 'r1',
            sessionId,
            provider: 'test',
            assistantTexts: ['{"damageDetected": true, "severity": "moderate", "confidence": 0.8, "reason": "frustration"}'],
        };

        handleLlmOutput(mockEvent as any, { workspaceDir, sessionId } as any);

        expect(mockFunnel.detect).toHaveBeenCalledWith('');
    });

    it('should continue pain processing when trajectory persistence fails', () => {
        const mockFunnel = {
            detect: vi.fn().mockReturnValue({
                detected: true,
                severity: 35,
                ruleId: 'P_CONFUSION_EN',
                source: 'l1_exact'
            })
        };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);
        mockWctx.trajectory.recordAssistantTurn.mockImplementation(() => {
            throw new Error('db offline');
        });

        const logger = {
            warn: vi.fn(),
            info: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };

        handleLlmOutput({
            runId: 'r-fail',
            sessionId,
            provider: 'test',
            model: 'test',
            assistantTexts: ['I am currently struggling to figure out why this test is failing.'],
        } as any, { workspaceDir, sessionId, logger } as any);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to persist assistant turn'));
        expect(painFlags.writePainFlag).toHaveBeenCalledWith(
            workspaceDir,
            expect.objectContaining({
                source: 'llm_p_confusion_en',
                score: '35',
            })
        );
        expect(mockEventLog.recordPainSignal).toHaveBeenCalledWith(
            sessionId,
            expect.objectContaining({
                source: 'llm_p_confusion_en',
                score: 35,
            })
        );
    });

    it('should rollback only the empathy slice when rollback tag is emitted', () => {
        vi.spyOn(sessionTracker, 'resetFriction').mockImplementation(() => ({ currentGfi: 10 } as any));
        const mockFunnel = { detect: vi.fn().mockReturnValue({ detected: false, source: 'l3_async_queued' }) };
        vi.mocked(DetectionService.get).mockReturnValue(mockFunnel as any);
        (mockEventLog as any).getLastEmpathyEventId = vi.fn().mockReturnValue('emp_rollback_1');
        (mockEventLog as any).rollbackEmpathyEvent = vi.fn().mockReturnValue(13);

        handleLlmOutput({
            runId: 'r-rollback',
            sessionId,
            provider: 'test',
            model: 'test',
            assistantTexts: ['[EMPATHY_ROLLBACK_REQUEST]'],
        } as any, { workspaceDir, sessionId } as any);

        expect(mockEventLog.getLastEmpathyEventId).toHaveBeenCalledWith(sessionId);
        expect(mockEventLog.rollbackEmpathyEvent).toHaveBeenCalledWith(
            'emp_rollback_1',
            sessionId,
            'Natural language rollback request detected',
            'natural_language'
        );
        expect(sessionTracker.resetFriction).toHaveBeenCalledWith(sessionId, workspaceDir, {
            source: 'user_empathy',
            amount: 13,
        });
    });
});
