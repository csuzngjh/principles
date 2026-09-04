#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { HostEventKind } from '@principles/core/host';
import { createProductionHostRuntime, loadPdConfigForPlugin, resolveNearestPdWorkspace } from '@principles/host-runtime';
import { CODEX_TOOL_SEMANTICS } from './tool-semantics.js';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime-v2';
import { CodexHooksHostAdapter } from './host-adapter.js';
import { CodexDecoderError, CodexEncoderError } from './codec/index.js';
import { ingestCodexConversation } from './ingestion/ingestion.js';
import { runGovernanceAdmission } from './ingestion/admission.js';

type EnvMap = Record<string, string | undefined>;
export interface PdHookResult { stdout: unknown; exitCode: number; stderr: string[] }
const MAX_DIAGNOSTIC = 500;

function diagnostic(reason: string, nextAction: string): string {
  const boundedReason = reason.replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC);
  const boundedNextAction = nextAction.replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC);
  return `[PD] status=degraded reason=${boundedReason} nextAction=${boundedNextAction}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, MAX_DIAGNOSTIC) : 'unknown_error';
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
    const result = await createProductionHostRuntime({ hostKind: 'codex', toolSemantics: CODEX_TOOL_SEMANTICS }).dispatch(event);
    const stderr = [...(result.warnings ?? []).slice(0, 16).map((warning) => diagnostic(warning, 'Inspect PD Workspace state and retry; the hook failed open.')), ...ingestionDiagnostics];
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
