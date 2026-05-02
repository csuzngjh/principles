/**
 * pd pain record command — Runtime v2 pain signal entry point.
 *
 * Usage:
 *   pd pain record --reason <text> [--score N] [--source manual] [--workspace <path>] [--json]
 *
 * Delegates to PainToPrincipleService (core) for bridge creation, observability,
 * error classification, and latency measurement.
 */

import {
  PainToPrincipleService,
  PrincipleTreeLedgerAdapter,
  resolveRuntimeConfig,
} from '@principles/core/runtime-v2';
import type { PainToPrincipleOutput, FailureCategory } from '@principles/core/runtime-v2';
import type { KnownProvider } from '@mariozechner/pi-ai';
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
  observabilityWarnings?: string[];
  failureCategory?: FailureCategory;
  latencyMs?: number;
}

async function formatConfigDiagnostic(stateDir: string, errMsg: string): Promise<void> {
  const config = (() => {
    try {
      return resolveRuntimeConfig(stateDir);
    } catch {
      return null;
    }
  })();
  if (!config) {
    console.error('Error: Pain signal processing failed — configuration issue\n');
    console.error(`  Details: ${errMsg}`);
    return;
  }
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

  console.error('Error: Pain signal processing failed — configuration issue\n');

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
  console.error(`  Details: ${errMsg}`);
}

function serviceOutputToResult(out: PainToPrincipleOutput): PainRecordResult {
  return {
    painId: out.painId,
    taskId: out.taskId,
    runId: out.runId,
    artifactId: out.artifactId,
    candidateIds: out.candidateIds,
    ledgerEntryIds: out.ledgerEntryIds,
    status: out.status,
    message: out.message,
    // Omit empty warnings from JSON output for cleaner display
    observabilityWarnings: out.observabilityWarnings.length > 0 ? out.observabilityWarnings : undefined,
    failureCategory: out.failureCategory,
    latencyMs: out.latencyMs,
  };
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

  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
  const service = new PainToPrincipleService({
    workspaceDir,
    stateDir,
    ledgerAdapter,
    owner: 'pd-cli',
    autoIntakeEnabled: true,
  });

  const painId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // Service never throws — all errors surfaced via result
  const out = await service.recordPain({
    painId,
    painType: 'user_frustration',
    source: opts.source ?? 'manual',
    reason: opts.reason,
    score: opts.score ?? 80,
    sessionId: 'cli',
    agentId: 'pd-cli',
  });

  const result = serviceOutputToResult(out);

  // Config init failure → show diagnostic guidance
  if (result.status !== 'succeeded' && result.failureCategory === 'config_missing') {
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      await formatConfigDiagnostic(stateDir, result.message ?? 'configuration error');
    }
    process.exit(1);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exit(1);
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
    } else if (result.status === 'skipped') {
      console.log('[SKIP] Pain signal already processed:', result.message);
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
    } else if (result.status === 'retried') {
      console.log('[RETRY] Pain signal triggered retry:', result.message);
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
    } else {
      console.error('[FAIL] Pain signal failed:', result.message);
      process.exit(1);
    }
  }
}
