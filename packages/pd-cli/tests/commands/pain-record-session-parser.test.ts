/**
 * PRI-642 Scope A — real-Commander integration for `pd pain record --session`.
 *
 * Spawns the BUILT pd CLI (dist/index.js) against a real temp workspace with a
 * real trajectory.db, exercising the actual commander registration and the
 * real typed acquisition path — not the in-process handler with mocks
 * (cli-7-test-wiring; SPEC §13 "Real Commander parser/registration tests for
 * --session and --json").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

function createWorkspace(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-record-parser-'));
  const stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });

  const db = new Database(path.join(stateDir, 'trajectory.db'));
  db.exec("CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, started_at TEXT, updated_at TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS assistant_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, sanitized_text TEXT, stop_reason TEXT, created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS user_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, raw_excerpt TEXT, correction_detected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, error_type TEXT, exit_code INTEGER, params_json TEXT NOT NULL DEFAULT '{}', result_preview TEXT, created_at TEXT NOT NULL)");
  db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
    .run('real-session-1', '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z');
  db.prepare('INSERT INTO user_turns (session_id, raw_excerpt, correction_detected, created_at) VALUES (?, ?, ?, ?)')
    .run('real-session-1', 'Please fix the output format', 1, '2026-01-01T09:59:00Z');
  db.close();
}

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Resolves and boundary-validates the built pd CLI entry before spawning it. */
async function resolveBuiltCliEntry(): Promise<string> {
  const packageRoot = path.resolve(process.cwd());
  const entry = path.resolve(packageRoot, 'dist', 'index.js');
  if (!entry.startsWith(`${packageRoot}${path.sep}`) || !fs.statSync(entry).isFile()) {
    throw new Error(`built pd CLI entry not found or outside the package: ${entry}`);
  }
  return entry;
}

async function runBuiltCli(literalArgv: readonly string[]): Promise<CliRunResult> {
  const { execFile } = await import('node:child_process');
  const execFileAsync = promisify(execFile);
  const entry = await resolveBuiltCliEntry();
  try {
    const { stdout } = await execFileAsync(process.execPath, [entry, ...literalArgv], {
      cwd: tmpDir,
      timeout: 30000,
      encoding: 'utf8',
      env: { ...process.env, PD_WORKSPACE_DIR: tmpDir },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { status: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('pd pain record --session (real Commander + real trajectory.db)', () => {
  beforeEach(() => {
    createWorkspace();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('--help registers and documents --session', async () => {
    const result = await runBuiltCli(['pain', 'record', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--session');
  }, 15_000);

  it('fails with a single JSON object and reason session_not_found for a nonexistent session (SPEC 12.1.4)', async () => {
    const result = await runBuiltCli([
      'pain', 'record',
      '--reason', 'parser test pain',
      '--session', 'no-such-session',
      '--workspace', tmpDir,
      '--json',
    ]);

    // Failed validation exits non-zero.
    expect(result.status).not.toBe(0);
    // cli-1: stdout is exactly one JSON object.
    const trimmed = result.stdout.trim();
    expect(trimmed.length).toBeGreaterThan(0);
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    expect(parsed.status).toBe('failed');
    expect(parsed.reason).toBe('session_not_found');
    expect(typeof parsed.nextAction).toBe('string');
  }, 15_000);

  it('accepts --session for a session that exists in the trajectory (validation passes, submission proceeds)', async () => {
    const result = await runBuiltCli([
      'pain', 'record',
      '--reason', 'parser test pain with real session',
      '--session', 'real-session-1',
      '--workspace', tmpDir,
      '--json',
    ]);

    // The session exists, so session validation must NOT reject it. The run
    // may still fail later (no LLM runtime configured in this temp
    // workspace) — the assertion is only about the validation stage.
    const trimmed = result.stdout.trim();
    expect(trimmed.length).toBeGreaterThan(0);
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    expect(parsed.reason).not.toBe('session_not_found');
    expect(parsed.reason).not.toBe('empty_trajectory');
  }, 15_000);
});
