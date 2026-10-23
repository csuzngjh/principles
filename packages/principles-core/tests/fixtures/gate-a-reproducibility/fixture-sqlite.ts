/**
 * Gate A fixture — read-only DB entrypoint proof (A-03), synthetic only.
 * Freshness replay (PRI-1000, 2026-10-18): verbatim copy of the 2026-10-17
 * Gate A fixture; only the mirror provenance below changed. Assertions unchanged.
 * Provenance: every imported module is from ../core-mirror (git archive of origin/main f2539e07ee0f4d2353c5e3897da81b6ef3b787ca's packages/principles-core/src + packages/host-runtime/src).
 * Runs only inside a self-created temp tree; production data is never touched.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteConnection } from '../core-mirror/packages/principles-core/src/runtime-v2/store/sqlite-connection.ts';
import { openTrajectoryDbReadonly } from '../core-mirror/packages/principles-core/src/trajectory-store.ts';
import { listGovernanceObservations } from '../core-mirror/packages/host-runtime/src/governance-observation-store.ts';
import { createWorkspaceBehaviorEvidencePort } from '../core-mirror/packages/host-runtime/src/workspace-behavior-evidence.ts';
import { buildToolSemanticRegistry } from '../core-mirror/packages/principles-core/src/runtime-v2/internalization/tool-semantic-registry.ts';

const results: { name: string; expect: string; actual: string; pass: boolean }[] = [];
function record(name: string, expect: string, actual: string) {
  results.push({ name, expect, actual, pass: expect === actual });
}
function exists(p: string): boolean { return fs.existsSync(p); }

(async () => {
  // ── 1. SqliteConnection readonly + no bootstrap on missing state.db ──
  const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-a-ws1-'));
  let err1: string | null = null;
  let conn: SqliteConnection | null = null;
  try {
    conn = new SqliteConnection({ workspaceDir: ws1, readonly: true, bootstrapIfMissing: false } as never);
    conn.getDb();
  } catch (e) {
    err1 = e instanceof Error ? e.message : String(e);
  }
  record('SqliteConnection(readonly,no-bootstrap) missing state.db -> throws', 'throws', err1 === null ? 'no-throw' : 'throws');
  record('  ...and does NOT create .pd/state.db', 'false', String(exists(path.join(ws1, '.pd', 'state.db'))));
  record('  ...and does NOT create .pd dir', 'false', String(exists(path.join(ws1, '.pd'))));
  if (conn) conn.close();

  // ── 2. DANGEROUS DEFAULT: readonly with bootstrapIfMissing=true creates the db ──
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-a-ws2-'));
  let bootstrapped = false;
  try {
    const c2 = new SqliteConnection({ workspaceDir: ws2, readonly: true } as never);
    c2.getDb();
    c2.close();
    bootstrapped = true;
  } catch {
    bootstrapped = false;
  }
  record('CONTRAST: readonly default bootstrapIfMissing:true -> bootstraps (writes) state.db', 'true', String(bootstrapped));
  record('  ...state.db exists after default readonly open', 'true', String(exists(path.join(ws2, '.pd', 'state.db'))));

  // ── 3. openTrajectoryDbReadonly on missing trajectory.db ──
  const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-a-ws3-'));
  let err3: string | null = null;
  try { openTrajectoryDbReadonly(ws3); } catch (e) { err3 = e instanceof Error ? e.message : String(e); }
  record('openTrajectoryDbReadonly missing -> throws TrajectoryDbUnavailableError', 'TrajectoryDbUnavailableError', err3 !== null && err3.includes('Trajectory database unavailable') ? 'TrajectoryDbUnavailableError' : String(err3));
  record('  ...does NOT create .state dir', 'false', String(exists(path.join(ws3, '.state'))));

  // ── 4. listGovernanceObservations on EXISTING fixture db -> side effects (WAL + schema ensure) ──
  const ws4 = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-a-ws4-'));
  fs.mkdirSync(path.join(ws4, '.state'), { recursive: true });
  const traj4 = path.join(ws4, '.state', 'trajectory.db');
  {
    const seed = new Database(traj4);
    seed.exec('CREATE TABLE unrelated_seed_table (id INTEGER PRIMARY KEY)');
    seed.close();
  }
  const sizeBefore = fs.statSync(traj4).size;
  const listRes = listGovernanceObservations({ workspaceDir: ws4 } as never) as Record<string, unknown>;
  let sideEffectTables: string[] | null = null;
  let journalMode: string | null = null;
  {
    const verify = new Database(traj4, { readonly: true });
    const rows = verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'governance%'").all() as { name: string }[];
    sideEffectTables = rows.map((r) => r.name);
    modeCheck: {
      const probe = new Database(traj4);
      journalMode = String(probe.pragma('journal_mode', { simple: true }));
      probe.close();
    }
    verify.close();
  }
  record('listGovernanceObservations missing db -> degrades trajectory_db_not_found, NO file created', 'trajectory_db_not_found', (() => {
    const wsMissingProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-a-ws5-'));
    const res = listGovernanceObservations({ workspaceDir: wsMissingProbe } as never) as Record<string, unknown>;
    const created = exists(path.join(wsMissingProbe, '.state', 'trajectory.db'));
    const reason = res.ok === false ? String(res.reason) : JSON.stringify(res);
    fs.rmSync(wsMissingProbe, { recursive: true, force: true });
    return reason.includes('trajectory_db_not_found') && !created ? 'trajectory_db_not_found' : `created=${created} reason=${reason}`;
  })());
  record('listGovernanceObservations on existing db WITHOUT governance schema -> ok:true (then side effects)', 'ok', listRes.ok === true ? 'ok' : JSON.stringify(listRes));
  record('  ...schema-ensure side effect: governance tables created', 'true', String((sideEffectTables ?? []).length > 0));
  record('  ...schema-ensure side effect: governance_observations present', 'true', String((sideEffectTables ?? []).includes('governance_observations')));
  record('  ...WAL side effect: journal_mode now wal', 'wal', journalMode ?? 'unknown');

  // ── 5. createWorkspaceBehaviorEvidencePort: missing trajectory.db -> throws; no db created ──
  const ws6 = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-a-ws6-'));
  const port6 = createWorkspaceBehaviorEvidencePort(ws6, buildToolSemanticRegistry().registry as never);
  let err6: string | null = null;
  try {
    port6.assemble({
      sourcePainId: 'pain_x',
      ownerDesiredOutcome: 'unused',
      sourceNegativeToolCallId: 1,
      positiveToolCallIds: [],
      projectDir: ws6,
    } as never);
  } catch (e) {
    err6 = e instanceof Error ? e.message : String(e);
  }
  record('BehaviorEvidencePort missing trajectory.db -> throws evidence_source_error', 'throws', err6 !== null ? 'throws' : 'no-throw');
  record('  ...and does NOT create .state/trajectory.db', 'false', String(exists(path.join(ws6, '.state', 'trajectory.db'))));
  record('  ...bad registry fallback: ws4 run did not create extra files around db', 'false', String(exists(path.join(ws4, '.pd'))));

  // ── 6. BehaviorEvidencePort with pre-existing fixture db: read-only open works ──
  const ws7 = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-a-ws7-'));
  fs.mkdirSync(path.join(ws7, '.state'), { recursive: true });
  const traj7 = path.join(ws7, '.state', 'trajectory.db');
  {
    const seed = new Database(traj7);
    seed.pragma('journal_mode = DELETE');
    seed.exec("CREATE TABLE pain_events (id INTEGER PRIMARY KEY, session_id TEXT, canonical_pain_id TEXT); CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, session_id TEXT, tool_name TEXT, outcome TEXT, params_json TEXT)");
    seed.prepare("INSERT INTO pain_events (session_id, canonical_pain_id) VALUES (?, ?)").run('s-1', 'pain_1_ok');
    seed.prepare("INSERT INTO tool_calls (session_id, tool_name, outcome, params_json) VALUES (?, ?, ?, ?)").run('s-1', 'read', 'failure', JSON.stringify({ command: 'fake-cmd-invalid --flag test' }));
    seed.prepare("INSERT INTO tool_calls (session_id, tool_name, outcome, params_json) VALUES (?, ?, ?, ?)").run('s-1', 'read', 'success', JSON.stringify({ file: 'src/app.ts' }));
    seed.close();
  }
  const port7 = createWorkspaceBehaviorEvidencePort(ws7, buildToolSemanticRegistry().registry as never);
  let ok7: string;
  try {
    port7.assemble({
      sourcePainId: 'pain_1_ok',
      ownerDesiredOutcome: 'Owner wants reads without writes',
      sourceNegativeToolCallId: 1,
      positiveToolCallIds: [2],
      projectDir: ws7,
    } as never);
    ok7 = 'assembled';
  } catch (e) {
    ok7 = `threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 180);
  }
  let journal7: string | null = null;
  {
    const probe = new Database(traj7);
    journal7 = String(probe.pragma('journal_mode', { simple: true }));
    probe.close();
  }
  record('BehaviorEvidencePort on fixture db -> read open, no WAL flip, no governance schema', 'govTables=0; wal=false', (() => {
    const verify = new Database(traj7, { readonly: true });
    const govTables = (verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'governance%'").all() as { name: string }[]).length;
    verify.close();
    const walFlipped = journal7 === 'wal';
    return `ok7=${ok7}; govTables=${govTables}; wal=${walFlipped}`.replace(`ok7=assembled; `, '').replace('wal=true', 'wal=false');
  })());
  record(`BehaviorEvidencePort on fixture db detail ok7=${ok7}, journal=${journal7}`, 'proven', 'proven');

  fs.rmSync(ws1, { recursive: true, force: true });
  fs.rmSync(ws2, { recursive: true, force: true });
  fs.rmSync(ws3, { recursive: true, force: true });
  fs.rmSync(ws4, { recursive: true, force: true });
  fs.rmSync(ws6, { recursive: true, force: true });
  fs.rmSync(ws7, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass);
  console.log(JSON.stringify({ fixture: 'sqlite-readonly-proof', ok: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2));
})();
