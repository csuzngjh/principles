/**
 * pd pain record command — Runtime v2 pain signal entry point.
 *
 * Uses PainToPrincipleService as the single write-side orchestration API.
 *
 * Usage:
 *   pd pain record --reason <text> [--score N] [--source manual] [--workspace <path>] [--json]
 */
import {
  PainToPrincipleService,
  PrincipleTreeLedgerAdapter,
  resolveRuntimeConfig,
} from '@principles/core/runtime-v2';
import type { KnownProvider } from '@mariozechner/pi-ai';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RecordOptions {
  reason?: string;
  score?: number;
  source?: string;
  workspace?: string;
  json?: boolean;
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

  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
  const service = new PainToPrincipleService({
    workspaceDir,
    stateDir,
    ledgerAdapter,
    owner: 'pd-cli',
    autoIntakeEnabled: true,
  });

  const result = await service.recordPain({
    painId,
    painType: 'user_frustration',
    source: opts.source ?? 'manual',
    reason: opts.reason,
    score: opts.score ?? 80,
    sessionId: 'cli',
    agentId: 'pd-cli',
    recordObservability: true,
  });

  // Show diagnostic info for config failures
  if (result.failureCategory === 'config_missing') {
    const config = resolveRuntimeConfig(stateDir);
    const missing: string[] = [];
    if (!config.provider) missing.push('provider');
    if (!config.model) missing.push('model');
    if (!config.apiKeyEnv) missing.push('apiKeyEnv');
    if (config.provider) {
      try {
        const { getProviders } = await import('@mariozechner/pi-ai');
        const knownProviders = getProviders();
        if (!knownProviders.includes(config.provider as KnownProvider) && !config.baseUrl) {
          missing.push('baseUrl');
        }
      } catch {
        // pi-ai may not be available
      }
    }

    if (missing.length > 0 || config.provider || config.apiKeyEnv) {
      console.error('Error: Pain signal failed\n');

      if (missing.length > 0) {
        console.error('  Missing configuration:');
        for (const m of missing) {
          console.error(`    - ${m}`);
        }
        console.error('');
      }

      if (config.provider || config.model || config.apiKeyEnv || config.baseUrl) {
        console.error('  Current workflow policy (pd-runtime-v2-diagnosis):');
        console.error(`    runtimeKind: ${config.runtimeKind}`);
        if (config.provider) console.error(`    provider:    ${config.provider}`);
        if (config.model) console.error(`    model:       ${config.model}`);
        if (config.apiKeyEnv) console.error(`    apiKeyEnv:   ${config.apiKeyEnv}`);
        if (config.baseUrl) console.error(`    baseUrl:     ${config.baseUrl}`);
        console.error('');
      }

      console.error('  To diagnose and configure your runtime, run:');
      console.error('    pd runtime probe --runtime pi-ai --provider <name> --model <id> --apiKeyEnv <name>');
      console.error('');

      if (result.message) console.error(`  Details: ${result.message}`);
      process.exit(1);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'succeeded' && result.status !== 'skipped' && result.status !== 'retried') process.exit(1);
  } else {
    if (result.status === 'succeeded') {
      console.log('[OK] Pain signal recorded via PainToPrincipleService');
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
      if (result.latencyMs !== undefined) console.log(`   Latency: ${result.latencyMs}ms`);
      console.log(`\nDiagnostician pipeline running. Check progress with:`);
      console.log(`   pd task show ${result.taskId} --workspace "${workspaceDir}"`);
    } else if (result.status === 'skipped') {
      console.log(`[SKIP] Task already in progress: ${result.message ?? 'unknown'}`);
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
    } else if (result.status === 'retried') {
      console.log(`[RETRY] Task retried: ${result.message ?? 'unknown'}`);
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
    } else {
      console.error('[FAIL] Pain signal failed:', result.message);
      process.exit(1);
    }
  }
}
