/**
 * PD-Lab v0.3 T3b r2 test helper — REAL pd-cli driver for the
 * runtime-safety regression suite (host-attribution group).
 *
 * Executes the REAL built pd-cli entry (packages/pd-cli/dist/index.js) with
 * the literal node binary and an argument array against ISOLATED temp
 * workspaces — no model, no network, no production data. The trajectory
 * database of each test workspace is bootstrapped by the REAL core dist
 * schema module (applyTrajectorySchemaBase) and seeded with parameterized
 * SQL inserts — never hand-written schema.
 *
 * The repo dist resolves from THIS repository's checkout (the same bytes the
 * worktree's readiness gate L2 verified). CI builds @principles/pd-cli for
 * the scripts job (PRI-1254 r2 workflow line) so the real entry exists
 * everywhere the suite runs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REAL_PD_CLI = path.join(repoRoot, 'packages', 'pd-cli', 'dist', 'index.js');

export function realPdCliPath() {
  return REAL_PD_CLI;
}

export function realCliAvailable() {
  try {
    return fs.statSync(REAL_PD_CLI).isFile();
  } catch {
    return false;
  }
}

/**
 * Run the REAL pd-cli with an argument array (no shell).
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runRealPd(args) {
  try {
    const stdout = execFileSync(process.execPath, [REAL_PD_CLI, ...args], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    const e = /** @type {{ status?: number, stdout?: string, stderr?: string, message?: string }} */ (err);
    return {
      status: e.status ?? -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr && e.stderr !== '' ? String(e.stderr) : String(e.message ?? err),
    };
  }
}

/**
 * Async bootstrap (the schema module is ESM): create ws/.state/trajectory.db
 * through the REAL dist schema and insert one session with two user turns
 * (parameterized inserts — the binding acquisition then has available
 * evidence for `--session`).
 */
export async function bootstrapTrajectoryWorkspaceAsync(wsDir, sessionId) {
  const stateDir = path.join(wsDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const trajectoryDb = path.join(stateDir, 'trajectory.db');
  const schemaModPath = path.join(repoRoot, 'packages', 'principles-core', 'dist', 'runtime', 'trajectory-schema.js');
  const schema = await import(pathToFileURL(schemaModPath).href);
  const Database = require('better-sqlite3');
  const db = new Database(trajectoryDb);
  try {
    schema.applyTrajectorySchemaBase(db);
    schema.convergeTrajectorySchemaVersion(db);
    const insertSession = db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)');
    const insertTurn = db.prepare('INSERT INTO user_turns (session_id, turn_index, raw_text, created_at) VALUES (?, ?, ?, ?)');
    const now = '2026-11-19T00:00:00.000Z';
    db.transaction(() => {
      insertSession.run(sessionId, now, now);
      insertTurn.run(sessionId, 0, `seed turn 1 for ${sessionId}`, now);
      insertTurn.run(sessionId, 1, `seed turn 2 for ${sessionId}`, now);
    })();
  } finally {
    db.close();
  }
  return { trajectoryDb };
}

/**
 * Read the pain_events rows of an isolated workspace (readonly).
 * @param {string} wsDir
 * @returns {Array<{ session_id: string, host_kind: string | null, canonical_pain_id: string | null, reason: string | null }>}
 */
export function queryPainEvents(wsDir) {
  const Database = require('better-sqlite3');
  const dbPath = path.join(wsDir, '.state', 'trajectory.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT session_id, host_kind, canonical_pain_id, reason FROM pain_events ORDER BY id').all();
  } finally {
    db.close();
  }
}
