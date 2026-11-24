/**
 * D1 collaborator wiring for BOTH plugin entries —
 * SPEC-PD-PIPELINE-SPINE-001 v0.9 §3.1.1 #2/#3 + §4.5 Layer C
 * (PRI-1291 Phase 1A red-first).
 *
 * Pre-fix reality (origin/main):
 *   - `src/hooks/pain.ts` passes an in-process trajectory reader (delegating
 *     to WorkspaceContext.trajectory) but NO sourceMaterialAuthorization and
 *     no telemetrySink;
 *   - `src/commands/pain.ts` (always synchronous — no asyncMode) passes
 *     NEITHER the reader NOR the authorization.
 *
 * Post-fix contract: both entries construct the service with the same
 * workspace-scoped authorization and the WorkspaceContext.trajectory-backed
 * reader.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let lastPainServiceOptions: Record<string, unknown> | null = null;

vi.mock('@principles/core/runtime', async () => {
  const actual = await vi.importActual<typeof import('@principles/core/runtime')>(
    '@principles/core/runtime',
  );
  return {
    ...actual,
    PainToPrincipleService: vi.fn().mockImplementation(function (options: Record<string, unknown>) {
      lastPainServiceOptions = options;
      return {
        recordPain: vi.fn().mockResolvedValue({
          status: 'succeeded',
          painId: 'pain-d1-layer-c',
          taskId: 'diagnosis_pain-d1-layer-c',
          candidateIds: [],
          ledgerEntryIds: [],
          observabilityWarnings: [],
          latencyMs: 1,
        }),
      };
    }),
    PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

vi.mock('../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../src/core/workspace-context.js');

vi.mock('../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn().mockReturnValue({ ok: true, effective: {}, source: 'defaults', warnings: [], errors: [] }),
}));

vi.mock('../src/core/intent-doc-reader-adapter.js', () => ({
  createIntentDocReader: vi.fn().mockReturnValue({ readIntentDoc: vi.fn().mockReturnValue(null) }),
  resolveIntentLang: vi.fn().mockReturnValue('en'),
}));

import { emitPainDetectedEvent } from '../src/hooks/pain.js';
import { handlePainReportCommand } from '../src/commands/pain.js';
import { WorkspaceContext } from '../src/core/workspace-context.js';
import { SqliteConnection } from '@principles/core/runtime';
import { SystemLogger, disposeAllSystemLoggers } from '../src/core/system-logger.js';
import type { EvolutionLoopEvent } from '../src/core/evolution-types.js';

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-layerc-d1-'));
}

function makePainEvent(): EvolutionLoopEvent {
  return {
    ts: new Date().toISOString(),
    type: 'pain_detected',
    data: {
      painId: 'pain_d1_layer_c_001',
      painType: 'tool_failure',
      source: 'write',
      reason: 'D1 wiring probe',
      score: 75,
      sessionId: 'sess-d1-001',
    },
  } as EvolutionLoopEvent;
}

describe('Layer C — plugin hook entry wires authorization + trajectory reader', () => {
  let workspaceDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const listUserTurns = vi.fn().mockReturnValue([]);
  const listAssistantTurns = vi.fn().mockReturnValue([]);

  beforeEach(() => {
    vi.clearAllMocks();
    lastPainServiceOptions = null;
    workspaceDir = makeTempWorkspace();
    // Bootstrap state.db so the real trigger/triage controllers (which the
    // hook invokes BEFORE constructing the service) find their tables — same
    // priming discipline as pain-dead-letter.test.ts.
    const prime = new SqliteConnection({ workspaceDir });
    prime.getDb();
    prime.close();
    disposeAllSystemLoggers();
    logSpy = vi.spyOn(SystemLogger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy?.mockRestore();
    disposeAllSystemLoggers();
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // best-effort on Windows
    }
  });

  it('hooks/pain.ts passes a WorkspaceContext.trajectory-backed reader AND a source-material authorization', async () => {
    const wctx = {
      workspaceDir,
      stateDir: path.join(workspaceDir, '.state'),
      evolutionReducer: { emitSync: vi.fn() },
      trajectory: {
        listUserTurnsForSession: listUserTurns,
        listAssistantTurns: listAssistantTurns,
      },
    };
    await emitPainDetectedEvent(wctx as never, makePainEvent());

    expect(lastPainServiceOptions).toBeTruthy();
    const reader = lastPainServiceOptions!.trajectoryTurnReader as Record<string, unknown> | undefined;
    expect(reader).toBeTruthy();
    expect(typeof reader!.listUserTurnsForSession).toBe('function');
    expect(typeof reader!.listAssistantTurns).toBe('function');
    // the reader actually delegates to WorkspaceContext.trajectory
    reader!.listUserTurnsForSession('sess-d1-001');
    expect(listUserTurns).toHaveBeenCalledWith('sess-d1-001');

    const authz = lastPainServiceOptions!.sourceMaterialAuthorization as
      | { isHostSourceMaterialAuthorized?: unknown }
      | undefined;
    expect(authz).toBeTruthy();
    expect(typeof authz!.isHostSourceMaterialAuthorized).toBe('function');
  });

  it('commands/pain.ts (always synchronous) passes BOTH collaborators', async () => {
    const mockWctx = {
      workspaceDir,
      stateDir: path.join(workspaceDir, '.state'),
      dictionary: { getStats: vi.fn().mockReturnValue({ totalRules: 0, totalHits: 0 }) },
      eventLog: {
        getEmpathyStats: vi.fn().mockReturnValue({
          totalEvents: 0, dedupedCount: 0, dedupeHitRate: 0, totalPenaltyScore: 0, rolledBackScore: 0,
          rollbackCount: 0, bySeverity: { mild: 0, moderate: 0, severe: 0 },
          scoreBySeverity: { mild: 0, moderate: 0, severe: 0 },
          byDetectionMode: { structured: 0, legacy_tag: 0 },
          byOrigin: { assistant_self_report: 0, user_manual: 0, system_infer: 0 },
          confidenceDistribution: { high: 0, medium: 0, low: 0 },
          dailyTrend: [],
        }),
        getDailyStats: vi.fn().mockReturnValue({
          tools: { total: 0, success: 0, failure: 0 },
          hooks: { total: 0, success: 0, failure: 0, byType: {} },
          evolution: { rulehostEvaluated: 0, rulehostBlocked: 0, rulehostAutoCorrectApplied: 0 },
        }),
      },
      config: { get: vi.fn().mockImplementation((key: string) => (key === 'language' ? 'en' : undefined)) },
      trajectory: {
        getDataStats: vi.fn().mockReturnValue({
          dbPath: '', dbSizeBytes: 0, assistantTurns: 0, userTurns: 0, toolCalls: 0,
          painEvents: 0, pendingSamples: 0, approvedSamples: 0, blobBytes: 0, lastIngestAt: null,
        }),
        listUserTurnsForSession: listUserTurns,
        listAssistantTurns: listAssistantTurns,
      },
    };
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as never);

    const cmdResult = await handlePainReportCommand({
      args: 'D1 wiring probe from command entry',
      config: { workspaceDir, language: 'en' },
      sessionId: 'sess-d1-001',
    } as never);
    expect(lastPainServiceOptions).toBeTruthy();
    const reader = lastPainServiceOptions!.trajectoryTurnReader as Record<string, unknown> | undefined;
    expect(reader).toBeTruthy();
    expect(typeof reader!.listUserTurnsForSession).toBe('function');
    const authz = lastPainServiceOptions!.sourceMaterialAuthorization as
      | { isHostSourceMaterialAuthorized?: unknown }
      | undefined;
    expect(authz).toBeTruthy();
    expect(typeof authz!.isHostSourceMaterialAuthorized).toBe('function');
  });
});
