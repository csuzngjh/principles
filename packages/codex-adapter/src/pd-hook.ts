#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { appendEventLogLine, redactTelemetryString, isRuleHostEvaluatedEventData, type RuleHostEvaluatedEventData } from '@principles/core/runtime-v2';
import type { HostEventEmitter, HostEventKind } from '@principles/core/host';
import { createProductionHostRuntime, loadPdConfigForPlugin, resolveNearestPdWorkspace } from '@principles/host-runtime';
import { CODEX_TOOL_SEMANTICS } from './tool-semantics.js';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime-v2';
import { CodexHooksHostAdapter } from './host-adapter.js';
import { CodexDecoderError, CodexEncoderError } from './codec/index.js';
import { ingestCodexConversation } from './ingestion/ingestion.js';
import { runGovernanceAdmission } from './ingestion/admission.js';
import { recordCodexPromptDeliveryEvidence, recordCodexDenyEvidence } from './codex-evidence-recorder.js';

type EnvMap = Record<string, string | undefined>;
export interface PdHookResult { stdout: unknown; exitCode: number; stderr: string[] }

/** PD v2 Phase 1: evidence context the emitter needs (subprocess-local). */
export interface CodexEvidenceContext {
  workspaceDir: string;
  evidenceEnabled: boolean;
  warn: (diagnosticLine: string) => void;
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
function codexEventEmitter(stateDir: string, evidence?: CodexEvidenceContext): HostEventEmitter {
  return {
    recordRuntimeV2ActivationsInjected(data) {
      appendEventLogLine(stateDir, {
        ts: new Date().toISOString(),
        type: 'runtime_v2_prompt_activations_injected',
        category: 'injected',
        sessionId: data.sessionId,
        data,
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
    const result = await createProductionHostRuntime({
      projectDir: requestedCwd,
      hostKind: 'codex',
      toolSemantics: CODEX_TOOL_SEMANTICS,
      events: codexEventEmitter(path.join(resolution.workspaceDir, '.state'), evidenceContext),
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
    // PD v2 Phase 1: encode BEFORE recording an attributed deny — a
    // runtime_verified application claims only what reached the stdout
    // channel (codex_permission_decision_encoded boundary). Dormant while
    // v2 enforcement is suspended (PRI-780); wired honestly for the day it
    // is not.
    const encoded = adapter.encodeOutput(result, event.kind);
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
    const stderr = [...annotateContextWarnings(result.warnings ?? []).slice(0, 16).map((warning) => diagnostic(warning, 'Inspect PD Workspace state and retry; the hook failed open.')), ...evaluationDiagnostics, ...evidenceDiagnostics, ...ingestionDiagnostics];
    return { stdout: encoded, exitCode: 0, stderr };
  } catch (error) {
    const reason = error instanceof CodexEncoderError ? error.reason : `runtime_failed:${errorMessage(error)}`;
    const nextAction = error instanceof CodexEncoderError ? error.nextAction : 'Inspect PD Workspace state and retry; the hook failed open.';
    return { stdout: {}, exitCode: 0, stderr: [diagnostic(reason, nextAction)] };
  }
}

// PRI-943: process-boundary fail-open belt. Every resolved path sets exitCode 0,
// so nothing may let an unwritable stream or an escaping rejection reach node's
// default handling, which terminates the hook with exit 1. Two distinct failure
// modes, both reproduced in tests/pd-hook-entry-belt.test.ts:
//   * a write that THROWS synchronously — caught per write below;
//   * a host closing the pipe, which raises an ASYNC 'error' event on the
//     Socket. try/catch cannot reach that one, so a listener is required
//     (armStreamBelts) or node aborts with "Unhandled 'error' event".
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
    result = await processHookInvocation(raw);
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
  stdoutJsonDelivered = writeStream('stdout', JSON.stringify(result.stdout));
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
