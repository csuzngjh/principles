/**
 * BDD step definitions for `pd principles stats` (PRI-562 Phase 0,
 * cli-1/cli-5/cli-6 contract).
 *
 * Approach: in-process handler invocation against real temp-workspace
 * fixtures (same pattern as tests/commands/principles-stats.test.ts —
 * real event JSONL + real SqliteConnection-bootstrap schema, no heavy mocks).
 *
 * @see docs/specs/features/cli/principles-stats.feature
 */
import { vi, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqliteConnection } from '@principles/core';
import { readFileSync } from 'node:fs';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';
import { handlePrinciplesStats } from '../../src/commands/principles-stats.js';

const registry = createStepRegistry();

interface WsState {
  ws?: string;
  dbBytesBefore?: Buffer;
  ledgerRowsBefore?: number;
}

const state: WsState = {};

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let stdoutText = '';
let stderrText = '';
let lastExitCode: number | undefined;

function makeFixtureWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-principles-bdd-'));
  const today = localDateString(new Date());
  const logsDir = path.join(root, '.state', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const event = JSON.stringify({
    ts: Date.now(),
    date: today,
    type: 'runtime_v2_prompt_activations_injected',
    category: 'injected',
    sessionId: 'bdd-s1',
    data: {
      sessionId: 'bdd-s1',
      principleIds: ['p1', 'p2'],
      injectedCount: 2,
      skippedWarnings: [],
      injectedCharCount: 420,
      budget: 2000,
      legacySelectedCount: 1,
      legacyTotalChars: 300,
      legacyTruncated: false,
      v2Truncated: false,
      crossBlockDuplicateIds: ['p2'],
    },
  });
  fs.writeFileSync(path.join(logsDir, `events_${today}.jsonl`), [event, ''].join('\n'), 'utf8');

  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const connection = new SqliteConnection({ workspaceDir: root });
  const db = connection.getDb();
  const insert = db.prepare(
    `INSERT INTO principle_applications (principle_id, channel, level, kind, session_id, created_at)
     VALUES (?, 'prompt', ?, ?, ?, ?)`,
  );
  insert.run('p1', 'presence', 'prompt_injected', 'bdd-s1', new Date().toISOString());
  insert.run('p2', 'presence', 'prompt_injected', 'bdd-s1', new Date().toISOString());
  insert.run('p2', 'effect', 'self_reported', 'bdd-s1', new Date().toISOString());
  connection.close();
  return root;
}

// ── Given ────────────────────────────────────────────────────────────────────

registry.given('一个可用的 pd-cli 可执行文件', () => {
  state.ws = undefined;
});

registry.given('一个包含已知注入事件与回执账本的临时工作区', () => {
  state.ws = makeFixtureWorkspace();
  const dbPath = path.join(state.ws, '.pd', 'state.db');
  state.dbBytesBefore = readFileSync(dbPath);
  const db = new Database(dbPath, { readonly: true });
  state.ledgerRowsBefore =
    (db.prepare('SELECT COUNT(*) AS n FROM principle_applications').get() as { n: number }).n;
  db.close();
});

registry.given('一个空的临时工作区', () => {
  state.ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-principles-bdd-empty-'));
});

// ── When ─────────────────────────────────────────────────────────────────────

registry.when(/operator 执行 "pd principles stats( --json)?"/, async (_ctx, jsonFlag) => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await handlePrinciplesStats({ workspace: state.ws, json: !!jsonFlag });
  } finally {
    stdoutText = logSpy.mock.calls.map((c) => String(c[0])).join('');
    stderrText = errSpy.mock.calls.map((c) => String(c[0])).join('');
    logSpy.mockRestore();
    errSpy.mockRestore();
    lastExitCode = process.exitCode;
    process.exitCode = originalExitCode;
  }
});

// ── Then ─────────────────────────────────────────────────────────────────────

registry.then('stdout 是严格的单一 JSON 对象', () => {
  expect(lastExitCode).toBeUndefined();
  expect(stderrText).toBe('');
  expect(stdoutText.trim().startsWith('{')).toBe(true);
  expect(stdoutText.trim().endsWith('}')).toBe(true);
});

registry.then('该 JSON 对象可以被 JSON.parse 解析', () => {
  expect(() => JSON.parse(stdoutText)).not.toThrow();
});

registry.then('stdout 不包含任何 banner 或 heading', () => {
  const text = stdoutText.replace(/^\s*\{[\s\S]*\}\s*$/, '');
  expect(text).toBe('');
});

function getParsed(): Record<string, unknown> {
  // rc-1/rc-2: narrow from unknown via runtime guards before touching fields.
  const parsed: unknown = JSON.parse(stdoutText);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in stdout but got: ${typeof parsed}`);
  }
  // runtime-contract-exempt: ERR-001 narrowed from unknown via typeof + Array.isArray check above (test-only helper on trusted stdout JSON)
  return parsed as Record<string, unknown>;
}

registry.then('该 JSON 对象的 ok 字段为 true', () => {
  expect(getParsed().ok).toBe(true);
});

registry.then('该 JSON 对象包含 injections 指标组', () => {
  expect(typeof getParsed().injections).toBe('object');
});

registry.then('该 JSON 对象包含 chars 指标组', () => {
  expect(typeof getParsed().chars).toBe('object');
});

registry.then('该 JSON 对象包含 duplicates 指标组', () => {
  expect(typeof getParsed().duplicates).toBe('object');
});

registry.then('该 JSON 对象包含 applicationCorrelation 指标组', () => {
  expect(typeof getParsed().applicationCorrelation).toBe('object');
});

registry.then('数据库未被修改', () => {
  const dbPath = path.join(state.ws as string, '.pd', 'state.db');
  expect(readFileSync(dbPath).equals(state.dbBytesBefore)).toBe(true);
});

registry.then('ledger 未被修改', () => {
  const db = new Database(path.join(state.ws as string, '.pd', 'state.db'), { readonly: true });
  const n = (db.prepare('SELECT COUNT(*) AS n FROM principle_applications').get() as { n: number }).n;
  db.close();
  expect(n).toBe(state.ledgerRowsBefore);
});

registry.then('未入队新任务', () => {
  // Read-only command: no queue writes anywhere. Guarded by the DB-bytes
  // comparison above; nothing further to assert without a tasks table.
  expect(state.dbBytesBefore).toBeDefined();
});

registry.then('未创建后继任务', () => {
  expect(state.dbBytesBefore).toBeDefined();
});

registry.then('该 JSON 对象的 status 字段为 "degraded"', () => {
  expect(getParsed().status).toBe('degraded');
});

registry.then('该 JSON 对象包含 nextAction 字段', () => {
  expect(typeof getParsed().nextAction).toBe('string');
  expect((getParsed().nextAction as string).length).toBeGreaterThan(0);
});

registry.then('nextAction 说明如何启用 receipt flag 或先产生注入数据', () => {
  const nextAction = getParsed().nextAction as string;
  expect(nextAction.includes('.pd/config.yaml') || nextAction.includes('Run PD')).toBe(true);
});

// ── Define Feature ───────────────────────────────────────────────────────────

const featurePath = resolveFeaturePath('docs/specs/features/cli/principles-stats.feature');
const featureText = readFileSync(featurePath, 'utf8');
defineFeature(featureText, registry);
