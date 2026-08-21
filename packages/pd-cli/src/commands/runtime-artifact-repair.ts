/**
 * PRI-555 phase 1 — artifact identity drift repair planner (DRY-RUN ONLY).
 *
 * Historical scribe artifacts were written under an older task-id naming
 * scheme (`artificer-scribe-…-<chan>×4`); re-seeded chains reference scribe
 * tasks under the current scheme (`scribe-…-<chan>×3`). The artificer-family
 * resolvers do exact source_task_id lookups, so those artifacts are
 * unreachable and 63 tasks failed permanently with input_invalid.
 *
 * This command ONLY builds a repair plan (migration-plan.json). It never
 * mutates state.db: the connection is opened readonly with
 * bootstrapIfMissing=false (ERR-023 — dry-run must not open writable DBs,
 * and must not create an empty state.db as a side effect).
 *
 * Repair rules (deliberately conservative — no fuzzy matching):
 * - Rule 1 (remap): a `principle` artifact exists whose source_task_id carries
 *   the SAME normalized role chain, the SAME full UUID token, AND the SAME
 *   trailing channel token as the dependency task id (e.g. a legacy channel
 *   repetition-count variant of the dependency's own key). Full-token equality
 *   on all three, not substring/prefix guessing. Exactly one match →
 *   high-confidence re-key proposal. Downstream-stage artifacts of the same
 *   chain (extra role prefixes like `artificer-…`/`evaluator-…`) do NOT match —
 *   re-keying them would feed a later stage's output into an earlier slot.
 * - Rule 2 (reconstruct): no artifact found, but the dependency task has a
 *   succeeded run with non-empty output_payload → medium-confidence artifact
 *   reconstruction proposal.
 * - Anything ambiguous or unconfirmable → needs_human_review. We never guess.
 *
 * CLI gates: cli-1 (strict JSON), cli-2 (exit + return), cli-4 (dry-run
 * default, --confirm refused in this phase), cli-5 (failure path writes
 * nothing to the DB), cli-6 (structured reason + nextAction).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { emitResult, emitError, emitFlagConflict } from '../services/cli-output.js';

interface ArtifactRepairOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  out?: string;
  json?: boolean;
}

// ── Plan types (migration-plan.json contract) ────────────────────────────────

export type ArtifactRepairAction =
  | 'remap_source_task_id'
  | 'reconstruct_from_run_payload'
  | 'needs_human_review';

export type ArtifactRepairSource =
  | 'old_key_uuid_match'
  | 'run_output_payload'
  | 'direct_key'
  | 'none';

export interface ArtifactRepairPlanEntry {
  failed_task_id: string;
  failed_task_kind: string;
  dependency_task_id: string;
  existing_artifact: {
    artifact_id: string;
    artifact_kind: string;
    source_task_id: string;
  } | null;
  artifact_source: ArtifactRepairSource;
  repair_action: ArtifactRepairAction;
  confidence: 'high' | 'medium' | null;
  reason: string;
  proposal: {
    action: 'remap_source_task_id' | 'reconstruct_from_run_payload';
    artifact_id?: string;
    old_source_task_id?: string;
    new_source_task_id?: string;
    run_id?: string;
    artifact_kind?: string;
    validation_status?: string;
  } | null;
  unresolved_dep_count: number;
}

export interface ArtifactRepairPlanSummary {
  scanned_failed_tasks: number;
  rule1_remap: number;
  rule2_reconstruct: number;
  needs_human_review: number;
}

export interface ArtifactRepairPlan {
  generatedAt: string;
  workspace: string;
  dryRun: true;
  summary: ArtifactRepairPlanSummary;
  entries: ArtifactRepairPlanEntry[];
}

// ── Untrusted-row helpers (rc-1/rc-4/rc-5) ───────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(row: unknown, key: string): string | null {
  if (!isRecord(row)) return null;
  if (!Object.hasOwn(row, key)) return null;
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

const BOUNDED_FIELD_MAX = 200;

function bounded(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= BOUNDED_FIELD_MAX ? value : value.substring(0, BOUNDED_FIELD_MAX);
}

const FULL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Extract the FIRST full canonical UUID token; null when the id has none. */
function extractFullUuid(id: string): string | null {
  for (const match of id.toLowerCase().matchAll(FULL_UUID_RE)) {
    return match[0];
  }
  return null;
}

/**
 * Extract the trailing repeated channel token (e.g. `prompt` from
 * `…-prompt-prompt-prompt`). Task ids end with the channel token repeated;
 * requiring equality on UUID and channel disambiguates same-chain tasks
 * across channels without any fuzzy matching.
 */
function extractTrailingChannelToken(id: string): string | null {
  const segments = id.split('-');
  const last = segments[segments.length - 1];
  return last ? last : null;
}

/**
 * Normalize an id to its role chain: strip the UUID token and the trailing
 * repeated channel tokens. `scribe-philosopher-dreamer-<uuid>-prompt×3` →
 * `scribe-philosopher-dreamer`; `artificer-scribe-philosopher-dreamer-<uuid>-
 * prompt×4` → `artificer-scribe-philosopher-dreamer` (a DIFFERENT stage).
 * Rule 1 requires this to be equal so downstream-stage artifacts of the same
 * chain are never re-keyed into an earlier stage's slot.
 */
function normalizeRoleChain(id: string): string {
  const withoutUuid = id.replace(FULL_UUID_RE, '');
  const segments = withoutUuid.split('-').filter((t) => t.length > 0);
  if (segments.length > 1) {
    const last = segments[segments.length - 1];
    let i = segments.length;
    while (i > 1 && segments[i - 1] === last) i -= 1;
    segments.length = i;
  }
  return segments.join('-');
}

/** Dependency kinds whose pi_artifacts feed downstream runners. */
const PRODUCER_DEP_KINDS: ReadonlySet<string> = new Set(['dreamer', 'philosopher', 'scribe', 'artificer']);

function extractDependencyTaskIds(diagnosticJson: string | null): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (!diagnosticJson) return { ok: false, reason: 'tasks.diagnostic_json is null' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(diagnosticJson);
  } catch (err) {
    return { ok: false, reason: `diagnostic_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'diagnostic_json is not an object' };
  if (!Object.hasOwn(parsed, 'pi_metadata')) return { ok: false, reason: 'diagnostic_json missing pi_metadata' };
  const meta: unknown = parsed.pi_metadata;
  if (!isRecord(meta)) return { ok: false, reason: 'pi_metadata is not an object' };
  if (!Object.hasOwn(meta, 'dependencyTaskIds')) return { ok: false, reason: 'pi_metadata missing dependencyTaskIds' };
  const deps: unknown = meta.dependencyTaskIds;
  if (!Array.isArray(deps)) return { ok: false, reason: 'dependencyTaskIds is not an array' };
  const ids = deps.filter((d): d is string => typeof d === 'string');
  if (ids.length === 0) return { ok: false, reason: 'dependencyTaskIds is empty or contains no string elements' };
  return { ok: true, ids };
}

// ── Plan builder ──────────────────────────────────────────────────────────────

interface DepTaskRow {
  taskId: string;
  taskKind: string | null;
  status: string | null;
}

function loadDepTask(db: Database, taskId: string): DepTaskRow | null {
  const row: unknown = db
    .prepare('SELECT task_id, task_kind, status FROM tasks WHERE task_id = ?')
    .get(taskId);
  if (!isRecord(row)) return null;
  const id = readString(row, 'task_id');
  if (!id) return null;
  return { taskId: id, taskKind: readString(row, 'task_kind'), status: readString(row, 'status') };
}

function countDirectArtifacts(db: Database, depTaskId: string): number {
  const row: unknown = db
    .prepare("SELECT COUNT(*) AS c FROM pi_artifacts WHERE source_task_id = ? AND artifact_kind = 'principle'")
    .get(depTaskId);
  if (!isRecord(row) || !Object.hasOwn(row, 'c')) return 0;
  const { c } = row;
  return typeof c === 'number' ? c : 0;
}

interface CandidateArtifact {
  artifactId: string;
  sourceTaskId: string;
}

function findOldKeyCandidates(
  db: Database,
  depTaskId: string,
): CandidateArtifact[] {
  const depUuid = extractFullUuid(depTaskId);
  const depChannel = extractTrailingChannelToken(depTaskId);
  const depRoleChain = normalizeRoleChain(depTaskId);
  if (!depUuid || !depChannel) return [];

  const rows: unknown[] = db
    .prepare("SELECT artifact_id, source_task_id FROM pi_artifacts WHERE artifact_kind = 'principle'")
    .all();
  const candidates: CandidateArtifact[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const artifactId = readString(row, 'artifact_id');
    const sourceTaskId = readString(row, 'source_task_id');
    if (!artifactId || !sourceTaskId) continue;
    if (sourceTaskId === depTaskId) continue; // direct key handled separately
    if (extractFullUuid(sourceTaskId) !== depUuid) continue; // exact full-UUID equality
    if (extractTrailingChannelToken(sourceTaskId) !== depChannel) continue;
    if (normalizeRoleChain(sourceTaskId) !== depRoleChain) continue; // same producer stage only
    candidates.push({ artifactId, sourceTaskId });
  }
  return candidates;
}

function findSucceededRunPayload(
  db: Database,
  depTaskId: string,
): { runId: string } | null {
  const row: unknown = db
    .prepare(
      `SELECT run_id FROM runs
       WHERE task_id = ? AND execution_status = 'succeeded'
         AND output_payload IS NOT NULL AND TRIM(output_payload) != ''
       ORDER BY started_at DESC, attempt_number DESC
       LIMIT 1`,
    )
    .get(depTaskId);
  if (!isRecord(row)) return null;
  const runId = readString(row, 'run_id');
  return runId ? { runId } : null;
}

function humanReviewEntry(input: {
  failedTaskId: string;
  failedTaskKind: string;
  dependencyTaskId: string;
  reason: string;
  unresolvedDepCount: number;
}): ArtifactRepairPlanEntry {
  return {
    failed_task_id: input.failedTaskId,
    failed_task_kind: input.failedTaskKind,
    dependency_task_id: input.dependencyTaskId,
    existing_artifact: null,
    artifact_source: 'none',
    repair_action: 'needs_human_review',
    confidence: null,
    reason: bounded(input.reason) ?? input.reason,
    proposal: null,
    unresolved_dep_count: input.unresolvedDepCount,
  };
}

/**
 * Build the dry-run repair plan. `db` must come from a readonly connection —
 * this function executes SELECTs only and never mutates state.
 */
export function buildArtifactRepairPlan(
  db: Database,
  opts: { workspaceDir: string; generatedAt: string },
): ArtifactRepairPlan {
  const failedTasks: unknown[] = db
    .prepare(
      `SELECT task_id, task_kind, last_error, diagnostic_json FROM tasks
       WHERE task_kind IN ('dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator')
         AND status = 'failed' AND last_error = 'input_invalid'`,
    )
    .all();

  const entries: ArtifactRepairPlanEntry[] = [];

  for (const failedRow of failedTasks) {
    if (!isRecord(failedRow)) continue;
    const failedTaskId = readString(failedRow, 'task_id');
    const failedTaskKind = readString(failedRow, 'task_kind') ?? 'unknown';
    if (!failedTaskId) continue;

    const deps = extractDependencyTaskIds(readString(failedRow, 'diagnostic_json'));
    if (!deps.ok) {
      entries.push(humanReviewEntry({
        failedTaskId,
        failedTaskKind,
        dependencyTaskId: '',
        reason: deps.reason,
        unresolvedDepCount: 0,
      }));
      continue;
    }

    // First producer dependency whose artifact cannot be resolved by the
    // exact-key lookup is the repair target; count the rest.
    let blocker: {
      depTaskId: string;
      depTask: DepTaskRow | null;
      directArtifacts: number;
    } | null = null;
    let unresolvedDepCount = 0;

    for (const depTaskId of deps.ids) {
      const depTask = loadDepTask(db, depTaskId);
      const depKind = depTask?.taskKind;
      if (!depTask || !depKind || !PRODUCER_DEP_KINDS.has(depKind)) continue; // resolver ignores non-producer deps
      const directArtifacts = countDirectArtifacts(db, depTaskId);
      if (directArtifacts > 0) continue; // resolvable — not a blocker
      unresolvedDepCount++;
      if (!blocker) blocker = { depTaskId, depTask, directArtifacts };
    }

    if (!blocker) {
      entries.push(humanReviewEntry({
        failedTaskId,
        failedTaskKind,
        dependencyTaskId: '',
        reason: 'no unresolved producer dependency found — input_invalid has another cause; inspect the task runs',
        unresolvedDepCount: 0,
      }));
      continue;
    }

    const { depTaskId, depTask } = blocker;

    if (!depTask || depTask.status !== 'succeeded') {
      const status = depTask?.status ?? 'missing';
      entries.push(humanReviewEntry({
        failedTaskId,
        failedTaskKind,
        dependencyTaskId: depTaskId,
        reason: `producer dependency task is ${status} — repair requires re-running the dependency, not artifact migration`,
        unresolvedDepCount,
      }));
      continue;
    }

    // Rule 1: unique old-key artifact with identical full UUID + channel token.
    const candidates = findOldKeyCandidates(db, depTaskId);
    const [candidate] = candidates;
    if (candidates.length === 1 && candidate) {
      entries.push({
        failed_task_id: failedTaskId,
        failed_task_kind: failedTaskKind,
        dependency_task_id: depTaskId,
        existing_artifact: {
          artifact_id: candidate.artifactId,
          artifact_kind: 'principle',
          source_task_id: candidate.sourceTaskId,
        },
        artifact_source: 'old_key_uuid_match',
        repair_action: 'remap_source_task_id',
        confidence: 'high',
        reason: `principle artifact exists under a legacy key with identical role-chain+UUID+channel tokens; propose re-keying source_task_id ${candidate.sourceTaskId} → ${depTaskId}`,
        proposal: {
          action: 'remap_source_task_id',
          artifact_id: candidate.artifactId,
          old_source_task_id: candidate.sourceTaskId,
          new_source_task_id: depTaskId,
        },
        unresolved_dep_count: unresolvedDepCount,
      });
      continue;
    }
    if (candidates.length > 1) {
      entries.push(humanReviewEntry({
        failedTaskId,
        failedTaskKind,
        dependencyTaskId: depTaskId,
        reason: `ambiguous legacy artifacts: ${candidates.length} principle rows share the dependency's role-chain+UUID+channel tokens (${candidates.map((c) => c.artifactId).join(', ')})`,
        unresolvedDepCount,
      }));
      continue;
    }

    // Rule 2: reconstruct from the dependency's succeeded run payload.
    const run = findSucceededRunPayload(db, depTaskId);
    if (run) {
      entries.push({
        failed_task_id: failedTaskId,
        failed_task_kind: failedTaskKind,
        dependency_task_id: depTaskId,
        existing_artifact: null,
        artifact_source: 'run_output_payload',
        repair_action: 'reconstruct_from_run_payload',
        confidence: 'medium',
        reason: `no principle artifact under any key, but succeeded run ${run.runId} has output_payload; propose reconstructing a principle artifact for ${depTaskId}`,
        proposal: {
          action: 'reconstruct_from_run_payload',
          run_id: run.runId,
          new_source_task_id: depTaskId,
          artifact_kind: 'principle',
          validation_status: 'pending',
        },
        unresolved_dep_count: unresolvedDepCount,
      });
      continue;
    }

    entries.push(humanReviewEntry({
      failedTaskId,
      failedTaskKind,
      dependencyTaskId: depTaskId,
      reason: 'no principle artifact under any resolvable key and no succeeded run output_payload to reconstruct from',
      unresolvedDepCount,
    }));
  }

  const summary: ArtifactRepairPlanSummary = {
    scanned_failed_tasks: entries.length,
    rule1_remap: entries.filter((e) => e.repair_action === 'remap_source_task_id').length,
    rule2_reconstruct: entries.filter((e) => e.repair_action === 'reconstruct_from_run_payload').length,
    needs_human_review: entries.filter((e) => e.repair_action === 'needs_human_review').length,
  };

  return {
    generatedAt: opts.generatedAt,
    workspace: opts.workspaceDir,
    dryRun: true,
    summary,
    entries,
  };
}

// ── CLI handler ───────────────────────────────────────────────────────────────

interface ArtifactRepairCliResult {
  ok: true;
  dryRun: true;
  planFile: string;
  summary: ArtifactRepairPlanSummary;
  nextAction: string;
}

function formatTextOutput(output: ArtifactRepairCliResult): string {
  const lines: string[] = [];
  lines.push(`Artifact Repair (dry-run, PRI-555 phase 1)`);
  lines.push(`  plan file:      ${output.planFile}`);
  lines.push(`  scanned failed: ${output.summary.scanned_failed_tasks}`);
  lines.push(`  Rule-1 remap:   ${output.summary.rule1_remap}`);
  lines.push(`  Rule-2 reconstruct: ${output.summary.rule2_reconstruct}`);
  lines.push(`  needs human review: ${output.summary.needs_human_review}`);
  lines.push(`  next action: ${output.nextAction}`);
  return lines.join('\n');
}

export async function handleRuntimeArtifactRepair(opts: ArtifactRepairOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    const exitCode = emitFlagConflict({ json: opts.json ?? false });
    process.exit(exitCode);
    return;
  }
  if (opts.confirm) {
    // PRI-555 phase 1 is dry-run only: applying a plan mutates production
    // state.db and must stay a deliberate, owner-approved follow-up.
    const reason = '--confirm is not implemented: artifact repair ships dry-run only in PRI-555 phase 1';
    const nextAction = 'Review migration-plan.json with the owner; apply confirmed entries via the runbook in docs/fix/pri-554-556-555-fix-report.md.';
    if (opts.json ?? false) {
      console.log(JSON.stringify({ ok: false, reason, nextAction }, null, 2));
    } else {
      console.error(`Error: ${reason}`);
      console.error(`Next action: ${nextAction}`);
    }
    process.exit(1);
    return;
  }

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const planPath = opts.out ? path.resolve(opts.out) : path.join(process.cwd(), 'migration-plan.json');

  // ERR-023: dry-run opens the DB readonly, and must not bootstrap an empty
  // state.db either — a missing state.db is an error, not a fresh workspace.
  let conn: SqliteConnection | null = null;
  try {
    conn = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
    const plan = buildArtifactRepairPlan(conn.getDb(), {
      workspaceDir,
      generatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

    const result: ArtifactRepairCliResult = {
      ok: true,
      dryRun: true,
      planFile: planPath,
      summary: plan.summary,
      nextAction: 'Review migration-plan.json (Rule-1 remap proposals first). Nothing has been modified; wait for owner confirmation before applying.',
    };
    emitResult(result, { json: opts.json ?? false, formatText: formatTextOutput });
  } catch (err) {
    process.exitCode = emitError(err, {
      json: opts.json ?? false,
      nextAction: 'Verify --workspace points to a workspace with an initialized .pd/state.db (pd runtime init), then retry.',
    });
  } finally {
    try { conn?.close(); } catch { /* best-effort */ }
  }
}
