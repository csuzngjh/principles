/**
 * Shared Stage-2 signal classifier factory (SPEC v0.3 §3.4 / B4).
 *
 * ONE implementation of the pi-ai classifier call for every host:
 * OpenClaw's plugin factory, the Codex worker and the WorkBuddy worker all
 * consume this instead of re-implementing startRun/pollRun/fetchOutput.
 *
 * The classifier contract is core-owned: `buildLlmPrompt`,
 * `signal-classification-output-v2` and `resolveLlmClassificationPayload`
 * come from `@principles/core/runtime`. This module only owns acquisition:
 * reading the signalCollector runtime profile and calling the adapter.
 *
 * No second model runtime is introduced (ADR-0029: pi-ai is the only backend).
 */
import path from 'node:path';
import {
  PiAiRuntimeAdapter,
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  SIGNAL_CLASSIFIER_SYSTEM_PROMPT,
  buildLlmPrompt,
  resolveLlmClassificationPayload,
  safeStringifyPreview,
  type LlmClassificationResult,
  type Stage2ConversationContext,
} from '@principles/core/runtime';
import { loadPdConfigForPlugin } from './pd-config.js';

export interface SignalClassifierCallOptions {
  /**
   * Per-call timeout override. The worker passes the cycle's REMAINING
   * aggregate budget so the real adapter request (startRun/poll deadline)
   * uses that budget instead of relying on an outer Promise race.
   */
  readonly timeoutMs?: number;
  /**
   * PD-BEHAVIOR-FIDELITY-001 Gate 3: host-owned conversation facts for the
   * prompt. Callers that hold no session evidence (Codex/WorkBuddy workers,
   * batch confirmation) omit it; the prompt then says the facts are
   * unavailable instead of implying there was prior assistant behavior.
   */
  readonly context?: Stage2ConversationContext;
}

export type SignalLlmClassifier = (
  text: string,
  options?: SignalClassifierCallOptions,
) => Promise<LlmClassificationResult | null>;

export interface SignalClassifierProfile {
  readonly provider: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly timeoutMs: number;
  readonly maxTokens?: number;
  readonly baseUrl?: string;
}

export interface SignalClassifierLog {
  (event: string, detail: string): void;
}

export interface CreateSignalClassifierOptions {
  readonly log?: SignalClassifierLog;
  readonly timeoutMs?: number;
}

/**
 * The Stage-2 structured-output contract this classifier requests. It MUST stay
 * in sync with the registry key in
 * packages/principles-core/src/runtime/adapter/output-schema-registry.ts:
 * the adapter fails loud (`output_invalid`) on an unregistered ref, and the
 * catch below would silently degrade Stage 2 to "no classification".
 * PRI-1139: version-neutral canonical key; the pre-cutover `-v2` spelling
 * still resolves through the registry's PRI-1104 alias table.
 */
export const SIGNAL_CLASSIFICATION_SCHEMA_REF = 'signal-classification-output';

/** Build the classifier from an already-resolved profile (no config I/O). */
export function createSignalLlmClassifier(
  profile: SignalClassifierProfile,
  workspaceDir: string,
  options: CreateSignalClassifierOptions = {},
): SignalLlmClassifier {
  const timeoutMs = options.timeoutMs ?? profile.timeoutMs;
  const adapter = new PiAiRuntimeAdapter({
    provider: profile.provider,
    model: profile.model,
    apiKeyEnv: profile.apiKeyEnv,
    timeoutMs,
    maxTokens: profile.maxTokens,
    baseUrl: profile.baseUrl,
    workspace: workspaceDir,
    // Stage-2 emits a 5-field JSON. json_mode_first avoids depending on the
    // provider's tool-call support; one repair attempt bounds latency.
    outputPathStrategy: 'json_mode_first',
    maxRepairAttempts: 1,
  });

  return async (text: string, callOptions?: SignalClassifierCallOptions): Promise<LlmClassificationResult | null> => {
    const prompt = buildLlmPrompt(text, callOptions?.context);
    // v0.3.1 §2.2: the effective timeout is the worker's remaining budget,
    // and it is handed to the adapter itself (not only to an outer race).
    const effectiveTimeoutMs = callOptions?.timeoutMs ?? timeoutMs;
    try {
      const handle = await adapter.startRun({
        agentSpec: { agentId: 'signal-collector', schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION },
        inputPayload: { prompt },
        contextItems: [],
        timeoutMs: effectiveTimeoutMs,
        outputSchemaRef: SIGNAL_CLASSIFICATION_SCHEMA_REF,
        systemPrompt: SIGNAL_CLASSIFIER_SYSTEM_PROMPT,
      });
      let status = await adapter.pollRun(handle.runId);
      const deadline = performance.now() + effectiveTimeoutMs;
      while (status.status === 'running' && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        status = await adapter.pollRun(handle.runId);
      }
      if (status.status !== 'succeeded') {
        options.log?.('SIGNAL_LLM_TIMEOUT', JSON.stringify({ status: status.status }));
        return null;
      }
      const output = await adapter.fetchOutput(handle.runId);
      const resolved = resolveLlmClassificationPayload(output?.payload);
      if (resolved.path === 'structured' && resolved.value) return resolved.value;
      if ((resolved.path === 'legacy_string' || resolved.path === 'legacy_envelope') && resolved.value) {
        options.log?.('SIGNAL_LLM_LEGACY_STRING_PAYLOAD', `adapter payload path=${resolved.path}`);
        return resolved.value;
      }
      options.log?.('SIGNAL_LLM_PARSE_FAIL', `unusable classifier payload path=${resolved.path}: ${safeStringifyPreview(output?.payload)}`);
      return null;
    } catch (error) {
      options.log?.('SIGNAL_LLM_FAILED', String(error).slice(0, 200));
      return null;
    }
  };
}

export type SignalClassifierResolution =
  | { ok: true; classifier: SignalLlmClassifier; profile: SignalClassifierProfile }
  | { ok: false; reason: string; nextAction: string; readiness: 'disabled' | 'needs_setup' | 'config_malformed' };

/**
 * Resolve the `signalCollector` internal agent's pi-ai profile from
 * `.pd/config.yaml` and build the classifier. This is the ONE resolution path
 * for the Codex/WorkBuddy workers and the OpenClaw plugin factory (which adds
 * its own bounded warning on top).
 */
export function createSignalClassifierForWorkspace(
  workspaceDir: string,
  options: CreateSignalClassifierOptions & { readonly flagId?: string } = {},
): SignalClassifierResolution {
  const configResult = loadPdConfigForPlugin(workspaceDir);
  if (!configResult.ok) {
    return {
      ok: false,
      readiness: 'config_malformed',
      reason: `Config validation failed: ${configResult.errors.map((error) => error.reason).join('; ')}`,
      nextAction: configResult.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry',
    };
  }
  const {config} = configResult.effective;
  const flagId = options.flagId ?? 'signal_collector';
  const agentName = 'signalCollector' as const;
  const feature = config.features[flagId];
  if (!feature?.enabled) {
    return {
      ok: false,
      readiness: 'disabled',
      reason: `${flagId} is disabled in .pd/config.yaml`,
      nextAction: `Enable it in the existing "features:" block as ${flagId}: {enabled: true}`,
    };
  }
  const agent = config.internalAgents.agents[agentName];
  if (!agent?.enabled) {
    return {
      ok: false,
      readiness: 'disabled',
      reason: `internalAgents.agents.${agentName}.enabled is false`,
      nextAction: `Enable internalAgents > agents > ${agentName} > enabled: true`,
    };
  }
  const runtimeProfileId = agent.runtimeProfile ?? config.internalAgents.defaultRuntime;
  const profile = config.runtimeProfiles[runtimeProfileId];
  if (!profile) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: `Runtime profile '${runtimeProfileId}' not found`,
      nextAction: `Add runtime profile '${runtimeProfileId}' to runtimeProfiles`,
    };
  }
  if (profile.type !== 'pi-ai') {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: `Runtime profile '${runtimeProfileId}' is '${profile.type}', not pi-ai`,
      nextAction: 'ADR-0029 requires a pi-ai runtime profile for signal classification',
    };
  }
  if (!profile.apiKeyEnv) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: `pi-ai profile '${runtimeProfileId}' missing apiKeyEnv`,
      nextAction: `Add apiKeyEnv to runtime profile '${runtimeProfileId}'`,
    };
  }
  if (!profile.provider || !profile.model) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: `pi-ai profile '${runtimeProfileId}' missing provider/model`,
      nextAction: `Set provider and model on runtime profile '${runtimeProfileId}'`,
    };
  }
  if (!Object.hasOwn(process.env, profile.apiKeyEnv) || !process.env[profile.apiKeyEnv]) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: `Environment variable '${profile.apiKeyEnv}' is not set or empty`,
      nextAction: `Set the environment variable '${profile.apiKeyEnv}' with a valid API key`,
    };
  }
  const resolved: SignalClassifierProfile = {
    provider: profile.provider,
    model: profile.model,
    apiKeyEnv: profile.apiKeyEnv,
    timeoutMs: options.timeoutMs ?? profile.timeoutMs ?? 60_000,
    ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {}),
    ...(profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {}),
  };
  return {
    ok: true,
    profile: resolved,
    classifier: createSignalLlmClassifier(resolved, path.resolve(workspaceDir), options),
  };
}
