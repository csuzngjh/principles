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
 * CLI gate compliance:
 *   - --json mode emits exactly one JSON object on stdout
 *   - exit paths return after setting process.exitCode (no fall-through)
 *   - failure paths include a structured reason + next action
 */
import * as path from 'path';
import { runRuleHostPipeline } from '../services/rulehost-pipeline-runner.js';
import type { RuleHostPipelineResult } from '../services/rulehost-pipeline-runner.js';
import { PiAiRuntimeAdapter } from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter } from '@principles/core/runtime-v2';
import { isRuntimeConfigError } from '@principles/core/runtime-v2';
import { resolveRuntimeFromPdConfig } from '../services/resolve-runtime-from-pd-config.js';

export interface RunRuleHostOptions {
  workspace?: string;
  painId: string;
  channel?: string;
  maxRounds?: number;
  timeoutMs?: number;
  json?: boolean;
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

function formatTextOutput(result: RuleHostPipelineResult): string {
  const lines: string[] = [];
  const icon = result.decision === 'approved' ? '✓' : '✗';
  lines.push('RuleHost Pipeline (PRI-429)');
  lines.push(`pain: ${result.painId}`);
  lines.push(`OVERALL: ${icon} ${result.decision.toUpperCase()}`);
  lines.push('');

  for (const stage of result.stages) {
    const sIcon = stage.status === 'succeeded' ? '✓' : stage.status === 'degraded' ? '⚠' : '✗';
    lines.push(`  ${sIcon} ${stage.name}: ${stage.status}`);
    if (stage.reason) lines.push(`      reason: ${stage.reason}`);
  }
  lines.push('');
  lines.push(`ruleArtifactId: ${result.ruleArtifactId ?? '(none)'}`);
  lines.push(`principleArtifactId: ${result.principleArtifactId ?? '(none)'}`);
  if (result.degradationReason) {
    lines.push(`degradationReason: ${result.degradationReason}`);
  }
  if (result.decision === 'approved') {
    lines.push('');
    lines.push('Next: the rule artifact is validated and ready for shadow activation.');
  } else {
    lines.push('');
    lines.push('Next: principle artifact remains for prompt-channel fallback. Check degradationReason.');
  }
  return lines.join('\n');
}

export async function handleRunRuleHost(opts: RunRuleHostOptions): Promise<void> {
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

  // ── Run the pipeline ──
  let result: RuleHostPipelineResult;
  try {
    result = await runRuleHostPipeline({
      workspaceDir,
      painId: opts.painId,
      runtimeAdapter,
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
    const output = result.decision === 'approved'
      ? { status: 'approved', ...result }
      : {
          status: 'rejected',
          ...result,
          nextAction: 'Check degradationReason; principle artifact remains for prompt-channel fallback.',
        };
    process.stdout.write(JSON.stringify(output) + '\n');
  } else {
    process.stdout.write(formatTextOutput(result) + '\n');
  }

  // exit 1 when rejected (CLI gate: operator knows it didn't succeed)
  if (result.decision !== 'approved') {
    process.exitCode = 1;
  }
}
