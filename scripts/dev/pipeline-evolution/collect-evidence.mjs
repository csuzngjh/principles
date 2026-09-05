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
// No new store is created; nothing is written except the optional --out file.
//
// Usage:
//   node scripts/dev/pipeline-evolution/collect-evidence.mjs --workspace <dir> \
//          [--chain <correlationId>] [--session <sid>] [--task <taskId>] [--json] [--out <file>]
//
// --task: per-attempt run timeline for one task (duration / runtime / death
//   reason per attempt) — retry-budget & timeout-cap forensics (PRI-683 pattern:
//   failures clustered at one exact duration = hard cap; spread = latency).
//
// Exit codes: 0 = collected (report may still contain FAIL stages — that is
// data, not a tool error); 1 = usage/environment error.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function clip(value, bound = BOUND) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  const max = Math.min(bound, BOUND);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parseArgs(argv) {
  const opts = { workspace: null, chain: null, session: null, task: null, json: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = argv[i + 1];
    const takesValue = a === '--workspace' || a === '--chain' || a === '--session' || a === '--task' || a === '--out';
    if (takesValue) {
      if (!value) {
        console.error(`missing value for ${a}`);
        process.exit(1);
      }
      if (a === '--workspace') opts.workspace = value;
      else if (a === '--chain') opts.chain = value;
      else if (a === '--session') opts.session = value;
      else if (a === '--task') opts.task = value;
      else opts.out = value;
      i += 1;
    } else if (a === '--json') {
      opts.json = true;
    } else {
      console.error(`unknown argument: ${a}`);
      console.error('usage: collect-evidence.mjs --workspace <abs-dir> [--chain <id>] [--session <sid>] [--task <taskId>] [--json] [--out <file>]');
      process.exit(1);
    }
  }
  if (!opts.workspace || !isAbsolute(resolve(opts.workspace))) {
    console.error('usage: collect-evidence.mjs --workspace <abs-dir> [--chain <id>] [--session <sid>] [--task <taskId>] [--json] [--out <file>]');
    process.exit(1);
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

function readAdversarialEvents(root) {
  const file = join(root, '.pd', 'telemetry', 'critical-events.jsonl');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const events = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      const t = String(j.eventType ?? '');
      if (t.startsWith('evaluator_adversarial')) {
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
  return events.slice(-20);
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

  // Correlations to report: explicit --chain, else every correlation seen in
  // tasks (bounded to the 10 most recently updated).
  let correlations;
  if (opts.chain) {
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
          'SELECT approval_id, artifact_id, channel, status, requested_at FROM approvals WHERE artifact_id IN (SELECT artifact_id FROM pi_artifacts WHERE source_task_id LIKE ?) LIMIT 20',
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
      artifacts: base.artifacts.map((a) => ({ id: a.artifact_id, kind: a.artifact_kind })),
      failures: base.runs
        .filter((r) => r.execution_status !== 'succeeded')
        .map((r) => ({ taskId: r.task_id, reason: clip(r.reason) })),
      approvals: approvalRows,
      activationCount,
      matrix,
      failureLayer: failureLayer(matrix),
    });
  }

  // trajectory.db: sessions + pains (by --session or recent)
  const trajPath = join(root, '.state', 'trajectory.db');
  let trajectory = { path: trajPath, available: existsSync(trajPath), sessions: [], pains: [], toolCalls: [] };
  if (trajectory.available) {
    const traj = openReadOnly(trajPath);
    const sessFilter = opts.session ? 'WHERE session_id = ?' : '';
    const sessArgs = opts.session ? [opts.session] : [];
    trajectory.sessions = traj
      .prepare(`SELECT session_id, updated_at FROM sessions ${sessFilter} ORDER BY updated_at DESC LIMIT 10`)
      .all(...sessArgs);
    trajectory.pains = traj
      .prepare(`SELECT session_id, source, score, reason FROM pain_events ORDER BY id DESC LIMIT 10`)
      .all()
      .map((p) => ({ ...p, reason: clip(p.reason) }));
    if (opts.session) {
      trajectory.toolCalls = traj
        .prepare('SELECT tool_name, outcome, created_at FROM tool_calls WHERE session_id = ? ORDER BY created_at LIMIT 200')
        .all(opts.session)
        .map((c) => ({ ...c, tool_name: clip(c.tool_name), outcome: clip(c.outcome) }));
    }
    traj.close();
  }

  const candidates = state
    .prepare('SELECT candidate_id, status, confidence, created_at FROM principle_candidates ORDER BY rowid DESC LIMIT 10')
    .all();

  const report = {
    collectedAt: new Date().toISOString(),
    workspaceRoot: root,
    candidates,
    chains,
    trajectory,
    adversarialEvents: readAdversarialEvents(root),
  };

  state.close();

  const text = opts.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (opts.out) {
    const { writeFileSync, mkdirSync } = require('node:fs');
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
  lines.push(`collected: ${r.collectedAt} · source: read-only state.db + trajectory.db + telemetry`);
  lines.push('');
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
