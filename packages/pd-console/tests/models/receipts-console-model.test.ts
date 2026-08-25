/**
 * ReceiptsConsoleModel Tests — PRI-533, coverage disclosure PRI-590..594.
 *
 * - ok: counts + timeline from seeded principle_applications rows
 * - degraded: state.db missing / ledger flag disabled / table missing (rc-9: reason + nextAction)
 * - effect vs presence counted separately; lastEffectAt only from effect rows
 * - coverage (PRI-590): sourceStatus/validationStatus/observedFrom/retention
 *   across the seven edge scenarios (available+valid, true zero, disabled,
 *   unavailable, partial, malformed, self-report independence)
 *
 * ERR entries: ERR-002 (degradation carries reason), ERR-001/005 (rows narrowed
 * with typeof, no as bypass).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { ReceiptsConsoleModel } from '../../src/server/models/ReceiptsConsoleModel.js';
import { updateFeatureFlag } from '../../src/server/config/pd-config-store.js';
import { SqliteConnection } from '@principles/core/runtime-v2';

let tempDir: string;
let workspaceDir: string;
let model: ReceiptsConsoleModel;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-receipts-model-test-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  model = new ReceiptsConsoleModel(workspaceDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedLedger(rows: Array<{ principleId: string; kind: string; level: string; sessionId?: string | null; digest?: string; createdAt: string }>): void {
  const conn = new SqliteConnection(workspaceDir);
  const db = conn.getDb();
  for (const row of rows) {
    db.prepare(`
      INSERT INTO principle_applications (principle_id, channel, level, kind, session_id, digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.principleId,
      row.kind === 'prompt_injected' ? 'prompt' : row.kind === 'rule_blocked' ? 'code_tool_hook' : 'prompt',
      row.level,
      row.kind,
      row.sessionId ?? null,
      row.digest ?? null,
      row.createdAt,
    );
  }
  conn.close();
}

function writeBaseConfig(): void {
  // Minimal valid config (mimics fresh install) — updateFeatureFlag requires
  // an existing config.yaml; hand-written partial configs fail validatePdConfig.
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  const yamlLines = [
    'version: 1',
    'runtimeProfiles:',
    '  openclaw.default:',
    '    type: openclaw',
    '    source: default',
    'internalAgents:',
    '  defaultRuntime: openclaw.default',
    '  agents:',
    '    diagnostician:',
    '      enabled: true',
    '    dreamer:',
    '      enabled: true',
    '    scribe:',
    '      enabled: true',
    'ui:',
    '  diagnostics:',
    '    mode: simple',
  ];
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), yamlLines.join('\n') + '\n', 'utf8');
}

function ensureStateDb(): void {
  const conn = new SqliteConnection(workspaceDir);
  conn.getDb().prepare('SELECT 1').get();
  conn.close();
}

function enableLedgerFlag(): void {
  writeBaseConfig();
  const result = updateFeatureFlag(workspaceDir, 'principle_receipt_ledger', true);
  expect(result.ok).toBe(true);
  ensureStateDb();
}

describe('ReceiptsConsoleModel — degraded paths (rc-9)', () => {
  it('degrades with reason + nextAction when state.db is missing', async () => {
    const result = await model.getPrincipleReceipts('princ-1');
    expect(result.status).toBe('degraded');
    expect(result.reason).toContain('state.db not found');
    expect(result.nextAction).toBeTruthy();

    const counts = await model.getReceiptCounts();
    expect(counts.status).toBe('degraded');
    expect(counts.counts).toEqual([]);
  });

  it('degrades with reason + nextAction when the ledger flag is disabled', async () => {
    // PRI-571 graduation: the ledger now defaults ON, so the degraded path is
    // reached via an explicit config disable (the documented rollback).
    writeBaseConfig();
    const disable = updateFeatureFlag(workspaceDir, 'principle_receipt_ledger', false);
    expect(disable.ok).toBe(true);
    ensureStateDb();
    const result = await model.getPrincipleReceipts('princ-1');
    expect(result.status).toBe('degraded');
    expect(result.reason).toContain('principle_receipt_ledger');
    expect(result.nextAction).toContain('principle_receipt_ledger');
  });

  it('degrades when the table is missing on an older workspace (flag on)', async () => {
    enableLedgerFlag();
    // state.db exists via flag write, but drop the table to simulate pre-PRI-531
    const conn = new SqliteConnection(workspaceDir);
    conn.getDb().prepare('DROP TABLE principle_applications').run();
    conn.close();
    const result = await model.getPrincipleReceipts('princ-1');
    expect(result.status).toBe('degraded');
    expect(result.reason).toContain('principle_applications');
    expect(result.nextAction).toContain('PRI-531');
  });
});

describe('ReceiptsConsoleModel — ok paths', () => {
  it('returns effect/presence counts, lastEffectAt and bounded timeline', async () => {
    enableLedgerFlag();
    seedLedger([
      { principleId: 'princ-A', kind: 'rule_blocked', level: 'effect', sessionId: 's1', digest: '删除类操作必须先确认目标', createdAt: '2026-08-14T10:00:00.000Z' },
      { principleId: 'princ-A', kind: 'self_reported', level: 'effect', sessionId: 's2', digest: '先读文档再动手', createdAt: '2026-08-15T11:00:00.000Z' },
      { principleId: 'princ-A', kind: 'prompt_injected', level: 'presence', sessionId: 's1', createdAt: '2026-08-13T09:00:00.000Z' },
      { principleId: 'princ-B', kind: 'rule_blocked', level: 'effect', sessionId: 's3', digest: 'other principle', createdAt: '2026-08-16T12:00:00.000Z' },
    ]);

    const a = await model.getPrincipleReceipts('princ-A');
    expect(a.status).toBe('ok');
    expect(a.effectCount).toBe(2);
    expect(a.presenceCount).toBe(1);
    expect(a.lastEffectAt).toBe('2026-08-15T11:00:00.000Z');
    expect(a.events).toHaveLength(3);
    // newest first
    expect(a.events[0]?.createdAt).toBe('2026-08-15T11:00:00.000Z');
    expect(a.events.map(e => e.kind)).toEqual(['self_reported', 'rule_blocked', 'prompt_injected']);

    const counts = await model.getReceiptCounts();
    expect(counts.status).toBe('ok');
    const byId = new Map(counts.counts.map(c => [c.principleId, c]));
    expect(byId.get('princ-A')).toMatchObject({ effectCount: 2, presenceCount: 1 });
    expect(byId.get('princ-B')).toMatchObject({ effectCount: 1, presenceCount: 0 });
  });

  it('schema CHECK constraint rejects invalid kind/level rows at write time', async () => {
    enableLedgerFlag();
    seedLedger([
      { principleId: 'princ-X', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-16T08:00:00.000Z' },
    ]);
    // The writer-side CHECK constraint guarantees kind/level validity — the
    // model's row narrowing is defense against schema drift, not live data.
    const conn = new SqliteConnection(workspaceDir);
    expect(() => {
      conn.getDb().prepare(`
        INSERT INTO principle_applications (principle_id, channel, level, kind, session_id, digest, created_at)
        VALUES ('princ-X', 'prompt', 'weird-level', 'weird-kind', NULL, NULL, '2026-08-16T09:00:00.000Z')
      `).run();
    }).toThrow();
    conn.close();

    const result = await model.getPrincipleReceipts('princ-X');
    expect(result.status).toBe('ok');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe('rule_blocked');
  });

  it('returns empty ok result for a principle with no receipt history', async () => {
    enableLedgerFlag();
    seedLedger([
      { principleId: 'princ-A', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-14T10:00:00.000Z' },
    ]);
    const result = await model.getPrincipleReceipts('princ-unknown');
    expect(result.status).toBe('ok');
    expect(result.effectCount).toBe(0);
    expect(result.events).toEqual([]);
  });
});

describe('ReceiptsConsoleModel — evidence coverage (PRI-590)', () => {
  /** Simulates schema drift / tampering: bypasses the writer-side CHECK constraints. */
  function seedTamperedRow(principleId: string, kind: string, level: string, createdAt: string): void {
    const conn = new SqliteConnection(workspaceDir);
    const db = conn.getDb();
    db.pragma('ignore_check_constraints = 1');
    db.prepare(`
      INSERT INTO principle_applications (principle_id, channel, level, kind, session_id, digest, created_at)
      VALUES (?, 'prompt', ?, ?, NULL, NULL, ?)
    `).run(principleId, level, kind, createdAt);
    db.pragma('ignore_check_constraints = 0');
    conn.close();
  }

  it('case 1 — available + valid: observedFrom is the earliest retained row, retention disclosed', async () => {
    enableLedgerFlag();
    seedLedger([
      { principleId: 'princ-A', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-15T11:00:00.000Z' },
      { principleId: 'princ-A', kind: 'prompt_injected', level: 'presence', createdAt: '2026-08-13T09:00:00.000Z' },
      { principleId: 'princ-B', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-10T08:00:00.000Z' },
    ]);
    const detail = await model.getPrincipleReceipts('princ-A');
    expect(detail.coverage.sourceStatus).toBe('available');
    expect(detail.coverage.validationStatus).toBe('valid');
    expect(detail.coverage.reasonCode).toBeUndefined();
    // Per-principle scope on the detail endpoint.
    expect(detail.coverage.observedFrom).toBe('2026-08-13T09:00:00.000Z');
    expect(detail.coverage.retentionPolicyDays).toBe(90);
    expect(Number.isNaN(new Date(detail.coverage.asOf).getTime())).toBe(false);

    const counts = await model.getReceiptCounts();
    expect(counts.coverage.sourceStatus).toBe('available');
    expect(counts.coverage.validationStatus).toBe('valid');
    // Global scope on the counts endpoint.
    expect(counts.coverage.observedFrom).toBe('2026-08-10T08:00:00.000Z');
    expect(counts.coverage.retentionPolicyDays).toBe(90);
  });

  it('case 2 — true zero: nothing retained → observedFrom null, NOT degraded and NOT disabled', async () => {
    enableLedgerFlag();
    // Table exists, flag on, zero rows.
    const detail = await model.getPrincipleReceipts('princ-A');
    expect(detail.status).toBe('ok');
    expect(detail.effectCount).toBe(0);
    expect(detail.coverage.sourceStatus).toBe('available');
    expect(detail.coverage.validationStatus).toBe('valid');
    expect(detail.coverage.observedFrom).toBeNull();

    const counts = await model.getReceiptCounts();
    expect(counts.status).toBe('ok');
    expect(counts.counts).toEqual([]);
    expect(counts.coverage.sourceStatus).toBe('available');
    expect(counts.coverage.validationStatus).toBe('valid');
    expect(counts.coverage.observedFrom).toBeNull();
  });

  it('case 3 — disabled: ledger flag off → coverage names the disabled state with reasonCode', async () => {
    writeBaseConfig();
    const disable = updateFeatureFlag(workspaceDir, 'principle_receipt_ledger', false);
    expect(disable.ok).toBe(true);
    ensureStateDb();
    const detail = await model.getPrincipleReceipts('princ-A');
    expect(detail.coverage.sourceStatus).toBe('disabled');
    expect(detail.coverage.reasonCode).toBe('ledger_flag_disabled');
    expect(detail.coverage.nextActionCode).toBe('enable_ledger_flag');
    expect(detail.coverage.observedFrom).toBeNull();
    // Legacy contract unchanged (flag-off behavior compatibility).
    expect(detail.status).toBe('degraded');
    expect(detail.reason).toContain('principle_receipt_ledger');
    expect(detail.nextAction).toContain('principle_receipt_ledger');

    const counts = await model.getReceiptCounts();
    expect(counts.coverage.sourceStatus).toBe('disabled');
    expect(counts.coverage.reasonCode).toBe('ledger_flag_disabled');
  });

  it('case 4 — unavailable: state.db missing and table missing are both named, not shown as zero', async () => {
    const noDb = await model.getPrincipleReceipts('princ-A');
    expect(noDb.coverage.sourceStatus).toBe('unavailable');
    expect(noDb.coverage.reasonCode).toBe('state_db_missing');
    expect(noDb.coverage.observedFrom).toBeNull();

    enableLedgerFlag();
    const conn = new SqliteConnection(workspaceDir);
    conn.getDb().prepare('DROP TABLE principle_applications').run();
    conn.close();
    const detail = await model.getPrincipleReceipts('princ-A');
    expect(detail.coverage.sourceStatus).toBe('unavailable');
    expect(detail.coverage.reasonCode).toBe('ledger_table_missing');
    expect(detail.coverage.nextActionCode).toBe('update_plugin');

    const counts = await model.getReceiptCounts();
    expect(counts.coverage.sourceStatus).toBe('unavailable');
    expect(counts.coverage.reasonCode).toBe('ledger_table_missing');
  });

  it('case 5 — partial: invalid kind row is dropped from the timeline but still counted; counts stay accurate', async () => {
    enableLedgerFlag();
    seedLedger([
      { principleId: 'princ-A', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-14T10:00:00.000Z' },
    ]);
    seedTamperedRow('princ-A', 'weird-kind', 'effect', '2026-08-15T10:00:00.000Z');
    const detail = await model.getPrincipleReceipts('princ-A');
    expect(detail.status).toBe('ok');
    expect(detail.coverage.sourceStatus).toBe('available');
    expect(detail.coverage.validationStatus).toBe('partial');
    expect(detail.coverage.reasonCode).toBe('receipt_rows_dropped');
    // Counts include the tampered row (valid level), timeline drops it.
    expect(detail.effectCount).toBe(2);
    expect(detail.events).toHaveLength(1);
    expect(detail.coverage.observedFrom).toBe('2026-08-14T10:00:00.000Z');

    // Endpoint parity (review round 2): the counts endpoint must reach the
    // SAME partial verdict for the same dirty table — unknown-kind rows are
    // flagged via invalid_kind_count, so neither surface says "valid" while
    // the other says "partial".
    const counts = await model.getReceiptCounts();
    expect(counts.coverage.sourceStatus).toBe('available');
    expect(counts.coverage.validationStatus).toBe('partial');
    expect(counts.coverage.reasonCode).toBe('receipt_rows_dropped');
    // Counts themselves remain accurate for known levels.
    expect(counts.counts.find(c => c.principleId === 'princ-A')).toMatchObject({ effectCount: 2 });
  });

  it('case 6 — malformed: out-of-level rows make counts untrustworthy (never a trustworthy zero)', async () => {
    enableLedgerFlag();
    seedLedger([
      { principleId: 'princ-A', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-14T10:00:00.000Z' },
    ]);
    seedTamperedRow('princ-B', 'rule_blocked', 'weird-level', '2026-08-16T07:00:00.000Z');

    // Detail endpoint: the GROUP BY returns the unknown level as its own row.
    const detail = await model.getPrincipleReceipts('princ-B');
    expect(detail.coverage.sourceStatus).toBe('available');
    expect(detail.coverage.validationStatus).toBe('malformed');
    expect(detail.coverage.reasonCode).toBe('ledger_level_invalid');

    // Counts endpoint: the row total exceeds effect+presence → same verdict.
    const counts = await model.getReceiptCounts();
    expect(counts.coverage.validationStatus).toBe('malformed');
    expect(counts.coverage.reasonCode).toBe('ledger_level_invalid');
    // The entry is kept (behavior compat) but the 0/0 must not be presented as
    // a trustworthy zero — that is exactly what validationStatus=malformed discloses.
    const entryB = counts.counts.find(c => c.principleId === 'princ-B');
    expect(entryB).toMatchObject({ effectCount: 0, presenceCount: 0 });
  });

  it('case 7 — self-report flag disabled independently leaves coverage available (flag independence)', async () => {
    enableLedgerFlag();
    const selfReportOff = updateFeatureFlag(workspaceDir, 'principle_receipt_self_report', false);
    expect(selfReportOff.ok).toBe(true);
    seedLedger([
      { principleId: 'princ-A', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-14T10:00:00.000Z' },
    ]);
    const detail = await model.getPrincipleReceipts('princ-A');
    expect(detail.coverage.sourceStatus).toBe('available');
    expect(detail.coverage.validationStatus).toBe('valid');
    expect(detail.coverage.reasonCode).toBeUndefined();
    expect(detail.effectCount).toBe(1);
  });

  it('asOf reflects read time (fresh per request, not a stored value)', async () => {
    enableLedgerFlag();
    const before = Date.now();
    const first = await model.getPrincipleReceipts('princ-A');
    const after = Date.now();
    const asOfMs = new Date(first.coverage.asOf).getTime();
    expect(asOfMs).toBeGreaterThanOrEqual(before);
    expect(asOfMs).toBeLessThanOrEqual(after);
  });

  it('issues a constant number of prepared statements regardless of principle count (no N+1)', async () => {
    enableLedgerFlag();
    seedLedger([
      { principleId: 'princ-A', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-14T10:00:00.000Z' },
      { principleId: 'princ-B', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-15T10:00:00.000Z' },
      { principleId: 'princ-C', kind: 'prompt_injected', level: 'presence', createdAt: '2026-08-16T10:00:00.000Z' },
    ]);
    const prepareSpy = vi.spyOn(Database.prototype, 'prepare');
    try {
      const small = await model.getReceiptCounts();
      expect(small.status).toBe('ok');
      expect(small.counts).toHaveLength(3);
      const callsForSmall = prepareSpy.mock.calls.length;

      // Double the data volume, re-measure. The invariant under test is "the
      // statement count does not grow with principle count" (spec PRI-594) —
      // NOT an exact constant tied to SqliteConnection internals (review
      // round 2: a toBe(2) assertion breaks whenever the connection layer
      // adds an internal pragma/prep statement).
      seedLedger([
        { principleId: 'princ-D', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-17T10:00:00.000Z' },
        { principleId: 'princ-E', kind: 'prompt_injected', level: 'presence', createdAt: '2026-08-18T10:00:00.000Z' },
        { principleId: 'princ-F', kind: 'rule_blocked', level: 'presence', createdAt: '2026-08-19T10:00:00.000Z' },
      ]);
      prepareSpy.mockClear();
      const large = await model.getReceiptCounts();
      expect(large.status).toBe('ok');
      expect(large.counts).toHaveLength(6);
      expect(prepareSpy.mock.calls.length).toBe(callsForSmall);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('case 8 — schema drift: NULL-principle rows are disclosed as partial on counts, valid rows still counted', async () => {
    enableLedgerFlag();
    // Rebuild the table WITHOUT the writer's NOT NULL/CHECK constraints — the
    // drifted schema can hold orphan rows that the production writer could
    // never produce (codecov gap from review round 1: this partial branch had
    // no test coverage). Seed AFTER the rebuild: DROP clears prior rows.
    const conn = new SqliteConnection(workspaceDir);
    const db = conn.getDb();
    db.exec('DROP TABLE principle_applications');
    db.exec(`CREATE TABLE principle_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      principle_id TEXT,
      activation_id TEXT,
      rule_id TEXT,
      channel TEXT,
      level TEXT,
      kind TEXT,
      session_id TEXT,
      tool_name TEXT,
      file_path TEXT,
      digest TEXT,
      created_at TEXT
    )`);
    db.prepare(
      `INSERT INTO principle_applications (principle_id, channel, level, kind, created_at)
       VALUES (NULL, 'prompt', 'effect', 'rule_blocked', '2026-08-10T00:00:00.000Z')`,
    ).run();
    conn.close();
    seedLedger([
      { principleId: 'princ-A', kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-14T10:00:00.000Z' },
    ]);

    const counts = await model.getReceiptCounts();
    expect(counts.status).toBe('ok');
    // The skipped-orphan path is disclosed as partial, never silently dropped.
    expect(counts.coverage.validationStatus).toBe('partial');
    expect(counts.coverage.reasonCode).toBe('receipt_rows_dropped');
    // The valid row survives in the entries; the orphan is not listed.
    expect(counts.counts).toHaveLength(1);
    expect(counts.counts[0]?.principleId).toBe('princ-A');
    expect(counts.counts[0]?.effectCount).toBe(1);
  });
});
