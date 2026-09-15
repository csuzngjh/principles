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
import * as fs from 'node:fs';
import type { Command } from 'commander';
import { runRuleHostPipeline } from '../services/rulehost-pipeline-runner.js';
import type { RuleHostPipelineResult, CodeRuleCapability, RuleHostAgentAdapters } from '../services/rulehost-pipeline-runner.js';
import { createSandboxGateDeps } from '../services/rulehost-pipeline-runner.js';
import {
  PiAiRuntimeAdapter,
  ArtificerL2Adapter,
  DefaultArtificerValidator,
  resolveAgentRuntimeBinding,
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
} from '@principles/core/runtime-v2';
import type { EffectivePdConfig, InternalAgentName, PDRuntimeAdapter } from '@principles/core/runtime-v2';
import type { BehaviorExamplePack } from '@principles/core/runtime-v2';
import { storeEmitter } from '@principles/core/runtime-v2';
import { WorkspaceTelemetryEmitter } from '@principles/host-runtime';
import { resolveRuntimeFromPdConfig } from '../services/resolve-runtime-from-pd-config.js';
import { resolveRuleHostReadiness } from '../services/rulehost-readiness.js';
import type { RuleHostReadinessResult } from '../services/rulehost-readiness.js';

export interface RunRuleHostOptions {
  workspace?: string;
  painId: string;
  channel?: string;
  maxRounds?: number;
  timeoutMs?: number;
  behaviorExamples?: string;
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
  readonly contextV2Enabled: boolean;
}

interface OwnerBehaviorExamplesInput {
  readonly ownerDesiredOutcome: string;
  readonly sourceNegativeToolCallId: number;
  readonly positiveToolCallIds: readonly number[];
}

type OwnerBehaviorExamplesResult =
  | { readonly ok: true; readonly value: OwnerBehaviorExamplesInput }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnerBehaviorExamples(filePath: string): OwnerBehaviorExamplesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `behavior_examples_unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'behavior_examples_invalid: root must be an object' };
  if (typeof parsed.ownerDesiredOutcome !== 'string' || parsed.ownerDesiredOutcome.trim() === '') {
    return { ok: false, reason: 'behavior_examples_invalid: ownerDesiredOutcome must be a non-empty string' };
  }
  if (!Number.isSafeInteger(parsed.sourceNegativeToolCallId) || Number(parsed.sourceNegativeToolCallId) <= 0) {
    return { ok: false, reason: 'behavior_examples_invalid: sourceNegativeToolCallId must be a positive integer' };
  }
  if (!Array.isArray(parsed.positiveToolCallIds) || parsed.positiveToolCallIds.length === 0 || parsed.positiveToolCallIds.length > 3
    || parsed.positiveToolCallIds.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)) {
    return { ok: false, reason: 'behavior_examples_invalid: positiveToolCallIds must contain 1 to 3 positive integers' };
  }
  return {
    ok: true,
    value: {
      ownerDesiredOutcome: parsed.ownerDesiredOutcome,
      sourceNegativeToolCallId: Number(parsed.sourceNegativeToolCallId),
      positiveToolCallIds: parsed.positiveToolCallIds.map((id) => Number(id)),
    },
  };
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
      // Forward profile maxTokens: pi-ai only sends max_tokens when the caller
      // sets it — omitting it lets the provider apply its own (small) default
      // output cap, truncating long JSON outputs (EP002-R3 scribe intentContract).
      // Parity with the consumer-cycle adapter (PRI-758 CodeRabbit P2).
      ...(binding.profile.maxTokens !== undefined ? { maxTokens: binding.profile.maxTokens } : {}),
      timeoutMs: options.timeoutMs ?? binding.profile.timeoutMs,
      baseUrl: binding.profile.baseUrl,
      workspace: options.workspaceDir,
      // PRI-633: profile systemPrompt rides as the append layer.
      ...(binding.profile.systemPrompt ? { systemPrompt: binding.profile.systemPrompt } : {}),
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
  readiness: RuleHostReadinessResult,
): ResolvedRunRuleHostRuntime {
  const { configLoadResult } = resolveRuntimeFromPdConfig(workspaceDir);

  if (!configLoadResult.ok) {
    throw new Error('config_malformed — cannot resolve agent bindings');
  }

  const { effective } = configLoadResult;
  const featureFlags = computeFeatureFlagsFromConfig(effective);
  const contextV2Enabled = isFeatureEnabled(featureFlags, 'rulecode_context_v2');
  const adapterOptions = { workspaceDir, timeoutMs };
  const dreamer = resolvePiAiAgentAdapter(effective, 'dreamer', adapterOptions);
  const philosopher = resolvePiAiAgentAdapter(effective, 'philosopher', adapterOptions);
  const scribe = resolvePiAiAgentAdapter(effective, 'scribe', adapterOptions);
  const agentRuntimeProfiles: Partial<Record<InternalAgentName, string>> = {
    dreamer: dreamer.profileId,
    philosopher: philosopher.profileId,
    scribe: scribe.profileId,
  };
  if (readiness.status === 'text_principle_only') {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: readiness.reason },
      capabilityStatus: `code_rule_capability: OFF (${readiness.reason})`,
      contextV2Enabled,
    };
  }
  if (!isFeatureEnabled(featureFlags, 'code_rule_capability')) {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: 'code_rule_capability feature flag is disabled' },
      capabilityStatus: 'code_rule_capability: OFF (feature flag disabled)',
      contextV2Enabled,
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
      contextV2Enabled,
    };
  }
  if (!evaluatorBinding.ok) {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: `evaluator agent disabled: ${evaluatorBinding.reason}` },
      capabilityStatus: `code_rule_capability: OFF (evaluator disabled — ${evaluatorBinding.reason})`,
      contextV2Enabled,
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
      contextV2Enabled,
    };
  }

  const apiKey = process.env[artificerProfile.apiKeyEnv];
  if (!apiKey) {
    return {
      agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: scribe.adapter },
      agentRuntimeProfiles,
      capability: { enabled: false, disabledReason: `artificer apiKeyEnv '${artificerProfile.apiKeyEnv}' is not set in environment` },
      capabilityStatus: `code_rule_capability: OFF (artificer apiKeyEnv '${artificerProfile.apiKeyEnv}' not set)`,
      contextV2Enabled,
    };
  }

  const evaluator = resolvePiAiAgentAdapter(effective, 'evaluator', adapterOptions);
  agentRuntimeProfiles.artificer = artificerBinding.profileId;
  agentRuntimeProfiles.evaluator = evaluator.profileId;

  // PRI-795 review P1: the CLI process is one-shot — without a durable sink
  // the artificer_l2_complete evidence (abortOwner/budget/elapsed/stopReason/
  // tokenUsage) dies with the process, repeating the EP002-R3
  // "nothing recoverable after a failure" investigation gap. Reuse the
  // host-runtime workspace-scoped emitter so completions land in
  // <workspaceDir>/.pd/telemetry/critical-events.jsonl.
  const artificerEmitter = new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir, (detail) => {
    console.error(`[run-rulehost] workspace telemetry persist failed: ${detail}`);
  });

  const artificerAdapter = new ArtificerL2Adapter({
    provider: artificerProfile.provider,
    model: artificerProfile.model,
    apiKeyEnv: artificerProfile.apiKeyEnv,
    baseUrl: artificerProfile.baseUrl,
    gateDeps: createSandboxGateDeps(),
    validator: new DefaultArtificerValidator(),
    // PRI-795: fall back to the profile's timeoutMs when --timeout-ms is not
    // given — parity with resolvePiAiAgentAdapter above. Previously the raw
    // CLI option (possibly undefined) was passed, silently dropping the L2
    // loop onto the adapter's 300s default regardless of the profile.
    totalBudgetMs: timeoutMs ?? artificerProfile.timeoutMs,
    // Forward profile maxTokens — parity with the consumer-cycle adapter;
    // omitting it truncates long artificer JSON at the provider's default cap.
    ...(artificerProfile.maxTokens !== undefined ? { maxTokens: artificerProfile.maxTokens } : {}),
    // PRI-795: forward profile reasoning so always-thinking models get a
    // bounded thinking level on the L2 loop too — parity with the
    // PiAiRuntimeAdapter wiring (it was previously L2-dropped).
    ...(artificerProfile.reasoning !== undefined ? { reasoning: artificerProfile.reasoning } : {}),
    eventEmitter: artificerEmitter,
  });

  return {
    agentAdapters: { dreamer: dreamer.adapter, philosopher: philosopher.adapter, scribe: scribe.adapter, evaluator: evaluator.adapter },
    agentRuntimeProfiles,
    capability: { enabled: true, artificerAdapter },
    capabilityStatus: `code_rule_capability: ON (artificer profile='${artificerBinding.profileId}', evaluator profile='${evaluatorBinding.profileId}')`,
    contextV2Enabled,
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

interface DryRunFormatInput {
  readonly opts: RunRuleHostOptions;
  readonly capabilityStatus: string;
  readonly workspaceDir: string;
  readonly readiness: RuleHostReadinessResult;
  /** PRI-780 review: the EFFECTIVE code-rule capability — conditions the ready "Next" line. */
  readonly capabilityEnabled: boolean;
}

function formatDryRunOutput(input: DryRunFormatInput): string {
  const { opts, capabilityStatus, workspaceDir, readiness, capabilityEnabled } = input;
  const lines: string[] = [];
  lines.push('RuleHost Pipeline (PRI-429) — DRY RUN');
  lines.push(`pain: ${opts.painId}`);
  lines.push(`workspace: ${workspaceDir}`);
  lines.push(`channel: ${opts.channel ?? 'code_tool_hook'}`);
  lines.push(`readiness: ${readiness.status.toUpperCase()}`);
  if (readiness.status !== 'ready') {
    lines.push(`  reason: ${readiness.reason}`);
    lines.push(`  nextAction: ${readiness.nextAction}`);
  }
  lines.push(capabilityStatus);
  lines.push('');
  lines.push('No tasks created, no LLM calls made, no artifacts written.');
  if (readiness.status === 'ready') {
    // PRI-780 review: derive the next action from the EFFECTIVE capability —
    // a kill-switched / BEP-missing workspace cannot run the code-rule
    // pipeline on --confirm, only text-principle-only internalization.
    lines.push(capabilityEnabled
      ? 'Next: pass --confirm to actually run the pipeline.'
      : 'Next: fix the code-rule capability issue above; --confirm runs text-principle-only internalization.');
  } else if (readiness.status === 'text_principle_only') {
    lines.push('Next: pass --confirm to run in text-principle-only mode, or fix the issues above to enable full pipeline.');
  } else {
    lines.push('Next: fix the readiness issues above before running the pipeline.');
  }
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

  // ── Readiness check (PRI-461) ──
  // Check all preconditions BEFORE constructing adapters. This produces a
  // structured ready/text_principle_only/refused status instead of an opaque
  // agent_runtime_resolution_failed error.
  const readiness = resolveRuleHostReadiness(workspaceDir);

  // If refused, emit structured error and exit (CLI gate rule 2 + rule 5).
  // Refused means the pipeline cannot run at all — do NOT attempt adapter
  // construction or pipeline execution.
  if (readiness.status === 'refused') {
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        status: 'refused',
        reason: readiness.reason,
        nextAction: readiness.nextAction,
        readiness,
      }) + '\n');
    } else {
      console.error(`RuleHost readiness: REFUSED`);
      console.error(`  reason: ${readiness.reason}`);
      console.error(`  nextAction: ${readiness.nextAction}`);
    }
    process.exitCode = 1;
    return;
  }

  // ── Resolve each executed agent from canonical config ──
  let resolvedRuntime: ResolvedRunRuleHostRuntime;
  try {
    resolvedRuntime = resolveRunRuleHostRuntime(workspaceDir, opts.timeoutMs, readiness);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason: 'agent_runtime_resolution_failed', message, nextAction: 'check internalAgents and runtimeProfiles in .pd/config.yaml; run pd config doctor', readiness }) + '\n');
    } else {
      console.error(`Error: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  let effectiveCapability = resolvedRuntime.capability;
  let behaviorExamplePack: BehaviorExamplePack | undefined;
  let behaviorExamplesReason: string | undefined;
  const behaviorExamplesPath = opts.behaviorExamples
    ? path.resolve(workspaceDir, opts.behaviorExamples)
    : undefined;

  if (!resolvedRuntime.contextV2Enabled && behaviorExamplesPath) {
    const reason = 'behavior_examples_not_allowed: rulecode_context_v2 is disabled (kill switch) and v2 is the only generation contract (PRI-780)';
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: 'failed', reason, nextAction: 're-enable rulecode_context_v2 or remove --behavior-examples' }) + '\n');
    } else {
      console.error(`Error: ${reason}. Re-enable rulecode_context_v2 or remove --behavior-examples.`);
    }
    process.exitCode = 1;
    return;
  }

  // PRI-780: the generation contract is v2-only. With the kill switch active
  // (explicit rulecode_context_v2 disable) code-rule generation is refused
  // with a structured reason — never a silent fallback to an action-only
  // (v1) rule. Text-principle internalization continues (capability OFF).
  if (!resolvedRuntime.contextV2Enabled) {
    effectiveCapability = {
      enabled: false,
      disabledReason: 'rulecode_context_v2_disabled: kill switch active — v2 is the only RuleCode generation contract (PRI-780); re-enable the flag to generate code rules',
    };
  } else {
    if (!behaviorExamplesPath) {
      behaviorExamplesReason = 'behavior_examples_missing';
    } else {
      const examplesResult = readOwnerBehaviorExamples(behaviorExamplesPath);
      if (!examplesResult.ok) {
        // P1 fix (CodeRabbit PR2 Comment 1): fail fast on parse failure instead
        // of silently degrading to text_principle_only (rc-9-no-silent-fallback).
        // examplesResult.reason already carries a stable prefix
        // (behavior_examples_unreadable: | behavior_examples_invalid:).
        const { reason } = examplesResult;
        if (opts.json) {
          process.stdout.write(JSON.stringify({
            status: 'failed',
            reason,
            nextAction: 'fix the --behavior-examples JSON payload and retry',
          }) + '\n');
        } else {
          console.error(`Error: ${reason}. Fix the --behavior-examples JSON payload and retry.`);
        }
        process.exitCode = 1;
        return;
      }
      if (opts.confirm) {
        // Lazy import: avoids loading `principles-disciple` at module init time.
        // `pd --version` (and the create-principles-disciple smoke test) loads
        // this file statically via index.ts. If we used a static import, the
        // module would fail with MODULE_NOT_FOUND in bundled environments where
        // `principles-disciple` is not resolvable from pd-cli's node_modules.
        // The import only executes when `--confirm` is actually used.
        const { BehaviorExamplePackAssembler, RuleHostEvidenceRegistry } = await import('principles-disciple/rulehost-evidence');
        try {
          const assembler = new BehaviorExamplePackAssembler({ workspaceDir, stateDir: path.join(workspaceDir, '.state') });
          behaviorExamplePack = assembler.assemble({
            sourcePainId: opts.painId,
            ownerDesiredOutcome: examplesResult.value.ownerDesiredOutcome,
            sourceNegativeToolCallId: examplesResult.value.sourceNegativeToolCallId,
            positiveToolCallIds: examplesResult.value.positiveToolCallIds,
            projectDir: workspaceDir,
          });
        } catch (error) {
          // P1 fix (CodeRabbit PR2 Comment 1): fail fast on assembly failure
          // instead of silently degrading to text_principle_only.
          const reason = `behavior_examples_unreliable: ${error instanceof Error ? error.message : String(error)}`;
          if (opts.json) {
            process.stdout.write(JSON.stringify({
              status: 'failed',
              reason,
              nextAction: 'verify pain lineage and tool call IDs reference existing trajectory rows; rerun pd pain record if needed',
            }) + '\n');
          } else {
            console.error(`Error: ${reason}. Verify pain lineage and tool call IDs reference existing trajectory rows; rerun pd pain record if needed.`);
          }
          process.exitCode = 1;
          return;
        } finally {
          RuleHostEvidenceRegistry.dispose(workspaceDir);
        }
      }
    }
    if (behaviorExamplesReason && effectiveCapability.enabled) {
      // Only override when code-rule generation would actually run — a more
      // fundamental blocker (text_principle_only readiness, disabled agent,
      // kill switch) keeps precedence and stays the reported reason.
      effectiveCapability = { enabled: false, disabledReason: `${behaviorExamplesReason}; nextAction: provide reliable Owner-labelled tool call IDs with --behavior-examples` };
    }
    // behaviorExamplesReason is intentionally KEPT even when a more fundamental
    // blocker takes precedence: the dry-run behaviorExamples field must still
    // report 'unreliable' (M6 — clearing it here masked the evidence problem).
  }

  // ── Dry-run mode: report what would happen, don't run the pipeline ──
  // Default is dry-run (CLI gate rule 4: mutating commands default to dry-run).
  const isDryRun = opts.dryRun || !opts.confirm;
  if (isDryRun) {
    // PRI-780 review M2: the status string derives from the EFFECTIVE
    // capability (kill switch / BEP refusal included), never from the
    // pre-flag resolvedRuntime snapshot — otherwise a kill-switched workspace
    // would display "ON" with a misleading "pass --confirm" nextAction.
    const effectiveCapabilityStatus = effectiveCapability.enabled
      ? resolvedRuntime.capabilityStatus
      : `code_rule_capability: OFF (${effectiveCapability.disabledReason ?? 'disabled'})`;
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        status: 'dry_run',
        painId: opts.painId,
        workspace: workspaceDir,
        channel,
        readiness,
        readinessStatus: readiness.status,
        capabilityStatus: effectiveCapabilityStatus,
        agentRuntimeProfiles: resolvedRuntime.agentRuntimeProfiles,
        codeRuleCapability: { enabled: effectiveCapability.enabled, disabledReason: effectiveCapability.disabledReason },
        // PRI-780: 'v2' is the only generation contract (observability field).
        contextMode: 'v2',
        behaviorExamples: behaviorExamplesPath
          ? { path: behaviorExamplesPath, status: behaviorExamplesReason ? 'unreliable' : 'provided' }
          : { status: resolvedRuntime.contextV2Enabled ? 'missing' : 'not_required' },
        nextAction: readiness.status === 'ready'
          ? (effectiveCapability.enabled
            ? 'pass --confirm to run the full pipeline'
            : 'fix the code-rule capability issues above; --confirm runs text-principle-only internalization')
          : readiness.status === 'text_principle_only'
            ? 'pass --confirm to run in text-principle-only mode (code-rule capability OFF), or fix the issues above to enable full pipeline'
            : 'fix the readiness issues above before running the pipeline',
      }) + '\n');
    } else {
      process.stdout.write(formatDryRunOutput({ opts, capabilityStatus: effectiveCapabilityStatus, workspaceDir, readiness, capabilityEnabled: effectiveCapability.enabled }) + '\n');
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
      codeRuleCapability: effectiveCapability,
      behaviorExamplePack,
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
    .option('--behavior-examples <json>', 'Owner-labelled negative/positive tool call IDs for RuleContext v2')
    .option('--dry-run', 'Validate inputs + config, report capability status, do NOT run the pipeline (default)')
    .option('--confirm', 'Actually run the pipeline (mutually exclusive with --dry-run)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRunRuleHost({ workspace: opts.workspace, painId: opts.painId, channel: opts.channel, maxRounds: opts.maxRounds, timeoutMs: opts.timeoutMs, behaviorExamples: opts.behaviorExamples, dryRun: opts.dryRun, confirm: opts.confirm, json: opts.json });
    });
}
