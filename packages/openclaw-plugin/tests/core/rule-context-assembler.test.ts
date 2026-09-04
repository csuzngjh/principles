/**
 * PRI-482 Phase 3 — rule-context-assembler tests
 *
 * Tests assembleHistoryFromRows (验收 B), sameActionBlockCount (验收 C),
 * and buildProductionRuleContext (验收 D).
 *
 * ERR-001: all rows validated as unknown (no `as` bypass).
 * ERR-024: buildProductionRuleContext fail-soft (query throws → unavailable).
 * ERR-025: at least one test uses recordToolCall → getRuleHostContextRows → assembler.
 * ERR-026: tests with real TrajectoryDatabase reuse production schema.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  UNAVAILABLE_RULE_CONTEXT,
} from '@principles/core/runtime-v2';
import type {
  RuleToolCallRecord,
} from '@principles/core/runtime-v2';
import {
  assembleHistoryFromRows,
  buildProductionRuleContext,
} from '../../src/core/rule-context-assembler.js';
import type { RuleHostContextRow } from '../../src/core/trajectory-types.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<RuleHostContextRow> = {}): RuleHostContextRow {
  return {
    id: 1,
    toolName: 'read',
    outcome: 'success',
    paramsJson: '{}',
    ...overrides,
  };
}

const PROJECT_DIR = '/fake/project';

// ── assembleHistoryFromRows (验收 B) ───────────────────────────────────────

describe('assembleHistoryFromRows (PRI-482 Phase 3)', () => {
  it('valid rows → available history with correct RuleToolCallRecord[]', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ id: 1, toolName: 'read', outcome: 'success', paramsJson: '{"file_path":"src/a.ts"}' }),
      makeRow({ id: 2, toolName: 'edit', outcome: 'failure', paramsJson: '{"file_path":"src/b.ts"}' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);

    expect(history.status).toBe('available');
    expect(history.truncated).toBe(false);
    expect(history.calls).toHaveLength(2);

    const call0 = history.calls[0] as RuleToolCallRecord;
    expect(call0.sequenceId).toBe(1);
    expect(call0.toolName).toBe('read');
    expect(call0.canonicalKind).toBe('read');
    expect(call0.outcome).toBe('success');

    const call1 = history.calls[1] as RuleToolCallRecord;
    expect(call1.toolName).toBe('edit');
    expect(call1.canonicalKind).toBe('write');
    expect(call1.outcome).toBe('failure');
  });

  it('params_json that is a JSON array → unavailable', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ paramsJson: '["not","an","object"]' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('unavailable');
    expect(history.unavailableReason).toBeTruthy();
  });

  it('params_json that is a JSON string → unavailable', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ paramsJson: '"just a string"' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('unavailable');
  });

  it('params_json that is invalid JSON → unavailable', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ paramsJson: '{broken' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('unavailable');
  });

  it('outcome not in enum (success/failure/blocked) → unavailable', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ outcome: 'pending' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('unavailable');
  });

  it('empty tool_name → unavailable', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ toolName: '' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('unavailable');
  });

  it('canonicalizeToolKind applied correctly for various tool names', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ id: 1, toolName: 'read_file', outcome: 'success' }),
      makeRow({ id: 2, toolName: 'grep_search', outcome: 'success' }),
      makeRow({ id: 3, toolName: 'write_file', outcome: 'success' }),
      makeRow({ id: 4, toolName: 'run_shell_command', outcome: 'failure' }),
      makeRow({ id: 5, toolName: 'sessions_spawn', outcome: 'success' }),
      makeRow({ id: 6, toolName: 'unknown_tool', outcome: 'success' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('available');
    expect(history.calls).toHaveLength(6);

    const kinds = history.calls.map((c) => (c as RuleToolCallRecord).canonicalKind);
    expect(kinds).toEqual(['read', 'search', 'write', 'execute', 'agent', 'other']);
  });

  it('PRI-634-F: OpenClaw host-layer tool names resolve through the registry (vocabulary drift regression)', () => {
    // Baseline defect: shell/cmd are BASH_TOOL_NAMES the gate dispatches, but
    // baseline-only canonicalizeToolKind mapped them to 'other' — a v2 rule
    // matching canonicalKind==='execute' never fired for them in production
    // facts. Same for delete_file/insert/patch on the write axis.
    const rows: RuleHostContextRow[] = [
      makeRow({ id: 1, toolName: 'shell', outcome: 'success', paramsJson: '{"command":"ls"}' }),
      makeRow({ id: 2, toolName: 'cmd', outcome: 'success', paramsJson: '{"command":"dir"}' }),
      makeRow({ id: 3, toolName: 'delete_file', outcome: 'success', paramsJson: '{"file_path":"src/a.ts"}' }),
      makeRow({ id: 4, toolName: 'insert', outcome: 'success', paramsJson: '{"file_path":"src/b.ts"}' }),
      makeRow({ id: 5, toolName: 'patch', outcome: 'success', paramsJson: '{"file_path":"src/c.ts"}' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('available');

    const kinds = history.calls.map((c) => (c as RuleToolCallRecord).canonicalKind);
    expect(kinds).toEqual(['execute', 'execute', 'write', 'write', 'write']);
  });

  it('truncated flag propagated to history window', () => {
    const rows: RuleHostContextRow[] = [makeRow({ id: 1 })];

    const history = assembleHistoryFromRows(rows, true, PROJECT_DIR);
    expect(history.truncated).toBe(true);
  });

  it('normalizedPath extracted and normalized from params_json', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ id: 1, toolName: 'edit', paramsJson: '{"file_path":"src/auth.ts"}' }),
    ];

    const history = assembleHistoryFromRows(rows, false, '/fake/project');
    expect(history.status).toBe('available');

    const call = history.calls[0] as RuleToolCallRecord;
    expect(call.normalizedPath).toBe('src/auth.ts');
  });

  it('normalizedPath is null when no path field in params_json', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ id: 1, toolName: 'bash', paramsJson: '{"command":"ls -la"}' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('available');

    const call = history.calls[0] as RuleToolCallRecord;
    // bash with a command but no file mutation → extractFilePathFromParams returns the command string
    // normalizePathPure will normalize it
    expect(call.normalizedPath).not.toBeNull();
  });

  it('paramsSummary contains the parsed params_json object', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ id: 1, toolName: 'read', paramsJson: '{"file_path":"src/a.ts","offset":10}' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('available');

    const call = history.calls[0] as RuleToolCallRecord;
    expect(call.paramsSummary.file_path).toBe('src/a.ts');
    expect(call.paramsSummary.offset).toBe(10);
  });

  it('any single malformed row makes the entire history unavailable (fail loud)', () => {
    const rows: RuleHostContextRow[] = [
      makeRow({ id: 1, toolName: 'read', outcome: 'success' }),
      makeRow({ id: 2, toolName: 'edit', outcome: 'bogus' }), // invalid outcome
      makeRow({ id: 3, toolName: 'bash', outcome: 'success' }),
    ];

    const history = assembleHistoryFromRows(rows, false, PROJECT_DIR);
    expect(history.status).toBe('unavailable');
  });

  it('empty rows → available with empty calls (not unavailable)', () => {
    const history = assembleHistoryFromRows([], false, PROJECT_DIR);
    expect(history.status).toBe('available');
    expect(history.calls).toHaveLength(0);
  });
});

// ── buildProductionRuleContext (验收 C, D) ─────────────────────────────────

describe('buildProductionRuleContext (PRI-482 Phase 3)', () => {
  let workspaceDir: string | null = null;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it('sessionId missing → UNAVAILABLE_RULE_CONTEXT', () => {
    const source = { getRuleHostContextRows: () => ({ rows: [], truncated: false }) };
    const ctx = buildProductionRuleContext(null, 'src/target.ts', source, PROJECT_DIR);
    expect(ctx).toBe(UNAVAILABLE_RULE_CONTEXT);
  });

  it('sessionId empty string → UNAVAILABLE_RULE_CONTEXT', () => {
    const source = { getRuleHostContextRows: () => ({ rows: [], truncated: false }) };
    const ctx = buildProductionRuleContext('', 'src/target.ts', source, PROJECT_DIR);
    expect(ctx).toBe(UNAVAILABLE_RULE_CONTEXT);
  });

  it('query throws → unavailable, does not throw (ERR-024 fail-soft)', () => {
    const source = {
      getRuleHostContextRows: () => {
        throw new Error('SQLite locked');
      },
    };

    const ctx = buildProductionRuleContext('s1', null, source, PROJECT_DIR);
    expect(ctx.history.status).toBe('unavailable');
    expect(ctx.facts.priorReadOfTarget).toBe('unknown');
    expect(ctx.facts.readCount).toBeNull();
  });

  it('valid data → available + facts computed (priorReadOfTarget, readCount, etc.)', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-assembler-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    // Seed: read the target file, then edit a different file
    db.recordToolCall({
      sessionId: 's1',
      toolName: 'read',
      outcome: 'success',
      paramsJson: { file_path: 'src/auth.ts' },
    });
    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'success',
      paramsJson: { file_path: 'src/other.ts' },
    });

    const ctx = buildProductionRuleContext('s1', 'src/auth.ts', db, workspaceDir);

    expect(ctx.version).toBe(2);
    expect(ctx.history.status).toBe('available');
    expect(ctx.history.calls).toHaveLength(2);
    expect(ctx.facts.priorReadOfTarget).toBe('yes');
    expect(ctx.facts.readCount).toBe(1);
    expect(ctx.facts.writeCount).toBe(1);
    expect(ctx.facts.uniqueWritePathCount).toBe(1);
    db.dispose();
  });

  it('sameActionBlockCount is always null (spec §5.4, 验收 C)', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-assembler-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'read',
      outcome: 'success',
      paramsJson: { file_path: 'src/a.ts' },
    });

    const ctx = buildProductionRuleContext('s1', 'src/a.ts', db, workspaceDir);
    expect(ctx.facts.sameActionBlockCount).toBeNull();
    db.dispose();
  });

  it('ERR-025: end-to-end recordToolCall → getRuleHostContextRows → assembleHistoryFromRows', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-assembler-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/target.ts' },
    });
    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'blocked',
      paramsJson: { file_path: 'src/target.ts' },
    });

    const ctx = buildProductionRuleContext('s1', 'src/target.ts', db, workspaceDir);

    expect(ctx.history.status).toBe('available');
    expect(ctx.history.calls).toHaveLength(2);

    const calls = ctx.history.calls as RuleToolCallRecord[];
    expect(calls[0].toolName).toBe('read_file');
    expect(calls[0].canonicalKind).toBe('read');
    expect(calls[1].toolName).toBe('edit');
    expect(calls[1].canonicalKind).toBe('write');
    expect(calls[1].outcome).toBe('blocked');

    // priorReadOfTarget should be 'yes' because we read src/target.ts before
    expect(ctx.facts.priorReadOfTarget).toBe('yes');
    expect(ctx.facts.readCount).toBe(1);
    expect(ctx.facts.writeCount).toBe(1);
    db.dispose();
  });

  it('truncated history is propagated through buildProductionRuleContext', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-assembler-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    // Insert 5 rows, limit to 3
    for (let i = 0; i < 5; i++) {
      db.recordToolCall({
        sessionId: 's1',
        toolName: 'read',
        outcome: 'success',
        paramsJson: { file_path: `src/file${i}.ts` },
      });
    }

    const ctx = buildProductionRuleContext('s1', null, db, workspaceDir, 3);
    expect(ctx.history.status).toBe('available');
    expect(ctx.history.truncated).toBe(true);
    expect(ctx.history.calls).toHaveLength(3);
    db.dispose();
  });
});
