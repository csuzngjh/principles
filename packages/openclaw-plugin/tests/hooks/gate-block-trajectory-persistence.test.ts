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
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';

 
const require_ = createRequire(import.meta.url);

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pri569-'));
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
});
