/**
 * pd runtime internalization audit-artificer-evidence — read-only history audit
 * (SPEC-PD-IAER-001 FR-09, T11, AC-10; PRI-985).
 *
 * Scans the workspace runtime state DB for runs that failed with the
 * `behavior_example_pack_missing` signature (runtime kinds `pi-ai-l2` AND
 * `pi-ai`), aggregates them BY TASK ID (production evidence: ~385 runs across
 * ~82 tasks — runs are not tasks), and reports four anomaly markers per task
 * plus a summary. This command is read-only BY CONSTRUCTION:
 *
 * - the DB is opened with `readonly: true, bootstrapIfMissing: false`
 *   (ERR-023 precedent from runtime-artifact-repair.ts) — a missing state.db
 *   is a structured refusal, never a fresh workspace;
 * - no --confirm exists and no write path exists in this file (cli-4 moot:
 *   there is nothing to confirm; cli-5: failure paths mutate nothing);
 * - no recovery/reschedule is performed here (that is the FR-09 B-side,
 *   handled by the existing retry / failed-tasks recovery entries).
 *
 * CLI contract (EP-04): `--json` prints exactly one parseable JSON object on
 * stdout (cli-1); no matching data is a structured EMPTY result with a
 * nextAction, not an error; a missing/unreadable DB or missing tables is a
 * structured refusal with exit code 1 (cli-2/cli-6).
 */

import * as path from 'path';
import type { Command } from 'commander';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import {
  aggregateArtificerEvidenceRuns,
  loadArtificerEvidenceAuditInputs,
  type ArtificerEvidenceAuditReport,
} from '../services/artificer-evidence-audit.js';

export interface AuditArtificerEvidenceOptions {
  workspace?: string;
  json?: boolean;
}

export interface AuditArtificerEvidenceOutput {
  ok: boolean;
  mode: 'read_only_audit';
  workspace: string;
  status: 'complete' | 'empty' | 'failed';
  summary?: ArtificerEvidenceAuditReport['summary'];
  tasks?: ArtificerEvidenceAuditReport['tasks'];
  governanceDetection?: string;
  reason?: string;
  nextAction?: string;
}

function emit(out: AuditArtificerEvidenceOutput, json?: boolean): void {
  if (json) {
    // cli-1-strict-json: exactly one parseable JSON object on stdout.
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`Artificer Evidence Audit (${out.mode}) — ${out.workspace}`);
  if (out.status === 'failed') {
    console.log(`  status:     failed`);
    console.log(`  reason:     ${out.reason ?? 'unknown'}`);
    console.log(`  nextAction: ${out.nextAction ?? ''}`);
    return;
  }
  const s = out.summary;
  console.log(`  status:            ${out.status}`);
  console.log(`  pack-missing runs: ${s?.totalRuns ?? 0}`);
  console.log(`  distinct tasks:    ${s?.distinctTasks ?? 0}`);
  console.log(`  by runtime kind:   ${Object.entries(s?.byRuntimeKind ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
  console.log(`  by final status:   ${Object.entries(s?.byFinalTaskStatus ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
  console.log(`  anomalies:         repeatedRetry=${s?.anomalyCounts.repeatedRetryConsumption ?? 0}, succeededArtifactThenFailed=${s?.anomalyCounts.succeededArtifactThenFailed ?? 0}, governanceSideEffects=${s?.anomalyCounts.hasGovernanceSideEffects ?? 0} (detection: ${out.governanceDetection ?? 'unknown'})`);
  console.log(`  nextAction:        ${out.nextAction ?? ''}`);
  const tasks = out.tasks ?? [];
  if (tasks.length > 0) {
    console.log('');
    console.log('Tasks (oldest first):');
    for (const t of tasks) {
      console.log(`  - ${t.taskId}`);
      console.log(`    taskKind:   ${t.taskKind ?? '-'}`);
      console.log(`    status:     ${t.taskStatus ?? 'unknown (no task row)'}${t.attemptCount !== null ? ` (${t.attemptCount}/${t.maxAttempts} attempts)` : ''}`);
      console.log(`    runs:       ${t.runCount}${Object.keys(t.failureCategories).length > 0 ? ` [${Object.entries(t.failureCategories).map(([k, v]) => `${k}=${v}`).join(', ')}]` : ''}`);
      console.log(`    window:     ${t.firstFailureAt} .. ${t.lastFailureAt}`);
      const flags = [
        t.anomalies.repeatedRetryConsumption ? 'repeated_retry_consumption' : null,
        t.anomalies.succeededArtifactThenFailed ? 'succeeded_artifact_then_failed' : null,
        t.anomalies.hasGovernanceSideEffects ? 'has_governance_side_effects' : null,
        t.anomalies.packMissingFailure ? 'pack_missing_failure' : null,
      ].filter((f): f is string => f !== null);
      console.log(`    anomalies:  ${flags.length > 0 ? flags.join(', ') : '(none)'}`);
      console.log(`    nextAction: ${t.nextAction}`);
    }
  }
}

export async function handleRuntimeInternalizationAuditArtificerEvidence(opts: AuditArtificerEvidenceOptions): Promise<void> {
  // Resolution runs inside the try so an unresolvable default workspace is
  // also a structured refusal (cli-6); if resolution itself fails, the
  // refusal reports the raw --workspace value, when one was given.
  let resolvedWorkspace: string | null = null;
  let conn: SqliteConnection | null = null;
  try {
    const workspaceDir = path.resolve(resolveWorkspaceDir(opts.workspace));
    resolvedWorkspace = workspaceDir;

    // ERR-023 precedent: read-only audit opens the DB readonly and must not
    // bootstrap an empty state.db — a missing state.db is a refusal.
    conn = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
    const db = conn.getDb();

    const inputs = loadArtificerEvidenceAuditInputs(db);
    const report = aggregateArtificerEvidenceRuns(inputs);

    const empty = report.summary.distinctTasks === 0;
    const out: AuditArtificerEvidenceOutput = {
      ok: true,
      mode: 'read_only_audit',
      workspace: workspaceDir,
      status: empty ? 'empty' : 'complete',
      summary: report.summary,
      tasks: report.tasks,
      governanceDetection: report.governanceDetection,
      reason: empty
        ? 'No runs match the behavior_example_pack_missing signature for runtime kinds pi-ai-l2/pi-ai'
        : undefined,
      nextAction: empty
        ? 'Nothing to audit. If a failure is expected, verify the workspace path: this audit scans <workspace>/.pd/state.db'
        : report.summary.anomalyCounts.packMissingFailure > 0
          ? 'Read-only result — nothing was modified. Recovery is per-task and Owner-driven: attach evidence via the recovery entry (PRI-983), then use the per-task nextAction (pd runtime internalization retry --confirm for needs_human_review, pd runtime recovery failed-tasks --confirm for failed).'
          : 'Read-only result — nothing was modified.',
    };
    emit(out, opts.json);
  } catch (err) {
    // Structured refusal (cli-6): reason + nextAction, exit 1, no repair attempts.
    const out: AuditArtificerEvidenceOutput = {
      ok: false,
      mode: 'read_only_audit',
      workspace: resolvedWorkspace ?? opts.workspace ?? '(workspace unresolved)',
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      nextAction: 'Verify --workspace points at a workspace with an initialized .pd/state.db (pd runtime init), then retry. This audit does not create or repair databases.',
    };
    emit(out, opts.json);
    process.exitCode = 1;
  } finally {
    try {
      conn?.close();
    } catch {
      // best-effort close of a read-only handle; the report is already emitted
    }
  }
}

/** Register the production `pd runtime internalization audit-artificer-evidence` command. */
export function registerRuntimeInternalizationAuditArtificerEvidenceCommand(
  internalizationCmd: Command,
  handler: (opts: AuditArtificerEvidenceOptions) => Promise<void> = handleRuntimeInternalizationAuditArtificerEvidence,
): Command {
  return internalizationCmd
    .command('audit-artificer-evidence')
    .description('Read-only history audit: aggregate behavior_example_pack_missing failures by task (FR-09)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output as JSON')
    .action(async (opts: AuditArtificerEvidenceOptions) => {
      await handler(opts);
    });
}
