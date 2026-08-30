/**
 * pd codex reconcile command implementation (Codex Governance Closure
 * Slice B, PRI-623; SPEC §13/§20).
 *
 * Runs the narrow idempotent reconciliation pass between the governance
 * admission markers (trajectory.db) and the Runtime V2 task store
 * (.pd/state.db): creates missing Diagnostician tasks for admitted pains,
 * repairs task links, retries pending promotion tails, and reports stale
 * tails — without a background worker (the Slice C Companion worker will
 * call the same seam).
 *
 * CLI gate compliance:
 * - cli-1: --json outputs exactly one parseable JSON object on stdout.
 * - cli-2: exit paths stop execution.
 * - cli-6: degraded results include reason + nextAction.
 */
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { reconcileGovernanceContinuation } from '@principles/host-runtime';

interface CodexReconcileOptions {
  workspace?: string;
  json?: boolean;
  limit?: number;
}

export interface CodexReconcileReport {
  generatedAt: string;
  host: 'codex';
  workspace: string;
  ok: boolean;
  reason?: string;
  nextAction?: string;
  tasksEnsured: number;
  linksRepaired: number;
  pendingTails: number;
  completedTails: number;
  staleTails: number;
  degradations: string[];
}

export async function handleCodexReconcile(options: CodexReconcileOptions): Promise<void> {
  const generatedAt = new Date().toISOString();
  const workspace = resolveWorkspaceDir(options.workspace);

  const result = await reconcileGovernanceContinuation({
    workspaceDir: workspace,
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
  });

  const report: CodexReconcileReport = {
    generatedAt,
    host: 'codex',
    workspace,
    ok: result.ok,
    tasksEnsured: result.tasksEnsured,
    linksRepaired: result.linksRepaired,
    pendingTails: result.pendingTails,
    completedTails: result.completedTails,
    staleTails: result.staleTails,
    degradations: [...result.degradations],
    ...(result.ok ? {} : { reason: result.reason ?? 'reconciliation_failed', nextAction: result.nextAction ?? 'Inspect the listed degradations; admitted pains and evidence remain durable.' }),
  };

  if (options.json) {
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const lines = [
    `Codex governance reconciliation (${workspace})`,
    `  tasks ensured:      ${report.tasksEnsured} (links repaired: ${report.linksRepaired})`,
    `  promotion tails:    pending=${report.pendingTails} completed-now=${report.completedTails} stale=${report.staleTails}`,
  ];
  for (const degradation of report.degradations) {
    lines.push(`  degradation: ${degradation}`);
  }
  if (!report.ok) {
    lines.push(`  reason: ${report.reason}`);
    lines.push(`  next action: ${report.nextAction}`);
  }
  console.log(lines.join('\n'));
  if (!report.ok) process.exitCode = 1;
}
