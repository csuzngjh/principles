/**
 * PRI-530/PRI-531 integration: the production shared rule-host path —
 * WorkspaceContext mocked (established pattern), everything else real (temp
 * workspace, real .pd/config.yaml flags, real state.db metadata + ledger rows).
 *
 * PRODUCTION REALITY: `handleBeforeToolCall` is no longer wired; the deny
 * decision is produced by the shared production gate and handed to
 * `handleSharedRuleHostResult`. The host blocks on that deny, so the plugin no
 * longer builds the owner-facing block copy. These tests therefore pin the
 * deny ACCOUNTING that survives on the shared path: the receipt-ledger effect
 * row attribution (ruleId/principleId threading), the ledger flag gate, and
 * the observable rc-9 skip when attribution is missing.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime';
import type { HostEventResult } from '@principles/core/host';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
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

function makeCtx(logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }) {
  return { workspaceDir, sessionId: 'sess-integ', logger };
}

/** The host-neutral deny result the shared production gate emits for a block. */
function makeDenyResult(metadata: Record<string, unknown>): HostEventResult {
  return {
    decision: 'deny',
    source: 'before_tool_call',
    reason: '删除类操作必须先确认目标',
    metadata: { evaluatedLiveRules: 1, ...metadata },
  };
}

function blockEvents() {
  return (mockEventLogInstance.recordGateBlock as { mock: { calls: unknown[][] } }).mock.calls;
}

function ledgerRows(): { principle_id: string; session_id: string; rule_id: string }[] {
  return conn.getDb()
    .prepare("SELECT principle_id, session_id, rule_id FROM principle_applications WHERE kind='rule_blocked'")
    .all() as never;
}

beforeEach(() => {
  clearPrincipleApplicationLedgerCache();
  clearPrincipleReceiptMetadataCache();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-integ-'));
  conn = new SqliteConnection(workspaceDir);
});

afterEach(() => {
  conn.close();
  clearPrincipleApplicationLedgerCache();
  clearPrincipleReceiptMetadataCache();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('PRI-530/PRI-531 gate-hook integration (shared rule-host path)', () => {
  it('block: deny accounting threads principle attribution into the ledger effect row (flags on)', () => {
    writeConfig({ blockCopy: true, ledger: true });
    seedMetadata();

    const result = handleSharedRuleHostResult(
      { toolName: 'exec', params: { command: 'rm -rf build/' } },
      makeCtx() as never,
      makeDenyResult({ ruleId: 'R-integ', principleId: 'princ-integ' }),
    );

    // The host blocks on the gate's deny; the adapter returns no second block
    // object (there is no plugin-side block copy on the shared path).
    expect(result).toBeUndefined();

    // Ledger row (shared deny accounting write point)
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.principle_id).toBe('princ-integ');
    expect(rows[0]?.session_id).toBe('sess-integ');
    expect(rows[0]?.rule_id).toBe('R-integ');

    // EventLog gate_block keeps the shared source tag.
    expect(blockEvents()).toEqual([
      ['sess-integ', expect.objectContaining({ blockSource: 'rule-host-shared', reason: '删除类操作必须先确认目标' })],
    ]);
  });

  it('block with flags off: no ledger row while the block itself is still accounted', () => {
    writeConfig({ blockCopy: false, ledger: false });
    seedMetadata();

    const result = handleSharedRuleHostResult(
      { toolName: 'exec', params: { command: 'rm -rf build/' } },
      makeCtx() as never,
      makeDenyResult({ ruleId: 'R-integ', principleId: 'princ-integ' }),
    );

    expect(result).toBeUndefined();
    const count = (conn.getDb()
      .prepare('SELECT COUNT(*) AS n FROM principle_applications')
      .get() as { n: number }).n;
    expect(count).toBe(0);
    // Enforcement is never gated by the ledger flag.
    expect(blockEvents()).toEqual([
      ['sess-integ', expect.objectContaining({ blockSource: 'rule-host-shared' })],
    ]);
  });

  it('PRI-573: block without ruleId/principleId skips the effect row with an observable rc-9 warn', () => {
    writeConfig({ blockCopy: false, ledger: true });

    const warn = vi.fn();
    const result = handleSharedRuleHostResult(
      { toolName: 'exec', params: { command: 'rm -rf build/' } },
      makeCtx({ warn, error: vi.fn(), info: vi.fn() }) as never,
      // no ruleId, no principleId — the gate metadata carries no attribution
      makeDenyResult({}),
    );

    // The deny itself still stands (ledger never gates enforcement)…
    expect(result).toBeUndefined();
    expect(blockEvents()).toHaveLength(1);
    // …but the skipped effect row must be observable, not silent (rc-9).
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Receipt ledger row skipped (rule_blocked, shared)'),
    );
    const count = (conn.getDb()
      .prepare('SELECT COUNT(*) AS n FROM principle_applications')
      .get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
