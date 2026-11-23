#!/usr/bin/env node
/**
 * PD pipeline funnel baseline — SPEC-PD-PIPELINE-SPINE-001 v0.9 Phase 0
 * (PRI-1290).
 *
 * Read-only funnel statistics over a PRODUCTION workspace's two SQLite
 * databases plus the principle ledger file:
 *
 *   Pain → 诊断 → 候选准入 → 账本入库 → 内化 → 激活 → 注入/拦截
 *
 * Safety contract (SPEC §6 Phase 0, AGENTS §1.1):
 *   - the workspace originals are NEVER opened with SQLite. Both databases
 *     are read through `stageWalSnapshot` — the WAL-safe, fingerprint-
 *     verified staged copy already proven by pain-recall-readonly.test.ts;
 *   - database paths come from the canonical resolvers
 *     (`@principles/core/runtime/storage-paths`), never hardcoded;
 *   - staged copies are opened `{ readonly: true, fileMustExist: true }`;
 *   - a snapshot whose fingerprints drift under concurrent writers is
 *     RETRIED (max 3) and then fails loud — a half-torn snapshot is never
 *     read, never reported as success;
 *   - every SQLite connection is closed BEFORE `dispose()` (Windows keeps
 *     temp files hostage through open handles);
 *   - no user content is ever emitted: only aggregates, ids, timestamps and
 *     categorical reason codes. `text`/`raw_excerpt`/free-form error strings
 *     are never selected.
 *
 * Cross-database semantics (SPEC Phase 0 v0.5/v0.6):
 *   - the two snapshots are independent linearization points (T1 = the WAL
 *     read inside stageWalSnapshot; `capturedAt` is that instant);
 *   - snapshot skew window: |T1_state − T1_trajs| ≤ 5 s (suggested value,
 *     NOT production-calibrated). On breach the earlier database is
 *     re-snapshotted ONCE; a remaining breach is flagged in the report, not
 *     hidden;
 *   - cross-db write allowance: a record may legitimately land in the other
 *     database up to 60 s after the first database's T1 (suggested value,
 *     NOT production-calibrated). A link missing INSIDE that window is
 *     reported as `skew_window_candidate` (re-checkable later), never as
 *     data loss. Until both thresholds are calibrated against production
 *     write-path evidence, out-of-window misses are ALSO reported as
 *     `skew_window_candidate` with a "threshold not calibrated" marker —
 *     this baseline refuses to declare definitive loss from skew logic
 *     alone.
 *
 * Usage:
 *   node scripts/dev/pipeline-funnel-snapshot.mjs --workspace <dir> \
 *        [--out <report.md>] [--days 30] [--json]
 *
 * Exit codes: 0 = report produced; 1 = snapshot/verification failure
 * (fail-loud, nothing reported as success).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
// Namespace imports keep the export-surface admission's consumer proof
// honest: each symbol is used as `<ns>.<symbol>` and the gate's AST check
// can see it.
import * as painRecall from '@principles/core/runtime/pain-recall';
import * as storagePaths from '@principles/core/runtime/storage-paths';
import * as principleTreeLedger from '@principles/core/principle-tree-ledger';

/** Suggested (uncalibrated) snapshot skew window between the two T1 points. */
export const SNAPSHOT_SKEW_MAX_MS = 5_000;
/** Suggested (uncalibrated) cross-database write allowance. */
export const CROSS_DB_WRITE_DELAY_MS = 60_000;
/** Max snapshot attempts per database before failing loud. */
export const SNAPSHOT_MAX_ATTEMPTS = 3;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PEER_RUNNER_KINDS = new Set([
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
  'rollout_reviewer',
]);
const DIAGNOSTICIAN_KINDS = new Set([
  'diagnostician',
  'diag_rootcause',
  'diag_distiller',
  'diag_router',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Argument parsing ─────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = { workspace: null, out: null, days: 30, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace' || arg === '-w') {
      options.workspace = argv[++i];
    } else if (arg === '--out') {
      options.out = argv[++i];
    } else if (arg === '--days') {
      const days = Number.parseInt(argv[++i], 10);
      if (!Number.isInteger(days) || days <= 0) throw new Error(`--days must be a positive integer, got: ${argv[i]}`);
      options.days = days;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.workspace) throw new Error('--workspace <dir> is required (the PD workspace whose funnel is measured)');
  return options;
}

// ── Cross-db miss classification (pure, unit-tested) ─────────────────────────

/**
 * Classify a missing cross-database link from the SURVIVING record's own
 * timestamp versus the OTHER database's snapshot T1 (SPEC v0.5: the missing
 * row has no timestamp of its own to consult).
 *
 * Returns 'skew_window_candidate' when the other database could still have
 * received the write (within the allowance), and 'skew_window_candidate'
 * with `thresholdUncalibrated: true` when the allowance is exceeded —
 * deliberately the same bucket, because the 60 s allowance is a suggested
 * value that this first baseline is not allowed to turn into a hard loss
 * verdict (SPEC v0.6 calibration clause).
 */
export function classifyMissingLink({ recordTimestamp, otherDbT1, allowDelayMs = CROSS_DB_WRITE_DELAY_MS }) {
  if (recordTimestamp === null || otherDbT1 === null) {
    return { bucket: 'skew_window_candidate', thresholdUncalibrated: true };
  }
  const recordMs = Date.parse(recordTimestamp);
  const t1Ms = Date.parse(otherDbT1);
  if (!Number.isFinite(recordMs) || !Number.isFinite(t1Ms)) {
    return { bucket: 'skew_window_candidate', thresholdUncalibrated: true };
  }
  const ageBeyondT1 = t1Ms - recordMs;
  if (ageBeyondT1 <= allowDelayMs) {
    return { bucket: 'skew_window_candidate', thresholdUncalibrated: false };
  }
  return { bucket: 'skew_window_candidate', thresholdUncalibrated: true };
}

// ── SQLite helpers (staged copies only) ──────────────────────────────────────

function openStagedReadonly(stagedDbPath) {
  return new Database(stagedDbPath, { readonly: true, fileMustExist: true });
}

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    if (String(error).includes('no such table')) return null;
    throw error;
  }
}

function countBy(db, table, column, extraWhere = '') {
  const rows = safeAll(db, `SELECT ${column} AS k, COUNT(*) AS n FROM ${table} ${extraWhere} GROUP BY ${column} ORDER BY n DESC`);
  if (rows === null) return null;
  const out = {};
  for (const row of rows) out[row.k === null ? '(null)' : String(row.k)] = row.n;
  return out;
}

function totalCount(db, table, extraWhere = '', params = []) {
  const rows = safeAll(db, `SELECT COUNT(*) AS n FROM ${table} ${extraWhere}`, params);
  return rows === null ? null : rows[0].n;
}

function windowClause(column) {
  return `WHERE datetime(${column}) >= datetime(?)`;
}

// ── Snapshot acquisition ─────────────────────────────────────────────────────

function snapshotWithRetry(dbPath, relSegments, label) {
  let lastReason = 'not_attempted';
  for (let attempt = 1; attempt <= SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    const staged = painRecall.stageWalSnapshot(dbPath, relSegments);
    if (staged.ok) {
      return { staged, attempts: attempt };
    }
    lastReason = staged.reason;
  }
  throw new Error(
    `wal_snapshot_failed: ${label} (${dbPath}) could not obtain a fingerprint-verified snapshot after `
    + `${SNAPSHOT_MAX_ATTEMPTS} attempts (last reason: ${lastReason}); refusing to read a torn snapshot`,
  );
}

/**
 * Snapshot both databases, keeping the two T1 points within the suggested
 * skew window when possible: on breach, only the EARLIER database is
 * re-snapshotted once (re-snapshotting the later one can only widen the
 * gap). A remaining breach is returned as a flag — the report must carry
 * it, not swallow it.
 */
function snapshotPair(stateDbPath, trajectoryDbPath) {
  const state = snapshotWithRetry(stateDbPath, ['funnel', 'state.db'], 'state.db');
  const trajectory = snapshotWithRetry(trajectoryDbPath, ['funnel', 'trajectory.db'], 'trajectory.db');
  const skewMs = Math.abs(Date.parse(state.staged.capturedAt) - Date.parse(trajectory.staged.capturedAt));
  if (skewMs > SNAPSHOT_SKEW_MAX_MS) {
    const earlierIsState = Date.parse(state.staged.capturedAt) <= Date.parse(trajectory.staged.capturedAt);
    const earlier = earlierIsState ? state : trajectory;
    const replacement = snapshotWithRetry(
      earlierIsState ? stateDbPath : trajectoryDbPath,
      earlierIsState ? ['funnel', 'state.db'] : ['funnel', 'trajectory.db'],
      earlierIsState ? 'state.db' : 'trajectory.db',
    );
    earlier.staged.dispose();
    if (earlierIsState) {
      return {
        state: replacement,
        trajectory,
        skewRetried: true,
        skewExceededMs: Math.abs(Date.parse(replacement.staged.capturedAt) - Date.parse(trajectory.staged.capturedAt)),
      };
    }
    return {
      state,
      trajectory: replacement,
      skewRetried: true,
      skewExceededMs: Math.abs(Date.parse(state.staged.capturedAt) - Date.parse(replacement.staged.capturedAt)),
    };
  }
  return { state, trajectory, skewRetried: false, skewExceededMs: skewMs };
}

// ── Funnel collection (staged copies + ledger file) ──────────────────────────

function parseAdmissionSummary(admissionJson) {
  if (admissionJson === null || admissionJson === undefined) return { kind: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(admissionJson);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid' };
  const evaluations = Array.isArray(parsed.evaluations) ? parsed.evaluations : [];
  const currentId = typeof parsed.currentEvaluationId === 'string' ? parsed.currentEvaluationId : null;
  const current = evaluations.find((e) => e && typeof e === 'object' && e.evaluationId === currentId) ?? null;
  const processing = parsed !== null && typeof parsed.processing === 'object' && parsed.processing !== null && !Array.isArray(parsed.processing)
    ? parsed.processing
    : null;
  return {
    kind: 'present',
    decision: current && typeof current.decision === 'string' ? current.decision : null,
    reason: current && typeof current.reason === 'string' ? current.reason : null,
    processingState: processing && typeof processing.state === 'string' ? processing.state : null,
    ownerDecisions: Array.isArray(parsed.ownerDecisions) ? parsed.ownerDecisions.length : 0,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectLedgerStats(workspaceDir) {
  const readAt = new Date().toISOString();
  const state = principleTreeLedger.readLedgerFileState(path.join(workspaceDir, '.state'));
  if (state.availability.status !== 'ok') {
    return { readAt, availability: state.availability.status, principles: null };
  }
  const principles = isRecord(state.ledger.tree.principles) ? state.ledger.tree.principles : {};
  const entries = Object.values(principles).filter(isRecord);
  const linkedCandidateIds = new Set();
  let reuseEdges = 0;
  let principlesWithReuse = 0;
  let principlesWithDerived = 0;
  for (const entry of entries) {
    const derived = Array.isArray(entry.derivedFromPainIds) ? entry.derivedFromPainIds : [];
    if (derived.length > 0) principlesWithDerived += 1;
    for (const id of derived) {
      if (typeof id === 'string' && id.length > 0) linkedCandidateIds.add(id);
    }
    const reuse = Array.isArray(entry.reuseEvidence) ? entry.reuseEvidence : [];
    if (reuse.length > 0) principlesWithReuse += 1;
    for (const edge of reuse) {
      if (isRecord(edge) && typeof edge.candidateId === 'string') {
        linkedCandidateIds.add(edge.candidateId);
        reuseEdges += 1;
      }
    }
  }
  return {
    readAt,
    availability: 'ok',
    principles: {
      total: entries.length,
      withReuseEvidence: principlesWithReuse,
      withDerivedCandidates: principlesWithDerived,
      reuseEdges,
      linkedCandidateCount: linkedCandidateIds.size,
    },
    linkedCandidateIds,
  };
}

function collectStateFunnel(db, cutoffIso) {
  const funnel = {};

  // ── 诊断 stage ──
  funnel.diagnosis = { available: true };
  {
    const rows = safeAll(db, 'SELECT task_kind AS k, status AS s, COUNT(*) AS n FROM tasks GROUP BY task_kind, status');
    if (rows === null) {
      funnel.diagnosis.taskKindStatus = null;
      funnel.diagnosis.kindTotals = null;
    } else {
      const kindStatus = {};
      const kindTotals = {};
      for (const row of rows) {
        kindStatus[`${row.k}/${row.s}`] = row.n;
        kindTotals[row.k] = (kindTotals[row.k] ?? 0) + row.n;
      }
      funnel.diagnosis.taskKindStatus = kindStatus;
      funnel.diagnosis.kindTotals = kindTotals;
    }
  }
  funnel.diagnosis.failedTasksByKind = countBy(db, 'tasks', 'task_kind', "WHERE status = 'failed'") ?? undefined;
  funnel.diagnosis.runFailuresByErrorCategory = countBy(db, 'runs', 'error_category', "WHERE execution_status = 'failed'") ?? undefined;
  funnel.diagnosis.deadLetterPains = {
    total: totalCount(db, 'dead_letter_pains'),
    unretried: totalCount(db, 'dead_letter_pains', 'WHERE retried_at IS NULL'),
    retried: totalCount(db, 'dead_letter_pains', 'WHERE retried_at IS NOT NULL'),
  };
  funnel.diagnosis.painDiagnoses = {
    total: totalCount(db, 'pain_diagnoses'),
    windowed: totalCount(db, 'pain_diagnoses', windowClause('created_at'), [cutoffIso]),
  };
  funnel.diagnosis.windowedTaskCreation = totalCount(db, 'tasks', windowClause('created_at'), [cutoffIso]);

  // ── 候选 + 准入 stage ──
  funnel.candidates = { available: true };
  funnel.candidates.total = totalCount(db, 'principle_candidates');
  funnel.candidates.windowed = totalCount(db, 'principle_candidates', windowClause('created_at'), [cutoffIso]);
  funnel.candidates.byStatus = countBy(db, 'principle_candidates', 'status');
  // recommendation_kind IS the raw persisted kind (candidate-store maps
  // rawRecommendationKind = r.recommendation_kind; the normalized view is
  // derived at read time and is deliberately not what we count here).
  funnel.candidates.byRawKind = countBy(db, 'principle_candidates', 'recommendation_kind');
  {
    const rows = safeAll(db, 'SELECT admission_json AS a, status AS s FROM principle_candidates');
    if (rows === null) {
      funnel.candidates.admission = null;
    } else {
      const decisionCounts = {};
      const reasonCounts = {};
      const refusalReasonCounts = {};
      const processingCounts = {};
      let invalid = 0;
      let absent = 0;
      let ownerDecisionPending = 0;
      for (const row of rows) {
        const summary = parseAdmissionSummary(row.a);
        if (summary.kind === 'absent') {
          absent += 1;
          processingCounts['(no document)'] = (processingCounts['(no document)'] ?? 0) + 1;
          continue;
        }
        if (summary.kind === 'invalid') {
          invalid += 1;
          continue;
        }
        const decision = summary.decision ?? '(no current evaluation)';
        decisionCounts[decision] = (decisionCounts[decision] ?? 0) + 1;
        if (summary.reason !== null) {
          reasonCounts[summary.reason] = (reasonCounts[summary.reason] ?? 0) + 1;
          if (decision !== 'admitted') {
            refusalReasonCounts[summary.reason] = (refusalReasonCounts[summary.reason] ?? 0) + 1;
          }
        }
        const proc = summary.processingState ?? '(none)';
        processingCounts[proc] = (processingCounts[proc] ?? 0) + 1;
        if (summary.ownerDecisions > 0) ownerDecisionPending += 1;
      }
      funnel.candidates.admission = {
        absent,
        invalid,
        decisions: decisionCounts,
        reasonsTop: topN(reasonCounts, 8),
        refusalReasonsTop: topN(refusalReasonCounts, 8),
        processingStates: processingCounts,
        candidatesWithOwnerDecisions: ownerDecisionPending,
      };
    }
  }

  // ── 内化 stage ──
  funnel.internalization = { available: true };
  {
    const rows = safeAll(db, 'SELECT task_kind AS k, status AS s, COUNT(*) AS n FROM tasks GROUP BY task_kind, status');
    const byKind = {};
    for (const row of rows ?? []) {
      if (!PEER_RUNNER_KINDS.has(row.k)) continue;
      byKind[row.k] = byKind[row.k] ?? { total: 0, byStatus: {} };
      byKind[row.k].total += row.n;
      byKind[row.k].byStatus[row.s] = row.n;
    }
    funnel.internalization.peerTasksByKind = rows === null ? null : byKind;
    const windowed = safeAll(
      db,
      `SELECT task_kind AS k, COUNT(*) AS n FROM tasks ${windowClause('created_at')} GROUP BY task_kind`,
      [cutoffIso],
    );
    const windowedByKind = {};
    for (const row of windowed ?? []) windowedByKind[row.k] = row.n;
    funnel.internalization.windowedByKind = windowed === null ? null : windowedByKind;
  }

  // ── 激活 stage ──
  funnel.activation = { available: true };
  funnel.activation.approvalsByStatus = countBy(db, 'approvals', 'status');
  funnel.activation.approvalsByChannel = countBy(db, 'approvals', 'channel');
  funnel.activation.activationsByAction = countBy(db, 'activations', 'action');
  funnel.activation.activationsByChannel = countBy(db, 'activations', 'channel');
  {
    const rows = safeAll(db, 'SELECT DISTINCT target_ref AS t FROM activations');
    if (rows === null) {
      funnel.activation.targets = null;
    } else {
      let uuidShaped = 0;
      let other = 0;
      for (const row of rows) {
        if (typeof row.t === 'string' && UUID_RE.test(row.t.trim())) uuidShaped += 1;
        else other += 1;
      }
      funnel.activation.targets = { distinct: rows.length, uuidShaped, otherShaped: other };
    }
  }
  funnel.activation.piArtifacts = {
    total: totalCount(db, 'pi_artifacts'),
    byKind: countBy(db, 'pi_artifacts', 'artifact_kind'),
    byValidationStatus: countBy(db, 'pi_artifacts', 'validation_status'),
    withSourcePrincipleId: totalCount(db, 'pi_artifacts', 'WHERE source_principle_id IS NOT NULL'),
  };

  // ── 注入/拦截 stage ──
  funnel.application = { available: true };
  funnel.application.byKind = countBy(db, 'principle_applications', 'kind');
  funnel.application.byLevel = countBy(db, 'principle_applications', 'level');
  funnel.application.total = totalCount(db, 'principle_applications');
  funnel.application.windowed = totalCount(db, 'principle_applications', windowClause('created_at'), [cutoffIso]);
  {
    const rows = safeAll(db, 'SELECT COUNT(DISTINCT principle_id) AS n FROM principle_applications');
    funnel.application.distinctPrinciples = rows === null ? null : rows[0].n;
  }
  funnel.application.interventionEvidenceRecords = totalCount(db, 'intervention_evidence_records');

  return funnel;
}

function topN(counts, n) {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n));
}

function collectTrajectoryFunnel(db, cutoffIso) {
  const funnel = {};
  funnel.pain = { available: true };
  funnel.pain.total = totalCount(db, 'pain_events');
  funnel.pain.windowed = totalCount(db, 'pain_events', windowClause('created_at'), [cutoffIso]);
  funnel.pain.bySource = countBy(db, 'pain_events', 'source');
  funnel.pain.byHostKind = countBy(db, 'pain_events', 'host_kind');
  funnel.pain.bySeverity = countBy(db, 'pain_events', 'severity');
  funnel.pain.withCanonicalId = totalCount(db, 'pain_events', 'WHERE canonical_pain_id IS NOT NULL');
  funnel.pain.withRuntimeTaskId = totalCount(db, 'pain_events', 'WHERE runtime_task_id IS NOT NULL');
  funnel.interception = { available: true };
  funnel.interception.gateBlocks = {
    total: totalCount(db, 'gate_blocks'),
    windowed: totalCount(db, 'gate_blocks', windowClause('created_at'), [cutoffIso]),
    byTool: countBy(db, 'gate_blocks', 'tool_name'),
  };
  return funnel;
}

// ── Cross-database linkage ───────────────────────────────────────────────────

function collectLinkage(stateDb, trajectoryDb, stateT1, trajectoryT1, cutoffIso) {
  const linkage = { notes: [] };

  // pain_events.runtime_task_id → state.tasks (the two databases cannot see
  // each other inside one SQL statement; fetch both sides and join in JS)
  {
    const rows = safeAll(
      trajectoryDb,
      'SELECT runtime_task_id AS t, created_at AS c FROM pain_events WHERE runtime_task_id IS NOT NULL',
    );
    const taskIds = new Set((safeAll(stateDb, 'SELECT task_id AS t FROM tasks') ?? []).map((r) => r.t));
    const missing = (rows ?? []).filter((r) => !taskIds.has(r.t));
    const buckets = { skew_window_candidate: 0 };
    let thresholdUncalibrated = 0;
    for (const row of missing) {
      const verdict = classifyMissingLink({ recordTimestamp: row.c, otherDbT1: stateT1 });
      buckets[verdict.bucket] += 1;
      if (verdict.thresholdUncalibrated) thresholdUncalibrated += 1;
    }
    linkage.painToTask = {
      painsWithRuntimeTaskRef: rows === null ? null : rows.length,
      missingTaskRefs: missing.length,
      buckets,
      thresholdUncalibrated,
    };
  }

  // diag parent tasks → trajectory pain_events (via diagnostic_json.sourcePainId)
  {
    const rows = safeAll(
      stateDb,
      `SELECT task_id AS id, created_at AS c, diagnostic_json AS d FROM tasks
        WHERE task_kind = 'diagnostician' AND diagnostic_json IS NOT NULL`,
    );
    const painIds = new Set(
      (safeAll(trajectoryDb, 'SELECT canonical_pain_id AS p FROM pain_events WHERE canonical_pain_id IS NOT NULL') ?? [])
        .map((r) => r.p),
    );
    const painRowIds = new Set((safeAll(trajectoryDb, 'SELECT id AS i FROM pain_events') ?? []).map((r) => String(r.i)));
    let diagnosed = 0;
    const missing = [];
    let unparsable = 0;
    for (const row of rows ?? []) {
      let sourcePainId = null;
      try {
        const parsed = JSON.parse(row.d);
        if (isRecord(parsed) && typeof parsed.sourcePainId === 'string') sourcePainId = parsed.sourcePainId;
      } catch {
        unparsable += 1;
      }
      if (sourcePainId === null) continue;
      if (painIds.has(sourcePainId) || painRowIds.has(sourcePainId)) diagnosed += 1;
      else missing.push({ created: row.c });
    }
    const buckets = { skew_window_candidate: 0 };
    let thresholdUncalibrated = 0;
    for (const m of missing) {
      const verdict = classifyMissingLink({ recordTimestamp: m.created, otherDbT1: trajectoryT1 });
      buckets[verdict.bucket] += 1;
      if (verdict.thresholdUncalibrated) thresholdUncalibrated += 1;
    }
    linkage.taskToPain = {
      diagnosticianTasksWithJson: (rows ?? []).length,
      linkedPainFound: diagnosed,
      painMissing: missing.length,
      diagnosticJsonUnparsable: unparsable,
      buckets,
      thresholdUncalibrated,
    };
  }

  // consumed candidates → dreamer task (same database; window vs state T1).
  // Split by RAW recommendation_kind: implementation/defer/prompt candidates
  // are designed not to seed a dreamer task, so their absence is a legal
  // route outcome, not a funnel gap.
  {
    const rows = safeAll(
      stateDb,
      `SELECT c.candidate_id AS cid, c.created_at AS c, c.recommendation_kind AS k FROM principle_candidates c
        WHERE c.status = 'consumed'
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.task_kind = 'dreamer' AND t.task_id LIKE 'dreamer-' || c.candidate_id || '-%'
          )`,
    );
    const buckets = { skew_window_candidate: 0 };
    let thresholdUncalibrated = 0;
    const byRawKind = {};
    for (const row of rows ?? []) {
      const verdict = classifyMissingLink({ recordTimestamp: row.c, otherDbT1: stateT1 });
      buckets[verdict.bucket] += 1;
      if (verdict.thresholdUncalibrated) thresholdUncalibrated += 1;
      const kind = row.k === null ? '(null)' : String(row.k);
      byRawKind[kind] = (byRawKind[kind] ?? 0) + 1;
    }
    linkage.candidateToDreamer = {
      consumedWithoutDreamerTask: (rows ?? []).length,
      byRawKind,
      buckets,
      thresholdUncalibrated,
    };
  }

  return linkage;
}

// ── Report rendering ─────────────────────────────────────────────────────────

function fmtCounts(counts) {
  if (counts === null || counts === undefined) return '_table missing_';
  const entries = Object.entries(counts);
  if (entries.length === 0) return '(none)';
  return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
}

function renderReport(model) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  push(`# PD Pipeline Funnel Baseline — ${model.meta.runDate}`);
  push();
  push('- 规范：SPEC-PD-PIPELINE-SPINE-001 v0.9 §6 Phase 0（PRI-1290）');
  push('- 性质：**只读基线**。未修改生产数据库、账本文件与任何运行中 Agent 的状态。');
  push(`- 工作区：\`${model.meta.workspace}\``);
  push();
  push('## 1. 数据来源与快照方式');
  push();
  push('- 两个数据库均通过 `stageWalSnapshot`（WAL 双文件 T0/T1 指纹校验暂存快照）复制到系统临时目录后以 `{ readonly: true, fileMustExist: true }` 打开；源库从未被 SQLite 打开，源目录零 `-shm` 新增。');
  push('- 数据库路径经 canonical `resolveStateDbPath` / `resolveTrajectoryDbPath` 解析（`.pd/state.db`、`.state/trajectory.db`），无硬编码路径。');
  push('- 账本为纯 JSON 文件，经既有 `readLedgerFileState` 只读读取（无 WAL 语义）。');
  push();
  push('## 2. 快照时间（T1 线性化点）与文件指纹');
  push();
  push('| 库 | T1 (capturedAt) | main SHA-256 | main size | wal state | wal SHA-256 | 快照尝试次数 |');
  push('|---|---|---|---|---|---|---|');
  push(`| state.db | ${model.meta.stateT1} | \`${model.meta.stateFingerprint.mainSha256}\` | ${model.meta.stateFingerprint.mainSize} | ${model.meta.stateFingerprint.walState} | ${model.meta.stateFingerprint.walSha256 ? '`' + model.meta.stateFingerprint.walSha256 + '`' : '—'} | ${model.meta.stateAttempts} |`);
  push(`| trajectory.db | ${model.meta.trajectoryT1} | \`${model.meta.trajectoryFingerprint.mainSha256}\` | ${model.meta.trajectoryFingerprint.mainSize} | ${model.meta.trajectoryFingerprint.walState} | ${model.meta.trajectoryFingerprint.walSha256 ? '`' + model.meta.trajectoryFingerprint.walSha256 + '`' : '—'} | ${model.meta.trajectoryAttempts} |`);
  push(`| ledger.json | ${model.meta.ledgerReadAt} | （整文件读取，availability=${model.meta.ledgerAvailability}） | — | — | — | 1 |`);
  push();
  push('## 3. 快照偏差窗口（两 T1 之差）');
  push();
  push(`- 实测偏差：**${model.meta.skewMs} ms**（建议阈值 ≤ ${SNAPSHOT_SKEW_MAX_MS} ms，未经生产校准）。`);
  push(`- 超差重试：${model.meta.skewRetried ? '已执行一次（对较早的库重新快照）' : '未触发'}。`);
  if (model.meta.skewExceeded) {
    push(`- **重试后仍超出建议窗口**（当前偏差 ${model.meta.skewMs} ms）。两次快照非原子，跨库对比按第 4 节窗口语义解读。`);
  }
  push();
  push('## 4. 跨库写入允许延迟假设');
  push();
  push(`- 建议值 ≤ ${CROSS_DB_WRITE_DELAY_MS / 1000} s，**未经生产实证校准**。`);
  push('- 判定规则：跨库关联缺失以**现存记录自身时间戳 vs 对方库 T1** 判定；窗口内（以及校准前超窗）一律标 `skew_window_candidate`，可延迟复查；本基线不据此判定确定流失。');
  push();
  push('## 5. 全量漏斗（自库创建起）');
  push();
  push('```text');
  push(`Pain 提交总量            ${valueOrNA(model.trajectory.pain.total)}`);
  push(`  └ 有 canonical id      ${valueOrNA(model.trajectory.pain.withCanonicalId)}`);
  push(`  └ 引用 runtime task    ${valueOrNA(model.trajectory.pain.withRuntimeTaskId)}`);
  push(`诊断父任务 diagnostician ${kindTotal(model.state.diagnosis, 'diagnostician')}`);
  push(`  └ diag_rootcause       ${kindTotal(model.state.diagnosis, 'diag_rootcause')}`);
  push(`  └ diag_distiller       ${kindTotal(model.state.diagnosis, 'diag_distiller')}`);
  push(`  └ diag_router          ${kindTotal(model.state.diagnosis, 'diag_router')}`);
  push(`死信 dead_letter_pains    ${valueOrNA(model.state.diagnosis.deadLetterPains?.total)}（未重放 ${valueOrNA(model.state.diagnosis.deadLetterPains?.unretried)}）`);
  push(`诊断持久化 pain_diagnoses ${valueOrNA(model.state.diagnosis.painDiagnoses?.total)}`);
  push(`候选 principle_candidates ${valueOrNA(model.state.candidates.total)}`);
  push(`账本 principles           ${model.meta.ledgerPrinciples === null ? 'NA(' + model.meta.ledgerAvailability + ')' : model.meta.ledgerPrinciples.total}`);
  push(`内化 dreamer               ${kindTotal(model.state.internalization, 'dreamer', true)}`);
  push(`  └ philosopher           ${kindTotal(model.state.internalization, 'philosopher', true)}`);
  push(`  └ scribe                ${kindTotal(model.state.internalization, 'scribe', true)}`);
  push(`  └ artificer             ${kindTotal(model.state.internalization, 'artificer', true)}`);
  push(`  └ evaluator             ${kindTotal(model.state.internalization, 'evaluator', true)}`);
  push(`  └ rollout_reviewer      ${kindTotal(model.state.internalization, 'rollout_reviewer', true)}`);
  push(`审批 approvals             ${Object.values(model.state.activation.approvalsByStatus ?? {}).reduce((a, b) => a + b, 0)}`);
  push(`激活 activations           ${Object.values(model.state.activation.activationsByAction ?? {}).reduce((a, b) => a + b, 0)}`);
  push(`应用 principle_applications ${valueOrNA(model.state.application.total)}（原则数 ${valueOrNA(model.state.application.distinctPrinciples)}）`);
  push(`拦截 gate_blocks            ${valueOrNA(model.trajectory.interception.gateBlocks?.total)}`);
  push('```');
  push();
  push(`近 ${model.meta.days} 天（${model.meta.cutoffIso} 之后，按各表 created_at）：`);
  push();
  push('```text');
  push(`Pain                    ${valueOrNA(model.trajectory.pain.windowed)}`);
  push(`新建任务（全部 kind）    ${valueOrNA(model.state.diagnosis.windowedTaskCreation)}`);
  push(`候选                    ${valueOrNA(model.state.candidates.windowed)}`);
  push(`诊断持久化              ${valueOrNA(model.state.diagnosis.painDiagnoses?.windowed)}`);
  push(`原则应用                ${valueOrNA(model.state.application.windowed)}`);
  push(`gate_blocks             ${valueOrNA(model.trajectory.interception.gateBlocks?.windowed)}`);
  push('```');
  push();
  push('## 6. 阶段明细与状态分布');
  push();
  push('### Pain（trajectory.pain_events）');
  push();
  push(`- 来源分布：${fmtCounts(model.trajectory.pain.bySource)}`);
  push(`- 宿主分布：${fmtCounts(model.trajectory.pain.byHostKind)}`);
  push(`- 严重度分布：${fmtCounts(model.trajectory.pain.bySeverity)}`);
  push();
  push('### 诊断（state.tasks / runs / dead_letter_pains）');
  push();
  push(`- task_kind × status：${fmtCounts(model.state.diagnosis.taskKindStatus)}`);
  push(`- 失败任务（按 kind）：${fmtCounts(model.state.diagnosis.failedTasksByKind)}`);
  push(`- 运行失败（runs.error_category Top）：${fmtCounts(topN(model.state.diagnosis.runFailuresByErrorCategory ?? {}, 8))}`);
  push();
  push('### 候选与准入（principle_candidates / admission_json）');
  push();
  push(`- 状态分布：${fmtCounts(model.state.candidates.byStatus)}`);
  push(`- 原始 recommendation_kind 分布（该列即原始持久化值，非归一化视图）：${fmtCounts(model.state.candidates.byRawKind)}`);
  if (model.state.candidates.admission) {
    push(`- 准入决定分布：${fmtCounts(model.state.candidates.admission.decisions)}`);
    push(`- 当前评估 reason Top（含 admitted）：${fmtCounts(model.state.candidates.admission.reasonsTop)}`);
    push(`- processing.state 分布：${fmtCounts(model.state.candidates.admission.processingStates)}`);
    push(`- 文档缺失：${model.state.candidates.admission.absent}；文档损坏（JSON 无效）：${model.state.candidates.admission.invalid}；带 Owner 决策记录：${model.state.candidates.admission.candidatesWithOwnerDecisions}`);
  } else {
    push('- 准入文档：_表缺失_');
  }
  push();
  push('### 账本（ledger.json）');
  push();
  if (model.meta.ledgerPrinciples === null) {
    push(`- availability = ${model.meta.ledgerAvailability}（未计入漏斗）`);
  } else {
    const p = model.meta.ledgerPrinciples;
    push(`- 原则总数 ${p.total}；带 reuseEvidence ${p.withReuseEvidence}（共 ${p.reuseEdges} 条边）；带 derivedFromPainIds ${p.withDerivedCandidates}；关联候选数 ${p.linkedCandidateCount}`);
  }
  push();
  push('### 内化（peer 任务 × status）');
  push();
  for (const kind of ['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer']) {
    push(`- ${kind}：${kindTotal(model.state.internalization, kind, true)}`);
  }
  push();
  push('### 激活（approvals / activations / pi_artifacts）');
  push();
  push(`- approvals 状态：${fmtCounts(model.state.activation.approvalsByStatus)}`);
  push(`- approvals 渠道：${fmtCounts(model.state.activation.approvalsByChannel)}`);
  push(`- activations 动作：${fmtCounts(model.state.activation.activationsByAction)}`);
  push(`- activations 渠道：${fmtCounts(model.state.activation.activationsByChannel)}`);
  push(`- 激活目标形态：${JSON.stringify(model.state.activation.targets)}`);
  push(`- pi_artifacts：总数 ${valueOrNA(model.state.activation.piArtifacts?.total)}，带 source_principle_id ${valueOrNA(model.state.activation.piArtifacts?.withSourcePrincipleId)}，验证状态 ${fmtCounts(model.state.activation.piArtifacts?.byValidationStatus)}`);
  push();
  push('### 注入/拦截（principle_applications / gate_blocks）');
  push();
  push(`- 应用类型：${fmtCounts(model.state.application.byKind)}`);
  push(`- 应用层级：${fmtCounts(model.state.application.byLevel)}`);
  push(`- 拦截工具分布：${fmtCounts(model.trajectory.interception.gateBlocks?.byTool)}`);
  push(`- 干预证据记录：${valueOrNA(model.state.application.interventionEvidenceRecords)}`);
  push();
  push('## 7. 转化率（分子/分母口径逐条声明）');
  push();
  push('| 转化 | 分子（口径） | 分母（口径） | 值 |');
  push('|---|---|---|---|');
  const diagParents = kindTotal(model.state.diagnosis, 'diagnostician');
  push(`| Pain→诊断 | diagnostician 父任务数 | pain_events 总量（两者为不同登记面，仅作比例参考） | ${ratio(diagParents, model.trajectory.pain.total)} |`);
  push(`| 诊断→候选 | principle_candidates 总量 | diagnostician 父任务数 | ${ratio(model.state.candidates.total, diagParents)} |`);
  const consumed = model.state.candidates.byStatus?.consumed ?? 0;
  const dreamerTotal = kindTotal(model.state.internalization, 'dreamer', true);
  push(`| 候选consumed→播种 | dreamer 任务数 | status='consumed' 的候选数 | ${ratio(dreamerTotal, consumed)} |`);
  const scribeTotal = kindTotal(model.state.internalization, 'scribe', true);
  push(`| 播种→Scribe | scribe 任务数 | dreamer 任务数 | ${ratio(scribeTotal, dreamerTotal)} |`);
  const approved = model.state.activation.approvalsByStatus?.approved ?? 0;
  push(`| 审批通过 | approvals status='approved' | approvals 全部 | ${ratio(approved, Object.values(model.state.activation.approvalsByStatus ?? {}).reduce((a, b) => a + b, 0))} |`);
  push(`| 激活→应用 | DISTINCT principle_id in principle_applications | 激活目标 DISTINCT target_ref | ${ratio(model.state.application.distinctPrinciples, model.state.activation.targets?.distinct)} |`);
  push();
  push('> 上述比率是**观测比例**而非严格漏斗转化（各阶段登记面与去重口径不同，已在分子/分母列声明）。');
  push();
  push('## 8. 失败与拒绝原因分布');
  push();
  push(`- 诊断运行失败 error_category：${fmtCounts(topN(model.state.diagnosis.runFailuresByErrorCategory ?? {}, 8))}`);
  push(`- 任务失败（status='failed'，按 kind）：${fmtCounts(model.state.diagnosis.failedTasksByKind)}`);
  if (model.state.candidates.admission) {
    push(`- 非 admitted 决定的 reason Top：${fmtCounts(model.state.candidates.admission.refusalReasonsTop)}`);
  }
  push();
  push('## 9. 跨库关联缺失与偏斜记录');
  push();
  push('```text');
  push(`pain→task:     引用 runtime_task_id 的 pain ${valueOrNA(model.linkage.painToTask?.painsWithRuntimeTaskRef)} 条，其中任务缺失 ${model.linkage.painToTask?.missingTaskRefs ?? 'NA'} 条 → ${JSON.stringify(model.linkage.painToTask?.buckets ?? {})}（阈值未校准 ${model.linkage.painToTask?.thresholdUncalibrated ?? 'NA'}）`);
  push(`task→pain:     带 diagnostic_json 的 diagnostician 任务 ${valueOrNA(model.linkage.taskToPain?.diagnosticianTasksWithJson)} 条，pain 可见 ${valueOrNA(model.linkage.taskToPain?.linkedPainFound)} 条，缺失 ${model.linkage.taskToPain?.painMissing ?? 'NA'} 条 → ${JSON.stringify(model.linkage.taskToPain?.buckets ?? {})}（阈值未校准 ${model.linkage.taskToPain?.thresholdUncalibrated ?? 'NA'}）`);
  push(`candidate→dreamer: consumed 但无 dreamer 任务 ${model.linkage.candidateToDreamer?.consumedWithoutDreamerTask ?? 'NA'} 条（按原始 kind：${fmtCounts(model.linkage.candidateToDreamer?.byRawKind)}）→ ${JSON.stringify(model.linkage.candidateToDreamer?.buckets ?? {})}`);
  push(`  注：implementation/defer/prompt 候选本就不播种 dreamer（合法路由），其缺失不计为管道缺口。`);
  push('```');
  push();
  const skewTotal = (model.linkage.painToTask?.buckets?.skew_window_candidate ?? 0)
    + (model.linkage.taskToPain?.buckets?.skew_window_candidate ?? 0)
    + (model.linkage.candidateToDreamer?.buckets?.skew_window_candidate ?? 0);
  push(`## 10. skew_window_candidate 总数：**${skewTotal}**`);
  push();
  push('（全部跨库缺失均落入该桶；其中标注「阈值未校准」的条目为超出 60 s 建议窗口者——在校准完成前不判定确定流失，可延迟复查。）');
  push();
  push('## 11. 当前无法确定的问题');
  push();
  push('- 5 s / 60 s 两个窗口阈值未经生产写入链路实证校准；本报告的跨库缺失因此全部按 `skew_window_candidate` 输出。');
  push('- Shadow 与 Live 激活的区分依赖 activations.channel/action 的语义组合，本报告只按原始值分布输出，不做语义归类。');
  push('- 候选→账本 的未关联候选包含合法 pending/待审路径（Owner 未 intake 的候选本就不在账本），该差值不是流失。');
  push('- task→pain 的缺失可能由 trajectory.db 的保留期清理（trajectory-retention）造成——旧 pain 行被清理后诊断任务仍在；该方向缺失在保留策略确认前不解读为写入断线。');
  push();
  push('## 12. 对 D1/D2/D4 与架构收敛工作的影响判断');
  push();
  push('- 本基线为 Phase 1A/1B（PRI-1291）的红灯对照与漏斗对照提供**修复前**的真实分布快照；');
  push('- `candidate→dreamer` 缺失与 `principle_candidates.recommendation_kind` 原始分布可直接用于验证 D4 修复后的播种门禁效果；');
  push('- `task→pain` 缺失与诊断任务分布可作为 D1（同步授权与轨迹读取器）修复后诊断覆盖率的对照基线；');
  push('- Pain 阶段的来源/宿主分布为后续阈值校准（写入链路节奏）提供样本量依据。');
  push();
  push('---');
  push();
  push(`生成命令：\`node scripts/dev/pipeline-funnel-snapshot.mjs --workspace "${model.meta.workspace}"\`（PRI-1290 Phase 0，只读）`);
  return lines.join('\n') + '\n';
}

function valueOrNA(v) {
  return v === null || v === undefined ? 'NA(表缺失)' : String(v);
}

function kindTotal(section, kind, fromByKind = false) {
  if (!section) return 'NA';
  if (fromByKind) {
    const v = section.peerTasksByKind?.[kind]?.total;
    return v === undefined ? 0 : v;
  }
  const v = section.kindTotals?.[kind];
  return v === undefined ? 0 : v;
}

function ratio(num, den) {
  if (num === null || den === null || den === undefined || den === 0 || num === undefined) return 'NA';
  return `${(Number(num) / Number(den)).toFixed(3)}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const workspace = path.resolve(options.workspace);
  if (!fs.existsSync(workspace)) {
    throw new Error(`workspace_not_found: ${workspace}`);
  }
  const stateDbPath = storagePaths.resolveStateDbPath(workspace);
  const trajectoryDbPath = storagePaths.resolveTrajectoryDbPath(workspace);
  for (const [label, dbPath] of [['state.db', stateDbPath], ['trajectory.db', trajectoryDbPath]]) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`database_missing: ${label} not found at canonical path ${dbPath} (resolved via storage-paths; refusing to guess)`);
    }
  }

  const pair = snapshotPair(stateDbPath, trajectoryDbPath);
  let stateDb = null;
  let trajectoryDb = null;
  let model;
  try {
    stateDb = openStagedReadonly(pair.state.staged.stagedDbPath);
    trajectoryDb = openStagedReadonly(pair.trajectory.staged.stagedDbPath);
    const laterT1 = Date.parse(pair.state.staged.capturedAt) >= Date.parse(pair.trajectory.staged.capturedAt)
      ? pair.state.staged.capturedAt
      : pair.trajectory.staged.capturedAt;
    const cutoffIso = new Date(Date.parse(laterT1) - options.days * 24 * 60 * 60 * 1000).toISOString();

    const ledger = collectLedgerStats(workspace);
    const state = collectStateFunnel(stateDb, cutoffIso);
    const trajectory = collectTrajectoryFunnel(trajectoryDb, cutoffIso);
    const linkage = collectLinkage(stateDb, trajectoryDb, pair.state.staged.capturedAt, pair.trajectory.staged.capturedAt, cutoffIso);

    model = {
      meta: {
        runDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
        workspace,
        days: options.days,
        cutoffIso,
        stateT1: pair.state.staged.capturedAt,
        stateFingerprint: pair.state.staged.fingerprint,
        stateAttempts: pair.state.attempts,
        trajectoryT1: pair.trajectory.staged.capturedAt,
        trajectoryFingerprint: pair.trajectory.staged.fingerprint,
        trajectoryAttempts: pair.trajectory.attempts,
        skewMs: pair.skewExceededMs,
        skewRetried: pair.skewRetried,
        skewExceeded: pair.skewExceededMs > SNAPSHOT_SKEW_MAX_MS,
        ledgerReadAt: ledger.readAt,
        ledgerAvailability: ledger.availability,
        ledgerPrinciples: ledger.principles,
      },
      trajectory,
      state,
      linkage,
    };
  } finally {
    // Close EVERY connection before dispose (Windows temp-file hostage rule).
    if (trajectoryDb !== null) trajectoryDb.close();
    if (stateDb !== null) stateDb.close();
    pair.state.staged.dispose();
    pair.trajectory.staged.dispose();
  }

  const defaultOut = path.join(REPO_ROOT, 'docs', 'reports', `PD_PIPELINE_FUNNEL_BASELINE_${model.meta.runDate}.md`);
  const outPath = options.out ? path.resolve(options.out) : defaultOut;
  const report = renderReport(model);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, report, 'utf-8');

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, out: outPath, meta: model.meta })}\n`);
  } else {
    process.stdout.write(`funnel baseline written: ${outPath}\n`);
    process.stdout.write(`state T1=${model.meta.stateT1} traj T1=${model.meta.trajectoryT1} skew=${model.meta.skewMs}ms${model.meta.skewExceeded ? ' (EXCEEDED, flagged)' : ''}\n`);
  }
  return model;
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
