#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { appendEventLogLine, redactTelemetryString, isRuleHostEvaluatedEventData, type RuleHostEvaluatedEventData } from '@principles/core/runtime';
import type { HostEventEmitter, HostEventKind } from '@principles/core/host';
import { ADAPTIVE_SELECTION_LIMITS, createAdaptivePriorityProviderForConfig, createCodexRuleContextProvider, createProductionHostRuntime, loadPdConfigForPlugin, renderAcceptedAdaptiveAppend, resolveHostToolSemanticsForHook, resolveNearestPdWorkspace, type AdaptivePriorityProvider, type AdaptiveSelectionDiagnosticLine } from '@principles/host-runtime';
import { classifyBashRisk } from '@principles/core/runtime/internalization/bash-risk';
import { CODEX_TOOL_SEMANTIC_MAPPINGS, CODEX_TOOL_SEMANTICS } from './tool-semantics.js';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime';
import { CodexHooksHostAdapter } from './host-adapter.js';
import { CodexDecoderError, CodexEncoderError } from './codec/index.js';
import { ingestCodexConversation } from './ingestion/ingestion.js';
import { runGovernanceAdmission } from './ingestion/admission.js';
import { parseOwnerStatementPrefix, recordExplicitOwnerStatement } from './ingestion/explicit-owner-statement.js';
import { writeCurrentTurnContext, clearCurrentTurnContext } from './ingestion/turn-context.js';
import { recordCodexPromptDeliveryEvidence, recordCodexDenyEvidence } from './codex-evidence-recorder.js';
import {
  ADAPTIVE_APPEND_SCHEMA_VERSION,
  appendAdaptiveAppendFact,
  appendToolObservation,
  claimAdaptiveAppendResult,
  claimAdaptiveReportMarker,
  clearAdaptiveAppendTurn,
  clearStaleAdaptiveAppendState,
  currentHookIdentity,
  discardAdaptiveAppendJob,
  evaluateAppendOrdering,
  hasAdaptiveAppendState,
  markAdaptiveTurnEnded,
  readToolObservations,
  releaseAdaptiveAppendClaim,
  spawnAdaptiveBackgroundSelection,
  writeAdaptiveAppendJob,
  type AdaptiveAppendResult,
  type AdaptiveAppendTargetRef,
  type ToolObservation,
} from './ingestion/adaptive-append-state.js';

type EnvMap = Record<string, string | undefined>;
export interface PdHookResult { stdout: unknown; exitCode: number; stderr: string[] }

/** PD v2 Phase 1: evidence context the emitter needs (subprocess-local). */
export interface CodexEvidenceContext {
  workspaceDir: string;
  evidenceEnabled: boolean;
  warn: (diagnosticLine: string) => void;
}

/**
 * Adaptive Activation turn fact, resolved BEFORE the assembly runs and read by
 * the emitter afterwards. `targetActivationId` is only a selection target —
 * the emitter reports it as appended only when it really reached the injected
 * list of the same event.
 */
interface AdaptiveTurnFact {
  status: string;
  reason: string;
  sends: number;
  targetActivationId: string | null;
}

const MAX_DIAGNOSTIC = 500;

function diagnostic(reason: string, nextAction: string): string {
  const boundedReason = reason.replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC);
  const boundedNextAction = nextAction.replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC);
  return `[PD] status=degraded reason=${boundedReason} nextAction=${boundedNextAction}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, MAX_DIAGNOSTIC) : 'unknown_error';
}

/**
 * PRI-1170: one bounded line per Adaptive turn. Records the facts needed to
 * tell first-byte expiry, generation expiry, transport failure and ref/digest
 * rejection apart — never the prompt, the raw response, or credentials.
 */
function adaptiveSelectionDiagnostic(line: AdaptiveSelectionDiagnosticLine): string {
  // PRI-1181: a deterministic pre-selection skip is normal behaviour (zero
  // reads, zero sends) — it must not be reported as a degraded selection.
  const status = line.status === 'selected'
    ? 'adaptive'
    : line.status === 'skipped'
      ? 'skipped'
      : 'degraded';
  const failures = line.failures.length > 0 ? line.failures.join('|') : 'none';
  // rc-8: bounded score projection — ids are `c1..cN` / `insufficient_context`,
  // never prompt text, and at most 16 entries reach the line.
  const scores = line.decision === null
    ? 'none'
    : Object.entries(line.decision.scores).slice(0, 16).map(([id, value]) => `${id}=${value}`).join(',');
  const decision = line.decision === null
    ? 'unknown'
    : `${line.decision.status}:${line.decision.reason}:${line.decision.ref ?? 'none'}`;
  return `[PD] status=${status} reason=adaptive_selection_${line.status}:${line.reason} stage=${line.stage} sends=${line.sends} requestSentAt=${line.requestSentAt ?? 'unknown'} firstByteAt=${line.firstByteAt ?? 'unknown'} generationEndedAt=${line.generationEndedAt ?? 'unknown'} validatedAt=${line.validatedAt ?? 'unknown'} cancelledAt=${line.cancelledAt ?? 'unknown'} httpStatus=${line.httpStatus ?? 'unknown'} finishReason=${line.finishReason} modelObserved=${line.modelObserved ?? 'unknown'} providerObserved=${line.providerObserved ?? 'absent'} decision=${decision} scores=${scores} failures=${failures}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC * 2);
}

function redactStringFields(data: object): Record<string, unknown> {
  // rc-8: telemetry is redacted string-field by string field (same policy as
  // the OpenClaw EventLog redactEventData) — shared by every emitter here.
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    redacted[key] = typeof value === 'string' ? redactTelemetryString(value) : value;
  }
  return redacted;
}

/**
 * PRI-750: event emitter for the Codex subprocess model. Writes the same
 * `events_<date>.jsonl` line shape as the OpenClaw EventLog via the core
 * writer, so the Codex host path stays independent of the OpenClaw plugin
 * (codex-adapter must not depend on principles-disciple — bundle guard).
 */
function codexEventEmitter(
  stateDir: string,
  evidence?: CodexEvidenceContext,
  readAdaptiveFact?: () => AdaptiveTurnFact | null,
): HostEventEmitter {
  return {
    recordRuntimeActivationsInjected(data) {
      // Adaptive Activation fact for this turn. Appended ONLY on the final
      // assembly basis: a selection whose id did not reach `activationIds`
      // (dropped by budget, replaced, failed packing) is not an append.
      const fact = readAdaptiveFact?.() ?? null;
      const adaptive = fact === null
        ? undefined
        : {
            resultCode: `${fact.status}:${fact.reason}`.slice(0, 240),
            scored: fact.sends > 0,
            ...(fact.targetActivationId !== null && data.activationIds.includes(fact.targetActivationId)
              ? {appendedActivationId: fact.targetActivationId}
              : {}),
          };
      appendEventLogLine(stateDir, {
        ts: new Date().toISOString(),
        type: 'runtime_v2_prompt_activations_injected',
        category: 'injected',
        sessionId: data.sessionId,
        data: adaptive === undefined ? data : {...data, adaptive},
      });
      // PD v2 Phase 1: the durable source line is appended — now record the
      // normalized agent-context delivery attempts (submitted, not delivered).
      // Degrades to a bounded diagnostic; never affects the hook result.
      if (evidence) {
        try {
          const injected = data.principleIds
            .map((principleId, index) => ({
              principleId,
              activationId: data.activationIds[index] ?? '',
              artifactId: data.artifactIds[index],
            }))
            .filter((entry) => entry.activationId.length > 0);
          recordCodexPromptDeliveryEvidence({
            workspaceDir: evidence.workspaceDir,
            sessionId: data.sessionId,
            ...(data.runId ? { turnId: data.runId } : {}),
            injected,
            evidenceEnabled: evidence.evidenceEnabled,
            warn: evidence.warn,
          });
        } catch (error: unknown) {
          evidence.warn(diagnostic(`codex_evidence_delivery_failed:${errorMessage(error)}`, 'The raw injected event is durable; replay is safe. The hook result is unaffected.'));
        }
      }
    },
    recordToolCall(sessionId, data) {
      appendEventLogLine(stateDir, {
        ts: new Date().toISOString(),
        type: 'tool_call',
        category: data.error || (data.exitCode !== undefined && data.exitCode !== 0) ? 'failure' : 'success',
        sessionId,
        data: redactStringFields(data),
      });
    },
  };
}

interface BackgroundTurnKey {
  readonly workspaceDir: string;
  readonly stateDir: string;
  readonly sessionId: string;
  readonly turnId: string;
}

interface BackgroundFact {
  readonly resultCode: string;
  readonly scored: boolean;
  readonly budget: number;
  readonly injectedCharCount: number;
  readonly appended?: AdaptiveAppendTargetRef;
}

/** One bounded Adaptive fact line; evidence is best-effort and never blocks the hook. */
function emitBackgroundFact(key: BackgroundTurnKey, fact: BackgroundFact): void {
  try {
    appendAdaptiveAppendFact({
      stateDir: key.stateDir,
      sessionId: key.sessionId,
      turnId: key.turnId,
      workspaceDir: key.workspaceDir,
      resultCode: fact.resultCode,
      scored: fact.scored,
      budget: fact.budget,
      injectedCharCount: fact.injectedCharCount,
      ...(fact.appended ? {appended: fact.appended} : {}),
    });
  } catch {
    // A failed evidence write must not change the host decision.
  }
}

interface BackgroundDrop {
  readonly reason: string;
  readonly scored: boolean;
  readonly budget: number;
}

/** Emit at most ONE terminal drop fact for this turn. */
function reportBackgroundDrop(key: BackgroundTurnKey, drop: BackgroundDrop): void {
  if (!claimAdaptiveReportMarker({...key, reason: drop.reason})) return;
  emitBackgroundFact(key, {
    resultCode: `skipped:background_${drop.reason}`,
    scored: drop.scored,
    budget: drop.budget,
    injectedCharCount: 0,
  });
}

/**
 * Turn end: claim any ready result, record one honest terminal fact, mark the
 * turn ended (a late selector must discard its decision) and clear the state.
 */
function finalizeBackgroundTurn(key: BackgroundTurnKey): void {
  if (!hasAdaptiveAppendState(key)) return;
  const claimed = claimAdaptiveAppendResult({...key, now: Date.now()});
  if (claimed.status === 'ready') {
    releaseAdaptiveAppendClaim(claimed.claimPath);
    reportBackgroundDrop(key, {reason: 'turn_ended', scored: true, budget: claimed.result.budgetChars});
  } else if (claimed.status === 'expired') {
    reportBackgroundDrop(key, {reason: 'expired', scored: true, budget: 0});
  } else {
    reportBackgroundDrop(key, {reason: 'turn_ended', scored: false, budget: 0});
  }
  markAdaptiveTurnEnded(key);
  clearAdaptiveAppendTurn(key);
}

/**
 * "Qualified read-only" is the existing semantic declaration plus the existing
 * shell-risk classifier: a `write` kind, an unresolved kind, or an execute
 * command that cannot be proven `safe` never qualifies.
 */
function resolveAppendToolFacts(kind: string, toolInput: unknown): {readOnly: boolean} {
  if (kind === 'execute') return {readOnly: classifyBashRisk(true, toolInput) === 'safe'};
  return {readOnly: kind === 'read' || kind === 'search'};
}

type BackgroundAppendConsumption =
  | {readonly ok: true; readonly directive: string; readonly target: AdaptiveAppendTargetRef}
  | {readonly ok: false; readonly reason: string};

/**
 * Consume-time proof. The decision may be seconds old, so the target's
 * authorization/body is re-read through the shared revalidator, the installed
 * hook identity must be unchanged, and the directive must still fit the
 * Native budget reported for THIS turn.
 */
async function consumeBackgroundAppend(input: {
  readonly workspaceDir: string;
  readonly result: AdaptiveAppendResult;
}): Promise<BackgroundAppendConsumption> {
  const currentIdentity = currentHookIdentity();
  const storedIdentity = input.result.hookIdentity;
  if (!currentIdentity || !storedIdentity) return {ok: false, reason: 'version_unverified'};
  if (currentIdentity.entryPath !== storedIdentity.entryPath || currentIdentity.mtimeMs !== storedIdentity.mtimeMs) {
    return {ok: false, reason: 'version_changed'};
  }
  if (input.result.nativeActivationIds.includes(input.result.target.activationId)) {
    return {ok: false, reason: 'already_native'};
  }
  const rendered = await renderAcceptedAdaptiveAppend({
    workspaceDir: input.workspaceDir,
    target: input.result.target,
    signal: AbortSignal.timeout(1500),
  });
  if (!rendered.ok) return {ok: false, reason: rendered.reason};
  if (input.result.nativeChars + rendered.directive.length > input.result.budgetChars) {
    return {ok: false, reason: 'budget_exhausted'};
  }
  return {
    ok: true,
    directive: rendered.directive,
    target: {
      principleId: rendered.principle.principleId,
      activationId: rendered.principle.activationId,
      artifactId: rendered.principle.artifactId,
    },
  };
}

/**
 * PRI-813: admissible evaluation entry = the CANONICAL core schema guard
 * (rc-1/rc-2, P4: no hand-rolled field copy that could drift from the
 * contract) plus one caller policy: a shadow observation without a non-blank
 * activationId is dead evidence — the shadow summary keys on the exact id —
 * so it is rejected here (CodeRabbit CR-6).
 */
function isAdmissibleRuleHostEvaluationEntry(value: unknown): value is RuleHostEvaluatedEventData {
  return isRuleHostEvaluatedEventData(value)
    && (value.activationMode !== 'shadow' || (typeof value.activationId === 'string' && value.activationId.trim().length > 0));
}

/**
 * PRI-813: persist the shared gate's per-activation evaluation facts
 * (metadata.evaluations — shadow observations plus the live aggregate) as
 * canonical `rulehost_evaluated` events through the same core JSONL writer
 * and the same telemetry-redaction policy the Codex emitter already uses.
 * This is the Codex side of the shadow-evidence reconnection: exact
 * activationId per event, `activationMode: 'shadow'` rows feed the existing
 * rulecode-shadow-summary and promotion evidence unchanged.
 */
function recordRuleHostEvaluations(stateDir: string, sessionId: string | undefined, evaluations: unknown): string[] {
  if (!Array.isArray(evaluations)) return [];
  // One bounded diagnostic per failure CLASS — an early entry-invalid must
  // not swallow a later persist-failure (review S4).
  const diagnostics: string[] = [];
  let sawInvalidEntry = false;
  let sawPersistFailure = false;
  for (const entry of evaluations) {
    if (!isAdmissibleRuleHostEvaluationEntry(entry)) {
      // rc-9: a skipped evidence row must be observable, never silent.
      if (!sawInvalidEntry) {
        sawInvalidEntry = true;
        diagnostics.push(diagnostic('rulehost_evaluation_entry_invalid', 'Inspect host-runtime gate metadata contract; the evaluation event was not persisted.'));
      }
      continue;
    }
    // CodeRabbit CR-1: evidence persistence is telemetry — an fs failure here
    // must never propagate into processHookInvocation's fail-open catch,
    // which would drop an already-computed deny from stdout and let the tool
    // call proceed. Degrade observably instead (rc-9).
    try {
      appendEventLogLine(stateDir, {
        ts: new Date().toISOString(),
        type: 'rulehost_evaluated',
        category: 'evaluated',
        sessionId,
        data: redactStringFields(entry),
      });
    } catch (error: unknown) {
      if (!sawPersistFailure) {
        sawPersistFailure = true;
        diagnostics.push(diagnostic(`rulehost_evaluation_persist_failed:${errorMessage(error)}`, 'Inspect workspace .state/logs writability; the evaluation event was not persisted, the tool decision is unaffected.'));
      }
    }
  }
  return diagnostics;
}

// Bounded governance-observation ingestion (Codex Governance Closure Slice
// A) followed by the Slice B signal-admission pass (SPEC §12/§13): detection
// → canonical pain → evidence promotion → one pending Diagnostician task.
// Runs only when BOTH host.codex and codex_conversation_ingestion are
// enabled — the flag gate below happens BEFORE any transcript path
// validation or filesystem I/O, so flag-off means the transcript boundary
// receives zero calls (SPEC §10 hard privacy invariant). Admission covers
// Owner corrections only: tool-call facts stay technical trajectory and never
// become a behavioral-deviation Pain by themselves (Phase A).
async function runConversationIngestion(args: { rawPayload: unknown; kind: HostEventKind; workspaceDir: string; env: EnvMap; suppressCorrectionCandidate?: boolean }): Promise<string[]> {
  const { rawPayload, kind, workspaceDir, env } = args;
  if (kind !== 'turn_complete' && kind !== 'before_prompt_build' && kind !== 'after_tool_call') return [];
  const diagnostics: string[] = [];
  try {
    const outcome = ingestCodexConversation(rawPayload, kind, { workspaceDir, env });
    if (outcome.status === 'degraded') {
      diagnostics.push(diagnostic(outcome.reason, outcome.nextAction));
    } else {
      for (const warning of outcome.warnings.slice(0, 2)) {
        diagnostics.push(diagnostic(warning, 'Inspect PD Workspace governance-observation state; ingestion continued.'));
      }
      // Slice B admission: hook awaits only admission + durable enqueue —
      // never an LLM (SPEC §12/§13). Ordinary conversation returns no
      // candidates/no admissions and stays completely silent.
      // CR-07: when the explicit Owner-statement entry already handled this
      // turn's prompt, its generic correction candidate is suppressed so the
      // observation passes through exactly one pain writer.
      const candidates = args.suppressCorrectionCandidate === true
        ? outcome.admissionCandidates.filter((candidate) => candidate.kind !== 'user_correction')
        : outcome.admissionCandidates;
      const admission = await runGovernanceAdmission({
        workspaceDir,
        candidates,
      });
      for (const degradation of admission.degradations.slice(0, 2)) {
        diagnostics.push(diagnostic(degradation.reason, degradation.nextAction));
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic(`codex_ingestion_unexpected:${errorMessage(error)}`, 'Retry the next Codex turn; if it repeats, inspect PD stderr and the Workspace trajectory database.'));
  }
  return diagnostics;
}

/**
 * The host hook window is declared by the plugin manifest
 * (`plugins/principles-disciple/hooks/hooks.json`, `UserPromptSubmit.timeout`,
 * in seconds). Codex owns that timer and terminates the hook process when it
 * fires; PD gets no in-band notification, so Adaptive must end BEFORE the
 * window and leave the remainder to emit the Native body.
 * `pd-hook-adaptive.test.ts` guards this constant against the manifest.
 */
export const CODEX_HOOK_TIMEOUT_MS = 5_000;
/** Reserved for Native packing, encoding and stdout after Adaptive is cut off. */
export const CODEX_NATIVE_RESERVE_MS = 800;
export const CODEX_ADAPTIVE_BUDGET_MS = CODEX_HOOK_TIMEOUT_MS - CODEX_NATIVE_RESERVE_MS;
/** Maximum from sending a scoring request to validating its full response. */
export const CODEX_ADAPTIVE_DECISION_MS = ADAPTIVE_SELECTION_LIMITS.requestTimeoutMs;

export interface PdHookDeps {
  /** Test seam: replace the outbound transport without bypassing the hook entry. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  /** Test seam: effective adaptive budget inside the host hook window. */
  readonly hookBudgetMs?: number;
  /**
   * PRI-1182: remaining-budget floor for the pre-selection skip gate. Defaults
   * to the request's minimum executable envelope; 0 keeps a cancellation
   * scenario sending.
   */
  readonly minExecutableBudgetMs?: number;
}

// stdin, env and cwd are the host CLI contract; `deps` is the optional transport
// seam that lets integration tests drive the real entry point without a network.
// eslint-disable-next-line @typescript-eslint/max-params
export async function processHookInvocation(rawStdin: string, _env: EnvMap = process.env, cwd = process.cwd(), deps: PdHookDeps = {}): Promise<PdHookResult> {
  // The host owns this window and kills the process when it expires; anchor at
  // entry so decode/ingestion time counts against the same budget.
  const adaptiveDeadlineAt = Date.now() + (deps.hookBudgetMs ?? CODEX_ADAPTIVE_BUDGET_MS);
  let parsed: unknown;
  try { parsed = JSON.parse(rawStdin); }
  catch (error) { return { stdout: {}, exitCode: 0, stderr: [diagnostic(`stdin_json_invalid:${errorMessage(error)}`, 'Verify Codex invokes the PD hook with one JSON object.')] }; }

  const adapter = new CodexHooksHostAdapter();
  let event;
  try { event = adapter.decodeEvent(parsed); }
  catch (error) {
    const reason = error instanceof CodexDecoderError ? error.reason : `decode_threw:${errorMessage(error)}`;
    const nextAction = error instanceof CodexDecoderError ? error.nextAction : 'Inspect the Codex 0.147 hook payload.';
    return { stdout: {}, exitCode: 0, stderr: [diagnostic(reason, nextAction)] };
  }
  // Capture the PreToolUse boundary before ingestion, governance or runtime
  // work can consume time; history must never include rows written afterwards.
  const hookEpoch = new Date();

  // Initializing the user workspace explicitly opts Codex into shared
  // governance. Otherwise preserve the existing per-project resolution.
  const requestedCwd = event.context.workspaceDir || cwd;
  if (!path.isAbsolute(requestedCwd)) return { stdout: {}, exitCode: 0, stderr: [diagnostic('cwd_not_absolute', 'Provide the absolute Codex project directory.')] };
  // Resolve like pd-locate.cjs does: a relative CODEX_HOME must yield the same
  // absolute workspace for hooks and owner scripts, or resolveNearestPdWorkspace
  // rejects it after the config check already accepted it.
  const userWorkspace = path.join(path.resolve(_env.CODEX_HOME || path.join(os.homedir(), '.codex')), 'pd-workspace');
  let userWorkspaceInitialized = false;
  try {
    userWorkspaceInitialized = statSync(path.join(userWorkspace, '.pd', 'config.yaml')).isFile();
    if (!userWorkspaceInitialized) return { stdout: {}, exitCode: 0, stderr: [diagnostic('user_workspace_config_invalid', 'Repair the user workspace .pd/config.yaml; project configuration was not used.')] };
  } catch (error) {
    if (!(error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT')) {
      return { stdout: {}, exitCode: 0, stderr: [diagnostic('user_workspace_config_unreadable', 'Restore access to the user workspace .pd/config.yaml; project configuration was not used.')] };
    }
  }
  const resolution = resolveNearestPdWorkspace(userWorkspaceInitialized ? userWorkspace : requestedCwd);
  if (!resolution.ok) return { stdout: {}, exitCode: 0, stderr: [diagnostic(resolution.reason, resolution.nextAction)] };
  event = { ...event, context: { ...event.context, workspaceDir: resolution.workspaceDir } };
  const config = loadPdConfigForPlugin(resolution.workspaceDir);
  if (!config.ok) {
    const [first] = config.errors;
    return { stdout: {}, exitCode: 0, stderr: [diagnostic(first?.reason ?? 'pd_config_invalid', first?.nextAction ?? 'Repair .pd/config.yaml.')] };
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.codex']?.enabled !== true) {
    // PRI-1063 (review fix): single-line flow mapping. `diagnostic()` below
    // collapses every whitespace run, so a multi-line YAML block would reach
    // the user flattened into garbage; and a second `features:` block would
    // duplicate the key already present in every real config.
    return { stdout: {}, exitCode: 0, stderr: [diagnostic('host.codex_disabled', 'Enable PD in the selected Workspace .pd/config.yaml — in the existing "features:" block set host.codex: {enabled: true} (one flat key, not nested).')] };
  }
  const ingestionEnabled = flags.codex_conversation_ingestion?.enabled === true;
  // PRI-1196: selection timing. Absent = 'sync' — every existing workspace
  // keeps the historical behavior. Background mode never builds the sync
  // provider, so this turn cannot be scored twice.
  const adaptiveTiming = config.effective.config.adaptiveActivation?.timing === 'background' ? 'background' as const : 'sync' as const;
  const backgroundSelectionEnabled = flags['host.codex.adaptive_activation']?.enabled === true && adaptiveTiming === 'background';

  if (event.kind === 'turn_complete') {
    // Withdraw the live turn context: once the turn completes, the
    // agent-assisted explicit entry must fail closed (turn_context_missing)
    // instead of binding an Owner statement to a finished turn. A withdrawal
    // failure is surfaced as ONE bounded diagnostic (rc-9) — never silent.
    const cleared = clearCurrentTurnContext({
      workspaceDir: resolution.workspaceDir,
      sessionId: event.context.sessionId,
      ...(event.context.turnId !== undefined ? { turnId: event.context.turnId } : {}),
    });
    const clearDiagnostics = cleared.ok
      ? []
      : [diagnostic(`turn_context_${cleared.reason}`, 'The turn context could not be withdrawn; the agent-assisted explicit entry stays fail-closed only via its staleness bound. Inspect the workspace .state directory.')];
    // Stop is the turn-complete ingestion trigger (G1 §2): no dispatch route,
    // and Codex's Stop output schema has no hookSpecificOutput — the neutral
    // result is exactly `{}` on stdout (runtime contract: "PD emits empty
    // stdout on Stop"). Flag-off preserves the zero-transcript-read invariant
    // and emits ONE bounded structured feature_disabled fact per completed
    // turn on stderr — never stdout, and never on the per-tool events (that
    // would be per-event noise).
    const stderr = ingestionEnabled
      ? [...clearDiagnostics, ...await runConversationIngestion({ rawPayload: parsed, kind: event.kind, workspaceDir: resolution.workspaceDir, env: _env })]
      : [...clearDiagnostics, diagnostic('feature_disabled', 'Enable bounded conversation ingestion in the selected Workspace .pd/config.yaml — in the existing "features:" block set codex_conversation_ingestion: {enabled: true} (one flat key, not nested).')];
    if (backgroundSelectionEnabled && event.context.turnId !== undefined) {
      finalizeBackgroundTurn({
        workspaceDir: resolution.workspaceDir,
        stateDir: path.join(resolution.workspaceDir, '.state'),
        sessionId: event.context.sessionId,
        turnId: event.context.turnId,
      });
    }
    return { stdout: {}, exitCode: 0, stderr };
  }

  try {
    if (event.kind === 'session_start') {
      // Belt for turn_complete: a fresh session must never inherit the
      // previous session's turn context. Withdrawal failure → diagnostic.
      const cleared = clearCurrentTurnContext({ workspaceDir: resolution.workspaceDir, sessionId: event.context.sessionId });
      const clearDiagnostics = cleared.ok
        ? []
        : [diagnostic(`turn_context_${cleared.reason}`, 'The turn context could not be withdrawn; the agent-assisted explicit entry stays fail-closed only via its staleness bound. Inspect the workspace .state directory.')];
      const health = await createProductionHostRuntime({ hostKind: 'codex' }).health(resolution.workspaceDir);
      if (!health.ok) return { stdout: {}, exitCode: 0, stderr: [...clearDiagnostics, diagnostic(health.reason ?? 'runtime_unhealthy', health.nextAction ?? 'Inspect the Workspace runtime.')] };
      return { stdout: adapter.encodeOutput({ decision: 'allow', source: event.source }, 'session_start'), exitCode: 0, stderr: clearDiagnostics };
    }

    // SPEC-CODEX-PAIN-CLOSURE-001 CR-07: the explicit Owner statement entry
    // owns the current user prompt. The prefix parse runs FIRST (pure, zero
    // I/O) so the single-writer suppression strategy is decided BEFORE any
    // ingestion or admission runs — then, when the prefix matched, the live
    // observation ingestion for this SAME payload runs BEFORE the explicit
    // registration, because the registration's evidence promotion requires
    // the trigger observation to already be persisted. Registering first and
    // ingesting afterwards made every FIRST submission of a rollout degrade
    // with rollout_not_found/trigger_not_found (the trigger row only appeared
    // in the later ingestion pass). Works regardless of the
    // codex_conversation_ingestion flag: flag-off skips the ingestion call
    // entirely, and the registration discloses promotion as skipped
    // (conversation_ingestion_disabled) instead of misreporting a missing
    // substrate; only the transcript PATH is ever validated (rollout
    // identity), never conversation content.
    let explicitReceiptContext: string | undefined;
    const explicitDiagnostics: string[] = [];
    let explicitPrefixMatched = false;
    let explicitStatementText: string | null = null;
    let explicitRejectReason: 'statement_empty' | 'statement_too_long' | undefined;
    if (event.kind === 'before_prompt_build') {
      // Agent-assisted explicit registration bridge: publish THIS turn's
      // host-verified identity (ids and paths only — never prompt text) so
      // `pd pain explicit` can register the Owner's verbatim words through
      // the same admission chain as the prefix entry, with the model never
      // seeing or guessing lineage ids. Not gated by the ingestion flag; a
      // write failure degrades only that entry (the prefix entry never
      // needed this file).
      const turnContext = writeCurrentTurnContext({ rawPayload: parsed, workspaceDir: resolution.workspaceDir, env: _env });
      if (!turnContext.ok) {
        explicitDiagnostics.push(diagnostic(`turn_context_${turnContext.reason}`, turnContext.nextAction));
      }
      const rawRecord = parsed as Record<string, unknown>;
      const prefixParse = parseOwnerStatementPrefix(typeof rawRecord?.prompt === 'string' ? rawRecord.prompt : undefined);
      explicitPrefixMatched = prefixParse.matched;
      if (prefixParse.matched) {
        explicitStatementText = prefixParse.text;
        explicitRejectReason = prefixParse.reason;
      }
    }

    const ingestionDiagnostics = ingestionEnabled
      ? await runConversationIngestion({
        rawPayload: parsed,
        kind: event.kind,
        workspaceDir: resolution.workspaceDir,
        env: _env,
        // CR-07: the prefix parse above already decided this turn's user
        // prompt belongs to the explicit path — suppress the generic
        // correction candidate so exactly one writer processes the
        // observation (A17), and the trigger observation is in place before
        // the explicit registration promotes evidence around it.
        ...(explicitPrefixMatched ? { suppressCorrectionCandidate: true } : {}),
      })
      : [];

    if (explicitPrefixMatched) {
      if (explicitStatementText === null) {
        explicitDiagnostics.push(diagnostic(
          `owner_statement_${explicitRejectReason ?? 'rejected'}`,
          explicitRejectReason === 'statement_too_long'
            ? `The statement exceeds 500 characters; nothing was recorded. Resubmit within the limit.`
            : 'The prefix carried no statement text; nothing was recorded. Resubmit as PD记录痛苦：<反馈原文>.',
        ));
      } else {
        const receipt = await recordExplicitOwnerStatement({
          rawPayload: parsed,
          workspaceDir: resolution.workspaceDir,
          statementText: explicitStatementText,
          env: _env,
          conversationIngestionEnabled: ingestionEnabled,
        });
        if (receipt.status === 'received') {
          const promotionNotice = receipt.promotionDegraded === 'conversation_ingestion_disabled'
            ? '会话证据提升已跳过：会话摄取未启用（按隐私边界未读取会话内容，也未写入会话观察）'
            : `会话证据提升暂不可用：${receipt.promotionDegraded}`;
          const ingressNotice = receipt.ingressWarning !== undefined
            ? `行为证据缺失，已按 Owner 陈述降级准入：${receipt.ingressWarning}`
            : undefined;
          explicitReceiptContext = `[PD] 已收到痛苦反馈（painId=${receipt.painId}, taskId=${receipt.taskId}${receipt.disposition === 'already_admitted' ? ', 重复提交已合并为同一信号' : ''}）。后台将自动诊断；请在回复中如实转述本回执，不要声称仍在等待用户输入，也不要虚构诊断结论。${receipt.promotionDegraded !== undefined ? `（注意：${promotionNotice}；诊断仍会基于你提交的陈述进行。）` : ''}${ingressNotice !== undefined ? `（注意：${ingressNotice}；诊断仍会基于你提交的陈述进行。）` : ''}`;
          explicitDiagnostics.push(diagnostic(
            `owner_statement_received:${receipt.painId}:${receipt.taskId}${receipt.promotionDegraded !== undefined ? `:promotion_degraded:${receipt.promotionDegraded}` : ''}${receipt.ingressWarning !== undefined ? `:ingress_degraded:${receipt.ingressWarning}` : ''}`,
            'Durable enqueue complete; the workspace worker continues diagnosis in the background.',
          ));
        } else {
          explicitDiagnostics.push(diagnostic(
            `owner_statement_${receipt.reason}`,
            receipt.nextAction,
          ));
        }
      }
    }
    // PD v2 Phase 1: evidence context for this subprocess invocation. The
    // ledger flag follows the OpenClaw convention (principle_receipt_ledger
    // gates normalized evidence writes).
    const evidenceDiagnostics: string[] = [];
    const evidenceContext: CodexEvidenceContext = {
      workspaceDir: resolution.workspaceDir,
      evidenceEnabled: flags.principle_receipt_ledger?.enabled === true,
      warn: (line) => evidenceDiagnostics.push(diagnostic(line.replace(/^\[PD:Evidence\] /, 'codex_evidence:'), 'Inspect workspace state.db evidence ledger; the durable raw source allows safe replay.')),
    };
    // PRI-750: emit shared-path injection/tool events with the host's natural
    // turn/tool ids (turn_id → runId, tool_use_id → toolCallId) through the core
    // event-JSONL writer (same events_*.jsonl format as the OpenClaw EventLog;
    // the Codex adapter stays independent of the OpenClaw plugin). The line
    // writer appends synchronously — no flush/dispose needed for the subprocess.
    // PRI-1170: Adaptive Activation is an INDEPENDENT, default-off switch on
    // top of the PD hook. `host.codex.enabled` remains the whole-hook gate.
    const adaptiveDiagnostics: string[] = [];
    let adaptivePriorityProvider: AdaptivePriorityProvider | undefined;
    let adaptiveTurnFact: AdaptiveTurnFact | null = null;
    if (event.kind === 'before_prompt_build' && flags['host.codex.adaptive_activation']?.enabled === true && adaptiveTiming === 'sync') {
      const adaptive = createAdaptivePriorityProviderForConfig(
        config.effective.config,
        resolution.workspaceDir,
        {
          env: _env,
          ...(deps.fetchImpl ? {fetchImpl: deps.fetchImpl} : {}),
          ...(deps.now ? {now: deps.now} : {}),
          requestTimeoutMs: deps.requestTimeoutMs ?? CODEX_ADAPTIVE_DECISION_MS,
          ...(deps.minExecutableBudgetMs !== undefined ? {minExecutableBudgetMs: deps.minExecutableBudgetMs} : {}),
          outerDeadlineAt: adaptiveDeadlineAt,
          onDiagnostic: (line) => {
            adaptiveDiagnostics.push(adaptiveSelectionDiagnostic(line));
            adaptiveTurnFact = {
              status: line.status,
              reason: line.reason,
              sends: line.sends,
              targetActivationId: line.targetActivationId,
            };
          },
        },
      );
      if (adaptive.ok) {
        adaptivePriorityProvider = adaptive.provider;
      } else {
        // rc-9: an enabled-but-unusable switch is observable, never silent.
        // `sends: 0` is a fact, not an assumption: no request can leave when
        // the effective configuration cannot build a model.
        adaptiveTurnFact = {
          status: 'needs_setup',
          reason: adaptive.reason,
          sends: 0,
          targetActivationId: null,
        };
        adaptiveDiagnostics.push(diagnostic(
          `adaptive_activation_${adaptive.readiness}:${adaptive.reason}`,
          adaptive.nextAction,
        ));
      }
    }
    // B3: resolve tool semantics from the workspace declarations — the SAME
    // source replay / evidence / Console read — with the compiled-in Codex
    // declaration as the fallback. A malformed declaration degrades
    // observably on stderr instead of blocking the tool call (rc-9).
    const toolSemanticsResolution = resolveHostToolSemanticsForHook({
      workspaceDir: resolution.workspaceDir,
      hostKind: 'codex',
      staticMappings: CODEX_TOOL_SEMANTIC_MAPPINGS,
    });
    const toolSemantics = toolSemanticsResolution.ok
      ? toolSemanticsResolution.registry
      : CODEX_TOOL_SEMANTICS;
    const toolSemanticsDiagnostics = toolSemanticsResolution.ok
      // ADR-0030: a legacy persisted declaration still loads (degraded to
      // defaults) and must be visible on stderr (rc-9).
      ? toolSemanticsResolution.warnings.map((warning) =>
          diagnostic(warning, 're-run this host so it refreshes its persisted tool declaration'))
      : [diagnostic(toolSemanticsResolution.reason, toolSemanticsResolution.nextAction)];
    // PRI-1196: the background decision is bound to THIS host turn. Ordering
    // observations exist only while the turn actually has a job/decision, so a
    // normal turn pays zero extra filesystem work.
    const backgroundTurnKey: BackgroundTurnKey | null = backgroundSelectionEnabled && event.context.turnId !== undefined
      ? {
          workspaceDir: resolution.workspaceDir,
          stateDir: path.join(resolution.workspaceDir, '.state'),
          sessionId: event.context.sessionId,
          turnId: event.context.turnId,
        }
      : null;
    const toolKind = toolSemantics.resolve(event.context.toolName ?? '');
    const appendToolFacts = resolveAppendToolFacts(toolKind, event.context.toolInput);
    if (backgroundTurnKey
      && event.context.toolCallId !== undefined
      && (event.kind === 'before_tool_call' || event.kind === 'after_tool_call')
      && hasAdaptiveAppendState(backgroundTurnKey)) {
      appendToolObservation({
        ...backgroundTurnKey,
        observation: {
          phase: event.kind === 'before_tool_call' ? 'pre' : 'post',
          toolCallId: event.context.toolCallId,
          toolName: event.context.toolName ?? '',
          canonicalKind: toolKind,
          readOnly: appendToolFacts.readOnly,
          at: Date.now(),
        } satisfies ToolObservation,
      });
    }
    // Capture the Native assembly facts the background job must match. The
    // emitter receives them from the runtime; no second prompt build is needed.
    const nativeCapture: {
      value: {
        activationIds: string[];
        injectedCharCount: number;
        budget: number;
        capacitySource: 'operator_declared' | 'host_effective_window' | 'pi_catalog_exact' | 'pi_catalog_model_id' | 'legacy_fallback' | undefined;
        capacityStatus: 'confirmed' | 'unknown' | undefined;
        contextWindowTokens: number | undefined;
      } | null;
    } = {value: null};
    const baseEmitter = codexEventEmitter(
      path.join(resolution.workspaceDir, '.state'),
      evidenceContext,
      () => adaptiveTurnFact,
    );
    const events: HostEventEmitter = {
      ...baseEmitter,
      recordRuntimeActivationsInjected(data) {
        nativeCapture.value = {
          activationIds: [...data.activationIds],
          injectedCharCount: data.injectedCharCount,
          budget: data.budget,
          capacitySource: data.budgetCapacitySource,
          capacityStatus: data.budgetCapacityStatus,
          contextWindowTokens: data.budgetContextWindowTokens,
        };
        baseEmitter.recordRuntimeActivationsInjected(data);
      },
    };
    const result = await createProductionHostRuntime({
      projectDir: requestedCwd,
      hostKind: 'codex',
      toolSemantics,
      ...(adaptivePriorityProvider ? {adaptiveGapProvider: adaptivePriorityProvider} : {}),
      ruleContextProvider: createCodexRuleContextProvider({
        workspaceDir: resolution.workspaceDir,
        projectDir: requestedCwd,
        enabled: flags.rulecode_context_v2?.enabled === true && ingestionEnabled,
        cutoffAt: hookEpoch,
        currentToolUseId: event.context.toolCallId ?? '',
        toolSemantics,
      }),
      events,
    }).dispatch(event);
    // PRI-813: the shared gate's evaluation facts leave through metadata —
    // persist them here (telemetry persistence is host-side business; the
    // gate itself never writes). Codex previously recorded NO
    // rulehost_evaluated rows, so shadow evidence never reached the
    // promotion pipeline.
    const evaluationDiagnostics = recordRuleHostEvaluations(
      path.join(resolution.workspaceDir, '.state'),
      event.context.sessionId,
      result.metadata?.evaluations,
    );
    // Encode before recording an attributed deny: runtime_verified evidence
    // claims only what reached stdout (codex_permission_decision_encoded).
    // V2 rules remain suspended by the shared gate when this provider reports
    // unavailable history; that degraded state is preserved in stderr.
    let encoded = adapter.encodeOutput(result, event.kind);
    // CR-07 (A16): the explicit-statement receipt rides as additional context
    // so the model can answer truthfully about what happened (received +
    // queued), instead of guessing or claiming it is still waiting for input.
    if (explicitReceiptContext !== undefined && event.kind === 'before_prompt_build') {
      const output = encoded as { hookSpecificOutput?: { additionalContext?: string } };
      if (output.hookSpecificOutput !== undefined) {
        output.hookSpecificOutput.additionalContext = output.hookSpecificOutput.additionalContext !== undefined
          ? `${output.hookSpecificOutput.additionalContext}\n${explicitReceiptContext}`
          : explicitReceiptContext;
      }
    }
    const backgroundDiagnostics: string[] = [];
    // PRI-1196 — background start. The Native body is ALREADY encoded above;
    // this only writes a single-use job and hands it to a detached process.
    // It never awaits the decision, and the child has no inherited stdio.
    if (backgroundTurnKey && event.kind === 'before_prompt_build') {
      const injection = nativeCapture.value;
      if (injection === null) {
        emitBackgroundFact(backgroundTurnKey, {resultCode: 'background:spawn_failed', scored: false, budget: 0, injectedCharCount: 0});
        backgroundDiagnostics.push(diagnostic('adaptive_background_spawn_failed:native_assembly_missing', 'The Native body was still encoded and sent; the background decision was skipped for this turn.'));
      } else {
        const output = encoded as { hookSpecificOutput?: { additionalContext?: string } };
        const nativeText = output.hookSpecificOutput?.additionalContext;
        const nativeChars = typeof nativeText === 'string' ? nativeText.length : injection.injectedCharCount;
        try {
          clearStaleAdaptiveAppendState(resolution.workspaceDir, Date.now());
          const jobPath = writeAdaptiveAppendJob({
            schemaVersion: ADAPTIVE_APPEND_SCHEMA_VERSION,
            createdAt: Date.now(),
            sessionId: event.context.sessionId,
            turnId: backgroundTurnKey.turnId,
            workspaceDir: resolution.workspaceDir,
            promptContent: event.context.promptContent ?? '',
            nativeActivationIds: injection.activationIds,
            nativeChars,
            budgetChars: injection.budget,
            hookIdentity: currentHookIdentity(),
          });
          const spawned = spawnAdaptiveBackgroundSelection(jobPath);
          if (!spawned.ok) {
            discardAdaptiveAppendJob(jobPath);
            emitBackgroundFact(backgroundTurnKey, {resultCode: 'background:spawn_failed', scored: false, budget: injection.budget, injectedCharCount: 0});
            backgroundDiagnostics.push(diagnostic(`adaptive_background_spawn_failed:${spawned.reason}`, 'The Native body was still encoded and sent; the background decision was skipped for this turn.'));
          } else {
            emitBackgroundFact(backgroundTurnKey, {resultCode: 'background:spawned', scored: false, budget: injection.budget, injectedCharCount: 0});
          }
        } catch (error: unknown) {
          emitBackgroundFact(backgroundTurnKey, {resultCode: 'background:spawn_failed', scored: false, budget: injection.budget, injectedCharCount: 0});
          backgroundDiagnostics.push(diagnostic(`adaptive_background_job_failed:${errorMessage(error)}`, 'The Native body was still encoded and sent; the background decision was skipped for this turn.'));
        }
      }
    }
    // PRI-1196 — consume at a qualified read-only tool boundary of the SAME
    // turn. The claim rename makes replay/concurrency emit at most once.
    if (backgroundTurnKey && event.kind === 'after_tool_call' && event.context.toolCallId !== undefined) {
      const claimed = claimAdaptiveAppendResult({...backgroundTurnKey, now: Date.now()});
      if (!appendToolFacts.readOnly) {
        if (claimed.status === 'ready') {
          releaseAdaptiveAppendClaim(claimed.claimPath);
          reportBackgroundDrop(backgroundTurnKey, {
            reason: toolKind === 'write' ? 'mutating_tool' : 'unknown_tool',
            scored: true,
            budget: claimed.result.budgetChars,
          });
        }
      } else {
        const ordering = evaluateAppendOrdering(readToolObservations(backgroundTurnKey), event.context.toolCallId);
        if (!ordering.ok) {
          if (claimed.status === 'ready') {
            releaseAdaptiveAppendClaim(claimed.claimPath);
            reportBackgroundDrop(backgroundTurnKey, {reason: ordering.reason, scored: true, budget: claimed.result.budgetChars});
          }
        } else if (claimed.status === 'expired') {
          reportBackgroundDrop(backgroundTurnKey, {reason: 'expired', scored: true, budget: 0});
        } else if (claimed.status === 'ready') {
          const consumed = await consumeBackgroundAppend({
            workspaceDir: resolution.workspaceDir,
            result: claimed.result,
          });
          if (consumed.ok) {
            // The appended directive is additional context for the NEXT model
            // request; Native items and their order are untouched.
            encoded = adapter.encodeOutput(
              {decision: 'observe', source: event.source, additionalContext: consumed.directive},
              'after_tool_call',
            );
            emitBackgroundFact(backgroundTurnKey, {
              resultCode: 'selected:background_appended',
              scored: true,
              budget: claimed.result.budgetChars,
              injectedCharCount: consumed.directive.length,
              appended: consumed.target,
            });
            try {
              recordCodexPromptDeliveryEvidence({
                workspaceDir: resolution.workspaceDir,
                sessionId: event.context.sessionId,
                turnId: backgroundTurnKey.turnId,
                injected: [consumed.target],
                evidenceEnabled: evidenceContext.evidenceEnabled,
                warn: evidenceContext.warn,
              });
            } catch (error: unknown) {
              evidenceDiagnostics.push(diagnostic(`codex_evidence_append_failed:${errorMessage(error)}`, 'The append was already encoded; evidence replay from the durable source is safe.'));
            }
          } else {
            reportBackgroundDrop(backgroundTurnKey, {reason: consumed.reason, scored: true, budget: claimed.result.budgetChars});
          }
          releaseAdaptiveAppendClaim(claimed.claimPath);
        }
      }
    }
    if (result.decision === 'deny') {
      try {
        let liveActivationId: string | undefined;
        const evaluations = result.metadata?.evaluations;
        if (Array.isArray(evaluations)) {
          for (const entry of evaluations) {
            if (typeof entry !== 'object' || entry === null) continue;
            const record = entry as { activationMode?: unknown; activationId?: unknown };
            if (record.activationMode === 'live' && typeof record.activationId === 'string' && record.activationId.length > 0) {
              ({ activationId: liveActivationId } = record);
              break;
            }
          }
        }
        const { metadata } = result;
        const principleId = typeof metadata?.principleId === 'string' ? metadata.principleId : undefined;
        const ruleId = typeof metadata?.ruleId === 'string' ? metadata.ruleId : undefined;
        const rawPayload = parsed as Record<string, unknown>;
        const toolName = typeof rawPayload?.tool_name === 'string'
          ? String(rawPayload.tool_name)
          : 'unknown-tool';
        const toolUseId = typeof rawPayload?.tool_use_id === 'string'
          ? String(rawPayload.tool_use_id)
          : undefined;
        recordCodexDenyEvidence({
          workspaceDir: resolution.workspaceDir,
          sessionId: event.context.sessionId,
          ...(toolUseId ? { toolUseId } : {}),
          toolName,
          activationId: liveActivationId,
          principleId,
          ruleId,
          reason: result.reason,
          evidenceEnabled: evidenceContext.evidenceEnabled,
          warn: evidenceContext.warn,
        });
      } catch (error: unknown) {
        evidenceDiagnostics.push(diagnostic(`codex_evidence_deny_failed:${errorMessage(error)}`, 'The deny decision was already encoded; evidence replay from the durable source is safe.'));
      }
    }
    const stderr = [...(result.warnings ?? []).slice(0, 16).map((warning) => diagnostic(warning, 'Inspect PD Workspace state and retry; the hook failed open.')), ...evaluationDiagnostics, ...evidenceDiagnostics, ...ingestionDiagnostics, ...explicitDiagnostics, ...adaptiveDiagnostics, ...toolSemanticsDiagnostics, ...backgroundDiagnostics];
    return { stdout: encoded, exitCode: 0, stderr };
  } catch (error) {
    const reason = error instanceof CodexEncoderError ? error.reason : `runtime_failed:${errorMessage(error)}`;
    const nextAction = error instanceof CodexEncoderError ? error.nextAction : 'Inspect PD Workspace state and retry; the hook failed open.';
    return { stdout: {}, exitCode: 0, stderr: [diagnostic(reason, nextAction)] };
  }
}

// PRI-943: process-boundary fail-open belt. Every resolved path sets exitCode 0,
// so nothing may let an unwritable stream, an unserializable result, or an
// escaping rejection reach node's default handling, which terminates the hook
// with exit 1. Three distinct failure modes, each reproduced from a spawned
// process in tests/pd-hook-entry-belt.test.ts:
//   * a write that THROWS synchronously — caught per write below;
//   * a host closing the pipe, which raises an ASYNC 'error' event on the
//     Socket. try/catch cannot reach that one, so a listener is required
//     (armStreamBelts) or node aborts with "Unhandled 'error' event".
//   * the stdout JSON object failing to SERIALIZE — guarded separately because
//     the object is the contract (serializeStdout).
// stdout must stay exactly one JSON object, so a belt diagnostic goes to stderr
// only; when stderr itself is the dead stream nothing is reported rather than
// written into the machine channel.
let beltReported = false;
let stdoutJsonDelivered = false;

function writeBeltDiagnostic(reason: string, nextAction: string): void {
  if (beltReported) return;
  beltReported = true;
  try {
    process.stderr.write(`${diagnostic(reason, nextAction)}\n`);
  } catch {
    // Both streams are gone: there is no channel left inside the fail-open
    // contract, and adding I/O here would widen the belt itself.
  }
}

function reportStreamFailure(error: unknown): void {
  writeBeltDiagnostic(
    `hook_stream_failed:${errorMessage(error)}`,
    'The host closed the pipe; retry the tool call — the hook failed open.',
  );
}

function writeStream(stream: 'stdout' | 'stderr', line: string): boolean {
  try {
    process[stream].write(`${line}\n`);
    // Tracked here rather than at each call site so no future stdout write can
    // make the entry belt believe nothing was delivered yet.
    if (stream === 'stdout') stdoutJsonDelivered = true;
    return true;
  } catch (error) {
    reportStreamFailure(error);
    return false;
  }
}

function armStreamBelts(): void {
  process.stdout.on('error', reportStreamFailure);
  process.stderr.on('error', reportStreamFailure);
}

/** rc-8: the stdout JSON object is the contract itself, so serializing it is a
 * failure path of the belt rather than of the encoder — degrade to `{}` and
 * report, never let the throw escape into the entry belt's last-resort branch. */
function serializeStdout(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch (error) {
    writeBeltDiagnostic(
      `hook_stdout_serialize_failed:${errorMessage(error)}`,
      'Retry the tool call; the hook failed open with an empty JSON object.',
    );
    return '{}';
  }
}

async function main(): Promise<void> {
  let raw: string;
  try { raw = readFileSync(0, 'utf8'); }
  catch (error) {
    writeStream('stderr', diagnostic(`stdin_read_failed:${errorMessage(error)}`, 'Run the hook from Codex with JSON stdin.'));
    writeStream('stdout', '{}');
    return;
  }
  let result: PdHookResult;
  try {
    // The host's 5 s window starts at process spawn, not at this call: node
    // boot and module loading already consumed part of it. Anchor the deadline
    // at process start so the measured reserve really reaches Native.
    const elapsedSinceProcessStartMs = Math.round(process.uptime() * 1000);
    const remainingBudgetMs = Math.max(1, CODEX_ADAPTIVE_BUDGET_MS - elapsedSinceProcessStartMs);
    result = await processHookInvocation(raw, process.env, process.cwd(), { hookBudgetMs: remainingBudgetMs });
  } catch (error) {
    // Fail-open belt for an unexpected pre-dispatch throw (e.g. a workspace
    // resolution race): Codex must still receive exactly one JSON object on
    // stdout and a bounded diagnostic on stderr — never a bare crash.
    writeStream('stderr', diagnostic(`hook_pipeline_unexpected:${errorMessage(error)}`, 'Retry the tool call; if it repeats, inspect PD stderr and the Workspace .pd/config.yaml state.'));
    result = { stdout: {}, exitCode: 0, stderr: [] };
  }
  // Each write is guarded on its own: with stderr dead the stdout JSON object
  // is still what Codex needs to fail open, so one stream must not abort the other.
  for (const line of result.stderr) {
    if (!writeStream('stderr', line)) break;
  }
  writeStream('stdout', serializeStdout(result.stdout));
  process.exitCode = result.exitCode;
}

// PRI-892: Node resolves the main module through symlinks/junctions while
// argv[1] keeps the unresolved link path (npm/npx `.bin` shims, or a
// junctioned extensions dir), so the old raw comparison silently skipped
// main() on Windows. Try the raw URL first so an ordinary direct invocation
// never depends on a filesystem lookup succeeding, then canonicalize through
// realpath for the linked-path case.
function isMainModuleEntry(): boolean {
  const [, entry] = process.argv;
  if (!entry) return false;
  if (pathToFileURL(entry).href === import.meta.url) return true;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch (error) {
    // rc-9: realpath is unavailable or failed, so the link cannot be verified.
    // If argv[1] still names this exact file, that is the entry — run main()
    // and leave a bounded diagnostic instead of the silent no-op this ticket
    // exists to remove. A test runner that merely imports this module never
    // satisfies it, because its argv[1] is the runner, not pd-hook.
    if (path.basename(entry) !== path.basename(fileURLToPath(import.meta.url))) return false;
    writeStream('stderr', diagnostic(
      `entry_identity_unverified:${errorMessage(error)}`,
      'Reinstall the Codex adapter; if it repeats, report this line together with the command that invoked the hook.',
    ));
    return true;
  }
}

if (isMainModuleEntry()) {
  armStreamBelts();
  void main().catch((error: unknown) => {
    // Last-resort belt: a rejection escaping main's own guards must still leave
    // Codex with exit 0 and, when nothing reached stdout yet, an empty JSON
    // object instead of a bare crash.
    writeBeltDiagnostic(
      `hook_fatal:${errorMessage(error)}`,
      'Retry the tool call; if it repeats, report this line together with the command that invoked the hook.',
    );
    if (!stdoutJsonDelivered) writeStream('stdout', '{}');
    process.exitCode = 0;
  });
}
