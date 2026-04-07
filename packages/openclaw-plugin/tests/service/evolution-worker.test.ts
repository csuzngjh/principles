import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    EvolutionWorkerService,
    createEvolutionTaskId,
    extractEvolutionTaskId,
    hasRecentDuplicateTask,
    hasEquivalentPromotedRule,
    registerEvolutionTaskSession,
} from '../../src/service/evolution-worker.js';
import { DictionaryService } from '../../src/core/dictionary-service.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as eventLog from '../../src/core/event-log.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluatePhase3Inputs } from '../../src/service/phase3-input-filter.js';
import { safeRmDir } from '../test-utils.js';

vi.mock('../../src/core/dictionary-service');
vi.mock('../../src/core/session-tracker', () => ({
    initPersistence: vi.fn(),
    flushAllSessions: vi.fn(),
    listSessions: vi.fn(() => []), // Returns empty sessions for idle detection
}));

describe('EvolutionWorkerService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });


    it('should detect recent duplicate tasks by source and preview', () => {
        const now = new Date('2026-03-18T00:30:00.000Z').getTime();
        const queue = [
            {
                id: 'a1',
                score: 50,
                source: 'llm_p_frustration_023',
                reason: 'pain',
                trigger_text_preview: '[EVOLUTION_ACK] 有失败记录',
                timestamp: '2026-03-18T00:10:00.000Z',
                status: 'pending',
            },
        ];

        expect(hasRecentDuplicateTask(queue as any, 'llm_p_frustration_023', '[EVOLUTION_ACK] 有失败记录', now, 'pain')).toBe(true);
        expect(hasRecentDuplicateTask(queue as any, 'llm_p_frustration_023', 'different preview', now, 'pain')).toBe(false);
        // Different reason should not be considered duplicate
        expect(hasRecentDuplicateTask(queue as any, 'llm_p_frustration_023', '[EVOLUTION_ACK] 有失败记录', now, 'different_reason')).toBe(false);
    });

    it('should skip promoting duplicate exact-match rules', () => {
        const dictionary = {
            getAllRules: () => ({
                EXISTING: {
                    type: 'exact_match',
                    phrases: ['Need more evidence'],
                    status: 'active',
                },
            }),
        };

        expect(hasEquivalentPromotedRule(dictionary as any, 'Need more evidence')).toBe(true);
        expect(hasEquivalentPromotedRule(dictionary as any, 'Another phrase')).toBe(false);
    });

    it('should generate distinct ids for different pain reasons with the same preview', () => {
        const now = new Date('2026-03-20T06:38:32.222Z').getTime();

        const idA = createEvolutionTaskId(
            'tool_failure',
            50,
            '',
            'Tool edit failed on memory/.scratchpad.md',
            now
        );
        const idB = createEvolutionTaskId(
            'tool_failure',
            50,
            '',
            'Tool edit failed on MEMORY.md',
            now
        );

        expect(idA).not.toBe(idB);
    });

    it('should extract evolution task ids from diagnostician payloads', () => {
        expect(extractEvolutionTaskId('Diagnose systemic pain [ID: ab12cd34]. Source: tool_failure.')).toBe('ab12cd34');
        expect(extractEvolutionTaskId('plain task without id')).toBeNull();
    });

    it('should register assigned diagnostician session on the matching in-progress task', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-session-'));
        const queuePath = path.join(dir, 'evolution_queue.json');

        fs.writeFileSync(queuePath, JSON.stringify([
            { id: 'task-a', status: 'pending', score: 40, source: 'pain', reason: 'a', timestamp: '2026-03-20T00:00:00.000Z' },
            { id: 'task-b', status: 'in_progress', score: 80, source: 'pain', reason: 'b', timestamp: '2026-03-20T00:00:00.000Z' }
        ], null, 2), 'utf8');

        try {
            const registered = await registerEvolutionTaskSession(
                () => queuePath,
                'task-b',
                'agent:diagnostician:session-1',
                { warn: vi.fn() }
            );

            expect(registered).toBe(true);
            const saved = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
            expect(saved[1].assigned_session_key).toBe('agent:diagnostician:session-1');
            expect(saved[1].started_at).toBeDefined();
        } finally {
            safeRmDir(dir);
        }
    });

    it('should process queue work without persisting a legacy directive file', async () => {
        const mockDict = {
            flush: vi.fn()
        };
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-worker-'));
        const stateDir = path.join(workspaceDir, '.state');
        fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
        fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
        fs.writeFileSync(
            path.join(stateDir, 'evolution_queue.json'),
            JSON.stringify([
                { id: 'task-1', score: 90, source: 'tool_failure', reason: 'write failed', timestamp: '2026-03-20T00:00:00.000Z', status: 'pending' },
            ], null, 2),
            'utf8'
        );

        const ctx = {
            workspaceDir,
            stateDir,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
        };

        try {
            EvolutionWorkerService.start(ctx as any);

            await vi.advanceTimersByTimeAsync(5000);

            const queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_queue.json'), 'utf8'));
            expect(queue[0].status).toBe('in_progress');
            expect(fs.existsSync(path.join(stateDir, 'evolution_directive.json'))).toBe(false);
        } finally {
            EvolutionWorkerService.stop(ctx as any);
            safeRmDir(workspaceDir);
        }
    });

    describe('sleep_reflection stuck in_progress recovery', () => {
        it('should recover stuck in_progress sleep_reflection tasks older than timeout', async () => {
            const mockDict = {
                flush: vi.fn()
            };
            vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

            const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sleep-recovery-'));
            const stateDir = path.join(workspaceDir, '.state');
            fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
            fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

            // Create a sleep_reflection task that's been in_progress for 2 hours
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
            fs.writeFileSync(
                path.join(stateDir, 'evolution_queue.json'),
                JSON.stringify([
                    {
                        id: 'sleep-stuck',
                        taskKind: 'sleep_reflection',
                        priority: 'medium',
                        score: 50,
                        source: 'nocturnal',
                        reason: 'Sleep-mode reflection',
                        trigger_text_preview: 'Idle workspace detected',
                        timestamp: twoHoursAgo,
                        enqueued_at: twoHoursAgo,
                        started_at: twoHoursAgo,
                        status: 'in_progress',
                        traceId: 'sleep-stuck',
                        retryCount: 0,
                        maxRetries: 1,
                    },
                ], null, 2),
                'utf8'
            );

            const ctx = {
                workspaceDir,
                stateDir,
                logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
            };

            try {
                EvolutionWorkerService.start(ctx as any);
                await vi.advanceTimersByTimeAsync(5000);

                const queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_queue.json'), 'utf8'));
                expect(queue[0].status).toBe('failed');
                expect(queue[0].resolution).toBe('failed_max_retries');
                expect(queue[0].completed_at).toBeDefined();
                expect(queue[0].lastError).toContain('timed out');
            } finally {
                EvolutionWorkerService.stop(ctx as any);
                safeRmDir(workspaceDir);
            }
        });

        it('should not recover sleep_reflection tasks within timeout', async () => {
            const mockDict = { flush: vi.fn() };
            vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

            const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sleep-recent-'));
            const stateDir = path.join(workspaceDir, '.state');
            fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
            fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

            // Task started 10 minutes ago — well within 1-hour timeout
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            fs.writeFileSync(
                path.join(stateDir, 'evolution_queue.json'),
                JSON.stringify([
                    {
                        id: 'sleep-recent',
                        taskKind: 'sleep_reflection',
                        priority: 'medium',
                        score: 50,
                        source: 'nocturnal',
                        reason: 'Sleep-mode reflection',
                        trigger_text_preview: 'Idle workspace detected',
                        timestamp: tenMinutesAgo,
                        enqueued_at: tenMinutesAgo,
                        started_at: tenMinutesAgo,
                        status: 'in_progress',
                        traceId: 'sleep-recent',
                        retryCount: 0,
                        maxRetries: 1,
                    },
                ], null, 2),
                'utf8'
            );

            const ctx = {
                workspaceDir,
                stateDir,
                logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
            };

            try {
                EvolutionWorkerService.start(ctx as any);
                await vi.advanceTimersByTimeAsync(5000);

                const queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_queue.json'), 'utf8'));
                // Still in_progress — not old enough to recover
                expect(queue[0].status).toBe('in_progress');
            } finally {
                EvolutionWorkerService.stop(ctx as any);
                safeRmDir(workspaceDir);
            }
        });

        it('should not affect pain_diagnosis in_progress timeout logic', async () => {
            const mockDict = { flush: vi.fn() };
            vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

            const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-unchanged-'));
            const stateDir = path.join(workspaceDir, '.state');
            fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
            fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

            // pain_diagnosis task that's been in_progress for 2 hours — should be auto-completed
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
            fs.writeFileSync(
                path.join(stateDir, 'evolution_queue.json'),
                JSON.stringify([
                    {
                        id: 'pain-old',
                        taskKind: 'pain_diagnosis',
                        priority: 'high',
                        score: 90,
                        source: 'tool_failure',
                        reason: 'write failed',
                        trigger_text_preview: 'Tool edit failed',
                        timestamp: twoHoursAgo,
                        enqueued_at: twoHoursAgo,
                        started_at: twoHoursAgo,
                        status: 'in_progress',
                        traceId: 'pain-old',
                        retryCount: 0,
                        maxRetries: 3,
                    },
                ], null, 2),
                'utf8'
            );

            const ctx = {
                workspaceDir,
                stateDir,
                logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
            };

            try {
                EvolutionWorkerService.start(ctx as any);
                await vi.advanceTimersByTimeAsync(5000);

                const queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_queue.json'), 'utf8'));
                // pain_diagnosis uses auto_completed_timeout, NOT failed
                expect(queue[0].status).toBe('completed');
                expect(queue[0].resolution).toBe('auto_completed_timeout');
            } finally {
                EvolutionWorkerService.stop(ctx as any);
                safeRmDir(workspaceDir);
            }
        });
    });

    describe('Phase 3 Eligibility - Queue Only (Trust Removed)', () => {
        it('makes queue eligible when tasks are valid', () => {
            const result = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }]
            );

            expect(result.phase3ShadowEligible).toBe(true);
            expect(result.queueTruthReady).toBe(true);
            expect(result.evolution.eligible).toHaveLength(1);
            expect(result.evolution.rejected).toHaveLength(0);
        });

        it('makes queue eligible when directive is stale (production scenario)', () => {
            const result = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }]
            );

            expect(result.phase3ShadowEligible).toBe(true);
            expect(result.queueTruthReady).toBe(true);
        });

        it('rejects empty queue', () => {
            const result = evaluatePhase3Inputs([]);

            expect(result.phase3ShadowEligible).toBe(false);
            expect(result.queueTruthReady).toBe(false);
        });

        it('rejects invalid queue status', () => {
            const result = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'invalid' }]
            );

            expect(result.phase3ShadowEligible).toBe(false);
            expect(result.queueTruthReady).toBe(false);
            expect(result.evolution.rejected[0].reasons).toContain('invalid_status');
        });

        it('eligible requires queue with valid completed tasks', () => {
            const result = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }]
            );

            expect(result.phase3ShadowEligible).toBe(true);
            expect(result.queueTruthReady).toBe(true);
        });

        it('does not accept directive as a parameter (API design)', () => {
            const func = evaluatePhase3Inputs;
            const funcString = func.toString();

            expect(funcString).not.toMatch(/directive\s*:/);
            expect(funcString).not.toMatch(/directive\s*\)/);
        });

        it('handles multiple queue items correctly', () => {
            const result = evaluatePhase3Inputs([
                { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' },
                { id: 'task-2', status: 'in_progress', started_at: '2026-03-25T11:00:00.000Z' },
                { id: 'task-3', status: 'pending' }
            ]);

            expect(result.phase3ShadowEligible).toBe(true);
            expect(result.evolution.eligible).toHaveLength(3);
            expect(result.evolution.rejected).toHaveLength(0);
        });
    });
});

// ── P0-3 / P1: purgeStaleFailedTasks tests ──

import { purgeStaleFailedTasks } from '../../src/service/evolution-worker.js';

describe('purgeStaleFailedTasks', () => {
    const makeTask = (id: string, status: string, hoursAgo: number) => ({
        id,
        taskKind: 'sleep_reflection' as const,
        status,
        timestamp: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
        enqueued_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
        source: 'test',
        score: 50,
        reason: 'test',
        retryCount: 1,
        maxRetries: 1,
        lastError: 'Nocturnal reflection failed: no_evaluable_principles',
        resolution: 'failed_max_retries' as const,
    });

    it('should purge failed tasks older than 24 hours', () => {
        const queue: any[] = [
            makeTask('old-1', 'failed', 30),  // 30h old — should be purged
            makeTask('old-2', 'failed', 48),  // 48h old — should be purged
            makeTask('recent', 'failed', 12), // 12h old — should be kept
            makeTask('pending', 'pending', 1),
        ];

        const result = purgeStaleFailedTasks(queue, console as any);

        expect(result.purged).toBe(2);
        expect(result.remaining).toBe(2);
        expect(queue.length).toBe(2);
        expect(queue.find((t) => t.id === 'old-1')).toBeUndefined();
        expect(queue.find((t) => t.id === 'recent')).toBeDefined();
        expect(queue.find((t) => t.id === 'pending')).toBeDefined();
    });

    it('should not purge non-failed tasks regardless of age', () => {
        const queue: any[] = [
            makeTask('old-completed', 'completed', 72),
            makeTask('old-pending', 'pending', 72),
            makeTask('old-in-progress', 'in_progress', 72),
        ];

        const result = purgeStaleFailedTasks(queue, console as any);

        expect(result.purged).toBe(0);
        expect(result.remaining).toBe(3);
        expect(queue.length).toBe(3);
    });

    it('should group purge results by failure reason', () => {
        const queue: any[] = [
            { ...makeTask('fail-1', 'failed', 30), lastError: 'Nocturnal reflection failed: no_evaluable_principles' },
            { ...makeTask('fail-2', 'failed', 30), lastError: 'Nocturnal reflection failed: no_evaluable_principles' },
            { ...makeTask('fail-3', 'failed', 30), lastError: 'Nocturnal reflection failed: validation_failed' },
        ];

        const result = purgeStaleFailedTasks(queue, console as any);

        expect(result.purged).toBe(3);
        expect(result.byReason['Nocturnal reflection failed: no_evaluable_principles']).toBe(2);
        expect(result.byReason['Nocturnal reflection failed: validation_failed']).toBe(1);
    });
});
