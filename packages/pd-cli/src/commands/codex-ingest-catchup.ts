/**
 * pd codex ingest catch-up command implementation (Codex Governance Closure
 * Slice C, PRI-624; SPEC §13/§15 recovery command).
 *
 * Performs ONE bounded non-destructive catch-up pass over the workspace's
 * durable Codex checkpoints: resolves each previously-authenticated rollout
 * by exact uuid, re-authorizes the transcript path, and resumes the bounded
 * incremental ingestion from the checkpoint — then feeds any admission
 * candidates through the same Slice B admission/continuation pass the hook
 * uses. Flag-off (`codex_conversation_ingestion=false`) performs ZERO
 * transcript filesystem I/O and reports a structured skip.
 *
 * This is the manual-mode counterpart of the Companion worker's catch-up
 * step (worker cycle step 2); it creates no LLM execution.
 *
 * CLI gate compliance:
 * - cli-1: --json outputs exactly one parseable JSON object on stdout.
 * - cli-2: exit paths stop execution.
 * - cli-5/6: skipped/degraded results carry reason + nextAction; nothing is
 *   mutated on failure (the ingestion seam is transactional per rollout).
 */
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { catchUpCodexIngestion, type CodexCatchUpResult } from '@principles/codex-adapter';

interface CodexIngestCatchUpOptions {
  workspace?: string;
  json?: boolean;
  maxRollouts?: number;
}

export interface CodexIngestCatchUpReport {
  generatedAt: string;
  host: 'codex';
  workspace: string;
  status: 'ok' | 'degraded' | 'skipped';
  reason?: string;
  nextAction?: string;
  rolloutsProcessed: number;
  remainingLagRollouts: string[];
  unexaminedRollouts: string[];
  degradations: string[];
}

function buildReport(generatedAt: string, workspace: string, result: CodexCatchUpResult): CodexIngestCatchUpReport {
  if (result.status === 'skipped') {
    return {
      generatedAt,
      host: 'codex',
      workspace,
      status: 'skipped',
      reason: result.reason,
      nextAction: result.nextAction,
      rolloutsProcessed: 0,
      remainingLagRollouts: [],
      unexaminedRollouts: [],
      degradations: [],
    };
  }
  const degradations: string[] = [];
  for (const rollout of result.rollouts) {
    for (const degradation of rollout.admissionDegradations) {
      degradations.push(`${rollout.rolloutIdentity}: ${degradation.reason}`);
    }
    if (rollout.outcome.status === 'degraded') {
      degradations.push(`${rollout.rolloutIdentity}: ${rollout.outcome.reason}`);
    }
  }
  return {
    generatedAt,
    host: 'codex',
    workspace,
    status: result.status,
    rolloutsProcessed: result.rollouts.length,
    remainingLagRollouts: [...result.remainingLagRollouts],
    unexaminedRollouts: [...result.unexaminedRollouts],
    degradations: degradations.slice(0, 10),
    ...(degradations.length > 0 && result.status === 'degraded'
      ? { reason: 'one or more rollouts degraded; committed observations remain durable', nextAction: 'Inspect the per-rollout degradations; re-run catch-up after fixing the underlying condition (Slice D adds the audited quarantine command).' }
      : {}),
  };
}

export async function handleCodexIngestCatchUp(options: CodexIngestCatchUpOptions): Promise<void> {
  const generatedAt = new Date().toISOString();
  const workspace = resolveWorkspaceDir(options.workspace);

  const result = await catchUpCodexIngestion({
    workspaceDir: workspace,
    env: { CODEX_HOME: process.env.CODEX_HOME },
    ...(typeof options.maxRollouts === 'number' ? { maxRollouts: options.maxRollouts } : {}),
  });

  const report = buildReport(generatedAt, workspace, result);
  if (options.json) {
    console.log(JSON.stringify(report));
    if (report.status === 'degraded') process.exitCode = 1;
    return;
  }

  const lines = [
    `Codex ingestion catch-up (${workspace})`,
    `  status:             ${report.status}`,
    `  rollouts processed: ${report.rolloutsProcessed}`,
    `  remaining lag:      ${report.remainingLagRollouts.length}`,
    `  unexamined (bound): ${report.unexaminedRollouts.length}`,
  ];
  for (const degradation of report.degradations) {
    lines.push(`  degradation: ${degradation}`);
  }
  if (report.reason !== undefined) lines.push(`  reason: ${report.reason}`);
  if (report.nextAction !== undefined) lines.push(`  next action: ${report.nextAction}`);
  console.log(lines.join('\n'));
  if (report.status === 'degraded') process.exitCode = 1;
}
