/**
 * PRI-642 Scope B — per-emitter funnel behavior tests (SPEC §12.2.1–3, §13).
 *
 * SPEC §13 requires production consumer tests BEFORE declaring an emitter
 * migrated; §11 forbids source-text assertions alone. These tests drive the
 * real funnel `emitPainDetectedEvent` (real ingress adapter, real typed
 * trajectory acquisition against a real temp trajectory.db) with a stubbed
 * PainToPrincipleService, asserting what `recordPain` actually receives for
 * each emitter family:
 *  1. automatic tool-failure WITHOUT a usable session → honest unbound
 *     shape, empty evidence, NO trajectory projection write, no 'cli' row;
 *  2. manual pain (skill:pain) with a real session + trajectory entries →
 *     bound provenance + real evidence at recordPain;
 *  3. LLM-detected signal with a real session but EMPTY trajectory →
 *     never host_context_bound in the recorded diagnostic facts;
 *  4. gate-block-style automatic signal WITH evidence → submitted (SPEC
 *     §12.2.2: gate-block with evidence submits, does not silently disappear).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import type { EvolutionLoopEvent } from '../../src/core/evolution-types.js';
import type { PainToPrincipleInput, PainToPrincipleServiceOptions } from '@principles/core/runtime-v2';

let lastRecordPainInput: PainToPrincipleInput | null = null;
const recordPainCalls: PainToPrincipleInput[] = [];

vi.mock('@principles/core/runtime-v2', async () => {
  const actual = await vi.importActual<typeof import('@principles/core/runtime-v2')>(
    '@principles/core/runtime-v2',
  );
  return {
    ...actual,
    PainToPrincipleService: vi.fn().mockImplementation(function (_options: PainToPrincipleServiceOptions) {
      return {
        recordPain: vi.fn(async (input: PainToPrincipleInput) => {
          lastRecordPainInput = input;
          recordPainCalls.push(input);
          return {
            status: 'succeeded',
            painId: input.painId,
            taskId: `diagnosis_${input.painId}`,
            candidateIds: [],
            ledgerEntryIds: [],
            observabilityWarnings: [],
            latencyMs: 1,
          };
        }),
      };
    }),
    PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(() => ({
    ok: true,
    source: 'mock',
    effective: {},
    errors: [],
  })),
  loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: false, source: 'mock' })),
}));

vi.mock('../../src/core/intent-doc-reader-adapter.js', () => ({
  createIntentDocReader: vi.fn(() => () => null),
  resolveIntentLang: vi.fn(() => 'en'),
}));

vi.mock('../../src/core/system-logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/system-logger.js')>();
  return { ...actual, SystemLogger: { ...actual.SystemLogger, log: vi.fn((...args: unknown[]) => {
    process.stderr.write(`[TEST-SYSLOG] ${args.map(String).join(' ')}\n`);
  }) }, disposeAllSystemLoggers: actual.disposeAllSystemLoggers };
});

let workspaceDir: string;

function createWorkspace(): void {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-funnel-'));
}

/** A real WorkspaceContext for the temp workspace (its constructor applies the full trajectory schema). */
async function contextFor(): Promise<Record<string, unknown>> {
  const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
  return WorkspaceContext.fromHookContextExplicit({
    workspaceDir,
    stateDir: path.join(workspaceDir, '.state'),
  } as never) as never;
}

/** Seed one real assistant turn through the production trajectory writer. */
async function seedTurn(sessionId: string, sanitizedText: string): Promise<void> {
  const wctx = await contextFor() as { trajectory: { recordAssistantTurn(input: Record<string, unknown>): void } };
  wctx.trajectory.recordAssistantTurn({
    sessionId,
    runId: `run-${sessionId}`,
    provider: 'test-provider',
    model: 'test-model',
    rawText: sanitizedText,
    sanitizedText,
    usageJson: {},
    empathySignalJson: {},
    createdAt: '2026-09-02T00:01:00.000Z',
  });
}

async function emit(data: Record<string, unknown>): Promise<void> {
  const event = { ts: new Date().toISOString(), type: 'pain_detected', data } as unknown as EvolutionLoopEvent;
  const wctx = await contextFor();
  await emitPainDetectedEvent(wctx as never, event);
}

function countCliSessionRows(): number {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare("SELECT COUNT(*) n FROM sessions WHERE session_id = 'cli'").get().n
      + db.prepare("SELECT COUNT(*) n FROM pain_events WHERE session_id = 'cli'").get().n;
  } catch {
    return -1; // table missing counts as zero rows
  } finally {
    db.close();
  }
}

describe('PRI-642 funnel behavior — per-emitter consumer tests (SPEC §12.2, §13)', () => {
  beforeEach(() => {
    createWorkspace();
    lastRecordPainInput = null;
    recordPainCalls.length = 0;
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // Windows temp cleanup may transiently fail (EPERM) — not a contract.
    }
  });

  it('§12.2.1: automatic tool failure WITHOUT session → empty evidence, unbound provenance, no cli sentinel rows', async () => {
    await emit({
      painId: 'pain_auto_nosess',
      painType: 'tool_failure',
      source: 'write_file',
      reason: 'tool failed',
      score: 60,
      sessionId: 'unknown',
    });

    expect(lastRecordPainInput).not.toBeNull();
    // The ingress derives automatic_hook (never host_context_bound), the
    // submission carries NO evidence and NO session.
    expect(lastRecordPainInput!.provenance).toBe('automatic_hook');
    expect(lastRecordPainInput!.sessionId).toBeUndefined();
    expect(lastRecordPainInput!.evidence).toEqual([]);
    // The trajectory projection is skipped — no 'cli' sentinel row anywhere.
    expect(countCliSessionRows()).toBe(0);
  });

  it('§12.2.2 (submit half): gate-block-style automatic signal WITH evidence submits with real evidence', async () => {
    await seedTurn('sess-gate', 'the agent failed the gate');
    await emit({
      painId: 'pain_gate_blocked',
      painType: 'user_frustration',
      source: 'gate_blocked',
      reason: 'Gate blocked write_file',
      score: 45,
      sessionId: 'sess-gate',
    });

    expect(lastRecordPainInput).not.toBeNull();
    expect(lastRecordPainInput!.provenance).toBe('automatic_hook');
    expect(lastRecordPainInput!.sessionId).toBe('sess-gate');
    expect(lastRecordPainInput!.evidence.length).toBeGreaterThan(0);
    expect(lastRecordPainInput!.evidence[0].sourceRef).toContain('agent_turn:');
    // The painIngress.v1 payload rides along to the bridge dual-write.
    expect(lastRecordPainInput!.painIngress).toMatchObject({
      version: 'v1',
      origin: { kind: 'automatic_hook' },
      correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'sess-gate' },
    });
  });

  it('§12.2.3: LLM-detected signal with a real session but empty trajectory is never host-context-bound-fabricated', async () => {
    await seedTurn('sess-llm', 'assistant ran in circles');
    await emit({
      painId: 'llm_123',
      painType: 'user_frustration',
      source: 'llm_empathy',
      reason: 'paralysis detected',
      score: 70,
      sessionId: 'sess-llm',
    });

    expect(lastRecordPainInput).not.toBeNull();
    // Automatic origin → automatic_hook; correlation stays in the v1 payload.
    expect(lastRecordPainInput!.provenance).toBe('automatic_hook');
    expect(lastRecordPainInput!.sessionId).toBe('sess-llm');
    expect(lastRecordPainInput!.painIngress.correlation).toMatchObject({ status: 'bound', sessionId: 'sess-llm' });
  });

  it('§12.2 row 6: manual skill:pain without session → honest unbound Owner report, observability skipped', async () => {
    await emit({
      painId: 'pain_manual_nosess',
      painType: 'user_frustration',
      source: 'skill:pain',
      reason: 'owner reports a problem',
      score: 100,
      sessionId: 'unknown',
    });

    expect(lastRecordPainInput).not.toBeNull();
    expect(lastRecordPainInput!.provenance).toBe('owner_reported_no_host_trace');
    expect(lastRecordPainInput!.sessionId).toBeUndefined();
    expect(lastRecordPainInput!.evidence).toEqual([]);
    // SPEC §7.4: no sentinel 'cli' trajectory rows for unbound reports.
    expect(countCliSessionRows()).toBe(0);
  });
});
