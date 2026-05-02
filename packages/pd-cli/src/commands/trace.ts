/**
 * pd runtime trace show command — full pain-to-ledger chain trace.
 *
 * Usage: pd runtime trace show --pain-id <id> [--workspace <path>] [--json]
 *
 * Delegates chain traversal to PainChainReadModel (core).
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { PainChainReadModel } from '@principles/core/runtime-v2';

interface TraceOptions {
  painId: string;
  workspace?: string;
  json?: boolean;
}

function outputNoTask(opts: TraceOptions, workspaceDir: string, checkedAt: string): never {
  const taskId = `diagnosis_${opts.painId}`;
  const result = {
    painId: opts.painId,
    taskId,
    status: 'not_found' as const,
    failureCategory: 'runtime_unavailable' as const,
    message: `No task found for painId: ${opts.painId}`,
    workspace: workspaceDir,
    checkedAt,
    missingLinks: ['task' as const],
    runId: undefined,
    artifactId: undefined,
    candidateIds: [] as string[],
    ledgerEntryIds: [] as string[],
    latencyMs: {},
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

export async function handleTraceShow(opts: TraceOptions): Promise<void> {
  if (!opts.painId) {
    console.error('Error: --pain-id <id> is required');
    process.exit(1);
  }

  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const readModel = new PainChainReadModel({ workspaceDir });

  try {
    const trace = await readModel.traceByPainId(opts.painId);

    if (trace.status === 'not_found') {
      outputNoTask(opts, workspaceDir, trace.checkedAt);
      return;
    }

    const result = {
      ...trace,
      workspace: workspaceDir,
    };

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

    if (result.status === 'failed' || result.status === 'degraded' || result.status === 'error') {
      process.exit(1);
    }
  } finally {
    await readModel.close();
  }
}
