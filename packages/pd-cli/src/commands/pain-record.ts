/**
 * pd pain record command — Runtime v2 pain signal entry point.
 *
 * Uses PainToPrincipleService as the single write-side orchestration API.
 *
 * Usage:
 *   pd pain record --reason <text> [--score N] [--source manual] [--workspace <path>] [--session <id>] [--json]
 */
import {
  PainToPrincipleService,
  PrincipleTreeLedgerAdapter,
  resolveRuntimeConfig,
  isRuntimeConfigError,
  isFeatureEnabled,
} from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { buildTrajectoryEvidenceFromDb } from './build-trajectory-evidence.js';

interface RecordOptions {
  reason?: string;
  score?: number;
  source?: string;
  workspace?: string;
  json?: boolean;
  session?: string;
  wait?: boolean;
}

export async function handlePainRecord(opts: RecordOptions): Promise<void> {
  if (!opts.reason) {
    console.error('Error: --reason <text> is required');
    console.error('Usage: pd pain record --reason <text> [--score N] [--source manual] [--workspace <path>] [--session <id>] [--json]');
    process.exit(1);
  }

  if (opts.score !== undefined && (isNaN(opts.score) || opts.score < 0 || opts.score > 100)) {
    console.error('Error: --score must be a number between 0 and 100');
    process.exit(1);
  }

  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateDir = `${workspaceDir}/.state`;
  const painId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // PRI-341: Build evidence from trajectory DB if session provided
  const effectiveSessionId = opts.session ?? 'cli';
  const evidence = buildTrajectoryEvidenceFromDb(stateDir, opts.session, workspaceDir);

  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
  // PRI-306: Load .pd/config.yaml for config-driven runtime binding
  const configResult = loadPdConfig(workspaceDir);
  if (!configResult.ok) {
    // ERR-009 / Runtime Contract Rule 9: fail loud with reason, don't silently swallow
    console.error(`Warning: .pd/config.yaml has errors — using defaults:`);
    for (const e of configResult.errors) {
      console.error(`  ${e.path}: ${e.reason}`);
      if (e.nextAction) console.error(`    nextAction: ${e.nextAction}`);
    }
  }
  const effectiveConfig = configResult.ok ? configResult.effective : configResult.defaults;

  // PRI-369: Determine async mode from feature flag + --wait override
  const featureFlags = computeFlagsFromLoadResult(configResult);
  const asyncFlagEnabled = isFeatureEnabled(featureFlags, 'diagnostician_async_cli');
  const asyncMode = asyncFlagEnabled && !opts.wait; // --wait overrides flag to force sync

  const service = new PainToPrincipleService({
    workspaceDir,
    stateDir,
    ledgerAdapter,
    owner: 'pd-cli',
    autoIntakeEnabled: true,
    effectiveConfig,
    getEnvVar: (name: string) => process.env[name],
    asyncMode,
  });

  const result = await service.recordPain({
    painId,
    painType: 'user_frustration',
    source: opts.source ?? 'manual',
    reason: opts.reason,
    score: opts.score ?? 80,
    sessionId: effectiveSessionId,
    agentId: 'pd-cli',
    provenance: 'owner_reported_no_host_trace',
    evidence,
    recordObservability: true,
  });

  // Show diagnostic info for config failures
  if (result.failureCategory === 'config_missing') {
    const legacyConfig = resolveRuntimeConfig(stateDir);
    if (isRuntimeConfigError(legacyConfig)) {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'failed',
          painId: result.painId,
          taskId: result.taskId,
          failureCategory: result.failureCategory,
          message: result.message,
          configError: {
            reason: legacyConfig.reason,
            message: legacyConfig.message,
            nextAction: legacyConfig.nextAction,
          },
        }, null, 2));
      } else {
        console.error(`  Config resolution failed: ${legacyConfig.reason}`);
        console.error(`  ${legacyConfig.message}`);
        console.error(`  nextAction: ${legacyConfig.nextAction}`);
      }
      process.exit(1);
      return;
    }
    const config = legacyConfig;
    const missing: string[] = [];
    if (!config.provider) missing.push('provider');
    if (!config.model) missing.push('model');
    if (!config.apiKeyEnv) missing.push('apiKeyEnv');
    if (config.provider) {
      try {
        // pi-ai is an optional peer; the package may or may not resolve depending on
        // the package manager (pnpm local vs npm in CI). @ts-ignore (not @ts-expect-error)
        // is intentional: it suppresses TS2307 when absent and is silently ignored when present.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { getProviders } = await import('@mariozechner/pi-ai');
        const knownProviders = getProviders() as readonly string[];
        if (!knownProviders.includes(config.provider) && !config.baseUrl) {
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
    if (result.status !== 'succeeded' && result.status !== 'skipped' && result.status !== 'retried' && result.status !== 'submitted') process.exit(1);
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
    } else if (result.status === 'submitted') {
      console.log('[SUBMITTED] Pain signal submitted for async diagnosis');
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
      console.log(`   Status: submitted`);
      console.log(`   Next action: pd task show ${result.taskId} --workspace "${workspaceDir}"`);
      if (result.latencyMs !== undefined) console.log(`   Submit latency: ${result.latencyMs}ms`);
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
