/**
 * Command handler: `pd runtime internalization run-rulehost`
 *
 * Drives a pain signal all the way to a validated rule artifact in one call:
 *   pain → dreamer → philosopher → scribe → artificer↔evaluator adversarial loop
 *
 * This is the production entry point for the code_tool_hook channel. It wraps
 * runRuleHostPipeline (the service) and constructs the PiAi runtime adapter
 * from .pd/config.yaml (same resolution path as run-once).
 *
 * Atomic capability (per user correction 2026-06-18):
 *   ArtificerL2 + Evaluator are atomic — both must run or neither runs.
 *   The CLI resolves per-agent config (enabled/runtimeProfile) for artificer
 *   and evaluator. When both are enabled, it constructs the ArtificerL2Adapter
 *   via buildArtificerL2GenerateCode and passes CodeRuleCapability.enabled=true.
 *   When either is disabled, it passes CodeRuleCapability.enabled=false with a
 *   structured reason, and the pipeline degrades to text-principle-only.
 *
 * CLI gate compliance:
 *   - --json mode emits exactly one JSON object on stdout
 *   - exit paths return after setting process.exitCode (no fall-through)
 *   - failure paths include a structured reason + next action
 *   - --dry-run is default; --confirm required for mutation
 *   - --dry-run and --confirm are mutually exclusive
 */
import * as path from 'path';
import type { Command } from 'commander';
import { runRuleHostPipeline } from '../services/rulehost-pipeline-runner.js';
import type { RuleHostPipelineResult, CodeRuleCapability, RuleHostAgentAdapters } from '../services/rulehost-pipeline-runner.js';
import { createSandboxGateDeps } from '../services/rulehost-pipeline-runner.js';
import {
  PiAiRuntimeAdapter,
  ArtificerL2Adapter,
  buildArtificerL2GenerateCode,
  DefaultArtificerValidator,
  resolveAgentRuntimeBinding,
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
} from '@principles/core/runtime-v2';
import type { EffectivePdConfig, InternalAgentName, PDRuntimeAdapter } from '@principles/core/runtime-v2';
import { resolveRuntimeFromPdConfig } from '../services/resolve-runtime-from-pd-config.js';

export interface RunRuleHostOptions {
  workspace?: string;
  painId: string;
  channel?: string;
  maxRounds?: number;
  timeoutMs?: number;
  json?: boolean;
  /** Dry-run mode (default). Validates inputs + config, reports capability status, does NOT run the pipeline. */
  dryRun?: boolean;
  /** Confirm mutation — actually run the pipeline. Mutually exclusive with --dry-run. */
  confirm?: boolean;
}

const DEFAULT_WORKSPACE = process.cwd();
const SUPPORTED_CHANNELS = new Set(['prompt', 'code_tool_hook', 'defer_archive']);

type RuleHostChannel = 'prompt' | 'code_tool_hook' | 'defer_archive';

function resolveWorkspace(opts: RunRuleHostOptions): string {
  return opts.workspace ? path.resolve(opts.workspace) : DEFAULT_WORKSPACE;
}

interface ResolvedRunRuleHostRuntime {
  readonly agentAdapters: RuleHostAgentAdapters;
  readonly agentRuntimeProfiles: Partial<Record<InternalAgentName, string>>;
  readonly capability: CodeRuleCapability;
  readonly capabilityStatus: string;
}

function resolvePiAiAgentAdapter(
  effective: EffectivePdConfig,
  agentName: InternalAgentName,
  options: { readonly workspaceDir: string; readonly timeoutMs: number | undefined },
): { adapter: PDRuntimeAdapter; profileId: string } {
  const binding = resolveAgentRuntimeBinding(effective, agentName);
  if (!binding.ok) {
    throw new Error(`${agentName}: ${binding.reason}. nextAction: ${binding.nextAction}`);
  }
  if (binding.profile.type !== 'pi-ai') {
    throw new Error(`${agentName}: runtime profile '${binding.profileId}' must be pi-ai (got '${binding.profile.type}')`);
  }
  if (!process.env[binding.profile.apiKeyEnv]) {
    throw new Error(`${agentName}: apiKeyEnv '${binding.profile.apiKeyEnv}' is not set`);
  }
  return {
    profileId: binding.profileId,
    adapter: new PiAiRuntimeAdapter({
      provider: binding.profile.provider,
      model: binding.profile.model,
      apiKeyEnv: binding.profile.apiKeyEnv,
      maxRetries: binding.profile.maxRetries,
      timeoutMs: options.timeoutMs ?? binding.profile.timeoutMs,
      baseUrl: binding.profile.baseUrl,
      workspace: options.workspaceDir,
    }),
  };
}

/**
 * Resolve the code-rule capability (atomic: ArtificerL2 + Evaluator).
 *
 * Checks per-agent config for artificer and evaluator. When both are enabled,
 * constructs the ArtificerL2Adapter via buildArtificerL2GenerateCode. When
 * either is disabled, returns a disabled capability with a structured reason.
 *
 * Returns the capability AND a human-readable status summary for dry-run output.
 */
function resolveRunRuleHostRuntime(
  workspaceDir: string,
  timeoutMs: number | undefined,
): ResolvedRunRuleHostRuntime {
  const { configLoadResult } = resolveRuntimeFromPdConfig(workspaceDir);

  if (!configLoadResult.ok) {
    throw new Error('config_malformed — cannot resolve agent bindings');
  }

  const { effective } = configLoadResult;
  const adapterOptions = { workspaceDir, timeoutMs };
  const dreamer = resolvePiAiAgentAdapter(effective, 'dreamer', adapterOptions);
  const philosopher = resolvePiAiAgentAdapter(effective, 'philosopher', adapterOptions);
  const scribe = resolvePiAiAgentAdapter(effective, 'scribe', adapterOptions);
  const agentRuntimeProfiles: Partial<Record<InternalAgentName, string>> = {
    dreamer: dreamer.profileId,
    philosopher: philosopher.profileId,
    scribe: scribe.profileId,
  };
  const featureFlags = computeFeatureFlagsFromConfig(effective);
  if (!isFeatureEnabled(featureFlags, 'code_rule_capability')) {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: 'code_rule_capability feature flag is disabled' },
      capabilityStatus: 'code_rule_capability: OFF (feature flag disabled)',
    };
  }

  const artificerBinding = resolveAgentRuntimeBinding(effective, 'artificer');
  const evaluatorBinding = resolveAgentRuntimeBinding(effective, 'evaluator');

  // Both must be enabled (atomic capability).
  if (!artificerBinding.ok) {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: `artificer agent disabled: ${artificerBinding.reason}` },
      capabilityStatus: `code_rule_capability: OFF (artificer disabled — ${artificerBinding.reason})`,
    };
  }
  if (!evaluatorBinding.ok) {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: `evaluator agent disabled: ${evaluatorBinding.reason}` },
      capabilityStatus: `code_rule_capability: OFF (evaluator disabled — ${evaluatorBinding.reason})`,
    };
  }

  // Both enabled — construct the ArtificerL2Adapter.
  // Resolve the artificer's runtime profile to get provider/model/apiKeyEnv.
  const { profile: artificerProfile } = artificerBinding;
  if (artificerProfile.type !== 'pi-ai') {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: `artificer runtime profile is not pi-ai (got '${artificerProfile.type}')` },
      capabilityStatus: `code_rule_capability: OFF (artificer profile type='${artificerProfile.type}', expected pi-ai)`,
    };
  }

  const apiKey = process.env[artificerProfile.apiKeyEnv];
  if (!apiKey) {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: `artificer apiKeyEnv '${artificerProfile.apiKeyEnv}' is not set in environment` },
      capabilityStatus: `code_rule_capability: OFF (artificer apiKeyEnv '${artificerProfile.apiKeyEnv}' not set)`,
    };
  }

  const evaluator = resolvePiAiAgentAdapter(effective, 'evaluator', adapterOptions);
  agentRuntimeProfiles.artificer = artificerBinding.profileId;
  agentRuntimeProfiles.evaluator = evaluator.profileId;

  const generateCode = buildArtificerL2GenerateCode({
    provider: artificerProfile.provider,
    model: artificerProfile.model,
    apiKey,
    baseUrl: artificerProfile.baseUrl,
    timeoutMs,
  });

  const artificerAdapter = new ArtificerL2Adapter({
    generateCode,
    gateDeps: createSandboxGateDeps(),
    validator: new DefaultArtificerValidator(),
  });

  return {
    agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: evaluator.adapter },
    agentRuntimeProfiles,
    capability: { enabled: true, artificerAdapter },
    capabilityStatus: `code_rule_capability: ON (artificer profile='${artificerBinding.profileId}', evaluator profile='${evaluatorBinding.profileId}')`,
  };
}

function formatTextOutput(result: RuleHostPipelineResult): string {
  const lines: string[] = [];
  const isReady = result.decision === 'candidate_ready_for_owner_review';
  const icon = isReady ? '✓' : result.decision === 'text_principle_only' ? '⚠' : '✗';
  lines.push('RuleHost Pipeline (PRI-429)');
  lines.push(`pain: ${result.painId}`);
  lines.push(`OVERALL: ${icon} ${result.decision.toUpperCase()}`);
  lines.push('');

  for (const stage of result.stages) {
    const sIcon = stage.status === 'succeeded' ? '✓' : stage.status === 'degraded' ? '⚠' : stage.status === 'skipped' ? '○' : '✗';
    lines.push(`  ${sIcon} ${stage.name}: ${stage.status}`);
    if (stage.reason) lines.push(`      reason: ${stage.reason}`);
  }
  lines.push('');
  lines.push(`ruleArtifactId: ${result.ruleArtifactId ?? '(none)'}`);
  lines.push(`principleArtifactId: ${result.principleArtifactId ?? '(none)'}`);
  if (result.degradationReason) {
    lines.push(`degradationReason: ${result.degradationReason}`);
  }
  if (result.decision === 'candidate_ready_for_owner_review') {
    lines.push('');
    lines.push('Next: the rule artifact is validated and WAITING for owner review. This is NOT owner approval.');
  } else if (result.decision === 'text_principle_only') {
    lines.push('');
    lines.push('Next: code-rule capability is OFF. Principle artifact remains for prompt-channel fallback.');
  } else {
    lines.push('');
    lines.push('Next: generation rejected. Check degradationReason. Principle artifact may still exist for prompt-channel fallback.');
  }
  return lines.join('\n');
}

function formatDryRunOutput(opts: RunRuleHostOptions, capabilityStatus: string, workspaceDir: string): string {
  const lines: string[] = [];
  lines.push('RuleHost Pipeline (PRI-429) — DRY RUN');
  lines.push(`pain: ${opts.painId}`);
  lines.push(`workspace: ${workspaceDir}`);
  lines.push(`channel: ${opts.channel ?? 'code_tool_hook'}`);
  lines.push(capabilityStatus);
  lines.push('');
  lines.push('No tasks created, no LLM calls made, no artifacts written.');
  lines.push('Next: pass --confirm to actually run the pipeline.');
  return lines.join('\n');
}

export async function handleRunRuleHost(opts: RunRuleHostOptions): Promise<void> {
  // ── Validate dry-run/confirm mutual exclusivity (CLI gate rule 4) ──
  if (opts.dryRun && opts.confirm) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: '--dry-run and --confirm are mutually exclusive', nextAction: 'pass either --dry-run or --confirm, not both' }) + '\n');
    } else {
      console.error('Error: --dry-run and --confirm are mutually exclusive. Pass either one, not both.');
    }
    process.exitCode = 1;
    return;
  }

  // ── Validate inputs ──
  if (!opts.painId || opts.painId.trim() === '') {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: 'painId is required', nextAction: 'pass --pain-id <id> (run pd pain record first)' }) + '\n');
    } else {
      console.error('Error: --pain-id is required. Run `pd pain record` first to seed a pain signal.');
    }
    process.exitCode = 1;
    return;
  }

  const channel = opts.channel ?? 'code_tool_hook';
  if (!SUPPORTED_CHANNELS.has(channel)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: `unsupported channel: ${channel}`, nextAction: 'use one of prompt|code_tool_hook|defer_archive' }) + '\n');
    } else {
      console.error(`Error: unsupported channel '${channel}'. Use one of: prompt, code_tool_hook, defer_archive.`);
    }
    process.exitCode = 1;
    return;
  }

  // Validate numeric opts (Commander parseInt can yield NaN for non-numeric input).
  if (opts.maxRounds !== undefined && (!Number.isInteger(opts.maxRounds) || opts.maxRounds <= 0)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: `invalid --max-rounds: ${opts.maxRounds}`, nextAction: 'pass a positive integer (PRD cap = 2)' }) + '\n');
    } else {
      console.error(`Error: --max-rounds must be a positive integer (got ${opts.maxRounds}).`);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.timeoutMs !== undefined && (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: `invalid --timeout-ms: ${opts.timeoutMs}`, nextAction: 'pass a positive integer (default 300000)' }) + '\n');
    } else {
      console.error(`Error: --timeout-ms must be a positive integer (got ${opts.timeoutMs}).`);
    }
    process.exitCode = 1;
    return;
  }

  const workspaceDir = resolveWorkspace(opts);

  // ── Resolve each executed agent from canonical config ──
  let resolvedRuntime: ResolvedRunRuleHostRuntime;
  try {
    resolvedRuntime = resolveRunRuleHostRuntime(workspaceDir, opts.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: 'agent_runtime_resolution_failed', message, nextAction: 'check internalAgents and runtimeProfiles in .pd/config.yaml; run pd config doctor' }) + '\n');
    } else {
      console.error(`Error: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  // ── Dry-run mode: report what would happen, don't run the pipeline ──
  // Default is dry-run (CLI gate rule 4: mutating commands default to dry-run).
  const isDryRun = opts.dryRun || !opts.confirm;
  if (isDryRun) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        status: 'dry_run',
        painId: opts.painId,
        workspace: workspaceDir,
        channel,
        capabilityStatus: resolvedRuntime.capabilityStatus,
        agentRuntimeProfiles: resolvedRuntime.agentRuntimeProfiles,
        codeRuleCapability: { enabled: resolvedRuntime.capability.enabled, disabledReason: resolvedRuntime.capability.disabledReason },
        nextAction: 'pass --confirm to actually run the pipeline',
      }) + '\n');
    } else {
      process.stdout.write(formatDryRunOutput(opts, resolvedRuntime.capabilityStatus, workspaceDir) + '\n');
    }
    return;
  }

  // ── Run the pipeline (--confirm mode) ──
  let result: RuleHostPipelineResult;
  try {
    result = await runRuleHostPipeline({
      workspaceDir,
      painId: opts.painId,
      runtimeAdapter: resolvedRuntime.agentAdapters.dreamer,
      agentAdapters: resolvedRuntime.agentAdapters,
      codeRuleCapability: resolvedRuntime.capability,
      channel: channel as RuleHostChannel,
      maxRounds: opts.maxRounds,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: 'pipeline_threw', message, nextAction: 'check workspace state and retry' }) + '\n');
    } else {
      console.error(`Error: pipeline failed: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  // ── Output ──
  if (opts.json) {
    // Exactly one parseable JSON object on stdout (CLI gate rule 1).
    // CLI gate rule 6: degraded/refused results include structured reason + nextAction.
    const output = result.decision === 'candidate_ready_for_owner_review'
      ? { status: 'candidate_ready_for_owner_review', ...result }
      : {
          status: result.decision,
          ...result,
          nextAction: result.decision === 'text_principle_only'
            ? 'code-rule capability OFF; principle artifact available for prompt-channel fallback.'
            : 'Check degradationReason; principle artifact may still exist for prompt-channel fallback.',
        };
    process.stdout.write(JSON.stringify(output) + '\n');
  } else {
    process.stdout.write(formatTextOutput(result) + '\n');
  }

  // exit 1 when not candidate_ready_for_owner_review (CLI gate: operator knows it didn't fully succeed)
  if (result.decision !== 'candidate_ready_for_owner_review') {
    process.exitCode = 1;
  }
}

/**
 * Register the `pd runtime internalization run-rulehost` subcommand.
 *
 * Single source of truth for both production (`index.ts`) and parser tests.
 * Extracted so parser-level tests can exercise the real flag wiring without
 * triggering `program.parse()` at module load (CLI gate rule 7).
 */
export function registerRunRuleHostCommand(internalizationCmd: Command): Command {
  return internalizationCmd
    .command('run-rulehost')
    .description('Full-chain: drive a pain signal to a validated rule artifact (pain → dreamer → philosopher → scribe → adversarial loop)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .requiredOption('--pain-id <id>', 'Pain ID whose internalization chain to drive (run `pd pain record` first)')
    .option('--channel <channel>', 'Activation channel: code_tool_hook, prompt, defer_archive (default: code_tool_hook)', 'code_tool_hook')
    .option('--max-rounds <n>', 'Max adversarial rounds (PRD cap = 2)', parseInt)
    .option('--timeout-ms <ms>', 'Per-LLM-call timeout in milliseconds (default: 300000)', parseInt)
    .option('--dry-run', 'Validate inputs + config, report capability status, do NOT run the pipeline (default)')
    .option('--confirm', 'Actually run the pipeline (mutually exclusive with --dry-run)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRunRuleHost({ workspace: opts.workspace, painId: opts.painId, channel: opts.channel, maxRounds: opts.maxRounds, timeoutMs: opts.timeoutMs, dryRun: opts.dryRun, confirm: opts.confirm, json: opts.json });
    });
}
