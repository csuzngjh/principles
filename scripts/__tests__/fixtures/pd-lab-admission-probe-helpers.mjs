/**
 * PRI-1257 / PD-Lab v0.3 T7a-Data — test fixtures and subprocess driver.
 *
 * Lives under fixtures/ as .mjs so the subprocess execution primitive keeps a
 * literal command position (argv-array form, never a composed shell string)
 * and the synthetic-world builders stay importable from the .ts suite
 * (same pattern as the T3b/T5 fixtures).
 *
 * Everything here is synthetic: REAL trajectory schema via
 * `applyTrajectorySchemaBase`, fake dataset, fake blob manifest. No real
 * full-fidelity data, no network, no model calls.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { applyTrajectorySchemaBase } = require('@principles/core/runtime');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');
export const SCRIPT = path.join(REPO_ROOT, 'scripts', 'dev', 'pd-lab', 'admission-probe.mjs');
export const SCRIPT_SOURCE = fs.readFileSync(SCRIPT, 'utf8');

/** CONTRACT §2.4 first-batch problem codes — the closed set the probe may emit. */
export const CONTRACT_PROBLEM_CODES = [
  'SOURCE_GAP',
  'SOURCE_RETENTION_EXPIRED',
  'TURN_BLOB_MISSING',
  'TOOL_RESULT_PREVIEW_ONLY',
  'PAIN_ANCHOR_MISSING',
  'EXPECTATION_UNRESOLVED',
  'AUTHORIZATION_UNVERIFIED',
  'REFERENCE_UNAVAILABLE',
  'DIGEST_MISMATCH',
  'FUTURE_INFORMATION',
  'ENVIRONMENT_UNAVAILABLE',
];

export const T0 = '2026-09-01T10:00:00.000Z'; // session start / early turns
export const T1 = '2026-09-01T10:02:00.000Z'; // later turns
export const PAIN_AT = '2026-09-01T10:05:00.000Z'; // pain trigger

export function tmpRoot() {
  const raw = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  return fs.realpathSync(typeof raw === 'string' && raw.length > 0 ? raw : os.tmpdir());
}

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** rel path -> { sha256, mtimeMs } for every file under `dir` (Dirent-safe walk). */
export function fingerprintTree(dir) {
  const out = new Map();
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        walk(full, `${prefix}${entry.name}/`);
        continue;
      }
      if (st.isFile()) {
        out.set(`${prefix}${entry.name}`, { sha256: sha256File(full), mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Subprocess driver: the REAL CLI through `npm run lab:probe`'s script.
 * Command position is the literal interpreter; all inputs go as argv.
 */
export function runProbe(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: REPO_ROOT,
  });
}

// ---------------------------------------------------------------------------
// Synthetic world builder (REAL schema, synthetic content)
// ---------------------------------------------------------------------------

export function buildWorld(label, options) {
  const root = fs.mkdtempSync(path.join(tmpRoot(), `pd-lab-probe-${label}-`));
  const snapshotDir = path.join(root, 'snapshot');
  const blobsDir = path.join(snapshotDir, 'blobs');
  fs.mkdirSync(blobsDir, { recursive: true });

  const bodyMarkers = [];
  const blobFiles = new Map(); // ref -> body

  const db = new Database(path.join(snapshotDir, 'trajectory.db'));
  applyTrajectorySchemaBase(db);

  for (const session of options.sessions) {
    if (!session.omitSessionRow) {
      db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run(
        session.sessionId,
        session.startedAt ?? T0,
        T0,
      );
    }
    for (const turn of session.userTurns ?? []) {
      const body = `user-body-${session.sessionId}-${turn.turnIndex}-CONFIDENTIAL-MARKER`;
      bodyMarkers.push(body);
      if (turn.blobRef) {
        blobFiles.set(turn.blobRef, `blob-body-${turn.blobRef}-CONFIDENTIAL-MARKER`);
      }
      db.prepare(
        'INSERT INTO user_turns (session_id, turn_index, raw_text, blob_ref, raw_excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(session.sessionId, turn.turnIndex, turn.blobRef ? null : body, turn.blobRef ?? null, 'excerpt', turn.createdAt ?? T0);
    }
    for (const turn of session.assistantTurns ?? []) {
      const body = `assistant-body-${session.sessionId}-${bodyMarkers.length}-CONFIDENTIAL-MARKER`;
      bodyMarkers.push(body);
      if (turn.blobRef) {
        blobFiles.set(turn.blobRef, `blob-body-${turn.blobRef}-CONFIDENTIAL-MARKER`);
      }
      db.prepare(
        'INSERT INTO assistant_turns (session_id, run_id, provider, model, sanitized_text, usage_json, empathy_signal_json, blob_ref, raw_excerpt, created_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(session.sessionId, 'run-1', 'prov', 'model', turn.blobRef ? '[blob]' : body, '{}', '{}', turn.blobRef ?? null, 'excerpt', turn.createdAt ?? T0);
    }
    let callIndex = 0;
    for (const call of session.toolCalls ?? []) {
      callIndex += 1;
      const preview = call.resultPreview ?? 'ok';
      if (preview.length > 20) {
        bodyMarkers.push(preview);
      }
      db.prepare(
        'INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, result_preview, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(session.sessionId, `tool-${callIndex}`, 'success', call.paramsJson ?? '{}', preview, T0);
    }
  }
  db.prepare('INSERT INTO pain_events (session_id, source, score, created_at) VALUES (?, ?, ?, ?)').run(
    'seed-pain-session',
    'user_frustration',
    80,
    PAIN_AT,
  );
  db.pragma('journal_mode = DELETE');
  db.close();

  for (const [ref, extraBody] of options.blobBodies ?? new Map()) {
    blobFiles.set(ref, extraBody);
  }
  const files = [];
  for (const [ref, body] of blobFiles) {
    fs.writeFileSync(path.join(blobsDir, ref), body, 'utf8');
    files.push({
      path: `blobs/${ref}`,
      ref,
      bytes: Buffer.byteLength(body, 'utf8'),
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      referenceCount: 1,
      referencedBy: ['assistant_turns'],
    });
  }
  if (options.corruptManifestEntry) {
    for (const entry of files) {
      options.corruptManifestEntry(entry);
    }
  }
  if (options.dropBlob) {
    fs.rmSync(path.join(blobsDir, options.dropBlob));
  }
  const manifest = {
    schema: 'pd-lab-blob-manifest.v1',
    generatedAt: '2026-11-20T00:00:00.000Z',
    sourceWorkspace: 'synthetic',
    blobDir: 'blobs',
    ok: true,
    consistencyStatus: 'CONSISTENT_WITHIN_WINDOW',
    consistencyReasons: [],
    files,
    counts: { referencedDistinct: files.length, referencedRows: files.length, copied: files.length, orphansNotCopied: 0 },
  };
  fs.writeFileSync(path.join(snapshotDir, 'blob-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const dataset = {
    spec: 'PD-SPEC-001',
    frozenAt: '2026-11-15T00:00:00.000Z',
    samples: options.samples.map((sample) => ({
      experimentPainId: sample.caseId,
      painEvent: {
        id: 1,
        session_id: sample.sessionId,
        source: 'user_frustration',
        score: 80,
        reason: sample.reason ?? 'synthetic reason',
        created_at: sample.createdAt ?? PAIN_AT,
        host_kind: sample.hostKind ?? 'openclaw',
      },
      evidenceRefs: sample.evidenceRefs ?? [],
    })),
  };
  const datasetPath = path.join(root, 'dataset.json');
  fs.writeFileSync(datasetPath, JSON.stringify(dataset, null, 2), 'utf8');

  return { root, datasetPath, snapshotDir, outDir: path.join(root, 'probe-out'), bodyMarkers };
}

/** A fully valid single-session, single-sample world (the positive control). */
export function buildHealthyWorld(label) {
  return buildWorld(label, {
    sessions: [
      {
        sessionId: 'sess-healthy',
        startedAt: T0,
        userTurns: [{ turnIndex: 0 }, { turnIndex: 1, createdAt: T1 }],
        assistantTurns: [{ createdAt: T0 }, { createdAt: T1 }],
        toolCalls: [{ paramsJson: '{"cmd":"ls"}', resultPreview: 'ok' }],
      },
    ],
    samples: [{ caseId: 'S01', sessionId: 'sess-healthy', evidenceRefs: ['session:sess-healthy'] }],
  });
}

/** Write JSON at a fixed filename inside a test-owned directory. */
export function writeJson(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

/** Read the probe's output artifacts. */
export function readOut(outDir, verifyMode = false) {
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'admission-report.json'), 'utf8'));
  const queue = JSON.parse(fs.readFileSync(path.join(outDir, 'remediation-queue.json'), 'utf8'));
  const groups = verifyMode ? null : JSON.parse(fs.readFileSync(path.join(outDir, 'source-groups.json'), 'utf8'));
  return { report, groups, queue };
}

export function codesOf(out, caseId) {
  return out.report.perSample.find((s) => s.caseId === caseId).problems.map((p) => p.code);
}

export function healthyExpectations() {
  return { S01: { expectationId: 'exp-1', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: false } };
}

export function healthyAuthorizations() {
  return { S01: { status: 'granted', scope: 'full_fidelity' } };
}

/** Parse the last stderr line of a failed probe run into its structured reason. */
export function stderrReason(run) {
  return JSON.parse(run.stderr.trim().split('\n').pop());
}
