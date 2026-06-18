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
import type { RuleHostPipelineResult, CodeRuleCapability } from '../services/rulehost-pipeline-runner.js';
import { createSandboxGateDeps } from '../services/rulehost-pipeline-runner.js';
import {
  PiAiRuntimeAdapter,
  ArtificerL2Adapter,
  buildArtificerL2GenerateCode,
  DefaultArtificerValidator,
  resolveAgentRuntimeBinding,
  isRuntimeConfigError,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter } from '@principles/core/runtime-v2';
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

function resolveRuntimeAdapter(workspaceDir: string, timeoutMs: number | undefined): PDRuntimeAdapter {
  const resolved = resolveRuntimeFromPdConfig(workspaceDir);
  const configResult = resolved.result;

  if (isRuntimeConfigError(configResult)) {
    throw new Error(
      `Config resolution from .pd/config.yaml failed: ${configResult.reason}. ` +
      `${configResult.message}. nextAction: ${configResult.nextAction}`,
    );
  }

  const cfg = configResult;

  if (cfg.runtimeKind !== 'pi-ai') {
    throw new Error(
      `run-rulehost requires runtimeKind=pi-ai (got '${cfg.runtimeKind}'). ` +
      `nextAction: set runtime.kind=pi-ai in .pd/config.yaml`,
    );
  }

  if (!cfg.provider || !cfg.model || !cfg.apiKeyEnv) {
    throw new Error(
      `run-rulehost requires provider, model, and apiKeyEnv in .pd/config.yaml ` +
      `(got provider='${cfg.provider ?? 'unset'}', model='${cfg.model ?? 'unset'}', apiKeyEnv='${cfg.apiKeyEnv ?? 'unset'}'). ` +
      `nextAction: set runtime.provider, runtime.model, and runtime.apiKeyEnv in .pd/config.yaml`,
    );
  }

  return new PiAiRuntimeAdapter({
    provider: cfg.provider,
    model: cfg.model,
    apiKeyEnv: cfg.apiKeyEnv,
    maxRetries: cfg.maxRetries,
    timeoutMs: timeoutMs ?? cfg.timeoutMs,
    baseUrl: cfg.baseUrl,
    workspace: workspaceDir,
  });
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
function resolveCodeRuleCapability(
  workspaceDir: string,
  timeoutMs: number | undefined,
): { capability: CodeRuleCapability; statusSummary: string } {
  const { configLoadResult } = resolveRuntimeFromPdConfig(workspaceDir);

  if (!configLoadResult.ok) {
    return {
      capability: { enabled: false, disabledReason: 'config_malformed — cannot resolve agent bindings' },
      statusSummary: 'code_rule_capability: OFF (config malformed)',
    };
  }

  const { effective } = configLoadResult;
  const artificerBinding = resolveAgentRuntimeBinding(effective, 'artificer');
  const evaluatorBinding = resolveAgentRuntimeBinding(effective, 'evaluator');

  // Both must be enabled (atomic capability).
  if (!artificerBinding.ok) {
    return {
      capability: { enabled: false, disabledReason: `artificer agent disabled: ${artificerBinding.reason}` },
      statusSummary: `code_rule_capability: OFF (artificer disabled — ${artificerBinding.reason})`,
    };
  }
  if (!evaluatorBinding.ok) {
    return {
      capability: { enabled: false, disabledReason: `evaluator agent disabled: ${evaluatorBinding.reason}` },
      statusSummary: `code_rule_capability: OFF (evaluator disabled — ${evaluatorBinding.reason})`,
    };
  }

  // Both enabled — construct the ArtificerL2Adapter.
  // Resolve the artificer's runtime profile to get provider/model/apiKeyEnv.
  const { profile: artificerProfile } = artificerBinding;
  if (artificerProfile.type !== 'pi-ai') {
    return {
      capability: { enabled: false, disabledReason: `artificer runtime profile is not pi-ai (got '${artificerProfile.type}')` },
      statusSummary: `code_rule_capability: OFF (artificer profile type='${artificerProfile.type}', expected pi-ai)`,
    };
  }

  const apiKey = process.env[artificerProfile.apiKeyEnv];
  if (!apiKey) {
    return {
      capability: { enabled: false, disabledReason: `artificer apiKeyEnv '${artificerProfile.apiKeyEnv}' is not set in environment` },
      statusSummary: `code_rule_capability: OFF (artificer apiKeyEnv '${artificerProfile.apiKeyEnv}' not set)`,
    };
  }

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
    capability: { enabled: true, artificerAdapter },
    statusSummary: `code_rule_capability: ON (artificer profile='${artificerBinding.profileId}', evaluator profile='${evaluatorBinding.profileId}')`,
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
  if (opts.maxRounds !== undefined && (!Number.isFinite(opts.maxRounds) || opts.maxRounds <= 0)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: `invalid --max-rounds: ${opts.maxRounds}`, nextAction: 'pass a positive integer (PRD cap = 2)' }) + '\n');
    } else {
      console.error(`Error: --max-rounds must be a positive integer (got ${opts.maxRounds}).`);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: `invalid --timeout-ms: ${opts.timeoutMs}`, nextAction: 'pass a positive integer (default 300000)' }) + '\n');
    } else {
      console.error(`Error: --timeout-ms must be a positive integer (got ${opts.timeoutMs}).`);
    }
    process.exitCode = 1;
    return;
  }

  const workspaceDir = resolveWorkspace(opts);

  // ── Resolve runtime adapter from config ──
  let runtimeAdapter: PDRuntimeAdapter;
  try {
    runtimeAdapter = resolveRuntimeAdapter(workspaceDir, opts.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: 'runtime_config_resolution_failed', message, nextAction: 'run pd config doctor' }) + '\n');
    } else {
      console.error(`Error: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  // ── Resolve code-rule capability (atomic: ArtificerL2 + Evaluator) ──
  let capability: CodeRuleCapability;
  let capabilityStatus: string;
  try {
    const { capability: resolvedCap, statusSummary: resolvedStatus } = resolveCodeRuleCapability(workspaceDir, opts.timeoutMs);
    capability = resolvedCap;
    capabilityStatus = resolvedStatus;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: 'code_rule_capability_resolution_failed', message, nextAction: 'check artificer/evaluator agent config in .pd/config.yaml' }) + '\n');
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
        capabilityStatus,
        codeRuleCapability: { enabled: capability.enabled, disabledReason: capability.disabledReason },
        nextAction: 'pass --confirm to actually run the pipeline',
      }) + '\n');
    } else {
      process.stdout.write(formatDryRunOutput(opts, capabilityStatus, workspaceDir) + '\n');
    }
    return;
  }

  // ── Run the pipeline (--confirm mode) ──
  let result: RuleHostPipelineResult;
  try {
    result = await runRuleHostPipeline({
      workspaceDir,
      painId: opts.painId,
      runtimeAdapter,
      codeRuleCapability: capability,
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
