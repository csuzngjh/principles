/**
 * PRI-569 — Gate-block persistence must run on EVERY enforcement path.
 *
 * Root cause (revised from the issue's original optional-chain hypothesis):
 * `WorkspaceContext.trajectory` is a lazily-constructing getter that never
 * returns undefined in production. The real gap was handleSharedRuleHostResult
 * — the shared host-runtime path recorded rulehost_blocked JSONL events on
 * deny but NEVER called the authoritative recordGateBlockAndReturn, so
 * trajectory.db gate_blocks stayed empty and Wave-4's "blocks today" metric
 * read 0 despite live blocks (34 blocks on 2026-08-21, all lacking
 * activationId = shared-path fingerprint).
 *
 * Negative control: against pre-fix code, T2 (shared path) writes no
 * gate_blocks row and emits no gate_block event, and T3/T4 assert warnings
 * that did not exist — all three fail before this fix.
 *
 * ERR checklist:
 * - ERR-024/ERR-025 (EP-02): enforcement helper existed but one production
 *   path never wired into it — these tests exercise the REAL shared handler,
 *   not a re-implemented copy.
 * - ERR-002 (EP-03): degradation paths now carry reasonCodes
 *   (trajectory_collector_unmounted / trajectory_getter_failed /
 *   trajectory_write_failed / trajectory_write_exhausted).
 * - ERR-088 (EP-09): assertions target unique signals (row content, JSONL
 *   event types, reasonCode substrings), not absence-of-error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import type { TrajectoryDatabase } from '../../src/core/trajectory.js';
import type { PluginLogger } from '../../src/openclaw-sdk.js';
import { persistGateBlock, recordGateBlockAndReturn } from '../../src/hooks/gate-block-helper.js';
import { accountSharedDeny, handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import { trackBlock } from '../../src/core/session-tracker.js';
import { RuntimeSummaryService } from '../../src/service/runtime-summary-service.js';

// Session tracker is partially mocked so the gfi_track_failed degradation
// branch is reachable; everything else (listSessions for RuntimeSummaryService)
// stays real.
vi.mock(import('../../src/core/session-tracker.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    trackBlock: vi.fn(() => {
      throw new Error('tracker down');
    }),
  };
});

 
const require_ = createRequire(import.meta.url);

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri569-'));
  tmpDirs.push(dir);
  return dir;
}

function makeLogger(): PluginLogger & { lines: string[] } {
  const lines: string[] = [];
  const wrap = (level: string) => (msg: string) => lines.push(`[${level}] ${msg}`);
  return {
    lines,
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  };
}

function readGateBlocks(workspaceDir: string): Array<Record<string, unknown>> {
  const Database = require_('better-sqlite3');
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM gate_blocks ORDER BY rowid').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function readJsonlEvents(workspaceDir: string): Array<Record<string, unknown>> {
  const logsDir = path.join(workspaceDir, '.state', 'logs');
  const events: Array<Record<string, unknown>> = [];
  if (!fs.existsSync(logsDir)) return events;
  for (const file of fs.readdirSync(logsDir)) {
    if (!file.startsWith('events_')) continue;
    for (const line of fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // ignore malformed tail lines
      }
    }
  }
  return events;
}

function typesOf(events: Array<Record<string, unknown>>): string[] {
  return events.map((e) => String(e['type']));
}

/** EventLog buffers up to 30s before writing JSONL — force-flush before asserting. */
function flushEventLog(wctx: WorkspaceContext): void {
  wctx.eventLog.flush();
}

describe('PRI-569 gate-block trajectory persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of tmpDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup — Windows EPERM on held handles is tolerated
      }
    }
  });

  it('T1: legacy hook path persists gate_blocks row via recordGateBlockAndReturn', () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    const logger = makeLogger();

    const result = recordGateBlockAndReturn(wctx, {
      filePath: 'a.txt',
      reason: 'pri569-legacy',
      toolName: 'Write',
      blockSource: 'rule-host',
    }, logger);

    expect(result.block).toBe(true);
    const rows = readGateBlocks(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['reason']).toBe('pri569-legacy');
    expect(rows[0]?.['tool_name']).toBe('Write');
    // EventLog primary persistence still records the gate_block event
    flushEventLog(wctx);
    expect(typesOf(readJsonlEvents(dir))).toContain('gate_block');
  });

  it('T2: shared host-runtime deny persists gate_blocks row + gate_block event (regression core)', () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    void wctx;
    const logger = makeLogger();

    handleSharedRuleHostResult(
      { toolName: 'Write', params: { file_path: path.join(dir, 'a.txt') } },
      { workspaceDir: dir, logger },
      { decision: 'deny', reason: 'pri569-shared-deny', source: 'test' },
    );

    // Pre-fix negative control: this row was NOT written by the shared path.
    const rows = readGateBlocks(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['reason']).toBe('pri569-shared-deny');
    expect(rows[0]?.['tool_name']).toBe('Write');

    flushEventLog(wctx);
    const types = typesOf(readJsonlEvents(dir));
    expect(types).toContain('rulehost_blocked');
    expect(types).toContain('gate_block');

    // PRI-569 round-3 review: close the loop to the USER-VISIBLE metric —
    // RuntimeSummaryService.recentBlocks counts gate_block events exactly
    // like the runtime summary surface does.
    const summary = RuntimeSummaryService.getSummary(dir);
    expect(summary.gate.recentBlocks).toBe(1);
  });

  it('T11: unresolved-path deny still counts — null file_path in trajectory, placeholder in EventLog', () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    const logger = makeLogger();

    accountSharedDeny(wctx, {
      sessionId: 's-unresolved',
      toolName: 'Write',
      filePath: null,
      reason: 'pri569-null-path',
    }, logger);

    const warns = logger.lines.filter((l) => l.startsWith('[warn]')).join('\n');
    expect(warns).toContain('shared_deny_path_unresolved');
    expect(warns).toContain('Receipt ledger row skipped');

    // trajectory.db accepts the null path — the deny IS counted
    const Database = require_('better-sqlite3');
    const trajDb = new Database(path.join(dir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const rows = trajDb.prepare('SELECT file_path FROM gate_blocks').all() as Array<{ file_path: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.file_path).toBeNull();
    } finally {
      trajDb.close();
    }

    // EventLog schema requires a string — placeholder carries attribution
    flushEventLog(wctx);
    const events = readJsonlEvents(dir).filter((e) => e['type'] === 'gate_block');
    expect(events).toHaveLength(1);
    const data = events[0]?.['data'] as Record<string, unknown>;
    expect(data['filePath']).toBe('<unresolved>');
  });

  it('T3: unmounted collector warns with reasonCode and still blocks + records event log', () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    vi.spyOn(wctx, 'trajectory', 'get').mockReturnValue(undefined as unknown as TrajectoryDatabase);
    const logger = makeLogger();

    const result = recordGateBlockAndReturn(wctx, {
      filePath: 'a.txt',
      reason: 'pri569-unmounted',
      toolName: 'Write',
      blockSource: 'rule-host',
    }, logger);

    expect(result.block).toBe(true);
    const warns = logger.lines.filter((l) => l.startsWith('[warn]')).join('\n');
    expect(warns).toContain('trajectory_collector_unmounted');
    // primary EventLog persistence unaffected
    flushEventLog(wctx);
    expect(typesOf(readJsonlEvents(dir))).toContain('gate_block');
    // unmounted collector must not lazily create the trajectory DB either
    expect(fs.existsSync(path.join(dir, '.state', 'trajectory.db'))).toBe(false);
  });

  it('T4: throwing trajectory getter warns with reasonCode instead of propagating', () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    vi.spyOn(wctx, 'trajectory', 'get').mockImplementation(() => {
      throw new Error('config exploded');
    });
    const logger = makeLogger();

    const result = recordGateBlockAndReturn(wctx, {
      filePath: 'a.txt',
      reason: 'pri569-getter-throw',
      toolName: 'Write',
      blockSource: 'rule-host',
    }, logger);

    expect(result.block).toBe(true);
    const warns = logger.lines.filter((l) => l.startsWith('[warn]')).join('\n');
    expect(warns).toContain('trajectory_getter_failed');
    expect(warns).toContain('config exploded');
  });

  it('T5: transient write failure schedules bounded retry and lands the row', async () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    const db = wctx.trajectory;
    vi.spyOn(db, 'recordGateBlock').mockImplementationOnce(() => {
      throw new Error('db busy');
    });
    vi.useFakeTimers();
    const logger = makeLogger();

    const result = recordGateBlockAndReturn(wctx, {
      filePath: 'a.txt',
      reason: 'pri569-retry',
      toolName: 'Write',
      blockSource: 'rule-host',
    }, logger);
    expect(result.block).toBe(true);
    expect(readGateBlocks(dir)).toHaveLength(0); // first attempt failed

    await vi.advanceTimersByTimeAsync(300); // retry #1 fires at 250ms
    const warns = logger.lines.filter((l) => l.startsWith('[warn]')).join('\n');
    expect(warns).toContain('persisted on retry 1');
    const rows = readGateBlocks(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['reason']).toBe('pri569-retry');
  });

  it('T6: persistGateBlock alone (shared entry surface) writes both stores without throwing', () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    const logger = makeLogger();

    expect(() => persistGateBlock(
      wctx,
      { filePath: 'b.txt', reason: 'pri569-direct', toolName: 'Edit', blockSource: 'rule-host-shared' },
      logger,
    )).not.toThrow();

    const rows = readGateBlocks(dir);
    expect(rows).toHaveLength(1);
    flushEventLog(wctx);
    expect(typesOf(readJsonlEvents(dir))).toContain('gate_block');
  });

  it('T8: session GFI tracking failure degrades with reasonCode, persistence unaffected', () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    const logger = makeLogger();

    expect(() => persistGateBlock(
      wctx,
      { filePath: 'c.txt', reason: 'pri569-gfi', toolName: 'Write', sessionId: 's-gfi', blockSource: 'rule-host-shared' },
      logger,
    )).not.toThrow();

    const warns = logger.lines.filter((l) => l.startsWith('[warn]')).join('\n');
    expect(warns).toContain('gfi_track_failed');
    expect(vi.mocked(trackBlock)).toHaveBeenCalledWith('s-gfi');
    // trajectory row + event log still land despite tracker failure
    const rows = readGateBlocks(dir);
    expect(rows).toHaveLength(1);
    flushEventLog(wctx);
    expect(typesOf(readJsonlEvents(dir))).toContain('gate_block');
  });

  it('T9: retry chain stops cleanly when the collector goes away mid-retry (skipped, not exhausted)', async () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    const db = wctx.trajectory;
    vi.spyOn(db, 'recordGateBlock').mockImplementationOnce(() => {
      throw new Error('db busy');
    });
    vi.useFakeTimers();
    const logger = makeLogger();

    recordGateBlockAndReturn(wctx, {
      filePath: 'a.txt',
      reason: 'pri569-retry-skip',
      toolName: 'Write',
      blockSource: 'rule-host',
    }, logger);
    expect(readGateBlocks(dir)).toHaveLength(0);

    // collector unmounts before retry #1 fires
    vi.spyOn(wctx, 'trajectory', 'get').mockReturnValue(undefined as unknown as TrajectoryDatabase);
    await vi.advanceTimersByTimeAsync(300);

    const warns = logger.lines.filter((l) => l.startsWith('[warn]')).join('\n');
    expect(warns).toContain('trajectory_collector_unmounted');
    expect(warns).not.toContain('persisted on retry');
    expect(logger.lines.join('\n')).not.toContain('trajectory_write_exhausted');
    expect(fs.existsSync(path.join(dir, '.state', 'trajectory.db'))).toBe(true); // created by first attempt
    expect(readGateBlocks(dir)).toHaveLength(0);
  });

  it('T10: shared deny is queryable by the Focus-page SQL and lands the receipt ledger row', () => {
    const dir = makeWorkspace();
    const logger = makeLogger();

    handleSharedRuleHostResult(
      { toolName: 'Write', params: { file_path: path.join(dir, 'a.txt') } },
      { workspaceDir: dir, logger },
      { decision: 'deny', reason: 'pri569-e2e', source: 'test', metadata: { ruleId: 'rule-e2e', principleId: 'princ-e2e' } },
    );

    // Focus-page consumption path (GovernanceConsoleModel): today-window SQL
    // against trajectory.db gate_blocks must see the shared-path row.
    const Database = require_('better-sqlite3');
    const trajDb = new Database(path.join(dir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const row = trajDb
        .prepare('SELECT COUNT(*) as c FROM gate_blocks WHERE created_at >= ?')
        .get(todayStart.toISOString()) as { c: number };
      expect(row.c).toBe(1);
    } finally {
      trajDb.close();
    }

    // Receipt-ledger parity: effect row in .pd/state.db (flag defaults ON)
    const stateDb = new Database(path.join(dir, '.pd', 'state.db'), { readonly: true });
    try {
      const ledgerRows = stateDb
        .prepare("SELECT principle_id, rule_id, level, kind FROM principle_applications WHERE kind='rule_blocked'")
        .all() as Array<Record<string, unknown>>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.['principle_id']).toBe('princ-e2e');
      expect(ledgerRows[0]?.['rule_id']).toBe('rule-e2e');
      expect(ledgerRows[0]?.['level']).toBe('effect');
    } finally {
      stateDb.close();
    }
  });

  it('T12: persistent trajectory write failure exhausts retries fail-loud', async () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    const db = wctx.trajectory;
    vi.spyOn(db, 'recordGateBlock').mockImplementation(() => {
      throw new Error('db down');
    });
    vi.useFakeTimers();
    const logger = makeLogger();

    const result = recordGateBlockAndReturn(wctx, {
      filePath: 'a.txt',
      reason: 'pri569-exhaust',
      toolName: 'Write',
      blockSource: 'rule-host',
    }, logger);
    expect(result.block).toBe(true);

    await vi.advanceTimersByTimeAsync(2000); // retries at +250/+500/+750 cumulative
    const errs = logger.lines.filter((l) => l.startsWith('[error]')).join('\n');
    expect(errs).toContain('trajectory_write_exhausted');
    expect(readGateBlocks(dir)).toHaveLength(0);
  });

  it('T13: EventLog primary write failure degrades without losing the trajectory row', () => {
    const dir = makeWorkspace();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir });
    vi.spyOn(wctx.eventLog, 'recordGateBlock').mockImplementation(() => {
      throw new Error('jsonl disk full');
    });
    const logger = makeLogger();

    const result = recordGateBlockAndReturn(wctx, {
      filePath: 'a.txt',
      reason: 'pri569-evfail',
      toolName: 'Write',
      blockSource: 'rule-host',
    }, logger);

    expect(result.block).toBe(true);
    const warns = logger.lines.filter((l) => l.startsWith('[warn]')).join('\n');
    expect(warns).toContain('Failed to record gate block event');
    expect(readGateBlocks(dir)).toHaveLength(1); // secondary store unaffected
  });
});
