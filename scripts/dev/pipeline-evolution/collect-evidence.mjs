#!/usr/bin/env node
// PRI-653 Pipeline Evolution Lab — evidence collector.
//
// Scripted form of the FORENSICS.md §1–3 query groups (closure-harness SPEC
// Phase 1 "pipeline assertion combo" half): reads ONLY existing stores —
//   <ws>/.pd/state.db            (tasks / runs / pi_artifacts / approvals /
//                                 activations / principle_candidates)
//   <ws>/.state/trajectory.db    (sessions / tool_calls / pain_events)
//   <ws>/.pd/telemetry/critical-events.jsonl   (adversarial gate events)
// — all SQLite opened READ-ONLY (better-sqlite3 readonly + fileMustExist).
// No new store is created; nothing is written except --out/--package output.
//
// PRI-685 Evidence Foundation additions:
//   --experiment <manifest.json>  bind collection to one experiment
//                                  (session → pain → candidate → correlation;
//                                  NO "recent 10" fallback in this mode)
//   --package <dir>                write a full evidence package
//                                  (manifest/index/trace/metrics/report +
//                                   artifact & telemetry export copies)
//   truncation marks               every bounded collection reports
//                                  { returned, total, truncated } (SPEC §12.3)
//
// Usage:
//   node scripts/dev/pipeline-evolution/collect-evidence.mjs --workspace <dir> \
//          [--chain <correlationId>] [--session <sid>] [--task <taskId>] [--json] [--out <file>] \
//          [--experiment <manifest.json> [--package <dir>]]
//
// --task: per-attempt run timeline for one task (duration / runtime / death
//   reason per attempt) — retry-budget & timeout-cap forensics (PRI-683 pattern:
//   failures clustered at one exact duration = hard cap; spread = latency).
//
// Exit codes: 0 = collected (report may still contain FAIL stages — that is
// data, not a tool error); 1 = usage/environment error.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadManifest } from './lib/experiment-manifest.mjs';
import {
  buildEvidenceIndex,
  buildMetrics,
  buildPipelineTrace,
  renderOwnerReview,
} from './lib/evidence-package.mjs';

const require = createRequire(import.meta.url);

const KINDS = [
  'diag_rootcause',
  'diag_distiller',
  'diag_router',
  'diagnostician',
  'dreamer',
  'philosopher',
  'scribe',
  'artificer_repair',
  'artificer-repair',
  'artificer',
  'evaluator_repair',
  'evaluator-repair',
  'evaluator',
  'rollout_reviewer',
];

const STAGE_ORDER = [
  'pain',
  'diagnosis',
  'principle',
  'rule',
  'validation',
  'activation',
  'behavior',
];

const BOUND = 200; // bounded preview length for any free-text field (rc-8)
// Collection caps. Experiment scope is naturally small, but bounds stay —
// truncation must be marked, never silent (SPEC §12.3).
const CAP = {
  chains: 50,
  pains: 100,
  sessions: 100,
  candidates: 100,
  toolCalls: 200,
  adversarialEvents: 20,
};

function clip(value, bound = BOUND) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  const max = Math.min(bound, BOUND);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parseArgs(argv) {
  const opts = {
    workspace: null,
    chain: null,
    session: null,
    task: null,
    json: false,
    out: null,
    experiment: null,
    package: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = argv[i + 1];
    const takesValue =
      a === '--workspace' || a === '--chain' || a === '--session' || a === '--task' || a === '--out' || a === '--experiment' || a === '--package';
    if (takesValue) {
      if (!value) {
        console.error(`missing value for ${a}`);
        process.exit(1);
      }
      if (a === '--workspace') opts.workspace = value;
      else if (a === '--chain') opts.chain = value;
      else if (a === '--session') opts.session = value;
      else if (a === '--task') opts.task = value;
      else if (a === '--out') opts.out = value;
      else if (a === '--experiment') opts.experiment = value;
      else opts.package = value;
      i += 1;
    } else if (a === '--json') {
      opts.json = true;
    } else {
      console.error(`unknown argument: ${a}`);
      console.error(
        'usage: collect-evidence.mjs --workspace <abs-dir> [--chain <id>] [--session <sid>] [--task <taskId>] [--json] [--out <file>] [--experiment <manifest.json> [--package <dir>]]',
      );
      process.exit(1);
    }
  }
  if (!opts.workspace || !isAbsolute(resolve(opts.workspace))) {
    console.error(
      'usage: collect-evidence.mjs --workspace <abs-dir> [--chain <id>] [--session <sid>] [--task <taskId>] [--json] [--out <file>] [--experiment <manifest.json> [--package <dir>]]',
    );
    process.exit(1);
  }
  if (opts.package && !opts.experiment) {
    console.error('--package requires --experiment: a package must name its experiment (SPEC §7 manifest.json)');
    process.exit(1);
  }
  if (opts.task && opts.experiment) {
    // Not a hard error — --task answers a different question (one task's run
    // timeline) and is already fully scoped — but say it, so a combined
    // invocation never looks like it produced experiment evidence.
    console.error('note: --task mode ignores --experiment (the task id is already fully scoped)');
  }
  return opts;
}

// PD state may live at <ws>/.pd or <ws>/main/.pd depending on how the lab
// workspace was wired (OpenClaw nests the main agent under <ws>/main).
function resolvePdRoot(workspace) {
  const candidates = [workspace, join(workspace, 'main')];
  for (const root of candidates) {
    if (existsSync(join(root, '.pd', 'state.db'))) return { root, stateDb: join(root, '.pd', 'state.db') };
  }
  console.error(`no .pd/state.db under ${workspace} (nor ${join(workspace, 'main')}) — is this a PD workspace?`);
  process.exit(1);
}

function openReadOnly(dbPath) {
  const Database = require('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function correlationOf(taskId, kind) {
  for (const k of KINDS) {
    const prefix = `${k}-`;
    if (taskId.startsWith(prefix)) return { kind: k, correlation: taskId.slice(prefix.length) };
  }
  // diagnosis root task: task_kind=diagnostician, task_id=diagnosis_<painId>
  if (taskId.startsWith('diagnosis_')) return { kind: 'diagnostician', correlation: taskId };
  return { kind: kind ?? 'unknown', correlation: taskId };
}

function statusBucket(status) {
  const s = String(status ?? '');
  if (s === 'succeeded') return 'PASS';
  if (s === 'failed') return 'FAIL';
  if (s === 'needs_human_review') return 'BLOCKED_OWNER';
  if (s === 'needs_revision' || s === 'revision') return 'REPAIR';
  if (s === 'pending' || s === 'leased' || s === 'ready' || s === 'running' || s === 'retry_wait') return 'PENDING';
  return 'UNKNOWN';
}

function collectChain(state, correlation) {
  let tasks = state
    .prepare(
      'SELECT task_id, task_kind, status, attempt_count, created_at, updated_at FROM tasks WHERE task_id LIKE ? ORDER BY created_at',
    )
    .all(`%${correlation}%`);
  // Peer-chain correlations are candidate UUIDs; the candidate row links back
  // to diag_router-diagnosis_<painId>, which lets us join the diagnosis half
  // of the chain (otherwise pain/diagnosis would always read UNKNOWN).
  let painId = null;
  // correlation carries a channel suffix (e.g. "<uuid>-prompt") that the
  // candidate_id lacks — match by prefix.
  const candidate = state
    .prepare(`SELECT task_id FROM principle_candidates WHERE ? LIKE candidate_id || '-%' OR candidate_id = ?`)
    .get(correlation, correlation);
  if (candidate?.task_id && candidate.task_id.includes('diagnosis_')) {
    const diagnosisId = candidate.task_id.replace(/^diag_router-/, '');
    const diagTasks = state
      .prepare(
        'SELECT task_id, task_kind, status, attempt_count, created_at, updated_at FROM tasks WHERE task_id LIKE ? ORDER BY created_at',
      )
      .all(`%${diagnosisId}%`);
    const known = new Set(tasks.map((t) => t.task_id));
    for (const t of diagTasks) if (!known.has(t.task_id)) tasks.push(t);
    tasks.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    painId = diagnosisId.replace(/^diagnosis_/, '');
  }
  const artifacts = state
    .prepare(
      'SELECT artifact_id, artifact_kind, source_task_id, created_at FROM pi_artifacts WHERE source_task_id LIKE ? ORDER BY created_at',
    )
    .all(`%${correlation}%`);
  const runs = state
    .prepare('SELECT task_id, execution_status, reason FROM runs WHERE task_id LIKE ? ORDER BY started_at')
    .all(`%${correlation}%`);
  return { tasks, artifacts, runs, painId };
}

function capabilityMatrix(chain) {
  // Evidence-first mapping: derive PASS/FAIL only from durable terminal
  // statuses; anything unresolved stays UNKNOWN (never invent attribution).
  const byKind = new Map();
  for (const t of chain.tasks) {
    const { kind } = correlationOf(t.task_id, t.task_kind);
    const prev = byKind.get(kind);
    if (!prev || (t.updated_at ?? '') > (prev.updated_at ?? '')) byKind.set(kind, t);
  }
  const diagKinds = ['diagnostician', 'diag_rootcause', 'diag_distiller', 'diag_router'];
  const diagStatuses = diagKinds.map((k) => byKind.get(k)?.status);
  const peerKinds = ['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer'];
  const stage = (kinds) => kinds.map((k) => byKind.get(k)).filter(Boolean);

  const painStage = diagStatuses.some(Boolean) ? 'PASS' : 'UNKNOWN';
  const diagDone = diagStatuses.every((s) => s === 'succeeded' || s === undefined) && diagStatuses.includes('succeeded');
  const diagnosisStage = diagDone ? 'PASS' : diagStatuses.includes('failed') ? 'FAIL' : 'UNKNOWN';

  const rows = stage(['dreamer', 'philosopher', 'scribe']);
  const principleStage = rows.length
    ? rows.every((t) => t.status === 'succeeded')
      ? 'PASS'
      : rows.some((t) => t.status === 'failed')
        ? 'FAIL'
        : 'PENDING'
    : 'UNKNOWN';

  const art = stage(['artificer']);
  const ruleStage = art.length
    ? art[0].status === 'succeeded'
      ? 'PASS'
      : art[0].status === 'failed'
        ? 'FAIL'
        : 'PENDING'
    : 'UNKNOWN';

  const ev = stage(['evaluator']);
  const validationStage = ev.length
    ? ev[0].status === 'succeeded'
      ? 'PASS'
      : ev[0].status === 'failed'
        ? 'FAIL'
        : ev[0].status === 'needs_human_review'
          ? 'BLOCKED_OWNER'
          : 'PENDING'
    : 'UNKNOWN';

  const activationStage = chain.activationCount > 0 ? 'PASS' : chain.approvalPending > 0 ? 'BLOCKED_OWNER' : 'UNKNOWN';
  // Behavior change is not derivable from stores — always UNKNOWN here and
  // supplied by the Phase-4 re-run (documented in the lab README §4).
  return {
    pain: painStage,
    diagnosis: diagnosisStage,
    principle: principleStage,
    rule: ruleStage,
    validation: validationStage,
    activation: activationStage,
    behavior: 'UNKNOWN',
  };
}

function failureLayer(matrix) {
  for (const stageName of STAGE_ORDER.slice(0, 6)) {
    if (matrix[stageName] === 'FAIL') return stageName;
  }
  return 'unknown';
}

function readAdversarialEvents(root, window) {
  const file = join(root, '.pd', 'telemetry', 'critical-events.jsonl');
  if (!existsSync(file)) return { events: [], total: 0 };
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const events = [];
  let total = 0;
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      const t = String(j.eventType ?? '');
      if (!t.startsWith('evaluator_adversarial')) continue;
      // Experiment mode scopes telemetry by the manifest window — without a
      // window check, another experiment's replay events would leak into this
      // package (isolation is a tested contract, PRI-685 test #1).
      if (window) {
        const ts = typeof j.timestamp === 'string' ? j.timestamp : null;
        if (ts === null) continue; // unattributable event cannot enter a windowed package
        if (window.start && ts < window.start) continue;
        if (window.end && ts > window.end) continue;
      }
      total += 1;
      if (events.length < CAP.adversarialEvents) {
        events.push({
          timestamp: j.timestamp ?? null,
          eventType: t,
          payload: clip(JSON.stringify(j.payload ?? {})),
        });
      }
    } catch {
      // malformed line in an append-only log — skip, not our data to fix
    }
  }
  return { events, total };
}

// ---------------------------------------------------------------------------
// PRI-685 experiment binding: manifest → (pains, correlations, sessions).
// The manifest is the experiment's metadata authority (scope + attribution);
// runtime facts stay owned by state.db/trajectory.db/telemetry — discovery
// goes session → pain_events → candidates → correlations, and explicit
// manifest entries (painIds / correlations) are trusted as operator truth.
// ---------------------------------------------------------------------------

function inClause(values) {
  return values.map(() => '?').join(',');
}

function resolveExperimentScope(state, traj, manifest) {
  const bindingNotes = [];

  // 1. pains: explicit painIds win; else discover via sessionIds (+window).
  let pains = [];
  if (manifest.painIds.length > 0) {
    pains = traj
      .prepare(
        `SELECT id, session_id, source, score, reason, canonical_pain_id, created_at FROM pain_events WHERE canonical_pain_id IN (${inClause(manifest.painIds)})`,
      )
      .all(...manifest.painIds);
    const found = new Set(pains.map((p) => p.canonical_pain_id));
    for (const id of manifest.painIds) if (!found.has(id)) bindingNotes.push(`manifest painId ${id} not found in pain_events`);
  } else if (manifest.sessionIds.length > 0) {
    let sql = `SELECT id, session_id, source, score, reason, canonical_pain_id, created_at FROM pain_events WHERE session_id IN (${inClause(manifest.sessionIds)})`;
    const args = [...manifest.sessionIds];
    if (manifest.startedAt) {
      sql += ' AND created_at >= ?';
      args.push(manifest.startedAt);
    }
    if (manifest.finishedAt) {
      sql += ' AND created_at <= ?';
      args.push(manifest.finishedAt);
    }
    sql += ' ORDER BY id';
    pains = traj.prepare(sql).all(...args);
  }
  const painIds = pains.map((p) => p.canonical_pain_id);

  // Correlation discovery runs over declared ∪ discovered pain ids: a
  // manifest painId is operator truth even when its trajectory row is absent
  // (real case: pri653-e1's first pain lost its pain_events row while its
  // full chain lives on in state.db — dropping it would silently amputate
  // the experiment).
  const discoveryPainIds = [...new Set([...manifest.painIds, ...painIds])];

  // 2. correlations: candidates admitted for those pains + explicit entries.
  const correlations = new Set(manifest.correlations);
  for (const painId of discoveryPainIds) {
    const rows = state
      .prepare('SELECT candidate_id FROM principle_candidates WHERE task_id = ? ORDER BY rowid')
      .all(`diag_router-diagnosis_${painId}`);
    for (const r of rows) correlations.add(r.candidate_id);
  }
  // A pain that never reached candidate admission can still have its
  // diagnosis-half chain collected via the diagnosis task id.
  for (const painId of discoveryPainIds) {
    const diagTask = state.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(`diagnosis_${painId}`);
    if (diagTask && correlations.size < CAP.chains) correlations.add(`diagnosis_${painId}`);
  }
  if (correlations.size > CAP.chains) bindingNotes.push(`correlation set capped at ${CAP.chains} (manifest scope larger)`);

  const sessionIds = manifest.sessionIds.length > 0 ? manifest.sessionIds : [...new Set(pains.map((p) => p.session_id).filter(Boolean))];
  return { pains, painIds, discoveryPainIds, correlations: [...correlations].slice(0, CAP.chains), sessionIds, bindingNotes };
}

// ---------------------------------------------------------------------------
// Evidence package writer (SPEC §7/§13): derived files + bounded export
// copies. Copies carry sourceId/hash/schemaVersion/createdAt; the stores stay
// the only truth — a package is a derived, disposable projection.
// ---------------------------------------------------------------------------

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Export capacity guard: a package is a derived copy, not an archive — bound
// both the number of exported artifacts and the total bytes so a lab package
// stays small even when the store has grown for years. Skipped (not silently
// dropped) artifacts are counted in the truncation mark (SPEC §12.3 shape).
const EXPORT_CAP = { artifacts: 50, maxTotalBytes: 10 * 1024 * 1024 };

function exportArtifacts(state, chains, outDir) {
  const taskIds = new Set(chains.flatMap((c) => c.stages.map((s) => s.taskId)));
  const dir = join(outDir, 'artifacts');
  // A package is a disposable projection — clear stale exports so a rebuilt
  // package never carries artifacts that no longer belong to the experiment.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const exported = [];
  let totalInScope = 0;
  let totalBytes = 0;
  for (const chain of chains) {
    for (const a of chain.artifacts) {
      if (!a.sourceTaskId || !taskIds.has(a.sourceTaskId)) continue;
      const row = state
        .prepare(
          'SELECT artifact_id, artifact_kind, source_task_id, content_json, validation_status, created_at, updated_at FROM pi_artifacts WHERE artifact_id = ?',
        )
        .get(a.id);
      if (!row) continue;
      totalInScope += 1;
      const contentJson = String(row.content_json ?? '');
      if (exported.length >= EXPORT_CAP.artifacts || totalBytes + contentJson.length > EXPORT_CAP.maxTotalBytes) {
        continue; // count as skipped — the mark below reports it, never silently dropped
      }
      let content = null;
      let schemaVersion = null;
      try {
        content = JSON.parse(row.content_json);
        schemaVersion = typeof content?.version === 'string' ? content.version : null;
      } catch {
        content = row.content_json; // keep raw — unparsable content is data, not an error to hide
      }
      const record = {
        artifactId: row.artifact_id,
        sourceId: row.source_task_id,
        artifactKind: row.artifact_kind,
        validationStatus: row.validation_status ?? null,
        hash: sha256(contentJson),
        schemaVersion, // null = artifact carries no version field — honest UNKNOWN (rc-9)
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
        contentJson: content,
      };
      const text = JSON.stringify(record, null, 2) + '\n';
      writeFileSync(join(dir, `${row.artifact_id}.json`), text, 'utf8');
      totalBytes += contentJson.length;
      exported.push(row.artifact_id);
    }
  }
  return {
    exported,
    truncation: { returned: exported.length, total: totalInScope, truncated: exported.length < totalInScope },
  };
}

function writePackage(pkgDir, pkgData) {
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'manifest.json'), JSON.stringify(pkgData.manifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(pkgDir, 'collected.json'), JSON.stringify(pkgData.collected, null, 2) + '\n', 'utf8');
  writeFileSync(join(pkgDir, 'evidence-index.json'), JSON.stringify(pkgData.evidenceIndex, null, 2) + '\n', 'utf8');
  writeFileSync(join(pkgDir, 'pipeline-trace.json'), JSON.stringify(pkgData.pipelineTrace, null, 2) + '\n', 'utf8');
  writeFileSync(join(pkgDir, 'metrics.json'), JSON.stringify(pkgData.metrics, null, 2) + '\n', 'utf8');
  writeFileSync(join(pkgDir, 'report.md'), renderOwnerReview(pkgData) + '\n', 'utf8');
  const telDir = join(pkgDir, 'telemetry');
  mkdirSync(telDir, { recursive: true });
  writeFileSync(
    join(telDir, 'adversarial-events.json'),
    JSON.stringify(pkgData.telemetryExport, null, 2) + '\n',
    'utf8',
  );
}

// Per-attempt run timeline for one task (PRI-653 round-2 lesson: timeout-cap /
// retry-budget forensics took ~40min of hand-written SQL; this mode reproduces
// it in one command). Read-only; shows what each attempt actually ran on,
// how long it took, and why it died — the data needed to distinguish
// "config timeout not consumed" from "a second inner cap".
function collectTaskTimeline(state, taskId) {
  const task = state
    .prepare('SELECT task_id, task_kind, status, attempt_count, max_attempts, created_at, updated_at FROM tasks WHERE task_id = ?')
    .get(taskId);
  if (!task) return { task: null };
  const runs = state
    .prepare(
      'SELECT run_id, attempt_number, runtime_kind, execution_status, started_at, ended_at, reason, error_category FROM runs WHERE task_id = ? ORDER BY started_at',
    )
    .all(taskId);
  const attempts = runs.map((r) => {
    const startedMs = r.started_at ? Date.parse(r.started_at) : null;
    const endedMs = r.ended_at ? Date.parse(r.ended_at) : null;
    const durationMs =
      startedMs !== null && !Number.isNaN(startedMs) && endedMs !== null && !Number.isNaN(endedMs)
        ? endedMs - startedMs
        : null;
    return {
      attempt: r.attempt_number ?? null,
      runtime: r.runtime_kind ?? null,
      status: r.execution_status,
      startedAt: r.started_at ?? null,
      durationMs,
      errorCategory: r.error_category ?? null,
      reason: r.reason ? clip(r.reason, 120) : null,
    };
  });
  // Retry/timeout forensics summary: how attempts distributed across durations.
  const failed = attempts.filter((a) => a.status === 'failed');
  const failedWithDuration = failed.filter((a) => a.durationMs !== null);
  const timeoutDeaths = failedWithDuration.filter((a) => /timeout/i.test(String(a.reason ?? '')));
  return {
    task: {
      taskId: task.task_id,
      kind: task.task_kind,
      status: task.status,
      attempts: task.attempt_count ?? null,
      maxAttempts: task.max_attempts ?? null,
      createdAt: task.created_at ?? null,
      updatedAt: task.updated_at ?? null,
    },
    attempts,
    summary: {
      totalRuns: attempts.length,
      succeeded: attempts.filter((a) => a.status === 'succeeded').length,
      failed: failed.length,
      running: attempts.filter((a) => a.status === 'running').length,
      timeoutDeaths: timeoutDeaths.length,
      // A cluster of failures all pinned at one duration (stddev ≈ 0) is the
      // signature of a hard cap (PRI-683 pattern); spread-out durations point
      // at genuine provider latency instead.
      failedDurationMs: failedWithDuration.map((a) => a.durationMs),
      distinctRuntimes: [...new Set(attempts.map((a) => a.runtime).filter(Boolean))],
    },
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { root, stateDb } = resolvePdRoot(opts.workspace);
  const state = openReadOnly(stateDb);

  // --task mode: per-attempt run timeline for one task, then exit.
  // (Everything below is the chain-matrix path.)
  if (opts.task) {
    const timeline = collectTaskTimeline(state, opts.task);
    if (!timeline.task) {
      console.error(`no task '${opts.task}' in ${stateDb}`);
      process.exit(1);
    }
    const output = {
      collected: new Date().toISOString(),
      source: `read-only ${stateDb}`,
      taskId: opts.task,
      ...timeline,
    };
    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`# Run Timeline — ${opts.task}`);
      console.log(`task: ${timeline.task.kind} ${timeline.task.status} (${timeline.task.attempts}/${timeline.task.maxAttempts} attempts)`);
      console.log('summary:', JSON.stringify(timeline.summary));
      console.log('');
      console.log('attempt | runtime | status    | duration | reason');
      for (const a of timeline.attempts) {
        const dur = a.durationMs === null ? '(running)' : `${(a.durationMs / 1000).toFixed(0)}s`;
        console.log(
          String(a.attempt ?? '?').padEnd(7),
          String(a.runtime ?? '?').padEnd(7),
          String(a.status).padEnd(10),
          dur.padEnd(9),
          a.reason ?? '',
        );
      }
    }
    state.close();
    return;
  }

  let manifest = null;
  let scope = null;
  if (opts.experiment) {
    try {
      manifest = loadManifest(opts.experiment);
    } catch (err) {
      console.error(`[collect-evidence] ${err.message}`);
      process.exit(1);
    }
  }

  // trajectory.db is needed for experiment binding even before chain collection.
  const trajPath = join(root, '.state', 'trajectory.db');
  const trajAvailable = existsSync(trajPath);

  // Correlations to report: explicit --chain, else every correlation seen in
  // tasks (bounded to the 10 most recently updated).
  let correlations;
  let candidateFilter = null; // Set of candidate_ids
  let sessionFilter = null; // explicit session list
  let bindingNotes = [];
  if (manifest) {
    if (!trajAvailable) {
      console.error(`[collect-evidence] experiment mode requires trajectory.db (not found at ${trajPath}) — pain binding impossible`);
      process.exit(1);
    }
    const traj = openReadOnly(trajPath);
    try {
      scope = resolveExperimentScope(state, traj, manifest);
    } finally {
      traj.close();
    }
    correlations = scope.correlations;
    bindingNotes = scope.bindingNotes;
    if (scope.painIds.length > 0 || manifest.painIds.length > 0) {
      const candidateIds = new Set();
      for (const painId of scope.discoveryPainIds) {
        for (const r of state.prepare('SELECT candidate_id FROM principle_candidates WHERE task_id = ?').all(`diag_router-diagnosis_${painId}`)) {
          candidateIds.add(r.candidate_id);
        }
      }
      candidateFilter = candidateIds;
    }
    sessionFilter = scope.sessionIds;
  } else if (opts.chain) {
    correlations = [opts.chain];
  } else {
    const recent = state
      .prepare('SELECT task_id, task_kind, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 200')
      .all();
    const seen = new Map();
    for (const t of recent) {
      const { correlation } = correlationOf(t.task_id, t.task_kind);
      if (!seen.has(correlation)) seen.set(correlation, t.updated_at ?? '');
      if (seen.size >= 10) break;
    }
    correlations = [...seen.keys()];
  }

  const chains = [];
  for (const correlation of correlations) {
    const base = collectChain(state, correlation);
    const artifactIds = base.artifacts.map((a) => a.artifact_id);
    let approvalRows = [];
    let activationCount = 0;
    if (artifactIds.length > 0) {
      approvalRows = state
        .prepare(
          'SELECT approval_id, artifact_id, channel, status, requested_at, decided_at FROM approvals WHERE artifact_id IN (SELECT artifact_id FROM pi_artifacts WHERE source_task_id LIKE ?) LIMIT 20',
        )
        .all(`%${correlation}%`);
      const placeholders = artifactIds.map(() => '?').join(',');
      activationCount = state
        .prepare(`SELECT COUNT(*) AS n FROM activations WHERE artifact_id IN (${placeholders})`)
        .get(...artifactIds).n;
    }
    const approvalPending = approvalRows.filter((r) => r.status === 'pending').length;
    const chain = { ...base, approvals: approvalRows, approvalPending, activationCount };
    const matrix = capabilityMatrix(chain);
    chains.push({
      correlation,
      painId: base.painId,
      stages: base.tasks.map((t) => ({
        taskId: t.task_id,
        kind: correlationOf(t.task_id, t.task_kind).kind,
        status: t.status,
        bucket: statusBucket(t.status),
        attempts: t.attempt_count ?? null,
        updatedAt: t.updated_at ?? null,
      })),
      artifacts: base.artifacts.map((a) => ({
        id: a.artifact_id,
        kind: a.artifact_kind,
        sourceTaskId: a.source_task_id,
        createdAt: a.created_at ?? null,
      })),
      failures: base.runs
        .filter((r) => r.execution_status !== 'succeeded')
        .map((r) => ({ taskId: r.task_id, reason: clip(r.reason) })),
      approvals: approvalRows,
      activationCount,
      matrix,
      failureLayer: failureLayer(matrix),
    });
  }

  // trajectory.db: sessions + pains (experiment-scoped or recent)
  let trajectory = { path: trajPath, available: trajAvailable, sessions: [], pains: [], toolCalls: [] };
  const truncation = {};
  if (trajAvailable) {
    const traj = openReadOnly(trajPath);

    // sessions
    let sessions = [];
    if (sessionFilter && sessionFilter.length > 0) {
      sessions = traj
        .prepare(`SELECT session_id, updated_at FROM sessions WHERE session_id IN (${inClause(sessionFilter)}) ORDER BY updated_at DESC`)
        .all(...sessionFilter);
    } else if (opts.session) {
      sessions = traj.prepare('SELECT session_id, updated_at FROM sessions WHERE session_id = ?').all(opts.session);
    } else {
      sessions = traj.prepare('SELECT session_id, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 10').all();
    }
    trajectory.sessions = sessions;
    truncation.sessions = { returned: sessions.length, total: sessions.length, truncated: false };

    // pains
    let pains;
    let painsTotal;
    if (manifest) {
      // Experiment scope was fully resolved during binding — reuse it so the
      // package and the binding see the same pain set.
      const inScope = scope.pains;
      painsTotal = inScope.length;
      pains = inScope.slice(0, CAP.pains).map((p) => ({ ...p, reason: clip(p.reason) }));
      truncation.pains = { returned: pains.length, total: painsTotal, truncated: painsTotal > pains.length };
    } else {
      const recent = traj.prepare('SELECT id, session_id, source, score, reason FROM pain_events ORDER BY id DESC LIMIT 10').all();
      const total = traj.prepare('SELECT COUNT(*) AS n FROM pain_events').get().n;
      pains = recent.map((p) => ({ ...p, reason: clip(p.reason) }));
      truncation.pains = { returned: pains.length, total, truncated: total > pains.length };
    }
    trajectory.pains = pains;

    // tool calls (session-scoped)
    const tcSessions = sessionFilter && sessionFilter.length > 0 ? sessionFilter : opts.session ? [opts.session] : [];
    if (tcSessions.length > 0) {
      const total = traj.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE session_id IN (${inClause(tcSessions)})`).get(...tcSessions).n;
      const rows = traj
        .prepare(`SELECT tool_name, outcome, created_at FROM tool_calls WHERE session_id IN (${inClause(tcSessions)}) ORDER BY created_at LIMIT ${CAP.toolCalls}`)
        .all(...tcSessions)
        .map((c) => ({ ...c, tool_name: clip(c.tool_name), outcome: clip(c.outcome) }));
      trajectory.toolCalls = rows;
      truncation.toolCalls = { returned: rows.length, total, truncated: total > rows.length };
    } else {
      truncation.toolCalls = { returned: 0, total: 0, truncated: false };
    }
    traj.close();
  }

  // candidates
  let candidates;
  if (candidateFilter) {
    const rows = state
      .prepare('SELECT candidate_id, task_id, status, confidence, created_at FROM principle_candidates ORDER BY rowid DESC')
      .all();
    const inScope = rows.filter((c) => candidateFilter.has(c.candidate_id));
    candidates = inScope.slice(0, CAP.candidates);
    truncation.candidates = { returned: candidates.length, total: inScope.length, truncated: inScope.length > candidates.length };
  } else {
    const rows = state.prepare('SELECT candidate_id, status, confidence, created_at FROM principle_candidates ORDER BY rowid DESC LIMIT 10').all();
    const total = state.prepare('SELECT COUNT(*) AS n FROM principle_candidates').get().n;
    candidates = rows;
    truncation.candidates = { returned: rows.length, total, truncated: total > rows.length };
  }

  const adversarialWindow = manifest
    ? { start: manifest.startedAt ?? null, end: manifest.finishedAt ?? null }
    : null;
  const adversarial = readAdversarialEvents(root, adversarialWindow);
  truncation.adversarialEvents = {
    returned: adversarial.events.length,
    total: adversarial.total,
    truncated: adversarial.total > adversarial.events.length,
  };

  const report = {
    collectedAt: new Date().toISOString(),
    workspaceRoot: root,
    experiment: manifest
      ? {
          experimentId: manifest.experimentId,
          scenarioId: manifest.scenarioId,
          manifestPath: resolve(opts.experiment),
          bindingNotes,
        }
      : null,
    truncation,
    candidates,
    chains,
    trajectory,
    adversarialEvents: adversarial.events,
  };

  if (opts.package) {
    const artExport = exportArtifacts(state, chains, opts.package);
    // Export capacity follows the same marked-truncation contract as every
    // other bounded collection (SPEC §12.3) — a package that skipped artifacts
    // says so in collected.json, never silently drops them.
    truncation.artifacts = artExport.truncation;
    const evidenceIndex = buildEvidenceIndex(report, manifest);
    const metrics = buildMetrics(report, evidenceIndex);
    const pipelineTrace = buildPipelineTrace(report);
    const pkgData = {
      manifest,
      collected: report,
      evidenceIndex,
      pipelineTrace,
      metrics,
      telemetryExport: { events: adversarial.events, total: adversarial.total, truncated: truncation.adversarialEvents.truncated },
      artifactsExport: artExport.truncation,
    };
    writePackage(opts.package, pkgData);
    // --out and stdout still describe WHERE the package went; keep stdout
    // clean of the full JSON in package mode (report.md is the human surface).
    console.log(
      `[ok] evidence package written to ${resolve(opts.package)} (${artExport.exported.length}/${artExport.truncation.total} artifacts exported${artExport.truncation.truncated ? ', TRUNCATED' : ''}, ${chains.length} chains)`,
    );
    state.close();
    return;
  }

  state.close();

  const text = opts.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (opts.out) {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, text, 'utf8');
    console.log(`[ok] evidence written to ${opts.out}`);
  } else {
    console.log(text);
  }
}

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# Pipeline Evidence — ${r.workspaceRoot}`);
  lines.push('');
  if (r.experiment) {
    lines.push(`experiment: **${r.experiment.experimentId}** (scenario ${r.experiment.scenarioId}, manifest ${r.experiment.manifestPath})`);
    if (r.experiment.bindingNotes.length) {
      for (const n of r.experiment.bindingNotes) lines.push(`- binding note: ${n}`);
    }
    lines.push('');
  }
  lines.push(`collected: ${r.collectedAt} · source: read-only state.db + trajectory.db + telemetry`);
  lines.push('');
  const trunc = Object.entries(r.truncation ?? {}).filter(([, v]) => v.truncated);
  if (trunc.length) {
    lines.push(`> truncated collections: ${trunc.map(([k, v]) => `${k} ${v.returned}/${v.total}`).join(', ')}`);
    lines.push('');
  }
  lines.push('## Capability matrix (per chain)');
  lines.push('');
  lines.push('| chain | pain | diagnosis | principle | rule | validation | activation | behavior | failureLayer |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of r.chains) {
    const m = c.matrix;
    lines.push(
      `| ${clip(c.correlation, 40)} | ${m.pain} | ${m.diagnosis} | ${m.principle} | ${m.rule} | ${m.validation} | ${m.activation} | ${m.behavior} | ${c.failureLayer} |`,
    );
  }
  lines.push('');
  for (const c of r.chains) {
    lines.push(`## Chain \`${clip(c.correlation, 60)}\``);
    lines.push('');
    lines.push('| stage | status | bucket | attempts | updated | taskId |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of c.stages) {
      lines.push(
        `| ${s.kind} | ${s.status} | ${s.bucket} | ${s.attempts ?? '-'} | ${s.updatedAt ?? '-'} | ${clip(s.taskId, 60)} |`,
      );
    }
    lines.push('');
    if (c.artifacts.length) {
      lines.push(`artifacts: ${c.artifacts.length}`);
      for (const a of c.artifacts) lines.push(`- [${a.kind}] ${clip(a.id, 100)}`);
      lines.push('');
    }
    if (c.failures.length) {
      lines.push('failures (runs.reason, authoritative):');
      for (const f of c.failures) lines.push(`- ${clip(f.taskId, 60)} → ${f.reason}`);
      lines.push('');
    }
    if (c.approvals.length) {
      lines.push('approvals:');
      for (const a of c.approvals) lines.push(`- ${clip(a.approval_id, 60)} [${a.channel}] ${a.status}`);
      lines.push('');
    }
    if (c.activationCount > 0) lines.push(`activations: ${c.activationCount}`);
  }
  lines.push('## Recent candidates');
  lines.push('');
  lines.push('| candidate | status | confidence | created |');
  lines.push('|---|---|---|---|');
  for (const c of r.candidates) {
    lines.push(`| ${clip(c.candidate_id, 40)} | ${c.status} | ${c.confidence} | ${c.created_at ?? '-'} |`);
  }
  lines.push('');
  lines.push('## Trajectory');
  lines.push(`available: ${r.trajectory.available}`);
  if (r.trajectory.available) {
    lines.push('');
    lines.push('| session | updated |');
    lines.push('|---|---|');
    for (const s of r.trajectory.sessions) lines.push(`| ${clip(s.session_id, 44)} | ${s.updated_at} |`);
    lines.push('');
    lines.push('| pain | session | source | score | reason |');
    lines.push('|---|---|---|---|---|');
    for (const p of r.trajectory.pains) {
      lines.push(`| - | ${clip(p.session_id, 20)} | ${p.source} | ${p.score} | ${p.reason ?? ''} |`);
    }
    if (r.trajectory.toolCalls.length) {
      lines.push('');
      lines.push(`tool calls (session-filtered): ${r.trajectory.toolCalls.length} rows`);
    }
  }
  lines.push('');
  lines.push('## Adversarial gate events (telemetry, last ≤20)');
  lines.push('');
  if (r.adversarialEvents.length === 0) lines.push('(none)');
  for (const e of r.adversarialEvents) lines.push(`- ${e.timestamp} ${e.eventType} ${e.payload ?? ''}`);
  lines.push('');
  return lines.join('\n');
}

main();
