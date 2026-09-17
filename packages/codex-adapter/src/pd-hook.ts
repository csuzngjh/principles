#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendEventLogLine, redactTelemetryString, isRuleHostEvaluatedEventData, type RuleHostEvaluatedEventData } from '@principles/core/runtime-v2';
import type { HostEventEmitter, HostEventKind } from '@principles/core/host';
import { createProductionHostRuntime, loadPdConfigForPlugin, resolveNearestPdWorkspace } from '@principles/host-runtime';
import { CODEX_TOOL_SEMANTICS } from './tool-semantics.js';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime-v2';
import { CodexHooksHostAdapter } from './host-adapter.js';
import { CodexDecoderError, CodexEncoderError } from './codec/index.js';
import { ingestCodexConversation } from './ingestion/ingestion.js';
import { runGovernanceAdmission } from './ingestion/admission.js';

type EnvMap = Record<string, string | undefined>;
export interface PdHookResult { stdout: unknown; exitCode: number; stderr: string[] }

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
function codexEventEmitter(stateDir: string): HostEventEmitter {
  return {
    recordRuntimeV2ActivationsInjected(data) {
      appendEventLogLine(stateDir, {
        ts: new Date().toISOString(),
        type: 'runtime_v2_prompt_activations_injected',
        category: 'injected',
        sessionId: data.sessionId,
        data,
      });
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
 * PRI-813: admissible evaluation entry = the CANONICAL core schema guard
 * (rc-1/rc-2, P4: no hand-rolled field copy that could drift from the
 * contract) plus one caller policy: a shadow observation without
 * activationId is dead evidence — the shadow summary keys on the exact id —
 * so it is rejected here (CodeRabbit CR-6).
 */
function isAdmissibleRuleHostEvaluationEntry(value: unknown): value is RuleHostEvaluatedEventData {
  return isRuleHostEvaluatedEventData(value)
    && (value.activationMode !== 'shadow' || typeof value.activationId === 'string');
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

/**
 * PRI-780 Codex capability declaration (structured UNSUPPORTED — suspension
 * semantics, revised after Codex review round 2 P1): the Codex host has no
 * runtime context provider, and the "unavailable → allow" contract is
 * generation-time prompt discipline, NOT a runtime-enforced invariant. Handing
 * v2 rules a truthy unavailable-posture context would let a persisted rule
 * evaluate context-blind and DENY tool calls that were previously suspended —
 * a silent governance behavior change. Codex therefore passes NO context
 * provider: the shared gate skips v2 rules with its structured
 * `rule_context_v2_unavailable` warning, and this hook annotates that warning
 * with the explicit host-unsupported reason before it reaches Codex stderr
 * (see annotateContextWarnings — ticket option B: 明确 unsupported + 结构化
 * warning, never a silent skip).
 */
const CODEX_CONTEXT_UNSUPPORTED_NOTE = 'codex_runtime_context_unsupported: the Codex host provides no runtime context provider; v2 rules stay suspended on this host';

export function annotateContextWarnings(warnings: readonly string[]): string[] {
  return warnings.map((warning) => warning.startsWith('rule_context_v2_unavailable')
    ? `${warning}; ${CODEX_CONTEXT_UNSUPPORTED_NOTE}`
    : warning);
}

// Bounded governance-observation ingestion (Codex Governance Closure Slice
// A) followed by the Slice B signal-admission pass (SPEC §12/§13): detection
// → canonical pain → evidence promotion → one pending Diagnostician task.
// Runs only when BOTH host.codex and codex_conversation_ingestion are
// enabled — the flag gate below happens BEFORE any transcript path
// validation or filesystem I/O, so flag-off means the transcript boundary
// receives zero calls (SPEC §10 hard privacy invariant). Admission runs
// BEFORE dispatch so a live tool failure is admitted through the same
// canonical derivation first and the production handler's duplicate probe
// then converges to a no-op (exactly one pain per real tool call).
async function runConversationIngestion(args: { rawPayload: unknown; kind: HostEventKind; workspaceDir: string; env: EnvMap }): Promise<string[]> {
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
      const admission = await runGovernanceAdmission({
        workspaceDir,
        candidates: outcome.admissionCandidates,
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

export async function processHookInvocation(rawStdin: string, _env: EnvMap = process.env, cwd = process.cwd()): Promise<PdHookResult> {
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

  // Codex 0.147 supplies the invocation cwd. It is the authoritative starting
  // point; a process-global environment variable can otherwise route one
  // Workspace's hook into another Workspace's business state.
  const requestedCwd = event.context.workspaceDir || cwd;
  const resolution = resolveNearestPdWorkspace(requestedCwd);
  if (!resolution.ok) return { stdout: {}, exitCode: 0, stderr: [diagnostic(resolution.reason, resolution.nextAction)] };
  event = { ...event, context: { ...event.context, workspaceDir: resolution.workspaceDir } };
  const config = loadPdConfigForPlugin(resolution.workspaceDir);
  if (!config.ok) {
    const [first] = config.errors;
    return { stdout: {}, exitCode: 0, stderr: [diagnostic(first?.reason ?? 'pd_config_invalid', first?.nextAction ?? 'Repair .pd/config.yaml.')] };
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.codex']?.enabled !== true) {
    return { stdout: {}, exitCode: 0, stderr: [diagnostic('host.codex_disabled', 'Set features.host.codex.enabled=true in the selected Workspace to enable PD.')] };
  }
  const ingestionEnabled = flags.codex_conversation_ingestion?.enabled === true;

  if (event.kind === 'turn_complete') {
    // Stop is the turn-complete ingestion trigger (G1 §2): no dispatch route,
    // and Codex's Stop output schema has no hookSpecificOutput — the neutral
    // result is exactly `{}` on stdout (runtime contract: "PD emits empty
    // stdout on Stop"). Flag-off preserves the zero-transcript-read invariant
    // and emits ONE bounded structured feature_disabled fact per completed
    // turn on stderr — never stdout, and never on the per-tool events (that
    // would be per-event noise).
    const stderr = ingestionEnabled
      ? await runConversationIngestion({ rawPayload: parsed, kind: event.kind, workspaceDir: resolution.workspaceDir, env: _env })
      : [diagnostic('feature_disabled', 'Set features.codex_conversation_ingestion.enabled=true in the selected Workspace .pd/config.yaml to enable bounded conversation ingestion.')];
    return { stdout: {}, exitCode: 0, stderr };
  }

  try {
    if (event.kind === 'session_start') {
      const health = await createProductionHostRuntime({ hostKind: 'codex' }).health(resolution.workspaceDir);
      if (!health.ok) return { stdout: {}, exitCode: 0, stderr: [diagnostic(health.reason ?? 'runtime_unhealthy', health.nextAction ?? 'Inspect the Workspace runtime.')] };
      return { stdout: adapter.encodeOutput({ decision: 'allow', source: event.source }, 'session_start'), exitCode: 0, stderr: [] };
    }
    const ingestionDiagnostics = ingestionEnabled
      ? await runConversationIngestion({ rawPayload: parsed, kind: event.kind, workspaceDir: resolution.workspaceDir, env: _env })
      : [];
    // PRI-750: emit shared-path injection/tool events with the host's natural
    // turn/tool ids (turn_id → runId, tool_use_id → toolCallId) through the core
    // event-JSONL writer (same events_*.jsonl format as the OpenClaw EventLog;
    // the Codex adapter stays independent of the OpenClaw plugin). The line
    // writer appends synchronously — no flush/dispose needed for the subprocess.
    const result = await createProductionHostRuntime({
      hostKind: 'codex',
      toolSemantics: CODEX_TOOL_SEMANTICS,
      events: codexEventEmitter(path.join(resolution.workspaceDir, '.state')),
      // PRI-780 (revised after Codex review round 2 P1): NO context provider —
      // v2 rules stay SUSPENDED on Codex (never loaded context-blind). See
      // annotateContextWarnings for the structured unsupported declaration.
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
    const stderr = [...annotateContextWarnings(result.warnings ?? []).slice(0, 16).map((warning) => diagnostic(warning, 'Inspect PD Workspace state and retry; the hook failed open.')), ...evaluationDiagnostics, ...ingestionDiagnostics];
    return { stdout: adapter.encodeOutput(result, event.kind), exitCode: 0, stderr };
  } catch (error) {
    const reason = error instanceof CodexEncoderError ? error.reason : `runtime_failed:${errorMessage(error)}`;
    const nextAction = error instanceof CodexEncoderError ? error.nextAction : 'Inspect PD Workspace state and retry; the hook failed open.';
    return { stdout: {}, exitCode: 0, stderr: [diagnostic(reason, nextAction)] };
  }
}

async function main(): Promise<void> {
  let raw: string;
  try { raw = readFileSync(0, 'utf8'); }
  catch (error) {
    process.stderr.write(`${diagnostic(`stdin_read_failed:${errorMessage(error)}`, 'Run the hook from Codex with JSON stdin.')}\n`);
    process.stdout.write('{}\n');
    return;
  }
  let result: PdHookResult;
  try {
    result = await processHookInvocation(raw);
  } catch (error) {
    // Fail-open belt for an unexpected pre-dispatch throw (e.g. a workspace
    // resolution race): Codex must still receive exactly one JSON object on
    // stdout and a bounded diagnostic on stderr — never a bare crash.
    process.stderr.write(`${diagnostic(`hook_pipeline_unexpected:${errorMessage(error)}`, 'Retry the tool call; if it repeats, inspect PD stderr and the Workspace .pd/config.yaml state.')}\n`);
    result = { stdout: {}, exitCode: 0, stderr: [] };
  }
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
  process.exitCode = result.exitCode;
}

const [, entry] = process.argv;
if (entry && import.meta.url === pathToFileURL(entry).href) void main();
