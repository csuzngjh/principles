/**
 * pd runtime trace show command — full pain-to-ledger chain trace.
 *
 * Usage: pd runtime trace show --pain-id <id> [--workspace <path>] [--json]
 *
 * Traces the complete pain→task→run→artifact→candidate→ledger chain
 * and reports consistency, latency, and failure classification.
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import {
  RuntimeStateManager,
  loadLedger,
  mapFailureCategory,
  isPDErrorCategory,
} from '@principles/core/runtime-v2';

interface TraceLatencyMs {
  painToTask?: number;
  taskToRun?: number;
  runToArtifact?: number;
  artifactToCandidate?: number;
  candidateToLedger?: number;
}

interface TraceResult {
  painId: string;
  taskId: string;
  runId?: string;
  artifactId?: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  status: string;
  latencyMs: TraceLatencyMs;
  failureCategory: string | null;
  checkedAt: string;
  missingLinks: string[];
}

interface TraceOptions {
  painId: string;
  workspace?: string;
  json?: boolean;
}

function parseTaskErrorCategory(task: { lastError?: string | null }): string | null {
  if (!task.lastError) return null;
  // lastError may be stored as plain PDErrorCategory string (e.g. "timeout", "execution_failed")
  if (isPDErrorCategory(task.lastError)) return task.lastError;
  // Fallback: try JSON parse for legacy structured formats
  try {
    const parsed = JSON.parse(task.lastError);
    return parsed.category ?? null;
  } catch {
    return null;
  }
}

// ── Output helpers (defined before handleTraceShow to satisfy no-use-before-define) ──

function outputNoTask(opts: TraceOptions, workspaceDir: string, checkedAt: string): never {
  const taskId = `diagnosis_${opts.painId}`;
  const result = {
    painId: opts.painId,
    taskId,
    status: 'not_found',
    failureCategory: 'runtime_unavailable' as const,
    message: `No task found for painId: ${opts.painId}`,
    workspace: workspaceDir,
    checkedAt,
    missingLinks: ['task' as const],
  };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.error(`Error: No task found for painId: ${opts.painId}`);
  console.error(`  Derived taskId: ${taskId}`);
  console.error(`  Workspace: ${workspaceDir}`);
  process.exit(1);
}

function outputResult(result: TraceResult, opts: TraceOptions): void {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'error' || result.status === 'failed' || result.status === 'degraded') {
      process.exit(1);
    }
    return;
  }

  console.log(`Pain ID:       ${result.painId}`);
  console.log(`Task ID:       ${result.taskId}`);
  console.log(`Status:        ${result.status}`);
  if (result.runId) console.log(`Run ID:        ${result.runId}`);
  if (result.artifactId) console.log(`Artifact ID:   ${result.artifactId}`);
  if (result.candidateIds.length > 0) console.log(`Candidate IDs:  ${result.candidateIds.join(', ')}`);
  if (result.ledgerEntryIds.length > 0) console.log(`Ledger Entries: ${result.ledgerEntryIds.join(', ')}`);
  if (result.failureCategory) console.log(`Failure:       ${result.failureCategory}`);
  console.log(`Checked at:    ${result.checkedAt}`);

  if (Object.keys(result.latencyMs).length > 0) {
    console.log('\nLatency:');
    if (result.latencyMs.painToTask) console.log(`  pain→task:          ${result.latencyMs.painToTask}ms`);
    if (result.latencyMs.taskToRun) console.log(`  task→run:           ${result.latencyMs.taskToRun}ms`);
    if (result.latencyMs.runToArtifact) console.log(`  run→artifact:       ${result.latencyMs.runToArtifact}ms`);
    if (result.latencyMs.artifactToCandidate) console.log(`  artifact→candidate: ${result.latencyMs.artifactToCandidate}ms`);
    if (result.latencyMs.candidateToLedger) console.log(`  candidate→ledger:   ${result.latencyMs.candidateToLedger}ms`);
  }

  if (result.missingLinks.length > 0) {
    console.log(`\nMissing links (${result.missingLinks.length}):`);
    for (const link of result.missingLinks) {
      console.log(`  - ${link}`);
    }
  }

  if (result.status === 'failed' || result.status === 'degraded') {
    process.exit(1);
  }
}

// ── Main handler ──

export async function handleTraceShow(opts: TraceOptions): Promise<void> {
  if (!opts.painId) {
    console.error('Error: --pain-id <id> is required');
    process.exit(1);
  }

  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const taskId = `diagnosis_${opts.painId}`;
  const checkedAt = new Date().toISOString();
  const missingLinks: string[] = [];

  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({
        painId: opts.painId,
        taskId,
        status: 'error',
        failureCategory: 'config_missing',
        message: `Failed to initialize state manager: ${msg}`,
        checkedAt,
      }, null, 2));
      process.exit(1);
    }
    console.error(`Error: Failed to open workspace at ${workspaceDir}`);
    console.error(`  ${msg}`);
    process.exit(1);
  }

  try {
    // 1. Query task
    const task = await stateManager.getTask(taskId);
    if (!task) {
      missingLinks.push('task');
      outputNoTask(opts, workspaceDir, checkedAt);
      await stateManager.close();
      return;
    }

    // 2. Query latest run
    const runs = await stateManager.getRunsByTask(taskId);
    const latestRun = runs.length > 0
      ? runs.reduce((a, b) => (a.startedAt > b.startedAt ? a : b))
      : undefined;

    // 3. Query artifact (from the runs, find latest artifact)
    // The state manager does not expose a direct "find artifact by taskId" query.
    // We walk each run's associated artifact via the runs table and use
    // direct DB queries for the artifacts table.
    let artifactId: string | undefined = undefined;
    let artifactCreatedAt: string | undefined = undefined;
    if (latestRun) {
      const runRows = stateManager.connection.getDb()
        .prepare('SELECT artifact_id, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(latestRun.runId) as { artifact_id: string; created_at: string } | undefined;
      if (runRows) {
        artifactId = runRows.artifact_id;
        artifactCreatedAt = runRows.created_at;
      }
    }

    // 4. Query candidates by taskId
    const candidates = await stateManager.getCandidatesByTaskId(taskId);

    // 5. Load ledger and match
    const ledgerStateDir = path.join(workspaceDir, '.state');
    const ledger = loadLedger(ledgerStateDir);
    const principleEntries = Object.values(ledger.tree.principles);

    const candidateToLedgerEntry = new Map<string, string>();
    for (const entry of principleEntries) {
      const e = entry as { id: string; derivedFromPainIds?: string[] };
      for (const cid of e.derivedFromPainIds ?? []) {
        candidateToLedgerEntry.set(cid, e.id);
      }
    }

    const candidateIds = candidates.map(c => c.candidateId);
    const ledgerEntryIds: string[] = [];
    for (const c of candidates) {
      const entryId = candidateToLedgerEntry.get(c.candidateId);
      if (entryId) {
        ledgerEntryIds.push(entryId);
      } else if (c.status === 'consumed') {
        missingLinks.push(`candidate:${c.candidateId} consumed but missing from ledger`);
      }
    }

    // 6. Compute latencies
    const latencyMs: TraceLatencyMs = {};
    if (task.createdAt && latestRun?.startedAt) {
      latencyMs.painToTask = Math.max(0, new Date(latestRun.startedAt).getTime() - new Date(task.createdAt).getTime());
    }
    if (latestRun?.startedAt && latestRun?.endedAt) {
      latencyMs.taskToRun = Math.max(0, new Date(latestRun.endedAt).getTime() - new Date(latestRun.startedAt).getTime());
    }
    if (latestRun?.endedAt && artifactCreatedAt) {
      latencyMs.runToArtifact = Math.max(0, new Date(artifactCreatedAt).getTime() - new Date(latestRun.endedAt).getTime());
    }
    if (artifactCreatedAt && candidates.length > 0) {
      const firstCandidateAt = candidates.reduce((min, c) =>
        c.createdAt < min ? c.createdAt : min, candidates[0].createdAt);
      latencyMs.artifactToCandidate = Math.max(0, new Date(firstCandidateAt).getTime() - new Date(artifactCreatedAt).getTime());
    }
    if (candidates.length > 0 && ledgerEntryIds.length > 0) {
      const lastCandidateAt = candidates.reduce((max, c) =>
        c.createdAt > max ? c.createdAt : max, candidates[0].createdAt);
      let earliestLedgerAt: string | undefined = undefined;
      for (const entry of principleEntries) {
        const e = entry as { id: string; createdAt?: string };
        if (ledgerEntryIds.includes(e.id) && e.createdAt) {
          if (!earliestLedgerAt || e.createdAt < earliestLedgerAt) earliestLedgerAt = e.createdAt;
        }
      }
      if (earliestLedgerAt) {
        latencyMs.candidateToLedger = Math.max(0, new Date(earliestLedgerAt).getTime() - new Date(lastCandidateAt).getTime());
      }
    }

    // 7. Determine status and failure category
    let status: string = task.status;
    let failureCategory: string | null = null;

    if (task.status === 'failed') {
      const errorCat = parseTaskErrorCategory(task);
      failureCategory = mapFailureCategory(errorCat) ?? 'runtime_unavailable';
    } else if (task.status === 'succeeded') {
      if (candidateIds.length === 0) {
        status = 'failed';
        failureCategory = 'candidate_missing';
        missingLinks.push('No candidates generated for succeeded task');
      } else if (ledgerEntryIds.length === 0) {
        status = 'degraded';
        failureCategory = 'ledger_inconsistent';
        missingLinks.push('Candidates present but no matching ledger entries');
      }
    }

    // 8. Build result
    const result: TraceResult = {
      painId: opts.painId,
      taskId,
      runId: latestRun?.runId,
      artifactId,
      candidateIds,
      ledgerEntryIds,
      status,
      latencyMs,
      failureCategory,
      checkedAt,
      missingLinks,
    };

    outputResult(result, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({
        painId: opts.painId,
        taskId,
        status: 'error',
        failureCategory: 'runtime_unavailable',
        message: msg,
        checkedAt,
        missingLinks: ['internal_error'],
      }, null, 2));
      process.exit(1);
    }
    console.error(`Error: ${msg}`);
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}