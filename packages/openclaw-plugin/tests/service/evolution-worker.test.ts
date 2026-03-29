import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    EvolutionWorkerService,
    createEvolutionTaskId,
    createPainCandidateFingerprint,
    extractEvolutionTaskId,
    hasRecentDuplicateTask,
    hasEquivalentPromotedRule,
    processPromotion,
    registerEvolutionTaskSession,
    shouldTrackPainCandidate,
    trackPainCandidate,
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
vi.mock('../../src/core/event-log', () => ({
    EventLogService: {
        get: vi.fn(() => ({
            recordEvolutionTask: vi.fn(),
            recordRulePromotion: vi.fn(),
            flush: vi.fn(),
        })),
    },
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

    it('should generate distinct pain candidate fingerprints when only the suffix differs', () => {
        const prefix = 'A'.repeat(60);
        const textA = `${prefix} root-cause-one`;
        const textB = `${prefix} root-cause-two`;

        expect(createPainCandidateFingerprint(textA)).not.toBe(createPainCandidateFingerprint(textB));
    });

    it('should skip known noise payloads when tracking pain candidates', () => {
        expect(shouldTrackPainCandidate('NO_REPLY')).toBe(false);
        expect(shouldTrackPainCandidate(
            '{"damageDetected":false,"severity":"mild","confidence":0.95,"reason":"observer"}'
        )).toBe(false);
        expect(shouldTrackPainCandidate('Tool edit failed on MEMORY.md')).toBe(true);
    });

    it('should initialize candidates as pending and keep longer samples', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-candidate-'));
        const candidatePath = path.join(dir, 'pain_candidates.json');
        const longText = `Tool edit failed on MEMORY.md: ${'x'.repeat(1200)}`;

        try {
            await trackPainCandidate(longText, {
                resolve: () => candidatePath,
            } as any);

            const data = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
            const candidate = Object.values(data.candidates)[0] as any;

            expect(candidate.status).toBe('pending');
            expect(candidate.samples[0].length).toBeGreaterThan(200);
            expect(candidate.samples[0].length).toBeLessThanOrEqual(1000);
        } finally {
            safeRmDir(dir);
        }
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

    it('should promote legacy candidates even when status is missing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-promotion-'));
        const candidatePath = path.join(dir, 'pain_candidates.json');
        const addRule = vi.fn();

        fs.writeFileSync(candidatePath, JSON.stringify({
            candidates: {
                deadbeef: {
                    count: 3,
                    firstSeen: '2026-03-20T00:00:00.000Z',
                    samples: [
                        'Tool edit failed on MEMORY.md. Could not find the exact text in MEMORY.md.',
                        'Tool edit failed on CURRENT_FOCUS.md. Could not find the exact text in CURRENT_FOCUS.md.',
                        'Tool edit failed on TEAM_COMMS.md. Could not find the exact text in TEAM_COMMS.md.',
                    ],
                },
            },
        }, null, 2), 'utf8');

        try {
            await processPromotion({
                workspaceDir: dir,
                resolve: () => candidatePath,
                config: {
                    get: (key: string) => {
                        if (key === 'thresholds.promotion_count_threshold') return 3;
                        if (key === 'scores.default_confusion') return 35;
                        return undefined;
                    },
                },
                dictionary: {
                    addRule,
                    getAllRules: () => ({}),
                },
            } as any, { info: vi.fn() }, null);

            const saved = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
            expect(addRule).toHaveBeenCalled();
            expect(saved.candidates.deadbeef.status).toBe('promoted');
        } finally {
            safeRmDir(dir);
        }
    });

    it('should flush the dictionary on its interval', async () => {
        const mockDict = {
            flush: vi.fn()
        };
        vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);

        // Use path.resolve for cross-platform compatibility
        const workspaceDir = path.resolve('/mock/workspace');
        const expectedStateDir = path.join(workspaceDir, '.state');

        const ctx = {
            workspaceDir,
            stateDir: path.resolve('/mock/state'),
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
        };

        EvolutionWorkerService.start(ctx as any);

        // Advance by 15 minutes
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

        expect(mockDict.flush).toHaveBeenCalled();
        // Service now uses workspace-specific stateDir, not ctx.stateDir
        expect(sessionTracker.initPersistence).toHaveBeenCalledWith(expectedStateDir);
        expect(sessionTracker.flushAllSessions).toHaveBeenCalled();
        
        EvolutionWorkerService.stop(ctx as any);
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

    describe('Phase 3 Eligibility - Directive Exclusion', () => {
        it('makes queue-only eligible when directive is missing', () => {
            const result = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }],
                { score: 85, frozen: true }
            );

            expect(result.phase3ShadowEligible).toBe(true);
            expect(result.queueTruthReady).toBe(true);
            expect(result.trustInputReady).toBe(true);
            expect(result.evolution.eligible).toHaveLength(1);
            expect(result.evolution.rejected).toHaveLength(0);
        });

        it('makes queue-only eligible when directive is stale (production scenario)', () => {
            // Production evidence shows directive stopped updating on 2026-03-22
            // Phase 3 eligibility should still work based on queue and trust alone
            const result = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }],
                { score: 85, frozen: true }
            );

            // Directive state (stale vs fresh) should never affect eligibility
            // Only queue and trust matter
            expect(result.phase3ShadowEligible).toBe(true);
            expect(result.queueTruthReady).toBe(true);
            expect(result.trustInputReady).toBe(true);
        });

        it('rejects empty queue regardless of directive state', () => {
            const result = evaluatePhase3Inputs(
                [],
                { score: 85, frozen: true, lastUpdated: '2026-03-25' }
            );

            expect(result.phase3ShadowEligible).toBe(false);
            expect(result.queueTruthReady).toBe(false);
            expect(result.trustInputReady).toBe(true);
        });

        it('rejects invalid queue regardless of directive state', () => {
            const result = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'invalid' }],
                { score: 85, frozen: true, lastUpdated: '2026-03-25' }
            );

            expect(result.phase3ShadowEligible).toBe(false);
            expect(result.queueTruthReady).toBe(false);
            expect(result.evolution.rejected[0].reasons).toContain('invalid_status');
        });

        it('rejects when trust input is invalid regardless of directive', () => {
            const result = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }],
                { score: null, frozen: false }
            );

            expect(result.phase3ShadowEligible).toBe(false);
            expect(result.queueTruthReady).toBe(true);
            expect(result.trustInputReady).toBe(false);
            expect(result.trust.rejectedReasons).toContain('missing_trust_score');
            expect(result.trust.rejectedReasons).toContain('legacy_or_unfrozen_trust_schema');
        });

        it('requires both queue truth ready AND trust input ready for Phase 3', () => {
            // Queue ready, trust not ready
            const result1 = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }],
                { score: null, frozen: false }
            );
            expect(result1.phase3ShadowEligible).toBe(false);
            expect(result1.queueTruthReady).toBe(true);
            expect(result1.trustInputReady).toBe(false);

            // Trust ready, queue not ready
            const result2 = evaluatePhase3Inputs(
                [],
                { score: 85, frozen: true }
            );
            expect(result2.phase3ShadowEligible).toBe(false);
            expect(result2.queueTruthReady).toBe(false);
            expect(result2.trustInputReady).toBe(true);

            // Both ready
            const result3 = evaluatePhase3Inputs(
                [{ id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }],
                { score: 85, frozen: true }
            );
            expect(result3.phase3ShadowEligible).toBe(true);
            expect(result3.queueTruthReady).toBe(true);
            expect(result3.trustInputReady).toBe(true);
        });

        it('does not accept directive as a parameter (API design)', () => {
            // evaluatePhase3Inputs should only accept queue and trust
            // This test verifies the function signature does NOT include directive
            const func = evaluatePhase3Inputs;
            const funcString = func.toString();

            // Function should not have directive parameter in signature
            expect(funcString).not.toMatch(/directive\s*:/);
            expect(funcString).not.toMatch(/directive\s*\)/);
        });

        it('handles multiple queue items correctly', () => {
            const result = evaluatePhase3Inputs(
                [
                    { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' },
                    { id: 'task-2', status: 'in_progress', started_at: '2026-03-25T11:00:00.000Z' },
                    { id: 'task-3', status: 'pending' }
                ],
                { score: 85, frozen: true }
            );

            expect(result.phase3ShadowEligible).toBe(true);
            expect(result.evolution.eligible).toHaveLength(3);
            expect(result.evolution.rejected).toHaveLength(0);
        });
    });
});
