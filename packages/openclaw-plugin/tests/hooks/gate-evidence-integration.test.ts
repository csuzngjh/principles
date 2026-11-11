/**
 * PD v2 Phase 1 gate-hook evidence integration: the PRODUCTION shared rule-host
 * path (WorkspaceContext mocked — established pattern), everything else real
 * (temp workspace, real config flags, real state.db + evidence ledger rows).
 *
 * The shared production gate owns the deny decision; `handleSharedRuleHostResult`
 * owns the accounting. These tests prove the wiring, not just the recorder: a
 * live-rule deny that reaches the adapter is mirrored into the normalized
 * evidence ledger as delivery (runtime_loaded) + runtime_verified application +
 * episode + effect, and that accounting degrades to a warning when evidence
 * storage fails.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteConnection } from '@principles/core/runtime';
import type { HostEventResult } from '@principles/core/host';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import { clearPrincipleApplicationLedgerCache } from '../../src/core/principle-application-ledger.js';
import { clearPrincipleReceiptMetadataCache } from '../../src/core/principle-receipt-metadata.js';

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
}));
const mockEventLogInstance = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
  recordGateBlock: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: (ctx.workspaceDir ?? '') + '/.state',
      eventLog: mockEventLogInstance,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
  },
}));

let workspaceDir = '';
let conn: SqliteConnection;

function seedLiveActivation(): void {
  const db = conn.getDb();
  const now = '2026-10-01T00:00:00Z';
  // affectedTools must cover the gated tool, otherwise the RuleCode safety
  // circuit treats a live rule as out-of-approved-scope and isolates it
  // (fail-open return) before any correction/approval path runs.
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
              content_json, created_at, updated_at)
              VALUES ('art-ev', 'principle', 'task-ev', 'princ-ev', ?, ?, ?)`)
    .run(JSON.stringify({ text: '删除类操作必须先确认目标', affectedTools: ['exec'] }), now, now);
  db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
              VALUES ('act-ev', 'idem-ev', 'art-ev', 'code_tool_hook', 'code_tool_hook_live_activate', 'ref', ?)`)
    .run(now);
  db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, isolation_decision_id, version, updated_at)
              VALUES ('act-ev', 'eligible', NULL, 1, ?)`)
    .run(now);
}

function evidenceRows(): { record_kind: string; observation_key: string; payload_json: string; episode_key: string | null }[] {
  return conn.getDb()
    .prepare('SELECT record_kind, observation_key, payload_json, episode_key FROM intervention_evidence_records')
    .all() as never;
}

function makeCtx(logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }) {
  return { workspaceDir, sessionId: 'sess-ev', logger };
}

function makeEvent(extra: Record<string, unknown> = {}) {
  return { toolName: 'exec', params: { command: 'rm -rf build/' }, ...extra };
}

/** The host-neutral deny result the shared production gate emits for a block. */
function makeDenyResult(activationId?: string): HostEventResult {
  return {
    decision: 'deny',
    source: 'before_tool_call',
    reason: '删除类操作必须先确认目标',
    metadata: {
      evaluatedLiveRules: 1,
      ruleId: 'R-ev',
      principleId: 'princ-ev',
      evaluations: [
        {
          toolName: 'exec',
          filePath: 'build/',
          matched: true,
          decision: 'block',
          ruleId: 'R-ev',
          activationMode: 'live',
          hostKind: 'openclaw',
          ...(activationId !== undefined ? { activationId } : {}),
        },
      ],
    },
  };
}

beforeEach(() => {
  clearPrincipleApplicationLedgerCache();
  clearPrincipleReceiptMetadataCache();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-ev-'));
  conn = new SqliteConnection(workspaceDir);
});

afterEach(() => {
  conn.close();
  clearPrincipleApplicationLedgerCache();
  clearPrincipleReceiptMetadataCache();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('PD v2 Phase 1: shared gate path writes normalized enforcement evidence', () => {
  it('block: delivery + runtime_verified application + episode + effect rows with cross-refs', () => {
    seedLiveActivation();

    const result = handleSharedRuleHostResult(
      makeEvent({ toolUseId: 'toolu-1', runId: 'run-ev' }),
      makeCtx() as never,
      makeDenyResult('act-ev'),
    );

    // The deny decision itself is untouched by evidence wiring (the host
    // blocks on the gate's deny; no second block object is returned).
    expect(result).toBeUndefined();

    const rows = evidenceRows();
    expect(rows.map((r) => r.record_kind).sort()).toEqual(['application', 'behavior_episode', 'delivery', 'effect']);

    const delivery = rows.find((r) => r.record_kind === 'delivery')!;
    expect(JSON.parse(delivery.payload_json)).toMatchObject({
      targetKind: 'runtime_enforcement', confirmation: 'runtime_loaded', outcome: 'delivered',
    });
    expect(delivery.observation_key).toContain('act-ev');

    const application = rows.find((r) => r.record_kind === 'application')!;
    expect(JSON.parse(application.payload_json)).toMatchObject({
      proofMethod: 'runtime_verified', action: 'tool_blocked',
    });

    const episode = rows.find((r) => r.record_kind === 'behavior_episode')!;
    expect(episode.observation_key).toContain('toolu-1');
    expect(application.episode_key).toBe(episode.observation_key);
    const effect = rows.find((r) => r.record_kind === 'effect')!;
    expect(effect.episode_key).toBe(episode.observation_key);
  });

  it('block without activation attribution writes NO evidence rows (honest gap)', () => {
    const result = handleSharedRuleHostResult(
      makeEvent({ toolUseId: 'toolu-gap' }),
      makeCtx() as never,
      makeDenyResult(),
    );

    expect(result).toBeUndefined();
    expect(evidenceRows()).toHaveLength(0);
  });

  it('allow decisions write no enforcement evidence', () => {
    seedLiveActivation();

    const result = handleSharedRuleHostResult(
      makeEvent({ params: { command: 'ls build/' }, toolUseId: 'toolu-2' }),
      makeCtx() as never,
      {
        decision: 'allow',
        source: 'before_tool_call',
        metadata: {
          evaluatedLiveRules: 1,
          ruleDecision: 'allow',
          matched: false,
          evaluations: [
            {
              toolName: 'exec',
              filePath: 'build/',
              matched: false,
              decision: 'allow',
              activationId: 'act-ev',
              activationMode: 'live',
              hostKind: 'openclaw',
            },
          ],
        },
      },
    );

    expect(result).toBeUndefined();
    expect(evidenceRows()).toHaveLength(0);
  });

  it('evidence storage failure never flips the block (SQLite write-failure injection)', () => {
    seedLiveActivation();
    // Inject a real persistence failure at the database boundary. The evidence
    // write must degrade to a warning; the deny decision and its accounting
    // stand unchanged (the shared path cannot re-decide the gate's deny).
    conn.getDb().exec(`CREATE TRIGGER fail_intervention_evidence_insert
      BEFORE INSERT ON intervention_evidence_records
      BEGIN SELECT RAISE(ABORT, 'injected evidence write failure'); END;`);

    const warn = vi.fn();
    const result = handleSharedRuleHostResult(
      makeEvent({ toolUseId: 'toolu-3' }),
      makeCtx({ warn, error: vi.fn(), info: vi.fn() }) as never,
      makeDenyResult('act-ev'),
    );

    expect(result).toBeUndefined();
    // The block itself is still accounted (event-log row retained).
    expect(mockEventLogInstance.recordGateBlock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('injected evidence write failure');
    expect(evidenceRows()).toHaveLength(0);
  });
});
