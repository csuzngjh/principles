#!/usr/bin/env node
/**
 * pd-hook.js — Single entry script + event router for Codex CLI (ADR-0020 §2.5)
 *
 * Codex spawns this script for each hook event. It:
 *   1. Reads JSON from stdin (Codex's snake_case payload).
 *   2. Routes by `hook_event_name` to the CodexHooksHostAdapter.
 *   3. Invokes PD's hook business logic (currently a stub — wired to
 *      openclaw-plugin's existing handlers in a follow-up PR).
 *   4. Encodes the result as camelCase JSON on stdout.
 *   5. Exits with the correct exit code (0 = proceed, 2 = block).
 *
 * Feature flag: when `host.codex.enabled = false` (default, ADR-0020 §2.4),
 * the script short-circuits to `{}` + exit 0 BEFORE invoking any adapter
 * logic. This is fail-dark — PD's gate is NOT applied. The flag flip is gated
 * on PRI-282 E2E validation passing on pinned Codex >= 0.124.0.
 *
 * Workspace resolution: Codex does not pass `workspace_dir` in the hook
 * payload. The script resolves it from:
 *   (a) PD_WORKSPACE_DIR env var (set by CodexHostInstaller at install time)
 *   (b) process.cwd() as fallback (least surprise for ad-hoc invocations)
 * ...then injects it into the raw payload before decoding.
 *
 * Exit code semantics:
 *   0 — success (Codex parses stdout JSON; continue = true proceeds)
 *   2 — hard block (Codex blocks the tool call, ignores stdout)
 *
 * Failure modes (rc-9-no-silent-fallback):
 *   - Decode error  → log to stderr, stdout `{}`, exit 0 (fail-OPEN: better
 *     to let Codex proceed than to crash the agent loop on a malformed payload).
 *   - Encode error  → log to stderr, stdout `{}`, exit 0 (fail-OPEN).
 *   - Business error → log to stderr, stdout `{}`, exit 0 (fail-OPEN).
 *
 *   Fail-OPEN is intentional: PD is an observer/gate, not a critical-path
 *   component. If PD crashes, Codex should continue. The gate is bypassed,
 *   but the agent loop is not broken. Observability is preserved via stderr
 *   logs (which Codex surfaces in the /hooks TUI as "Failed" status).
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { CodexHooksHostAdapter } from './host-adapter.js';
import { CodexDecoderError, CodexEncoderError } from './codec/index.js';
import type { HostEvent, HostEventKind, HostEventResult } from '@principles/core/host';

/** Environment variable map (avoids NodeJS global namespace for ESLint). */
type EnvMap = Record<string, string | undefined>;

/** Type guard: narrows unknown to a mutable record (rc-2: no `as` bypass). */
function isObjectPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Public entry (exported for testability) ────────────────────────────────
export interface PdHookResult {
  /** stdout JSON to emit (object, will be JSON.stringify'd by the caller). */
  stdout: unknown;
  /** exit code (0 = proceed, 2 = block). */
  exitCode: number;
  /** stderr lines for observability (rc-9). */
  stderr: string[];
}

/**
 * Stub for PD's hook business logic. The real implementation will be wired
 * in PRI-281 via the runtime-protocol (PD calls openclaw-plugin's gate/pain/
 * prompt handlers through a shared dispatch interface).
 *
 * For PRI-280 skeleton: returns an `allow` decision with no additional context.
 */
function invokeBusinessLogic(event: HostEvent): HostEventResult {
  // PRI-280 skeleton: allow everything, observe only.
  // PRI-281 will replace this with the real dispatcher.
  return {
    decision: 'allow',
    source: event.source,
  };
}

/**
 * Process a single Codex hook invocation.
 *
 * @param rawStdin the raw stdin bytes from Codex
 * @param env the environment overrides (default: process.env)
 */
export function processHookInvocation(
  rawStdin: string,
  env: EnvMap = process.env,
): PdHookResult {
  const stderr: string[] = [];

  // ─── Feature flag short-circuit (host.codex default OFF) ────────────────
  // Read from .pd/config.yaml at startup. For MVP simplicity we read a single
  // env var PD_HOST_CODEX_ENABLED ('true' / '1') set by the installer; the
  // full config.yaml loader lives in pd-cli and is not imported here (the
  // hook script must stay dependency-light to minimize cold start).
  const flagRaw = env.PD_HOST_CODEX_ENABLED;
  const flagEnabled = flagRaw === 'true' || flagRaw === '1';
  if (!flagEnabled) {
    // rc-9: non-silent — log the skip reason so /hooks TUI shows it.
    stderr.push('[PD] host.codex flag is OFF — short-circuiting to {} + exit 0');
    return { stdout: {}, exitCode: 0, stderr };
  }

  // ─── Parse stdin ────────────────────────────────────────────────────────
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawStdin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.push(`[PD] stdin JSON parse failed: ${msg}`);
    // fail-OPEN: output {} and exit 0
    return { stdout: {}, exitCode: 0, stderr };
  }

  // ─── Inject workspace_dir (Codex does not pass it in the payload) ────────
  // rc-2: use type guard instead of `as` cast to narrow JSON.parse result.
  if (isObjectPayload(rawPayload)) {
    if (!Object.hasOwn(rawPayload, 'workspace_dir')) {
      const ws = env.PD_WORKSPACE_DIR ?? process.cwd();
      rawPayload.workspace_dir = ws;
    }
  }

  // ─── Decode ─────────────────────────────────────────────────────────────
  const adapter = new CodexHooksHostAdapter();
  let event: HostEvent;
  try {
    event = adapter.decodeEvent(rawPayload);
  } catch (err) {
    if (err instanceof CodexDecoderError) {
      stderr.push(`[PD] decode failed: ${err.reason} | nextAction: ${err.nextAction}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.push(`[PD] decode threw: ${msg}`);
    }
    // fail-OPEN
    return { stdout: {}, exitCode: 0, stderr };
  }

  // ─── Invoke business logic (stub — wired in a follow-up PR) ──────────────
  // PRI-280 ships the codec + adapter + pd-hook skeleton. The actual
  // invocation of openclaw-plugin's gate/pain/prompt handlers happens in
  // PRI-281 (installer integration) — the adapter invokes the shared
  // business logic via a runtime-protocol call, not a direct import.
  let result: HostEventResult;
  try {
    result = invokeBusinessLogic(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.push(`[PD] business logic threw: ${msg}`);
    // fail-OPEN
    return { stdout: {}, exitCode: 0, stderr };
  }

  // ─── Encode ─────────────────────────────────────────────────────────────
  let stdout: unknown;
  try {
    stdout = adapter.encodeOutput(result, event.kind);
  } catch (err) {
    if (err instanceof CodexEncoderError) {
      stderr.push(`[PD] encode failed: ${err.reason} | nextAction: ${err.nextAction}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.push(`[PD] encode threw: ${msg}`);
    }
    // fail-OPEN
    return { stdout: {}, exitCode: 0, stderr };
  }

  // ─── Exit code mapping ──────────────────────────────────────────────────
  // exit 2 = hard block (Codex blocks the tool call, ignores stdout)
  // Currently PD never hard-blocks (deny is communicated via permissionDecision
  // in the JSON). Exit 2 is reserved for future use cases where PD detects
  // an unrecoverable safety violation.
  const exitCode = 0;

  return { stdout, exitCode, stderr };
}

// ─── CLI entrypoint (when run as `node pd-hook.js`) ─────────────────────────
function main(): void {
  // Read all of stdin synchronously (Codex writes a single JSON object).
  // Using readFileSync(0) for sync read; fd 0 = stdin.
  let rawStdin = '';
  try {
    rawStdin = readFileSync(0, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[PD] stdin read failed: ${msg}\n`);
    process.stdout.write('{}\n');
    process.exit(0);
  }

  const result = processHookInvocation(rawStdin, process.env);

  for (const line of result.stderr) {
    process.stderr.write(`${line}\n`);
  }
  process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
  process.exit(result.exitCode);
}

// Run only when invoked directly (not when imported for tests)
const isMain = (() => {
  // Check both CommonJS and ESM entry-point conventions.
  // - CommonJS: process.argv[1] ends with 'pd-hook.js'
  // - ESM: import.meta.url basename === 'pd-hook.js'
  if (typeof process !== 'undefined' && process.argv[1]) {
    const arg1 = String(process.argv[1]);
    if (arg1.endsWith('pd-hook.js') || arg1.endsWith('pd-hook.cjs')) {
      return true;
    }
  }
  return false;
})();

if (isMain) {
  main();
}

// Suppress unused-import warning for HostEventKind — it's the documented
// interface contract even if invokeBusinessLogic stub doesn't use it yet.
export type { HostEventKind };
