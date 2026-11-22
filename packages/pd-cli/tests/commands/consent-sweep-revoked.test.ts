/**
 * `pd consent sweep-revoked` — CLI contract tests (PRI-1283 R3).
 *
 * cli-7: exercises the REAL Commander registration through the built CLI
 * (parser + flags + --json output contract), plus the handler-level
 * dry-run/apply semantics (cli-4/cli-5: default dry run mutates nothing).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';
import { recordConversationIngestionConsent } from '@principles/host-runtime';
import { handleConsentSweepRevoked } from '../../src/commands/consent-sweep-revoked.js';

const tempDirs: string[] = [];

function makeWorkspace(decision: 'granted' | 'revoked'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-consent-sweep-cli-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  const db = new Database(path.join(dir, '.state', 'trajectory.db'));
  db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)`);
  db.close();
  const recorded = recordConversationIngestionConsent(dir, 'codex', {
    decision,
    decidedVia: 'pd_codex_setup',
    decidedAt: '2026-11-21T10:00:00.000Z',
    disclosureVersion: 'g2b-2026-11-12',
    ...(decision === 'failed' ? { failureReason: 'x' } : {}),
  });
  if (!recorded.ok) throw new Error(recorded.reason);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows file-lock tolerance; temp dir cleanup is best-effort.
    }
  }
});

describe('pd consent sweep-revoked (parser registration, cli-7)', () => {
  it('registers under the consent group with the documented flags', () => {
    const output = execFileSync('node', [getBuiltPdCliPath(), 'consent', 'sweep-revoked', '--help'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(output).toContain('--apply');
    expect(output).toContain('--workspace <path>');
    expect(output).toContain('--json');
  });
});

describe('handleConsentSweepRevoked (contract)', () => {
  it('default is a DRY RUN: skipped report on a granted workspace, no audit file (cli-4)', async () => {
    const ws = makeWorkspace('granted');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleConsentSweepRevoked({ workspace: ws, apply: false, json: true });
      const report = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(report.outcome).toBe('skipped');
      expect(report.reason).toBe('no_host_with_non_granted_consent');
      expect(fs.existsSync(path.join(ws, '.state', 'source-revocation-sweep.jsonl'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('revoked workspace: dry run reports, apply purges and writes the audit trail', async () => {
    const ws = makeWorkspace('revoked');
    // Seed one operational codex observation row (direct fixture; the sweep's
    // own host-runtime suite covers the full admission chain).
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(`CREATE TABLE governance_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_kind TEXT NOT NULL,
      rollout_identity TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      host_turn_id TEXT,
      kind TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      visible_text TEXT,
      sanitized_tool_facts_json TEXT,
      source TEXT,
      completeness TEXT,
      retention_class TEXT NOT NULL DEFAULT 'operational',
      observed_at TEXT NOT NULL,
      expired_at TEXT)`);
    db.prepare('INSERT INTO governance_observations (host_kind, rollout_identity, root_session_id, kind, logical_key, visible_text, retention_class, observed_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('codex', 'r1', 's1', 'user_turn', 'codex|r1|t1|user', 'sensitive turn text', 'operational', '2026-11-21T09:00:00.000Z');
    db.close();

    const drySpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let report: { outcome?: string; hosts?: { purged?: { governanceObservations?: number } }[] };
    try {
      await handleConsentSweepRevoked({ workspace: ws, apply: false, json: true });
      report = JSON.parse(drySpy.mock.calls[0]![0] as string);
    } finally {
      drySpy.mockRestore();
    }
    expect(report.outcome).toBe('completed');
    expect(report.hosts?.[0]?.purged?.governanceObservations).toBe(1);
    // Dry run wrote nothing (cli-5).
    const check = new Database(path.join(ws, '.state', 'trajectory.db'), { readonly: true });
    expect((check.prepare('SELECT visible_text FROM governance_observations').get() as { visible_text: string }).visible_text).toBe('sensitive turn text');
    check.close();

    const applySpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleConsentSweepRevoked({ workspace: ws, apply: true, json: true });
      const applied = JSON.parse(applySpy.mock.calls[0]![0] as string);
      expect(applied.outcome).toBe('completed');
      expect(applied.apply).toBe(true);
    } finally {
      applySpy.mockRestore();
    }
    const after = new Database(path.join(ws, '.state', 'trajectory.db'), { readonly: true });
    expect((after.prepare('SELECT visible_text, retention_class FROM governance_observations').get() as { visible_text: string | null; retention_class: string }).visible_text).toBeNull();
    after.close();
    expect(fs.existsSync(path.join(ws, '.state', 'source-revocation-sweep.jsonl'))).toBe(true);
  });
});
