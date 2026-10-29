#!/usr/bin/env node
/**
 * WorkBuddy pd-hook — the process entry WorkBuddy invokes per hook event
 * (through plugin/scripts/wrapper.cjs, which forwards stdin/stdout/exit code).
 *
 * FAILURE POLICY (SPEC §4.4 / OD-01, frozen by Phase 0 probe P02):
 * WorkBuddy exit codes have PER-EVENT effects, so unlike the Codex belt
 * ("always exit 0") the channel matters:
 *
 *   flag-off / uninitialized / degraded workspace
 *     → EMPTY stdout + exit 0 + observable stderr skip/degrade record
 *       (rc-9; never escalated to blocking — the Owner has not opted in);
 *   PreToolUse INSIDE the supported governance path whose decode/dispatch/
 *   encode/serialization fails
 *     → exit 2 + bounded stderr + EMPTY stdout (P02 verified exit 2 blocks
 *       the tool even when stdout is closed);
 *   UserPromptSubmit failure
 *     → exit 0 + degraded stderr; explicit Owner submissions may also carry
 *       a bounded rejection context (exit 2 would CLEAR the user's prompt);
 *   PostToolUse ANY failure
 *     → EMPTY stdout + exit 0 + evidence-degradation stderr (the tool already
 *       ran; nothing can be blocked, so blocking language is never used);
 *   SessionStart ANY failure
 *     → EMPTY stdout + exit 0 + status stderr (non-blocking for the session).
 *
 * An ALREADY-COMPUTED deny always survives evidence-write failure (encode
 * first, record evidence after — P02: deny is the real blocking signal).
 *
 * OUTPUT: stdout carries AT MOST ONE JSON document (the whitelisted
 * hookSpecificOutput) and ONLY when there is something whitelisted to say —
 * the host injects any raw stdout text into model-visible context (P04), so
 * neutral means EMPTY stdout, never `{}`. Diagnostics go to stderr only.
 */
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { appendEventLogLine, redactTelemetryString, isRuleHostEvaluatedEventData } from '@principles/core/runtime-v2';
import type { HostEventEmitter, HostEventResult } from '@principles/core/host';
import { createProductionHostRuntime, createWorkbuddyRuleContextProvider, loadPdConfigForPlugin, parseOwnerStatementPrefix, assessWorkbuddyLiveKeyword, resolveSharedCorrectionKeywordStoreForDetection, admitTrustedWorkbuddyLiveCorrection, ensureGovernanceDiagnosticianTask } from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime-v2';
import { WorkBuddyHooksHostAdapter } from './host-adapter.js';
import { WORKBUDDY_TOOL_SEMANTICS } from './tool-semantics.js';
import { resolveWorkbuddyWorkspace } from './workspace-resolution.js';
import { WorkBuddyDecoderError, WorkBuddyEncoderError, isWorkBuddyHookOutput, WORKBUDDY_EVENT_PRE_TOOL_USE, type WorkBuddyHookOutput } from './codec/index.js';
import { recordWorkbuddyOwnerStatement } from './explicit-owner-statement.js';
import { recordWorkbuddyPromptDeliveryEvidence, recordWorkbuddyDenyEvidence } from './workbuddy-evidence-recorder.js';

type EnvMap = Record<string, string | undefined>;
export interface WorkBuddyPdHookResult { stdout: WorkBuddyHookOutput | null; exitCode: number; stderr: string[] }

const MAX_DIAGNOSTIC = 500;

function bound(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC);
}

/** rc-8/rc-9: bounded, single-line, machine-greppable diagnostic on stderr. */
function diagnostic(status: 'skipped' | 'degraded', reason: string, nextAction: string): string {
  return `[PD] status=${status} reason=${bound(reason)} nextAction=${bound(nextAction)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, MAX_DIAGNOSTIC) : 'unknown_error';
}

function redactStringFields(data: object): Record<string, unknown> {
  // rc-8: telemetry redacted field by field (same policy as the Codex emitter).
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    redacted[key] = typeof value === 'string' ? redactTelemetryString(value) : value;
  }
  return redacted;
}

/** Evidence context the emitters need (subprocess-local, best-effort). */
export interface WorkbuddyEvidenceContext {
  workspaceDir: string;
  evidenceEnabled: boolean;
  warn: (diagnosticLine: string) => void;
}

/**
 * Event emitter for the WorkBuddy subprocess: writes the same
 * `events_<date>.jsonl` line shape as the Codex/OpenClaw paths through the
 * core writer, so the WorkBuddy host path carries the host's natural ids
 * (generation_id → runId/turnId, call_id → toolCallId).
 */
function workbuddyEventEmitter(stateDir: string, evidence?: WorkbuddyEvidenceContext): HostEventEmitter {
  return {
    recordRuntimeV2ActivationsInjected(data) {
      appendEventLogLine(stateDir, {
        ts: new Date().toISOString(),
        type: 'runtime_v2_prompt_activations_injected',
        category: 'injected',
        sessionId: data.sessionId,
        data,
      });
      // Delivery evidence AFTER the durable source line exists; degrades to a
      // bounded diagnostic and never affects the hook result.
      if (evidence) {
        try {
          const injected = data.principleIds
            .map((principleId, index) => ({
              principleId,
              activationId: data.activationIds[index] ?? '',
              artifactId: data.artifactIds[index],
            }))
            .filter((entry) => entry.activationId.length > 0);
          recordWorkbuddyPromptDeliveryEvidence({
            workspaceDir: evidence.workspaceDir,
            sessionId: data.sessionId,
            ...(data.runId ? { turnId: data.runId } : {}),
            injected,
            evidenceEnabled: evidence.evidenceEnabled,
            warn: evidence.warn,
          });
        } catch (error: unknown) {
          evidence.warn(diagnostic('degraded', `workbuddy_evidence_delivery_failed:${errorMessage(error)}`, 'The raw injected event is durable; replay is safe. The hook result is unaffected.'));
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

/**
 * Persist the shared gate's per-activation evaluation facts
 * (metadata.evaluations — shadow observations plus the live aggregate) as
 * canonical `rulehost_evaluated` events (PRI-813 pattern). One bounded
 * diagnostic per failure CLASS; never throws into the caller's fail-open /
 * fail-closed handling.
 */
function recordRuleHostEvaluations(stateDir: string, sessionId: string | undefined, evaluations: unknown): string[] {
  if (!Array.isArray(evaluations)) return [];
  const diagnostics: string[] = [];
  let sawInvalidEntry = false;
  let sawPersistFailure = false;
  for (const entry of evaluations) {
    if (!isRuleHostEvaluatedEventData(entry)) {
      // rc-9: a skipped evidence row must be observable, never silent.
      if (!sawInvalidEntry) {
        sawInvalidEntry = true;
        diagnostics.push(diagnostic('degraded', 'rulehost_evaluation_entry_invalid', 'Inspect host-runtime gate metadata contract; the evaluation event was not persisted.'));
      }
      continue;
    }
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
        diagnostics.push(diagnostic('degraded', `rulehost_evaluation_persist_failed:${errorMessage(error)}`, 'Inspect workspace .state/logs writability; the evaluation event was not persisted, the tool decision is unaffected.'));
      }
    }
  }
  return diagnostics;
}

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 C: WorkBuddy now supplies a REAL V2 rule
 * context provider over its own trajectory (see the dispatch wiring below),
 * so the old blanket "host provides no runtime context provider" note no
 * longer applies. The remaining honest boundary: rules whose required facts
 * include design_approval stay suspended on this host (no WorkBuddy
 * design-gate attestation entry exists), and unavailable history still
 * suspends context-dependent rules through the shared-gate contract. The
 * note below annotates exactly that residual state.
 */
const WORKBUDDY_CONTEXT_UNSUPPORTED_NOTE = 'workbuddy_runtime_context_limited: WorkBuddy resolves rule context from its own trajectory only; rules requiring design_approval facts or unavailable history stay suspended on this host';

export function annotateContextWarnings(warnings: readonly string[]): string[] {
  return warnings.map((warning) => warning.startsWith('rule_context_v2_unavailable')
    ? `${warning}; ${WORKBUDDY_CONTEXT_UNSUPPORTED_NOTE}`
    : warning);
}

/** The wrapper's event argument names the registration context; only a
 * PreToolUse registration channel may escalate a failure to a blocking exit 2. */
function channelBlocksOnFailure(channelEventName: string | undefined): boolean {
  return channelEventName === WORKBUDDY_EVENT_PRE_TOOL_USE;
}

function neutralWithDiagnostics(stderr: string[]): WorkBuddyPdHookResult {
  return { stdout: null, exitCode: 0, stderr };
}

/** Pre-decode failures (bad JSON / decode) route per registration channel. */
function channelFailure(channelEventName: string | undefined, reason: string, nextAction: string): WorkBuddyPdHookResult {
  const line = diagnostic('degraded', reason, nextAction);
  if (channelBlocksOnFailure(channelEventName)) {
    // P02: exit 2 blocks the tool even with an empty stdout / closed pipe.
    return { stdout: null, exitCode: 2, stderr: [line] };
  }
  // UserPromptSubmit: exit 2 would clear the user's prompt (P02) — protect it.
  // PostToolUse/SessionStart: nothing blockable exists on those channels.
  return neutralWithDiagnostics([line]);
}

export async function processWorkbuddyHookInvocation(rawStdin: string, channelEventName: string | undefined, _env: EnvMap = process.env): Promise<WorkBuddyPdHookResult> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawStdin); }
  catch (error) {
    return channelFailure(channelEventName, `stdin_json_invalid:${errorMessage(error)}`, 'Verify the WorkBuddy hook passes one JSON object on stdin.');
  }

  const adapter = new WorkBuddyHooksHostAdapter();
  let event;
  try { event = adapter.decodeEvent(parsed); }
  catch (error) {    const reason = error instanceof WorkBuddyDecoderError ? error.reason : `decode_threw:${errorMessage(error)}`;
    const nextAction = error instanceof WorkBuddyDecoderError ? error.nextAction : 'Inspect the WorkBuddy hook payload against the Phase 0 host contract.';
    const failure = channelFailure(channelEventName, reason, nextAction);
    // Rejection communicates failure, never grants Owner authority or bypasses
    // decoding. Keep malformed native identity visible to the requesting Owner.
    if (channelEventName === 'UserPromptSubmit' && typeof parsed === 'object' && parsed !== null
      && Object.getOwnPropertyDescriptor(parsed, 'hook_event_name')?.value === 'UserPromptSubmit'
      && parseOwnerStatementPrefix(Object.getOwnPropertyDescriptor(parsed, 'prompt')?.value).matched) {
      const workspace = resolveWorkbuddyWorkspace(os.homedir());
      if (workspace.status === 'ok') {
        const config = loadPdConfigForPlugin(workspace.workspaceDir);
        if (config.ok && computeFeatureFlagsFromConfig(config.effective).flags['host.workbuddy']?.enabled === true) {
          failure.stdout = { hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: '[PD] host=workbuddy status=rejected reason=owner_statement_decode_invalid nextAction=Native hook input is invalid; nothing was recorded. Check PD status and submit a new current-user message.',
          } };
        }
      }
    }
    return failure;
  }

  // Capture the decode boundary before governance or runtime work can consume
  // time; the rule-context history window must never include rows written
  // afterwards (same cutoff discipline as the Codex hook epoch).
  const hookEpoch = new Date();

  // OD-07/P06 governance workspace: explicit, user-level, shared across
  // projects; never auto-created here and never falling back to another host.
  const resolution = resolveWorkbuddyWorkspace(os.homedir());
  if (resolution.status === 'uninitialized') {
    return neutralWithDiagnostics([diagnostic('skipped', resolution.reason, resolution.nextAction)]);
  }
  if (resolution.status === 'degraded') {
    return neutralWithDiagnostics([diagnostic('degraded', resolution.reason, resolution.nextAction)]);
  }

  const config = loadPdConfigForPlugin(resolution.workspaceDir);
  if (!config.ok) {
    const [first] = config.errors;
    return neutralWithDiagnostics([diagnostic('degraded', first?.reason ?? 'pd_config_invalid', first?.nextAction ?? 'Repair the governance workspace .pd/config.yaml.')]);
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.workbuddy']?.enabled !== true) {
    // OD-03: default OFF; observable skip, no dispatch, no workspace writes.
    return neutralWithDiagnostics([diagnostic('skipped', 'host.workbuddy_disabled', 'Set features.host.workbuddy.enabled=true in the WorkBuddy governance workspace config to enable PD for WorkBuddy.')]);
  }
  const evidenceEnabled = flags.principle_receipt_ledger?.enabled === true;

  // projectDir = the host cwd (payload cwd; SessionStart carries none);
  // workspaceDir = the governance directory (OD-07). The decoder placed the
  // payload cwd in context.workspaceDir as the pre-rewrite carrier — capture
  // it before replacing with the governance workspace.
  const projectDir = event.context.workspaceDir.length > 0 ? event.context.workspaceDir : undefined;
  event = { ...event, context: { ...event.context, workspaceDir: resolution.workspaceDir } };

  const ownerReceipt = channelEventName === 'UserPromptSubmit'
    ? await recordWorkbuddyOwnerStatement(event, resolution.workspaceDir)
    : undefined;
  // SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 P0: only a REAL current-user
  // UserPromptSubmit may enter this quiet, default-OFF live keyword path.
  // It does not inspect transcripts or alter normal hook stdout / exit codes.
  const autoDiagnostics: string[] = [];
  if (channelEventName === 'UserPromptSubmit' &&
      event.kind === 'before_prompt_build' &&
      flags.workbuddy_live_keyword_pain?.enabled === true) {
    try {
      const raw = parsed as Record<string, unknown>;
      const prompt = event.context.promptContent;
      const fromOwner = Object.getOwnPropertyDescriptor(raw, 'is_internal_continuation')?.value === false;
      const nativeId = event.context.turnId;
      const explicitReserved = typeof prompt === 'string' && prompt.trimStart().startsWith('PD记录痛苦');
      if (fromOwner && nativeId !== undefined && nativeId.trim().length > 0 &&
          typeof prompt === 'string' && !explicitReserved) {
        // AUDIT-P3-01: 预检与 admitTrustedWorkbuddyLiveCorrection 内部使用同一份
        // 共享 live 词库（seed ∪ learned）——预检不会漏掉学习词，也不会比准入
        // 更宽。startsWith 预过滤与 matched 判据不变（无 LLM、无 transcript）。
        const matched = assessWorkbuddyLiveKeyword(
          prompt,
          event.context.sessionId,
          resolveSharedCorrectionKeywordStoreForDetection(resolution.workspaceDir),
        );
        if (matched.matched) {
          const admitted = admitTrustedWorkbuddyLiveCorrection({
            workspaceDir: resolution.workspaceDir,
            rawEvent: parsed,
          });
          if (!admitted.ok) {
            autoDiagnostics.push(diagnostic('degraded', 'workbuddy_keyword_admission_' + admitted.reason, admitted.nextAction));
          } else {
            for (const outcome of admitted.outcomes) {
              if (!('disposition' in outcome)) {
                autoDiagnostics.push(diagnostic('degraded', 'workbuddy_keyword_admission_rejected', outcome.reason));
                continue;
              }
              if (outcome.disposition === 'admitted' || outcome.disposition === 'already_admitted') {
                const ensured = await ensureGovernanceDiagnosticianTask({
                  workspaceDir: resolution.workspaceDir,
                  logicalObservationKey: outcome.logicalObservationKey,
                  canonicalPainId: outcome.canonicalPainId,
                });
                if (!ensured.ok) {
                  autoDiagnostics.push(diagnostic('degraded', 'workbuddy_keyword_task_' + ensured.reason, ensured.nextAction));
                } else {
                  // Metadata only: never log the raw prompt or fabricate a
                  // completed diagnosis, approval or activation.
                  try {
                    appendEventLogLine(path.join(resolution.workspaceDir, '.state'), {
                      ts: new Date().toISOString(),
                      type: 'workbuddy_keyword_pain_admitted',
                      category: 'detected',
                      sessionId: event.context.sessionId,
                      data: { hostKind: 'workbuddy', outcome: outcome.disposition,
                        painId: outcome.canonicalPainId, taskId: ensured.taskId },
                    });
                  } catch { /* Evidence-log failure must not block the prompt. */ }
                }
              } else if (outcome.disposition === 'rate_limited') {
                autoDiagnostics.push(diagnostic('degraded', 'workbuddy_keyword_rate_limited', 'Per-session strong signal limit reached; no new Pain was created.'));
              }
            }
          }
        } else if (matched.reason === 'prompt_too_large') {
          autoDiagnostics.push(diagnostic('degraded', 'workbuddy_keyword_prompt_too_large', 'Oversized prompt was not scanned or persisted as a keyword signal.'));
        }
      }
    } catch (error) {
      autoDiagnostics.push(diagnostic('degraded', 'workbuddy_keyword_unexpected:' + errorMessage(error), 'The current prompt was preserved; inspect the governance workspace.'));
    }
  }

  const receiptOutput = (output: WorkBuddyHookOutput | null): WorkBuddyHookOutput | null => ownerReceipt === undefined ? output : {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: [ownerReceipt, output?.hookSpecificOutput.additionalContext].filter(Boolean).join('\n\n') },
  };

  try {
    if (event.kind === 'session_start') {
      // SPEC §4.2: health check only — first version injects NO body, and the
      // neutral result is an EMPTY stdout (any stdout is context-injected).
      const health = await createProductionHostRuntime({ hostKind: 'workbuddy' }).health(resolution.workspaceDir);
      if (!health.ok) return neutralWithDiagnostics([diagnostic('degraded', health.reason ?? 'runtime_unhealthy', health.nextAction ?? 'Inspect the governance workspace runtime.')]);
      return neutralWithDiagnostics([]);
    }

    const evidenceDiagnostics: string[] = [];
    const evidenceContext: WorkbuddyEvidenceContext = {
      workspaceDir: resolution.workspaceDir,
      evidenceEnabled,
      warn: (line) => evidenceDiagnostics.push(diagnostic('degraded', line.replace(/^\[PD:Evidence\] /, 'workbuddy_evidence:'), 'Inspect workspace state.db evidence ledger; the durable raw source allows safe replay.')),
    };
    const stateDir = path.join(resolution.workspaceDir, '.state');
    const result: HostEventResult = await createProductionHostRuntime({
      ...(projectDir !== undefined ? { projectDir } : {}),
      hostKind: 'workbuddy',
      toolSemantics: WORKBUDDY_TOOL_SEMANTICS,
      events: workbuddyEventEmitter(stateDir, evidenceContext),
      // SPEC-RULECODE-HOST-PROMOTION-001 C: the V2 rule context provider over
      // WorkBuddy's own observable trajectory (same-session tool_calls rows
      // the shared afterToolCall path records). No designGate fact is
      // supplied — WorkBuddy has no design-gate attestation entry point, so
      // design_approval-dependent rules suspend with the precise
      // `rule_required_fact_unavailable` warning rather than borrowing
      // another host's declaration. Unavailable history (disabled flag, no
      // project scope, first session turn) degrades through the shared
      // suspension contract, observably.
      ruleContextProvider: createWorkbuddyRuleContextProvider({
        workspaceDir: resolution.workspaceDir,
        ...(projectDir !== undefined ? { projectDir } : {}),
        enabled: flags.rulecode_context_v2?.enabled === true,
        cutoffAt: hookEpoch,
        currentToolCallId: event.context.toolCallId ?? '',
        toolSemantics: WORKBUDDY_TOOL_SEMANTICS,
      }),
      // Remediation R2 (candidate-level admission): the diagnostician's
      // candidates are admitted ONLY with input evidence (needs_evidence
      // otherwise), and Codex-style transcript promotion does not exist on
      // this host. OpenClaw-parity: the HOOK supplies the evidence — a
      // sourceRef to the durable raw event line (idempotent replay source,
      // SPEC §13.7) plus a bounded failure note. No raw tool output is copied
      // (ADR-0027 hook-log content rule).
      painEnrichmentProvider: (hostEvent) => {
        if (hostEvent.kind !== 'after_tool_call') return {};
        const toolName = hostEvent.context.toolName ?? 'unknown-tool';
        const output = hostEvent.context.toolOutput;
        const detail = typeof output === 'object' && output !== null && !Array.isArray(output)
          ? Object.hasOwn(output, 'tool_error_code')
            ? `tool_error_code=${String((output as Record<string, unknown>).tool_error_code)}`
            : Object.hasOwn(output, 'exitCode')
              ? `exitCode=${String((output as Record<string, unknown>).exitCode)}`
              : 'failure'
          : 'failure';
        return {
          evidence: [{
            sourceRef: `workbuddy-pd-hook-event-log:${hostEvent.context.sessionId}`,
            note: `${toolName} failed (${detail}); raw payload in the durable workbuddy hook event log for this session`,
          }],
        };
      },
    }).dispatch(event);
    const evaluationDiagnostics = recordRuleHostEvaluations(stateDir, event.context.sessionId, result.metadata?.evaluations);
    // Encode BEFORE recording an attributed deny: a runtime_verified
    // application claims only what reached the stdout channel (P02: the
    // encoded permissionDecision is the verified blocking boundary).
    const encodedUnknown = adapter.encodeOutput(result, event.kind);
    if (encodedUnknown !== null && !isWorkBuddyHookOutput(encodedUnknown)) {
      throw new WorkBuddyEncoderError('encodeOutput produced a non-whitelisted document', 'Encode only the frozen hookSpecificOutput contract.');
    }
    const encoded = encodedUnknown;
    if (result.decision === 'deny') {
      try {
        let liveActivationId: string | undefined;
        const evaluations = result.metadata?.evaluations;
        if (Array.isArray(evaluations)) {
          for (const entry of evaluations) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
            const record = entry as Record<string, unknown>;
            const activationMode = Object.hasOwn(record, 'activationMode') ? record.activationMode : undefined;
            const activationId = Object.hasOwn(record, 'activationId') ? record.activationId : undefined;
            if (activationMode === 'live' && typeof activationId === 'string' && activationId.length > 0) {
              liveActivationId = activationId;
              break;
            }
          }
        }
        const { metadata } = result;
        const principleId = typeof metadata?.principleId === 'string' ? metadata.principleId : undefined;
        const ruleId = typeof metadata?.ruleId === 'string' ? metadata.ruleId : undefined;
        recordWorkbuddyDenyEvidence({
          workspaceDir: resolution.workspaceDir,
          sessionId: event.context.sessionId,
          ...(event.context.toolCallId !== undefined ? { toolCallId: event.context.toolCallId } : {}),
          toolName: event.context.toolName ?? 'unknown-tool',
          activationId: liveActivationId,
          principleId,
          ruleId,
          reason: result.reason,
          evidenceEnabled,
          warn: evidenceContext.warn,
        });
      } catch (error: unknown) {
        // P02: the deny was already encoded — an evidence failure must never
        // turn it into a release.
        evidenceDiagnostics.push(diagnostic('degraded', `workbuddy_evidence_deny_failed:${errorMessage(error)}`, 'The deny decision was already encoded; evidence replay from the durable source is safe.'));
      }
    }
    const stderr = [
      ...annotateContextWarnings(result.warnings ?? []).slice(0, 16).map((warning) => diagnostic('degraded', warning, 'Inspect the PD governance workspace state and retry; the hook stayed permissive (allow+warnings is degraded health, not fail-closed).')),
      ...evaluationDiagnostics,
      ...evidenceDiagnostics,
      ...autoDiagnostics,
    ];
    return { stdout: receiptOutput(encoded), exitCode: 0, stderr: [...stderr, ...(ownerReceipt === undefined ? [] : [ownerReceipt])] };
  } catch (error) {
    const reason = error instanceof WorkBuddyEncoderError ? error.reason : `runtime_failed:${errorMessage(error)}`;
    const nextAction = error instanceof WorkBuddyEncoderError ? error.nextAction : 'Inspect the PD governance workspace state and retry.';
    if (event.kind === 'before_tool_call') {
      // P02: exit 2 on the PreToolUse channel genuinely blocks the tool —
      // the only honest failure posture inside the supported governance path.
      return { stdout: null, exitCode: 2, stderr: [diagnostic('degraded', reason, `${nextAction} The tool call was blocked because PD could not verify it.`)] };
    }
    // UserPromptSubmit: protect the prompt (exit 2 clears it — P02).
    // after_tool_call: the tool already ran — report evidence degradation only.
    return { stdout: receiptOutput(null), exitCode: 0, stderr: [diagnostic('degraded', reason, nextAction), ...autoDiagnostics, ...(ownerReceipt === undefined ? [] : [ownerReceipt])] };
  }
}

// ─── Process-boundary belt (PRI-943 pattern, WorkBuddy exit-code semantics) ──
// No unrejected promise, unwritable stream, or unserializable result may reach
// node's default handling. Three failure modes (reproduced from spawned
// processes in tests/pd-hook-entry.test.ts):
//   * a write that THROWS synchronously — caught per write below;
//   * the host closing the pipe — an ASYNC 'error' event only a listener can
//     contain (ERR-156);
//   * the stdout JSON failing to SERIALIZE — per SPEC §4.4 never a silent
//     `{} + exit 0`: an undeliverable deny becomes exit 2 (P02: exit 2 blocks
//     even with stdout closed); every other channel keeps its exit code and
//     degrades observably on stderr.
let beltReported = false;
/**
 * Set once main() knows the registration channel: a STDOUT delivery failure
 * on the PreToolUse channel means a computed deny was lost, and P02 proved
 * exit 2 blocks the tool even with a dead stdout — so the belt escalates the
 * exit code instead of letting the tool run unblocked.
 */
let blockingChannelArmed = false;

function writeBeltDiagnostic(reason: string, nextAction: string): void {
  if (beltReported) return;
  beltReported = true;
  try {
    process.stderr.write(`${diagnostic('degraded', reason, nextAction)}\n`);
  } catch {
    // Both streams gone: no channel remains inside the belt's contract.
  }
}

function reportStdoutFailure(error: unknown): void {
  writeBeltDiagnostic(
    `hook_stream_failed:${errorMessage(error)}`,
    'The host closed the pipe; retry the hook invocation.',
  );
  // The deny bytes could not be delivered — the exit code is the only
  // remaining real blocker (P02: stdout-closed exit 2 still blocks).
  if (blockingChannelArmed && (process.exitCode ?? 0) === 0) process.exitCode = 2;
}

function reportStderrFailure(error: unknown): void {
  // stderr loss never loses a decision — stdout remains the contract channel.
  writeBeltDiagnostic(
    `hook_stream_failed:${errorMessage(error)}`,
    'The host closed the pipe; retry the hook invocation.',
  );
}

function writeStream(stream: 'stdout' | 'stderr', line: string): boolean {
  try {
    process[stream].write(`${line}\n`);
    return true;
  } catch (error) {
    if (stream === 'stdout') reportStdoutFailure(error);
    else reportStderrFailure(error);
    return false;
  }
}

function armStreamBelts(): void {
  process.stdout.on('error', reportStdoutFailure);
  process.stderr.on('error', reportStderrFailure);
}

/**
 * rc-8 + SPEC §4.4: serialization failure of the stdout contract is never a
 * silent `{} + exit 0`. Returns the serialized line, or null when nothing can
 * be delivered — plus whether an undeliverable deny must escalate this
 * invocation to a blocking exit 2 (PreToolUse channel only).
 */
function serializeStdout(value: WorkBuddyHookOutput, channelEventName: string | undefined): { line: string | null; escalateToBlocking: boolean } {
  try {
    return { line: JSON.stringify(value), escalateToBlocking: false };
  } catch (error) {
    writeBeltDiagnostic(
      `hook_stdout_serialize_failed:${errorMessage(error)}`,
      'Retry the invocation; the stdout contract could not be serialized.',
    );
    // An undeliverable deny loses the P02-verified blocking channel — the
    // exit code is the only remaining real blocker, so use it (PreToolUse
    // registration channel only; a UserPromptSubmit additionalContext loss
    // degrades without blocking so the prompt is preserved).
    return { line: null, escalateToBlocking: channelBlocksOnFailure(channelEventName) };
  }
}

async function main(): Promise<void> {
  // argv[2] is the wrapper's event argument (argv[0]=node, argv[1]=script).
  // Double-hole destructuring — eslint's member-access fix `[, x]` would
  // silently read argv[1] (the SCRIPT PATH) as the channel.
  const [, , channelEventName] = process.argv;
  blockingChannelArmed = channelBlocksOnFailure(channelEventName);
  let raw: string;
  try { raw = readFileSync(0, 'utf8'); }
  catch (error) {
    writeStream('stderr', diagnostic('degraded', `stdin_read_failed:${errorMessage(error)}`, 'Run the hook from WorkBuddy with JSON stdin.'));
    process.exitCode = 0;
    return;
  }
  let result: WorkBuddyPdHookResult;
  try {
    result = await processWorkbuddyHookInvocation(raw, channelEventName);
  } catch (error) {
    // Belt for an unexpected pre-dispatch throw: the host still gets a clean
    // neutral (empty stdout) instead of a bare crash — never stdout noise.
    writeStream('stderr', diagnostic('degraded', `hook_pipeline_unexpected:${errorMessage(error)}`, 'Retry the hook invocation; if it repeats, inspect PD stderr and the governance workspace config.'));
    result = { stdout: null, exitCode: 0, stderr: [] };
  }
  for (const line of result.stderr) {
    if (!writeStream('stderr', line)) break;
  }
  let {exitCode} = result;
  if (result.stdout !== null) {
    const { line, escalateToBlocking } = serializeStdout(result.stdout, channelEventName);
    const delivered = line !== null && writeStream('stdout', line);
    if (escalateToBlocking && exitCode === 0) exitCode = 2;
    // A serialized deny whose bytes could not REACH stdout (sync write throw)
    // must not degrade to exit 0: on the blocking channel the exit code is
    // then the only real blocker left (P02: stdout-closed exit 2 blocks).
    // The belt's reportStdoutFailure covers the ASYNC stream-error variant.
    if (!delivered && blockingChannelArmed && exitCode === 0) exitCode = 2;
  }
  process.exitCode = exitCode;
}

// Node resolves the main module through symlinks/junctions while argv[1]
// keeps the unresolved link path (npm shims, junctioned runtime dirs — the
// install layout junctions ~/.pd/runtime), so compare the raw URL first,
// then canonicalize through realpath (PRI-892 pattern).
function isMainModuleEntry(): boolean {
  const [, entry] = process.argv;
  if (!entry) return false;
  if (pathToFileURL(entry).href === import.meta.url) return true;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch (error) {
    if (path.basename(entry) !== path.basename(fileURLToPath(import.meta.url))) return false;
    writeStream('stderr', diagnostic('degraded', `entry_identity_unverified:${errorMessage(error)}`, 'Reinstall the WorkBuddy adapter; if it repeats, report this line together with the command that invoked the hook.'));
    return true;
  }
}

if (isMainModuleEntry()) {
  armStreamBelts();
  void main().catch((error: unknown) => {
    writeBeltDiagnostic(
      `hook_fatal:${errorMessage(error)}`,
      'Retry the hook invocation; if it repeats, report this line together with the command that invoked the hook.',
    );
    // The WorkBuddy neutral is EMPTY stdout — nothing to write here; the
    // process must terminate with a real exit code on every path.
    if (process.exitCode === undefined) process.exitCode = 0;
  });
}
