/**
 * PRI-530/PRI-531 integration: the REAL gate hook path — RuleHost boundary
 * mocked (established pattern), everything else real (temp workspace, real
 * .pd/config.yaml flags, real state.db metadata + ledger rows).
 *
 * Closes the wiring-depth gap found in the BDD review gate: block-copy and
 * ledger scenarios entered at recordGateBlockAndReturn / recordInjectionPresence,
 * leaving gate.ts's ruleId/principleId threading untested through the hook.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime-v2';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import type { PluginHookBeforeToolCallResult } from '../../src/openclaw-sdk.js';
import {
  clearPrincipleApplicationLedgerCache,
} from '../../src/core/principle-application-ledger.js';
import {
  clearPrincipleReceiptMetadataCache,
} from '../../src/core/principle-receipt-metadata.js';

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
}));
vi.mock('../../src/core/evolution-engine.js', () => ({
  getEvolutionEngine: vi.fn(() => ({ getTier: vi.fn().mockReturnValue(3), getPoints: vi.fn().mockReturnValue(200) })),
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
let _mockEvaluate = vi.fn().mockReturnValue(undefined);
vi.mock('../../src/core/rule-host.js', () => ({
  RuleHost: vi.fn(function(this: unknown, _stateDir: string, _logger: unknown) {
    this.evaluate = _mockEvaluate;
  }),
  // P1 (2026-08-20): the gate now routes compatibility-guard blocks through
  // this type guard; the mocked rule-host must export it so the mocked
  // evaluate() results (no diagnostics.kind) are NOT misrouted.
  isCompatibilityGuardBlock: vi.fn(() => false),
}));
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: (ctx.workspaceDir ?? '') + '/.state',
      getRuleHost: () => ({ evaluate: _mockEvaluate, dispose: vi.fn() }),
      eventLog: mockEventLogInstance,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
  },
}));

let workspaceDir = '';
let conn: SqliteConnection;

function writeConfig(flags: { blockCopy: boolean; ledger: boolean }): void {
  const cfg = getDefaultPdConfig() as unknown as {
    features: Record<string, { category?: string; enabled: boolean }>;
  };
  cfg.features.principle_receipt_block_copy = { category: 'quiet', enabled: flags.blockCopy };
  cfg.features.principle_receipt_ledger = { category: 'quiet', enabled: flags.ledger };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
}

function seedMetadata(): void {
  const db = conn.getDb();
  const now = '2026-08-01T00:00:00.000Z';
  db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('task-integ', 'diagnostician', 'pending', now, now);
  db.prepare('INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('run-integ', 'task-integ', 'test-double', 'queued', now, now, now);
  db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('art-integ', 'run-integ', 'task-integ', 'principle', '{}', now);
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
              content_json, created_at, updated_at)
              VALUES ('pi-integ', 'principle', 'task-integ', 'princ-integ', ?, ?, ?)`)
    .run(JSON.stringify({ text: '删除类操作必须先确认目标', painReasonSummary: 'owner 纠正过一次误删' }), now, now);
  db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id,
              title, description, idempotency_key, created_at)
              VALUES ('cand-integ', 'art-integ', 'task-integ', 'run-integ', '删除前确认目标', '', 'ikey-integ', ?)`)
    .run(now);
  db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status,
              requested_at, decided_at, decided_by)
              VALUES ('appr-integ', 'pi-integ', 'code_tool_hook', 'high', 'approved', ?, '2026-07-30T10:00:00.000Z', 'owner')`)
    .run(now);
}

beforeEach(() => {
  clearPrincipleApplicationLedgerCache();
  clearPrincipleReceiptMetadataCache();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-integ-'));
  conn = new SqliteConnection(workspaceDir);
  _mockEvaluate = vi.fn().mockReturnValue(undefined);
});

afterEach(() => {
  conn.close();
  clearPrincipleApplicationLedgerCache();
  clearPrincipleReceiptMetadataCache();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('PRI-530/PRI-531 gate-hook integration (real handleBeforeToolCall path)', () => {
  it('block: blockReason carries principle attribution AND ledger effect row is written (flags on)', () => {
    writeConfig({ blockCopy: true, ledger: true });
    seedMetadata();
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'block',
      matched: true,
      reason: '删除类操作必须先确认目标',
      ruleId: 'R-integ',
      principleId: 'princ-integ',
    });

    const result = handleBeforeToolCall(
      { toolName: 'bash', params: { command: 'rm -rf build/' } },
      { workspaceDir, sessionId: 'sess-integ', logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
    ) as PluginHookBeforeToolCallResult;

    // Receipt copy (gate → gate-block-helper threading of ruleId/principleId)
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('「删除前确认目标」');
    expect(result.blockReason).toContain('2026-07-30');
    expect(result.blockReason).toContain('来源：');

    // Ledger row (gate write point)
    const row = conn.getDb()
      .prepare("SELECT * FROM principle_applications WHERE kind='rule_blocked'")
      .get() as { principle_id: string; session_id: string; rule_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.principle_id).toBe('princ-integ');
    expect(row?.session_id).toBe('sess-integ');
    expect(row?.rule_id).toBe('R-integ');
  });

  it('block with flags off: generic copy AND no ledger row', () => {
    writeConfig({ blockCopy: false, ledger: false });
    seedMetadata();
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'block',
      matched: true,
      reason: '删除类操作必须先确认目标',
      ruleId: 'R-integ',
      principleId: 'princ-integ',
    });

    const result = handleBeforeToolCall(
      { toolName: 'bash', params: { command: 'rm -rf build/' } },
      { workspaceDir, sessionId: 'sess-integ', logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
    ) as PluginHookBeforeToolCallResult;

    expect(result.blockReason).toContain('Security Gate Blocked');
    expect(result.blockReason).not.toContain('PD 原则');
    const count = (conn.getDb()
      .prepare('SELECT COUNT(*) AS n FROM principle_applications')
      .get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
