/**
 * PD-SPEC-001 Phase 0c step 1 — workspace DB snapshot (consistent, read-only)
 * + linkage discovery for the pain inventory.
 *
 * PD-Lab v0.3 / PRI-1251 (T1): parameterized, blob-inclusive read-only
 * snapshot per TECH-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3 §5.1.
 *
 * Contract:
 * - `--source-workspace <dir>` and `--out <dir>` are both REQUIRED. A missing
 *   or valueless flag exits 2 with usage on stderr. No defaults, no machine
 *   paths, no env fallback.
 * - Source DBs are opened READONLY (fileMustExist) and never written; copies
 *   come from the better-sqlite3 backup API; integrity_check runs on BOTH the
 *   source and the copy. A non-ok source integrity fails the run (exit 1).
 * - Paths come from their owning authorities, never hand-assembled here:
 *   state/trajectory DBs from `@principles/core/runtime/storage-paths`; the
 *   blob dir from the plugin's own `PD_FILES` authority
 *   (`resolvePdPath(ws, 'TRAJECTORY_BLOBS_DIR')`).
 * - Snapshot layout (kept compatible with build-inventory / freeze-dataset):
 *     <out>/snapshot/state.db            backup-API copy
 *     <out>/snapshot/trajectory.db       backup-API copy
 *     <out>/snapshot/blobs/<file>        ONLY blobs referenced by an in-DB
 *                                        `blob_ref` column; orphans counted,
 *                                        never copied
 *     <out>/snapshot/blob-manifest.json  per-file path/bytes/sha256/refCount
 *     <out>/snapshot-report.json         full report (unchanged file name)
 *     <out>/README.md                    git-16 style index
 * - Cross-source consistency: the two DBs and the blobs are not one atomic
 *   transaction. The run records windowStart/windowEnd and each DB's latest
 *   row timestamp; a row newer than windowStart proves a concurrent write and
 *   marks the snapshot PARTIAL_CONSISTENCY instead of claiming full
 *   consistency.
 * - All SQL uses bound parameters. The only identifiers interpolated into
 *   statement text come from the copy's own sqlite_master and must match
 *   /^[A-Za-z0-9_]+$/; blob refs must match the store's `<kind>-<hash>.txt`
 *   shape (no separators, no traversal).
 */
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { resolveStateDbPath, resolveTrajectoryDbPath } = require('@principles/core/runtime/storage-paths');
const { resolvePdPath } = require('../../../packages/openclaw-plugin/dist/core/paths.js');

const USAGE = [
  'usage: node snapshot-and-discover.mjs --source-workspace <dir> --out <dir>',
  '',
  '  --source-workspace <dir>  PD workspace whose .pd/state.db,',
  '                            .state/trajectory.db and .state/blobs are',
  '                            snapshotted. Opened read-only; never written.',
  '  --out <dir>               snapshot output directory. Must live outside',
  '                            the source workspace.',
  '',
  'Both flags are required; there are no defaults.',
].join('\n');

// ── Argument parsing (exit 2 on any misuse) ─────────────────────────────────

const argv = process.argv.slice(2);

/**
 * null = flag absent; undefined = present but its value is missing/empty/another
 * flag (a usage error); string = the value.
 */
function readOpt(name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return undefined;
  return value;
}

if (argv.includes('--help')) {
  console.error(USAGE);
  process.exit(0);
}
const sourceWorkspaceRaw = readOpt('--source-workspace');
const outRaw = readOpt('--out');
if (sourceWorkspaceRaw == null || outRaw == null) {
  console.error(USAGE);
  process.exit(2);
}

function fail(reason, nextAction) {
  console.error(JSON.stringify({ ok: false, reason, nextAction }, null, 2));
  process.exit(1);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contains(ancestor, candidate) {
  const rel = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const sourceWorkspace = path.resolve(sourceWorkspaceRaw);
const outDir = path.resolve(outRaw);
if (contains(sourceWorkspace, outDir)) {
  fail(
    `out_inside_source_workspace:${outDir}`,
    'The snapshot output must live OUTSIDE the source workspace; writing into it would violate the read-only discipline',
  );
}

// ── Path resolution via the owning authorities ──────────────────────────────

const SOURCES = {
  state: resolveStateDbPath(sourceWorkspace),
  trajectory: resolveTrajectoryDbPath(sourceWorkspace),
};
const sourceBlobDir = resolvePdPath(sourceWorkspace, 'TRAJECTORY_BLOBS_DIR');

for (const [name, srcPath] of Object.entries(SOURCES)) {
  if (!existsSync(srcPath)) {
    fail(
      `source_db_missing:${name}:${srcPath}`,
      'Point --source-workspace at an initialized PD workspace (pd runtime init) and retry',
    );
  }
}

const snapDir = path.join(outDir, 'snapshot');
const snapBlobsDir = path.join(snapDir, 'blobs');
mkdirSync(snapBlobsDir, { recursive: true });

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── Phase 1: integrity + backup-API copy of both DBs ───────────────────────

const windowStartIso = new Date().toISOString();
const report = {
  spec: 'PD-SPEC-001',
  phase: '0c-snapshot',
  takenAt: windowStartIso,
  params: { sourceWorkspace, outDir },
  sources: {},
  snapshots: {},
  counts: {},
  blobs: {},
  consistency: {},
  discovery: {},
};

for (const [name, srcPath] of Object.entries(SOURCES)) {
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const integrity = src.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    src.close();
    fail(
      `source_integrity_not_ok:${name}:${String(integrity)}`,
      'The source database failed integrity_check; no snapshot was taken from it. Inspect the source before retrying',
    );
  }
  const destPath = path.join(snapDir, `${name}.db`);
  await src.backup(destPath);
  const snap = new Database(destPath, { readonly: true });
  const snapIntegrity = snap.pragma('integrity_check', { simple: true });
  report.sources[name] = {
    path: srcPath,
    integrityCheck: integrity,
    sizeBytes: statSync(srcPath).size,
  };
  report.snapshots[name] = {
    path: destPath,
    integrityCheck: snapIntegrity,
    sha256: sha256File(destPath),
    sizeBytes: statSync(destPath).size,
  };
  snap.close();
  src.close();
}

// ── Phase 2: count verification source vs snapshot ─────────────────────────

const COUNT_TABLES = {
  state: ['tasks', 'runs', 'artifacts', 'pi_artifacts', 'principle_candidates', 'pain_diagnoses', 'dead_letter_pains', 'pending_agent_drafts', 'intent_decisions'],
  trajectory: ['pain_events'],
};
for (const [name, tables] of Object.entries(COUNT_TABLES)) {
  const src = new Database(SOURCES[name], { readonly: true, fileMustExist: true });
  const snap = new Database(report.snapshots[name].path, { readonly: true });
  report.counts[name] = {};
  for (const t of tables) {
    try {
      const a = src.prepare(`SELECT count(*) AS c FROM "${t}"`).get().c;
      const b = snap.prepare(`SELECT count(*) AS c FROM "${t}"`).get().c;
      report.counts[name][t] = { source: a, snapshot: b, match: a === b };
    } catch (e) {
      report.counts[name][t] = { error: String(e.message) };
    }
  }
  snap.close();
  src.close();
}

// ── Phase 3: blob reference scan (on the trajectory copy) ──────────────────
//
// "Referenced" follows TECH §5.1 (scan the DB's own `blob_ref` columns). This
// is a superset of the plugin's orphan-prune set (assistant_turns ∪
// user_turns): a blob referenced by any table is preserved here even if the
// plugin's sweeper would not count it.

const IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;
const BLOB_REF_SHAPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const trajSnap = new Database(report.snapshots.trajectory.path, { readonly: true });
const refTables = [];
for (const row of trajSnap.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
  if (!isRecord(row) || typeof row.name !== 'string' || !IDENTIFIER_RE.test(row.name)) continue;
  const cols = trajSnap.prepare(`PRAGMA table_info("${row.name}")`).all();
  if (Array.isArray(cols) && cols.some((c) => isRecord(c) && c.name === 'blob_ref')) {
    refTables.push(row.name);
  }
}

/** ref -> { count, tables } */
const referenced = new Map();
for (const table of refTables) {
  const rows = trajSnap
    .prepare(`SELECT blob_ref AS ref, COUNT(*) AS c FROM "${table}" WHERE blob_ref IS NOT NULL AND blob_ref <> '' GROUP BY blob_ref`)
    .all();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.ref !== 'string' || typeof row.c !== 'number') {
      trajSnap.close();
      fail('blob_ref_scan_row_invalid', 'The trajectory copy returned an unexpected blob_ref row shape; no blobs were copied');
    }
    const entry = referenced.get(row.ref) ?? { count: 0, tables: new Set() };
    entry.count += row.c;
    entry.tables.add(table);
    referenced.set(row.ref, entry);
  }
}

const unsafeRefs = [...referenced.keys()].filter((ref) => !BLOB_REF_SHAPE_RE.test(ref));
if (unsafeRefs.length > 0) {
  trajSnap.close();
  fail(
    `blob_ref_shape_unsafe:${unsafeRefs.slice(0, 3).join(',')}`,
    'blob_ref values must be plain file names (no separators/traversal); refusing to resolve them',
  );
}

// ── Phase 4: copy referenced blobs, count orphans ──────────────────────────

const manifestFiles = [];
const missingRefs = [];
for (const ref of [...referenced.keys()].sort()) {
  const src = path.join(sourceBlobDir, ref);
  if (!existsSync(src)) {
    missingRefs.push(ref);
    continue;
  }
  const dest = path.join(snapBlobsDir, ref);
  copyFileSync(src, dest);
  manifestFiles.push({
    path: `blobs/${ref}`,
    ref,
    bytes: statSync(dest).size,
    sha256: sha256File(dest),
    referenceCount: referenced.get(ref).count,
    referencedBy: [...referenced.get(ref).tables].sort(),
  });
}
if (missingRefs.length > 0) {
  trajSnap.close();
  fail(
    `referenced_blob_missing:${missingRefs.slice(0, 3).join(',')}${missingRefs.length > 3 ? ` (+${missingRefs.length - 3} more)` : ''}`,
    'A row references a blob file that is absent from the source blob dir; the snapshot would be incomplete',
  );
}
if (manifestFiles.length !== referenced.size) {
  trajSnap.close();
  fail(
    `blob_copy_count_mismatch:referenced=${referenced.size}:copied=${manifestFiles.length}`,
    'Copied blob count does not reconcile with the referenced set; inspect the blob dir',
  );
}

const orphanNames = [];
if (existsSync(sourceBlobDir)) {
  for (const entry of readdirSync(sourceBlobDir)) {
    if (referenced.has(entry)) continue;
    const st = statSync(path.join(sourceBlobDir, entry));
    if (st.isFile()) orphanNames.push(entry);
  }
}

// ── Phase 5: blob manifest ──────────────────────────────────────────────────

const manifest = {
  schema: 'pd-lab-blob-manifest.v1',
  generatedAt: new Date().toISOString(),
  sourceWorkspace,
  blobDir: 'blobs',
  files: manifestFiles,
  counts: {
    referencedDistinct: referenced.size,
    referencedRows: [...referenced.values()].reduce((sum, e) => sum + e.count, 0),
    copied: manifestFiles.length,
    orphansNotCopied: orphanNames.length,
  },
};
const manifestPath = path.join(snapDir, 'blob-manifest.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const manifestSha256 = sha256File(manifestPath);
report.blobs = {
  sourceBlobDir,
  scanTables: [...refTables].sort(),
  manifestPath,
  manifestSha256,
  ...manifest.counts,
  orphanNames,
};

// ── Phase 6: cross-source consistency window ────────────────────────────────
//
// The DBs and blob files are copied in separate steps, so cross-source
// consistency cannot be assumed. The recorded facts: the snapshot window and
// each DB's latest row timestamp. Any row newer than windowStart proves a
// write DURING the snapshot → PARTIAL_CONSISTENCY (TECH §5.1).

function latestRowIso(dbPath, tables) {
  const db = new Database(dbPath, { readonly: true });
  let latest = null;
  try {
    for (const table of tables) {
      const existsRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (existsRow === undefined) continue;
      const row = db.prepare(`SELECT MAX(created_at) AS m FROM "${table}"`).get();
      if (isRecord(row) && typeof row.m === 'string' && (latest === null || row.m > latest)) {
        latest = row.m;
      }
    }
  } finally {
    db.close();
  }
  return latest;
}

const windowEndIso = new Date().toISOString();
const stateLatestRowAt = latestRowIso(report.snapshots.state.path, ['tasks', 'runs']);
const trajectoryLatestRowAt = latestRowIso(report.snapshots.trajectory.path, [
  'pain_events',
  'assistant_turns',
  'user_turns',
  'tool_calls',
]);
const windowStartMs = Date.parse(windowStartIso);
const rowsNewerThanWindowStart = [stateLatestRowAt, trajectoryLatestRowAt]
  .filter((iso) => iso !== null && Number.isFinite(Date.parse(iso)) && Date.parse(iso) > windowStartMs)
  .length;
report.consistency = {
  windowStart: windowStartIso,
  windowEnd: windowEndIso,
  stateLatestRowAt,
  trajectoryLatestRowAt,
  rowsNewerThanWindowStart,
  status: rowsNewerThanWindowStart > 0 ? 'PARTIAL_CONSISTENCY' : 'CONSISTENT_WITHIN_WINDOW',
  note:
    'The two SQLite DBs and the blob files are not one atomic transaction; '
    + 'consistency is declared for the recorded window only. A row newer than '
    + 'windowStart proves a concurrent write and downgrades the snapshot to '
    + 'PARTIAL_CONSISTENCY.',
};

// ── Phase 7: discovery (on the copies, unchanged from Phase 0c) ─────────────

const state = new Database(report.snapshots.state.path, { readonly: true });

report.discovery.painBySource = trajSnap.prepare('SELECT source, count(*) AS c FROM pain_events GROUP BY source ORDER BY c DESC').all();
report.discovery.painBySeverity = trajSnap.prepare('SELECT severity, count(*) AS c FROM pain_events GROUP BY severity ORDER BY c DESC').all();
report.discovery.painByHostKind = trajSnap.prepare('SELECT host_kind, count(*) AS c FROM pain_events GROUP BY host_kind ORDER BY c DESC').all();
report.discovery.painColumns = trajSnap.prepare('PRAGMA table_info(pain_events)').all().map((c) => c.name);

report.discovery.taskKindStatus = state.prepare('SELECT task_kind, status, count(*) AS c FROM tasks GROUP BY task_kind, status ORDER BY task_kind, c DESC').all();

const kinds = state.prepare('SELECT DISTINCT task_kind FROM tasks').all().map((r) => r.task_kind);
report.discovery.taskIdSamples = {};
for (const k of kinds) {
  report.discovery.taskIdSamples[k] = state.prepare('SELECT task_id FROM tasks WHERE task_kind = ? LIMIT 2').all(k).map((r) => r.task_id);
}

report.discovery.painDiagnosesColumns = state.prepare('PRAGMA table_info(pain_diagnoses)').all().map((c) => c.name);
report.discovery.painDiagnosesSamples = state.prepare('SELECT id, pain_id, task_id, diagnosis_id, category, confidence, created_at FROM pain_diagnoses ORDER BY created_at DESC LIMIT 5').all();

report.discovery.principleCandidateColumns = state.prepare('PRAGMA table_info(principle_candidates)').all().map((c) => c.name);
report.discovery.piArtifactKinds = state.prepare('SELECT artifact_kind, validation_status, count(*) AS c FROM pi_artifacts GROUP BY artifact_kind, validation_status ORDER BY c DESC').all();

report.discovery.allTables = state.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);

state.close();
trajSnap.close();

// ── Phase 8: README index (AGENTS.md git-16) + report ──────────────────────

const totalBytesOut =
  report.snapshots.state.sizeBytes
  + report.snapshots.trajectory.sizeBytes
  + manifestFiles.reduce((sum, f) => sum + f.bytes, 0);
const readme = [
  '# PD workspace snapshot (read-only copy)',
  '',
  `- source workspace: ${sourceWorkspace}`,
  `- taken at: ${report.takenAt}`,
  `- snapshot window: ${windowStartIso} .. ${windowEndIso} (${report.consistency.status})`,
  `- state.db: ${report.snapshots.state.sizeBytes} bytes, sha256 ${report.snapshots.state.sha256}, integrity ${report.snapshots.state.integrityCheck}`,
  `- trajectory.db: ${report.snapshots.trajectory.sizeBytes} bytes, sha256 ${report.snapshots.trajectory.sha256}, integrity ${report.snapshots.trajectory.integrityCheck}`,
  `- blobs: ${manifest.counts.copied} copied (${manifestFiles.reduce((sum, f) => sum + f.bytes, 0)} bytes), ${manifest.counts.orphansNotCopied} orphans NOT copied`,
  `- blob-manifest.json sha256: ${manifestSha256}`,
  `- total snapshot payload: ${totalBytesOut} bytes across ${2 + manifest.counts.copied} files (DBs + blobs)`,
  `- source latest rows: state=${stateLatestRowAt ?? 'n/a'} trajectory=${trajectoryLatestRowAt ?? 'n/a'}`,
  '',
  'Contents: snapshot/state.db, snapshot/trajectory.db, snapshot/blobs/,',
  'snapshot/blob-manifest.json, snapshot-report.json. The source workspace was',
  'opened read-only and never written. Orphan blobs (present in the source blob',
  'dir but referenced by no `blob_ref` row) are intentionally excluded.',
  '',
  `Reproduce: node experiment/prompt-v2/scripts/snapshot-and-discover.mjs --source-workspace <dir> --out <dir>`,
  '',
].join('\n');
writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');

writeFileSync(path.join(outDir, 'snapshot-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  params: report.params,
  sources: report.sources,
  snapshots: report.snapshots,
  counts: report.counts,
  blobs: { ...report.blobs, orphanNames: undefined },
  consistency: report.consistency,
}, null, 1));
console.log('painBySource:', JSON.stringify(report.discovery.painBySource));
console.log('taskKindStatus:', JSON.stringify(report.discovery.taskKindStatus));
console.log('piArtifactKinds:', JSON.stringify(report.discovery.piArtifactKinds.slice(0, 12)));
console.log('allTables:', JSON.stringify(report.discovery.allTables));
console.log('report ->', path.relative(process.cwd(), path.join(outDir, 'snapshot-report.json')));
