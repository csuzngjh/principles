/**
 * Adaptive Activation — Codex host provider (default OFF).
 *
 * The provider is a thin, optional hook boundary:
 *   UserPromptSubmit → decoded HostEvent → this provider → shared assembly.
 *
 * It binds ONLY the host-supplied current-turn identity (`session_id`,
 * `turn_id`) and prompt body. No markers, no manual principle ids, no scene
 * mapping. Any missing identity/config/model keeps the Native path unchanged.
 */
import type { HostEvent } from '@principles/core/host';
import type { PdConfig } from '@principles/core/runtime';
import {loadPdConfigForPlugin} from './pd-config.js';
import {
  ADAPTIVE_SELECTION_LIMITS,
  runAdaptiveSelection,
  type AdaptiveSelectionModel,
} from './adaptive-selection.js';

/** Independent switch. `features.host.codex.enabled` remains the whole-hook gate. */
export const ADAPTIVE_ACTIVATION_FLAG = 'host.codex.adaptive_activation';

export interface AdaptivePrioritySelection {
  readonly artifactId: string;
  readonly activationId: string;
  readonly additiveOnly: true;
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
}

export type AdaptivePriorityProvider = (
  event: HostEvent,
) => Promise<AdaptivePrioritySelection | undefined>;

export interface AdaptiveActivationReadiness {
  readonly readiness: 'ready' | 'disabled' | 'needs_setup';
  readonly reason: string;
  readonly nextAction: string;
}

export type AdaptiveModelResolution =
  | {readonly ok: true; readonly model: AdaptiveSelectionModel; readonly profileId: string}
  | {readonly ok: false; readonly reason: string; readonly nextAction: string};

export function resolveAdaptiveSelectionModel(
  config: PdConfig,
  env: Record<string, string | undefined>,
): AdaptiveModelResolution {
  const feature = config.features[ADAPTIVE_ACTIVATION_FLAG];
  if (feature?.enabled !== true) {
    return {
      ok: false,
      reason: `${ADAPTIVE_ACTIVATION_FLAG} is disabled in .pd/config.yaml`,
      nextAction: `Enable it explicitly with ${ADAPTIVE_ACTIVATION_FLAG}: {enabled: true}`,
    };
  }
  const profileId = config.internalAgents.defaultRuntime;
  const profile = config.runtimeProfiles[profileId];
  if (!profile) {
    return {
      ok: false,
      reason: `Runtime profile '${profileId}' not found`,
      nextAction: `Add runtime profile '${profileId}' to runtimeProfiles`,
    };
  }
  if (profile.type !== 'pi-ai') {
    return {
      ok: false,
      reason: `Runtime profile '${profileId}' is '${profile.type}', not pi-ai`,
      nextAction: 'ADR-0029 requires a pi-ai runtime profile for adaptive selection',
    };
  }
  if (!profile.provider || !profile.model || !profile.apiKeyEnv) {
    return {
      ok: false,
      reason: `pi-ai profile '${profileId}' missing provider/model/apiKeyEnv`,
      nextAction: `Set provider, model and apiKeyEnv on runtime profile '${profileId}'`,
    };
  }
  if (!Object.hasOwn(env, profile.apiKeyEnv) || !env[profile.apiKeyEnv]) {
    return {
      ok: false,
      reason: `Environment variable '${profile.apiKeyEnv}' is not set or empty`,
      nextAction: `Set the environment variable '${profile.apiKeyEnv}' with a valid API key`,
    };
  }
  return {
    ok: true,
    profileId,
    model: {
      provider: profile.provider,
      model: profile.model,
      apiKeyEnv: profile.apiKeyEnv,
      ...(profile.baseUrl ? {baseUrl: profile.baseUrl} : {}),
    },
  };
}

export interface AdaptiveSelectionDiagnosticLine {
  readonly status: string;
  readonly reason: string;
  readonly stage: string;
  readonly sends: number;
  readonly firstByteAt: number | null;
  readonly generationEndedAt: number | null;
  readonly cancelledAt: number | null;
  readonly httpStatus: number | null;
  readonly finishReason: string;
  readonly failures: readonly string[];
}

export interface CreateAdaptivePriorityProviderOptions {
  readonly workspaceDir: string;
  readonly model: AdaptiveSelectionModel;
  readonly firstByteTimeoutMs?: number;
  readonly generationTimeoutMs?: number;
  /**
   * Absolute host deadline (Codex: the plugin hook window minus the Native
   * reserve). Selection, revalidation and packing all share it: a selection
   * that cannot finish inside the window is cancelled and never applied.
   */
  readonly outerDeadlineAt?: number;
  readonly maxTokens?: number;
  readonly now?: () => number;
  /** Test seam: production uses the global transport. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Observability seam (rc-9): one bounded line per turn, no prompt text,
   * no raw response, no credentials.
   */
  readonly onDiagnostic?: (line: AdaptiveSelectionDiagnosticLine) => void;
}

export function createAdaptivePriorityProvider(
  options: CreateAdaptivePriorityProviderOptions,
): AdaptivePriorityProvider {
  const now = options.now ?? Date.now;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? ADAPTIVE_SELECTION_LIMITS.firstByteTimeoutMs;
  const generationTimeoutMs = options.generationTimeoutMs ?? ADAPTIVE_SELECTION_LIMITS.generationTimeoutMs;

  return async (event) => {
    if (event.kind !== 'before_prompt_build') return undefined;
    const {sessionId, turnId, promptContent, workspaceDir} = event.context;
    if (!sessionId || !turnId || !promptContent?.trim()) return undefined;

    const admissionDeadlineAt = options.outerDeadlineAt === undefined
      ? now() + firstByteTimeoutMs
      : Math.min(now() + firstByteTimeoutMs, options.outerDeadlineAt);
    const remainingBudgetMs = options.outerDeadlineAt === undefined
      ? firstByteTimeoutMs
      : Math.max(1, options.outerDeadlineAt - now());
    const effectiveGenerationTimeoutMs = options.outerDeadlineAt === undefined
      ? generationTimeoutMs
      : Math.min(generationTimeoutMs, remainingBudgetMs);
    // Reuse the selector's AbortSignal seam instead of a second timer: it is
    // combined with the first-byte and request signals inside the transport.
    const signal = options.outerDeadlineAt === undefined ? undefined : AbortSignal.timeout(remainingBudgetMs);
    const outcome = await runAdaptiveSelection({
      workspaceDir: workspaceDir || options.workspaceDir,
      currentPrompt: promptContent,
      admissionDeadlineAt,
      model: options.model,
      generationTimeoutMs: effectiveGenerationTimeoutMs,
      ...(options.outerDeadlineAt !== undefined ? {outerDeadlineAt: options.outerDeadlineAt} : {}),
      ...(signal ? {signal} : {}),
      ...(options.maxTokens !== undefined ? {maxTokens: options.maxTokens} : {}),
      ...(options.now ? {now: options.now} : {}),
      ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    });
    options.onDiagnostic?.({
      status: outcome.status,
      reason: outcome.reason,
      stage: outcome.diagnostics.stage,
      sends: outcome.sends,
      firstByteAt: outcome.diagnostics.firstByteAt,
      generationEndedAt: outcome.diagnostics.generationEndedAt,
      cancelledAt: outcome.diagnostics.cancelledAt,
      httpStatus: outcome.diagnostics.httpStatus,
      finishReason: outcome.diagnostics.finishReason,
      failures: [...outcome.diagnostics.failures],
    });
    if (outcome.status !== 'selected' || !outcome.target) return undefined;
    return {
      artifactId: outcome.target.artifactId,
      activationId: outcome.target.activationId,
      additiveOnly: true,
      deadlineAt: options.outerDeadlineAt ?? admissionDeadlineAt + generationTimeoutMs,
      ...(signal ? {signal} : {}),
    };
  };
}

export type AdaptivePriorityProviderResolution =
  | (AdaptiveActivationReadiness & {
      readonly ok: true;
      readonly readiness: 'ready';
      readonly provider: AdaptivePriorityProvider;
      readonly profileId: string;
    })
  | (AdaptiveActivationReadiness & {readonly ok: false});

export interface CreateAdaptiveProviderFromConfigOptions
  extends Omit<CreateAdaptivePriorityProviderOptions, 'workspaceDir' | 'model'> {
  readonly env?: Record<string, string | undefined>;
}

/**
 * Config-first factory for hosts (Codex pd-hook) that already loaded the
 * workspace config for the current turn.
 */
export function createAdaptivePriorityProviderForConfig(
  config: PdConfig,
  workspaceDir: string,
  options: CreateAdaptiveProviderFromConfigOptions = {},
): AdaptivePriorityProviderResolution {
  const resolved = resolveAdaptiveSelectionModel(config, options.env ?? process.env);
  if (!resolved.ok) {
    return {
      ok: false,
      readiness: 'disabled',
      reason: resolved.reason,
      nextAction: resolved.nextAction,
    };
  }
  const provider = createAdaptivePriorityProvider({
    workspaceDir,
    model: resolved.model,
    ...(options.firstByteTimeoutMs !== undefined ? {firstByteTimeoutMs: options.firstByteTimeoutMs} : {}),
    ...(options.generationTimeoutMs !== undefined ? {generationTimeoutMs: options.generationTimeoutMs} : {}),
    ...(options.outerDeadlineAt !== undefined ? {outerDeadlineAt: options.outerDeadlineAt} : {}),
    ...(options.maxTokens !== undefined ? {maxTokens: options.maxTokens} : {}),
    ...(options.now ? {now: options.now} : {}),
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    ...(options.onDiagnostic ? {onDiagnostic: options.onDiagnostic} : {}),
  });
  return {
    ok: true,
    readiness: 'ready',
    reason: `adaptive selection ready via runtime profile '${resolved.profileId}'`,
    nextAction: 'none',
    provider,
    profileId: resolved.profileId,
  };
}

/**
 * Workspace-facing variant: mirrors the existing signal-classifier readiness
 * contract (flag → profile → api key) so a misconfigured workspace degrades to
 * Native with one observable reason instead of a silent model attempt.
 */
export function createAdaptivePriorityProviderForWorkspace(
  workspaceDir: string,
  options: CreateAdaptiveProviderFromConfigOptions = {},
): AdaptivePriorityProviderResolution {
  const configResult = loadPdConfigForPlugin(workspaceDir);
  if (!configResult.ok) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: configResult.errors[0]?.reason ?? 'invalid .pd/config.yaml',
      nextAction: configResult.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry',
    };
  }
  return createAdaptivePriorityProviderForConfig(configResult.effective.config, workspaceDir, options);
}
