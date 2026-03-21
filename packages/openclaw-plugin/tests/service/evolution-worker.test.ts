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

vi.mock('../../src/core/dictionary-service');
vi.mock('../../src/core/session-tracker', () => ({
    initPersistence: vi.fn(),
    flushAllSessions: vi.fn(),
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
            fs.rmSync(dir, { recursive: true, force: true });
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
            fs.rmSync(dir, { recursive: true, force: true });
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
            fs.rmSync(dir, { recursive: true, force: true });
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
});
