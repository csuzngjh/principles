/**
 * pd pain record command — Runtime v2 pain signal entry point.
 *
 * Usage:
 *   pd pain record --reason <text> [--score N] [--source manual] [--workspace <path>] [--json]
 *
 * Flow:
 *   PainDetectedData → PainSignalBridge.onPainDetected()
 *   → DiagnosticianRunner.run() → CandidateIntakeService.intake()
 *   → PrincipleTreeLedger probation entry
 *
 * Output:
 *   JSON: { painId, taskId, runId, artifactId, candidateIds, ledgerEntryIds }
 *   Text: Human-readable summary
 *   Exit: non-0 on failure
 */

import { createPainSignalBridge, PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RecordOptions {
  reason?: string;
  score?: number;
  source?: string;
  workspace?: string;
  json?: boolean;
}

interface PainRecordResult {
  painId: string;
  taskId: string;
  runId?: string;
  artifactId?: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  status: 'succeeded' | 'skipped' | 'failed' | 'retried';
  message?: string;
}

export async function handlePainRecord(opts: RecordOptions): Promise<void> {
  if (!opts.reason) {
    console.error('Error: --reason <text> is required');
    console.error('Usage: pd pain record --reason <text> [--score N] [--source manual] [--workspace <path>] [--json]');
    process.exit(1);
  }

  if (opts.score !== undefined && (isNaN(opts.score) || opts.score < 0 || opts.score > 100)) {
    console.error('Error: --score must be a number between 0 and 100');
    process.exit(1);
  }

  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateDir = `${workspaceDir}/.state`;

  const painId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const taskId = `diagnosis_${painId}`;
  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });

  const bridge = await createPainSignalBridge({
    workspaceDir,
    stateDir,
    ledgerAdapter,
    owner: 'pd-cli',
    autoIntakeEnabled: true,
  });

  const painData = {
    painId,
    taskId,
    painType: 'user_frustration' as const,
    source: opts.source ?? 'manual',
    reason: opts.reason,
    score: opts.score ?? 80,
    sessionId: 'cli',
    agentId: 'pd-cli',
  };

  const result = await (async (): Promise<PainRecordResult> => {
    const bridgeResult = await bridge.onPainDetected(painData);

    return {
      painId: bridgeResult.painId,
      taskId: bridgeResult.taskId,
      runId: bridgeResult.runId,
      artifactId: bridgeResult.artifactId,
      candidateIds: bridgeResult.candidateIds,
      ledgerEntryIds: bridgeResult.ledgerEntryIds,
      status: bridgeResult.status,
      message: bridgeResult.message,
    };
  })().catch((err: unknown) => ({
    painId,
    taskId,
    status: 'failed' as const,
    candidateIds: [],
    ledgerEntryIds: [],
    message: err instanceof Error ? err.message : String(err),
  }));

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'succeeded') process.exit(1);
  } else {
    if (result.status === 'succeeded') {
      console.log('[OK] Pain signal recorded via Runtime v2 bridge');
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
      if (result.runId) console.log(`   Run ID: ${result.runId}`);
      if (result.artifactId) console.log(`   Artifact ID: ${result.artifactId}`);
      if (result.candidateIds.length > 0) console.log(`   Candidate IDs: ${result.candidateIds.join(', ')}`);
      if (result.ledgerEntryIds.length > 0) console.log(`   Ledger Entry IDs: ${result.ledgerEntryIds.join(', ')}`);
      console.log(`   Reason: ${opts.reason}`);
      console.log(`   Score: ${opts.score ?? 80}`);
      console.log(`   Source: ${opts.source ?? 'manual'}`);
      console.log(`   Workspace: ${workspaceDir}`);
      console.log(`\nDiagnostician pipeline running. Check progress with:`);
      console.log(`   pd task show ${result.taskId} --workspace "${workspaceDir}"`);
    } else {
      console.error('[FAIL] Pain signal failed:', result.message);
      process.exit(1);
    }
  }
}
