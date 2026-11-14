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
import type { ActivatedPrinciple, PdConfig } from '@principles/core/runtime';
import type {AdaptiveGapOptions} from './active-principle-prompt.js';
import {loadPdConfigForPlugin} from './pd-config.js';
import {
  ADAPTIVE_SELECTION_LIMITS,
  runAdaptiveSelection,
  type AdaptiveSelectionModel,
} from './adaptive-selection.js';
import {decideAdaptiveSkip} from './adaptive-skip-decision.js';

/** Independent switch. `features.host.codex.enabled` remains the whole-hook gate. */
export const ADAPTIVE_ACTIVATION_FLAG = 'host.codex.adaptive_activation';
export type AdaptiveActivationFlag = typeof ADAPTIVE_ACTIVATION_FLAG | 'host.workbuddy.adaptive_activation' | 'host.openclaw.adaptive_activation';

/**
 * PRI-1182 §2: time kept back from the host window for the principle assembly
 * and the hook's own output. Selection never spends the reserve.
 */
export const ADAPTIVE_OUTPUT_RESERVE_MS = 200;

export interface AdaptivePrioritySelection {
  readonly artifactId: string;
  readonly activationId: string;
  readonly additiveOnly: true;
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
}

export type AdaptivePriorityProvider = (
  event: HostEvent,
  candidates: readonly ActivatedPrinciple[],
  options: AdaptiveGapOptions,
) => Promise<AdaptivePrioritySelection | undefined>;

export interface AdaptiveActivationReadiness {
  readonly readiness: 'ready' | 'disabled' | 'needs_setup';
  readonly reason: string;
  readonly nextAction: string;
}

export type AdaptiveModelResolution =
  | {readonly ok: true; readonly model: AdaptiveSelectionModel}
  | {
      readonly ok: false;
      readonly readiness: 'disabled' | 'needs_setup';
      readonly reason: string;
      readonly nextAction: string;
    };

export function resolveAdaptiveSelectionModel(
  config: PdConfig,
  env: Record<string, string | undefined>,
  flag: AdaptiveActivationFlag = ADAPTIVE_ACTIVATION_FLAG,
): AdaptiveModelResolution {
  const feature = config.features[flag];
  if (feature?.enabled !== true) {
    return {
      ok: false,
      readiness: 'disabled',
      reason: `${flag} is disabled in .pd/config.yaml`,
      nextAction: `Enable it explicitly with ${flag}: {enabled: true}`,
    };
  }
  // PRI-1182: the Adaptive path has its OWN endpoint + model + credential
  // reference. It no longer borrows a pi-ai runtime profile, because the
  // Decisions protocol is a single scoring endpoint, not a chat completion.
  const section = config.adaptiveActivation;
  if (!section) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: 'adaptiveActivation is not configured in .pd/config.yaml',
      nextAction: 'Add adaptiveActivation: {endpoint, model, apiKeyEnv} to .pd/config.yaml',
    };
  }
  if (!section.endpoint || !section.model || !section.apiKeyEnv) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: 'adaptiveActivation is missing endpoint/model/apiKeyEnv',
      nextAction: 'Set endpoint (https URL), model and apiKeyEnv on adaptiveActivation',
    };
  }
  if (!Object.hasOwn(env, section.apiKeyEnv) || !env[section.apiKeyEnv]) {
    return {
      ok: false,
      readiness: 'needs_setup',
      reason: `Environment variable '${section.apiKeyEnv}' is not set or empty`,
      nextAction: `Set the environment variable '${section.apiKeyEnv}' with a valid API key`,
    };
  }
  return {
    ok: true,
    model: {
      endpoint: section.endpoint,
      model: section.model,
      apiKeyEnv: section.apiKeyEnv,
      ...(section.provider ? {provider: section.provider} : {}),
      ...(section.responseModels && section.responseModels.length > 0
        ? {allowedResponseModels: section.responseModels}
        : {}),
    },
  };
}

export interface AdaptiveSelectionDiagnosticLine {
  readonly status: string;
  readonly reason: string;
  readonly stage: string;
  readonly sends: number;
  readonly requestSentAt: number | null;
  readonly firstByteAt: number | null;
  readonly generationEndedAt: number | null;
  readonly validatedAt: number | null;
  readonly cancelledAt: number | null;
  readonly httpStatus: number | null;
  readonly finishReason: string;
  /** Observed response model; null when no body was parsed. */
  readonly modelObserved: string | null;
  /** Observed response provider; null when absent or no body was parsed. */
  readonly providerObserved: string | null;
  /**
   * The activation id this turn resolved to append, or null when nothing was
   * appended. This is the SELECTION target: the assembly must still confirm it
   * actually reached the injected list before it is reported as appended.
   */
  readonly targetActivationId: string | null;
  /** Bounded local adjudication evidence (ids only, never prompt text). */
  readonly decision: {
    readonly status: string;
    readonly ref: string | null;
    readonly reason: string;
    readonly scores: Readonly<Record<string, number>>;
  } | null;
  readonly failures: readonly string[];
}

export interface CreateAdaptivePriorityProviderOptions {
  readonly workspaceDir: string;
  readonly model: AdaptiveSelectionModel;
  readonly requestTimeoutMs?: number;
  /**
   * Absolute host deadline (Codex: the plugin hook window minus the Native
   * reserve). Selection, revalidation and packing all share it: a selection
   * that cannot finish inside the window is cancelled and never applied.
   */
  readonly outerDeadlineAt?: number;
  /**
   * PRI-1182 §2: reserved for assembly and output after the decision. The
   * effective deadline is the earlier of the host's remaining window (minus
   * this reserve) and the request's own short limit.
   */
  readonly outputReserveMs?: number;
  /**
   * PRI-1181/PRI-1182: below this remaining budget the turn is skipped before
   * the candidate read — no model request is sent at all. Defaults to the
   * request's minimum executable envelope
   * (`ADAPTIVE_SKIP_LIMITS.minExecutableBudgetMs`); 0 disables the gate for
   * scenarios that isolate transport cancellation.
   */
  readonly minExecutableBudgetMs?: number;
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
  const requestTimeoutMs = options.requestTimeoutMs ?? ADAPTIVE_SELECTION_LIMITS.requestTimeoutMs;
  const outputReserveMs = options.outputReserveMs ?? ADAPTIVE_OUTPUT_RESERVE_MS;

  return async (event, candidates, { excludedByBudget, replacementByActivationId }) => {
    if (event.kind !== 'before_prompt_build') return undefined;
    const {sessionId, turnId, promptContent, workspaceDir} = event.context;
    // The host budget starts before selection; the request budget starts at send.
    const nowMs = now();
    const hostDeadlineAt = options.outerDeadlineAt === undefined
      ? undefined
      : options.outerDeadlineAt - outputReserveMs;
    // PRI-1181: the deterministic gate runs before any model request.
    // Native has already been assembled, even when Adaptive skips.
    const skip = decideAdaptiveSkip({
      kind: event.kind,
      sessionId,
      turnId,
      prompt: promptContent ?? '',
      remainingBudgetMs: Math.max(0, Math.min(requestTimeoutMs, (hostDeadlineAt ?? Infinity) - nowMs)),
      ...(options.minExecutableBudgetMs !== undefined
        ? {minExecutableBudgetMs: options.minExecutableBudgetMs}
        : {}),
    });
    if (skip.skip || (candidates.length === 0 && excludedByBudget)) {
      options.onDiagnostic?.({
        status: 'skipped',
        reason: skip.skip ? skip.reason : 'no_appendable_gap',
        stage: 'gate',
        sends: 0,
        requestSentAt: null,
        firstByteAt: null,
        generationEndedAt: null,
        validatedAt: null,
        cancelledAt: null,
        httpStatus: null,
        finishReason: 'skipped',
        modelObserved: null,
        providerObserved: null,
        targetActivationId: null,
        decision: null,
        failures: [],
      });
      return undefined;
    }
    // The gate already proved identity and a non-blank prompt (rc-3); the
    // selector only needs the prompt body from here on.
    const prompt = promptContent ?? '';

    const signal = hostDeadlineAt === undefined ? undefined : AbortSignal.timeout(Math.max(1, hostDeadlineAt - now()));
    const outcome = await runAdaptiveSelection({
      workspaceDir: workspaceDir || options.workspaceDir,
      currentPrompt: prompt,
      candidates,
      replacementByActivationId,
      model: options.model,
      requestTimeoutMs,
      ...(hostDeadlineAt !== undefined ? {outerDeadlineAt: hostDeadlineAt, signal} : {}),
      ...(options.now ? {now: options.now} : {}),
      ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    });
    options.onDiagnostic?.({
      status: outcome.status,
      reason: outcome.reason,
      stage: outcome.diagnostics.stage,
      sends: outcome.sends,
      requestSentAt: outcome.diagnostics.requestSentAt,
      firstByteAt: outcome.diagnostics.firstByteAt,
      generationEndedAt: outcome.diagnostics.generationEndedAt,
      validatedAt: outcome.diagnostics.validatedAt,
      cancelledAt: outcome.diagnostics.cancelledAt,
      httpStatus: outcome.diagnostics.httpStatus,
      finishReason: outcome.diagnostics.finishReason,
      modelObserved: outcome.diagnostics.modelObserved,
      providerObserved: outcome.diagnostics.providerObserved,
      targetActivationId: outcome.status === 'selected' && outcome.target ? outcome.target.activationId : null,
      decision: outcome.diagnostics.decision,
      failures: [...outcome.diagnostics.failures],
    });
    if (outcome.status !== 'selected' || !outcome.target) return undefined;
    return {
      artifactId: outcome.target.artifactId,
      activationId: outcome.target.activationId,
      additiveOnly: true,
      ...(hostDeadlineAt !== undefined ? {deadlineAt: hostDeadlineAt, signal} : {}),
    };
  };
}

export type AdaptivePriorityProviderResolution =
  | (AdaptiveActivationReadiness & {
      readonly ok: true;
      readonly readiness: 'ready';
      readonly provider: AdaptivePriorityProvider;
    })
  | (AdaptiveActivationReadiness & {readonly ok: false});

export interface CreateAdaptiveProviderFromConfigOptions
  extends Omit<CreateAdaptivePriorityProviderOptions, 'workspaceDir' | 'model'> {
  readonly env?: Record<string, string | undefined>;
  readonly flag?: AdaptiveActivationFlag;
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
  const resolved = resolveAdaptiveSelectionModel(config, options.env ?? process.env, options.flag);
  if (!resolved.ok) {
    return {
      ok: false,
      readiness: resolved.readiness,
      reason: resolved.reason,
      nextAction: resolved.nextAction,
    };
  }
  const provider = createAdaptivePriorityProvider({
    workspaceDir,
    model: resolved.model,
    ...(options.requestTimeoutMs !== undefined ? {requestTimeoutMs: options.requestTimeoutMs} : {}),
    ...(options.outerDeadlineAt !== undefined ? {outerDeadlineAt: options.outerDeadlineAt} : {}),
    ...(options.outputReserveMs !== undefined ? {outputReserveMs: options.outputReserveMs} : {}),
    ...(options.minExecutableBudgetMs !== undefined ? {minExecutableBudgetMs: options.minExecutableBudgetMs} : {}),
    ...(options.now ? {now: options.now} : {}),
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    ...(options.onDiagnostic ? {onDiagnostic: options.onDiagnostic} : {}),
  });
  return {
    ok: true,
    readiness: 'ready',
    reason: `adaptive decision ready at '${resolved.model.endpoint}' (model '${resolved.model.model}')`,
    nextAction: 'none',
    provider,
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
