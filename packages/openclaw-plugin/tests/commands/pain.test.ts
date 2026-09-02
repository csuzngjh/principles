import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePainCommand, handlePainReportCommand } from '../../src/commands/pain.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('../../src/core/session-tracker.js');
vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn().mockReturnValue({ ok: true, effective: {}, source: 'defaults', warnings: [], errors: [] }),
}));
vi.mock('../../src/core/intent-doc-reader-adapter.js', () => ({
  createIntentDocReader: vi.fn().mockReturnValue({ readIntentDoc: vi.fn() }),
  resolveIntentLang: vi.fn().mockReturnValue('zh-CN'),
}));
vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  // PRI-642: the /pd-pain path now routes through the shared ingress
  // (@principles/host-runtime), whose barrel transitively imports many
  // core exports — spread the actual module and override only the classes
  // under test.
  const actual = await importOriginal<typeof import('@principles/core/runtime-v2')>();
  return {
    ...actual,
    PainToPrincipleService: vi.fn(),
    PrincipleTreeLedgerAdapter: vi.fn(function(this: any) { this.stateDir = ''; }),
  };
});

import { PainToPrincipleService } from '@principles/core/runtime-v2';

describe('Pain Command', () => {
    const workspaceDir = '/mock/workspace';
    const sessionId = 's1';

    const mockDictionary = {
        getStats: vi.fn().mockReturnValue({ totalRules: 10, totalHits: 5 })
    };

    const mockEventLog = {
        getEmpathyStats: vi.fn().mockReturnValue({
            totalEvents: 0,
            dedupedCount: 0,
            dedupeHitRate: 0,
            totalPenaltyScore: 0,
            rolledBackScore: 0,
            rollbackCount: 0,
            bySeverity: { mild: 0, moderate: 0, severe: 0 },
            scoreBySeverity: { mild: 0, moderate: 0, severe: 0 },
            byDetectionMode: { structured: 0, legacy_tag: 0 },
            byOrigin: { assistant_self_report: 0, user_manual: 0, system_infer: 0 },
            confidenceDistribution: { high: 0, medium: 0, low: 0 },
            dailyTrend: [],
        })
    };

    const mockConfig = {
        get: vi.fn().mockImplementation((key: string) => {
            if (key === 'language') return 'en';
            return undefined;
        })
    };

    const mockWctx = {
        workspaceDir,
        dictionary: mockDictionary,
        eventLog: mockEventLog,
        config: mockConfig,
        trajectory: {
            getDataStats: vi.fn().mockReturnValue({
                dbPath: '/mock/workspace/.state/trajectory.db',
                dbSizeBytes: 2048,
                assistantTurns: 2,
                userTurns: 3,
                toolCalls: 4,
                painEvents: 1,
                pendingSamples: 1,
                approvedSamples: 2,
                blobBytes: 1024,
                lastIngestAt: '2026-03-19T10:00:00.000Z',
            })
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    });

    it('should format a comprehensive pain report', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 45 } as any);
        
        const result = handlePainCommand({ 
            args: '', 
            config: { workspaceDir, language: 'en' },
            sessionId 
        } as any);

        expect(result.text).toContain('Friction (GFI)**: [');
        expect(result.text).toContain('] 45/100');
        expect(result.text).toContain('Dictionary**: 10');
        expect(result.text).toContain('blocked 5');
    });

    it('should show 🟢 status for low GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 10 } as any);
        const result = handlePainCommand({ config: { workspaceDir }, sessionId } as any);
        expect(result.text).toContain('10/100');
    });

    it('should show 🔴 status for high GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);
        const result = handlePainCommand({ config: { workspaceDir }, sessionId } as any);
        expect(result.text).toContain('85/100');
    });

    it('shows trajectory data stats for the data subcommand', () => {
        const result = handlePainCommand({
            args: 'data',
            config: { workspaceDir, language: 'en' },
            sessionId
        } as any);

        expect(result.text).toContain('trajectory.db');
        expect(result.text).toContain('assistant turns: 2');
        expect(result.text).toContain('blob bytes: 1024');
        expect(result.text).toContain('last ingest: 2026-03-19T10:00:00.000Z');
        expect(result.text).toContain('pending samples');
        expect(result.text).toContain('approved samples');
    });

    // Fix-14 (P1-DESIGN-2): empty-state onboarding guidance for fresh installs.
    it('shows English welcome + onboarding guidance when dictionary is empty', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 0 } as any);
        mockDictionary.getStats.mockReturnValueOnce({ totalRules: 0, totalHits: 0 });

        const result = handlePainCommand({
            config: { workspaceDir, language: 'en' },
            sessionId
        } as any);

        expect(result.text).toContain('Welcome to Principles Disciple');
        expect(result.text).toContain('fresh workspace');
        expect(result.text).toContain('pd demo first-principle');
        expect(result.text).toContain('pd console open');
        expect(result.text).not.toContain('Hint: Use `/pd-status empathy`');
    });

    it('shows Chinese welcome + onboarding guidance when dictionary is empty (zh)', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 0 } as any);
        mockDictionary.getStats.mockReturnValueOnce({ totalRules: 0, totalHits: 0 });

        const result = handlePainCommand({
            config: { workspaceDir, language: 'zh' },
            sessionId
        } as any);

        expect(result.text).toContain('欢迎使用 Principles Disciple');
        expect(result.text).toContain('全新工作区');
        expect(result.text).toContain('pd demo first-principle');
        expect(result.text).toContain('pd console open');
        expect(result.text).not.toContain('提示: 使用 `/pd-status empathy`');
    });
});

describe('Pain Report Command (/pd-pain)', () => {
    const workspaceDir = '/mock/workspace';
    const sessionId = 's1';

    const mockEvolutionReducer = { emitSync: vi.fn() };
    const mockWctx = {
        workspaceDir,
        stateDir: '/mock/workspace/.state',
        evolutionReducer: mockEvolutionReducer,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    });

    async function runPainReport(args: string, lang = 'en') {
        return handlePainReportCommand({
            args,
            config: { workspaceDir, language: lang },
            sessionId,
        } as any);
    }

    it('rejects empty args', async () => {
        const result = await runPainReport('');
        expect(result.text).toContain('Please provide a pain reason');
    });

    it('rejects missing session ID', async () => {
        const result = await handlePainReportCommand({
            args: 'something broke',
            config: { workspaceDir, language: 'en' },
        } as any);
        expect(result.text).toContain('Session ID not available');
    });

    it('reports success when recordPain returns succeeded', async () => {
        const mockRecordPain = vi.fn().mockResolvedValue({
            status: 'succeeded',
            painId: 'manual_123_abc',
            taskId: 'diagnosis_manual_123_abc',
            candidateIds: [],
            ledgerEntryIds: [],
            observabilityWarnings: [],
            latencyMs: 100,
        });
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);

        const result = await runPainReport('something broke');
        expect(result.text).toContain('Pain recorded');
        expect(result.text).toContain('manual_');
        expect(result.text).not.toContain('not accepted');
    });

    it('reports retried as pain recorded with retry info, NOT as "not accepted"', async () => {
        const mockRecordPain = vi.fn().mockResolvedValue({
            status: 'retried',
            painId: 'manual_456_def',
            taskId: 'diagnosis_manual_456_def',
            failureCategory: 'output_invalid',
            message: 'Diagnostician output failed validation',
            candidateIds: [],
            ledgerEntryIds: [],
            observabilityWarnings: [],
            latencyMs: 200,
        });
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);

        const result = await runPainReport('something broke');
        expect(result.text).toContain('Pain recorded');
        expect(result.text).toContain('retry');
        expect(result.text).toContain('diagnosis_manual_456_def');
        expect(result.text).toContain('output_invalid');
        expect(result.text).toContain('/pd-status');
        // Must NOT say "not accepted" or "failed"
        expect(result.text).not.toContain('not accepted');
        expect(result.text).not.toContain('未成功');
    });

    it('reports retried in Chinese correctly', async () => {
        const mockRecordPain = vi.fn().mockResolvedValue({
            status: 'retried',
            painId: 'manual_789_xyz',
            taskId: 'diagnosis_manual_789_xyz',
            failureCategory: 'output_invalid',
            candidateIds: [],
            ledgerEntryIds: [],
            observabilityWarnings: [],
            latencyMs: 200,
        });
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);

        const result = await runPainReport('something broke', 'zh');
        expect(result.text).toContain('Pain 已记录');
        expect(result.text).toContain('重试');
        expect(result.text).not.toContain('未成功');
        expect(result.text).not.toContain('not accepted');
    });

    it('reports retried without failureCategory or message', async () => {
        const mockRecordPain = vi.fn().mockResolvedValue({
            status: 'retried',
            painId: 'manual_000_nocat',
            taskId: 'diagnosis_manual_000_nocat',
            candidateIds: [],
            ledgerEntryIds: [],
            observabilityWarnings: [],
            latencyMs: 150,
        });
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);

        const result = await runPainReport('something broke');
        expect(result.text).toContain('Pain recorded');
        expect(result.text).toContain('retry');
        expect(result.text).toContain('diagnosis_manual_000_nocat');
        // No error category or detail lines when absent
        expect(result.text).not.toContain('Error category');
        expect(result.text).not.toContain('Detail');
    });

    it('reports failed as "not accepted" with reason', async () => {
        const mockRecordPain = vi.fn().mockResolvedValue({
            status: 'failed',
            painId: 'manual_fail_1',
            taskId: 'diagnosis_manual_fail_1',
            failureCategory: 'runtime_unavailable',
            message: 'No runner available',
            candidateIds: [],
            ledgerEntryIds: [],
            observabilityWarnings: [],
            latencyMs: 50,
        });
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);

        const result = await runPainReport('something broke');
        expect(result.text).toContain('not accepted');
        expect(result.text).toContain('failed');
        expect(result.text).toContain('runtime_unavailable');
        expect(result.text).toContain('No runner available');
    });

    it('reports degraded as "not accepted"', async () => {
        const mockRecordPain = vi.fn().mockResolvedValue({
            status: 'degraded',
            painId: 'manual_deg_1',
            taskId: 'diagnosis_manual_deg_1',
            candidateIds: [],
            ledgerEntryIds: [],
            observabilityWarnings: [],
            latencyMs: 30,
        });
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);

        const result = await runPainReport('something broke');
        expect(result.text).toContain('not accepted');
        expect(result.text).toContain('degraded');
    });

    it('reports error on exception', async () => {
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) {
            throw new Error('DB connection failed');
        });

        const result = await runPainReport('something broke');
        expect(result.text).toContain('Failed to record pain');
        expect(result.text).toContain('DB connection failed');
    });

    // ── PRI-642 Scope A (SPEC §7.2, §12.1.2): /pd-pain submits its trusted
    // session AND validated non-placeholder evidence together. ────────────────

    function makeEvidenceTrajectory() {
        return {
            listUserTurnsForSession: vi.fn().mockReturnValue([
                { createdAt: '2026-09-01T10:00:00Z', correctionDetected: true, rawExcerpt: 'Owner correction text' },
            ]),
            listAssistantTurns: vi.fn().mockReturnValue([
                { createdAt: '2026-09-01T10:01:00Z', sanitizedText: 'assistant turn text' },
            ]),
            listToolCallsForSession: vi.fn().mockReturnValue([]),
        };
    }

    function makeRecordPain(status = 'succeeded') {
        return vi.fn().mockResolvedValue({
            status,
            painId: 'manual_123_abc',
            taskId: 'diagnosis_manual_123_abc',
            candidateIds: [],
            ledgerEntryIds: [],
            observabilityWarnings: [],
            latencyMs: 100,
        });
    }

    it('submits evidence from the current session together with the session ID (SPEC 12.1.2)', async () => {
        const trajectory = makeEvidenceTrajectory();
        const mockRecordPain = makeRecordPain();
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
            ...mockWctx,
            trajectory,
        } as any);

        const result = await runPainReport('something broke');

        expect(mockRecordPain).toHaveBeenCalledTimes(1);
        const input = mockRecordPain.mock.calls[0][0];
        // rc-6: the submitted session is exactly the command-context session…
        expect(input.sessionId).toBe(sessionId);
        // …and the evidence was acquired from that same session.
        expect(trajectory.listUserTurnsForSession).toHaveBeenCalledWith(sessionId);
        expect(Array.isArray(input.evidence)).toBe(true);
        expect(input.evidence.length).toBeGreaterThan(0);
        const refs = input.evidence.map((e: { sourceRef: string }) => e.sourceRef).join(',');
        expect(refs).toContain('owner_message:2026-09-01T10:00:00Z');
        expect(refs).toContain('agent_turn:2026-09-01T10:01:00Z');
        // No placeholder entries may be submitted.
        expect(refs).not.toContain('owner_reported:cli');
        expect(refs).not.toContain('trajectory:empty');
        expect(result.text).toContain('Pain recorded');
    });

    it('keeps provenance host_context_bound with hostKind openclaw on the bound path', async () => {
        const trajectory = makeEvidenceTrajectory();
        const mockRecordPain = makeRecordPain();
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
            ...mockWctx,
            trajectory,
        } as any);

        await runPainReport('something broke');

        const input = mockRecordPain.mock.calls[0][0];
        expect(input.provenance).toBe('host_context_bound');
        expect(input.hostKind).toBe('openclaw');
    });

    it('submits empty evidence (no placeholder) and warns explicitly when the session has no usable evidence', async () => {
        const trajectory = {
            listUserTurnsForSession: vi.fn().mockReturnValue([]),
            listAssistantTurns: vi.fn().mockReturnValue([]),
            listToolCallsForSession: vi.fn().mockReturnValue([]),
        };
        const mockRecordPain = makeRecordPain();
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
            ...mockWctx,
            trajectory,
        } as any);

        const result = await runPainReport('something broke');

        const input = mockRecordPain.mock.calls[0][0];
        // Honest empty evidence — never a fabricated placeholder entry.
        expect(input.evidence).toEqual([]);
        // Explicit degradation in the Owner-facing copy — no false
        // "will diagnose using current session context" claim (SPEC §8.2 row 2).
        expect(result.text).toMatch(/evidence|证据/i);
        expect(result.text).not.toContain('The system will diagnose using current session context.');
        expect(result.text).not.toContain('系统将基于当前会话上下文进行诊断');
    });

    it('degrades explicitly when the trajectory DB is unavailable', async () => {
        const mockRecordPain = makeRecordPain();
        vi.mocked(PainToPrincipleService).mockImplementation(function(this: any) { this.recordPain = mockRecordPain; } as any);
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
            ...mockWctx,
            trajectory: undefined,
        } as any);

        const result = await runPainReport('something broke');

        const input = mockRecordPain.mock.calls[0][0];
        expect(input.evidence).toEqual([]);
        expect(result.text).toMatch(/trajectory_unavailable|evidence/i);
    });
});
