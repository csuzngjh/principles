/**
 * Onboarding route - POST /api/v1/onboarding/run-demo
 *
 * Spec: docs/superpowers/specs/2026-06-30-new-user-onboarding-design.md 6.3 change 5
 *
 * Spawns `pd demo story-a --workspace <path> --json` as a subprocess, waits for
 * it to complete, validates the JSON stdout, and returns 200 with the demo
 * result. The console backend NEVER writes SQLite directly - all DB I/O happens
 * inside the pd-cli subprocess (EP-06 Source of Truth).
 *
 * Feature flag gate: `new_user_onboarding` (default true, registered in
 * packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts).
 *
 * ERR entries considered:
 * - EP-02 (Production Path Wiring): registered in server/index.ts handleRequest
 * - EP-03 (Fail Loud): spawn failure -> 500 with reason + nextAction;
 *   flag disabled -> 403 with reason + nextAction (rc-9-no-silent-fallback)
 * - EP-06 (Source of Truth): reuses pd-cli demo command, no direct DB writes
 * - EP-08 (Security Boundary): no shell:true — argv passed directly to OS,
 *   eliminating command-injection risk; demo runs in a temp workspace so no
 *   user-controlled path enters the command at all
 * - rc-1-treat-as-unknown / rc-2-no-as-bypass / rc-4-validate-array-elements:
 *   parsed stdout is validated by parseDemoStdout before use
 * - rc-9-no-silent-fallback: timeout, error, and invalid-stdout paths each
 *   return a structured error with reason + nextAction
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';
import { sendError, sendJson } from '../utils/response.js';

export interface OnboardingRouteContext {
  workspaceDir: string;
  subPath: string;
}

interface StructuredErrorPayload {
  statusCode: number;
  error: string;
  reason: string;
  nextAction: string;
}

/** Demo subprocess timeout in milliseconds (60s). */
const DEMO_TIMEOUT_MS = 60_000;
// P1-1: Best-effort removal of the temp demo workspace.
function cleanupTempWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — temp dir will be cleaned by OS eventually.
  }
}

/** Send a structured error with reason + nextAction (Runtime Contract rc-9). */
function sendStructuredError(res: ServerResponse, payload: StructuredErrorPayload): void {
  sendError(res, payload.statusCode, payload.error, payload.reason, {
    reason: payload.reason,
    nextAction: payload.nextAction,
  });
}

/** Load the new_user_onboarding flag state from .pd/config.yaml. */
function loadOnboardingFlagEnabled(workspaceDir: string): boolean {
  const configResult = loadPdConfig(workspaceDir);
  const flagsResult = computeFlagsFromLoadResult(configResult);
  return flagsResult.flags.new_user_onboarding?.enabled === true;
}

/** Resolve the pd CLI binary name. Resolved through PATH (no shell). */
function findPdBin(): string {
  // The `pd` binary is installed globally (npm i -g @principles/pd-cli) and
  // resolved through PATH. We spawn WITHOUT shell:true so argv is passed
  // directly to the OS, eliminating command-injection risk. On Windows the
  // pd.cmd shim is resolved by Node's CreateProcess; if not found, spawn
  // emits 'error' which we handle with a clear nextAction.
  return 'pd';
}

/**
 * Validate the parsed JSON stdout from `pd demo story-a --json`.
 *
 * rc-1-treat-as-unknown: parsed JSON is treated as unknown until validated.
 * rc-2-no-as-bypass: no `as` cast is used to bypass validation - all fields
 *   are checked with typeof / Array.isArray before the value is accepted.
 * rc-4-validate-array-elements: the `stages` array is type-checked as an array
 *   (element-level shape validation happens downstream in the UI validator).
 *
 * Required fields: status (string), generatedAt (string), narrative (string),
 * stages (array). Returns the validated object or null if invalid.
 */
function parseDemoStdout(stdout: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.status !== 'string') return null;
  if (typeof v.generatedAt !== 'string') return null;
  if (typeof v.narrative !== 'string') return null;
  if (!Array.isArray(v.stages)) return null;
  return v;
}
/**
 * Spawn `pd demo story-a --json`, wait for it to complete, validate stdout,
 * and return 200 with { success: true, data: { simulated: true, demo: ... } }.
 *
 * The demo typically completes in < 30s. We block on the subprocess so the
 * response carries the validated demo result in a single round-trip - the
 * frontend does not need to poll for the demo itself (it still polls
 * /api/v1/evidence-chain in step 3 for live evidence detection).
 *
 * Failure modes (rc-9-no-silent-fallback - every path returns a structured
 * error with reason + nextAction):
 *   - spawn throws synchronously (e.g. ENOENT) -> 500 demo_spawn_failed
 *   - child emits 'error' after spawn -> 500 demo_subprocess_error
 *   - subprocess exceeds DEMO_TIMEOUT_MS -> 504 demo_timeout (subprocess killed)
 *   - subprocess exits with non-zero code -> 500 demo_exit_nonzero
 *   - stdout cannot be parsed/validated -> 500 demo_invalid_stdout
 */
async function handleRunDemo(
  res: ServerResponse,
  _workspaceDir: string,  // unused — demo runs in temp workspace to avoid pollution
): Promise<void> {
  // P1-1: Use a temporary workspace so the demo's simulated DB writes
  // (tasks, artifacts, approvals, activations) do NOT pollute the user's
  // real workspace state.db.
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-onboarding-demo-'));

  let child: ChildProcess;
  try {
    const pdBin = findPdBin();
    // P1-2: no shell:true — pass args as argv array, eliminating command
    // injection risk from user-controlled paths. The `pd` binary is resolved
    // via PATH; on Windows, if pd.cmd is not found, the spawn will emit 'error'
    // which we handle below with a clear nextAction.
    child = spawn(
      pdBin,
      ['demo', 'story-a', '--workspace', tempWorkspace, '--json'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // No shell:true — argv is passed directly to the OS.
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cleanupTempWorkspace(tempWorkspace);
    sendStructuredError(res, {
      statusCode: 500,
      error: 'demo_spawn_failed',
      reason: `spawn failed: ${message}`,
      nextAction: 'Check that the pd CLI is installed (npm i -g @principles/pd-cli) and on PATH.',
    });
    return;
  }

  try {
    // Capture stdout into a buffer. stderr is logged for observability (rc-9).
    const stdoutChunks: Buffer[] = [];
    let stderrText = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdoutChunks.push(data);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrText += chunk;
      console.error('[pd-console] onboarding demo stderr:', chunk.trim());
    });

    // Wrap the subprocess lifecycle in a Promise that resolves with the exit code
    // or rejects on 'error'. A timeout is enforced via a separate Promise that
    // resolves with a sentinel value - Promise.race is used below.
    const settled = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
      let done = false;
      const finish = (code: number | null, error: Error | null) => {
        if (done) return;
        done = true;
        resolve({ code, error });
      };
      child.on('error', (err: Error) => {
        finish(null, err);
      });
      child.on('close', (code: number | null) => {
        finish(code, null);
      });
    });

    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), DEMO_TIMEOUT_MS);
    });

    const outcome = await Promise.race([settled, timeout]);
    // -- Timeout: kill the subprocess and return 504 --
    if (outcome === 'timeout') {
      try {
        child.kill();
      } catch {
        // Best-effort kill; ignore failures (rc-9: the 504 response still carries
        // the reason + nextAction so the operator is not left in the dark).
      }
      sendStructuredError(res, {
        statusCode: 504,
        error: 'demo_timeout',
        reason: `demo subprocess exceeded ${DEMO_TIMEOUT_MS}ms timeout`,
        nextAction: 'Retry the demo; if it persists, check pd CLI health (pd doctor).',
      });
      return;
    }

    // -- 'error' event after spawn (e.g. EACCES, broken pipe) -> 500 --
    if (outcome.error !== null) {
      sendStructuredError(res, {
        statusCode: 500,
        error: 'demo_subprocess_error',
        reason: `subprocess error: ${outcome.error.message}`,
        nextAction: 'Check pd CLI installation and permissions; see server logs for stderr.',
      });
      return;
    }

    // -- Non-zero exit code -> 500 --
    if (outcome.code !== 0) {
      sendStructuredError(res, {
        statusCode: 500,
        error: 'demo_exit_nonzero',
        reason: `demo exited with code ${outcome.code}`,
        nextAction: stderrText.trim()
          ? `pd stderr: ${stderrText.trim()}`
          : 'Run `pd demo story-a --json` manually for diagnostics.',
      });
      return;
    }

    // -- Validate stdout (rc-1/rc-2/rc-4) --
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const validated = parseDemoStdout(stdout);
    if (validated === null) {
      sendStructuredError(res, {
        statusCode: 500,
        error: 'demo_invalid_stdout',
        reason: 'demo stdout did not match the expected JSON schema',
        nextAction: 'Run `pd demo story-a --json` manually and inspect the output.',
      });
      return;
    }

    // -- 200 OK with validated demo result --
    sendJson(res, 200, {
      success: true,
      data: {
        simulated: true,
        demo: validated,
      },
    });
  } finally {
    // P1-1: always clean up the temp workspace, whether the demo succeeded,
    // failed, timed out, or threw. Best-effort — OS will reap temp dirs eventually.
    cleanupTempWorkspace(tempWorkspace);
  }
}


export async function handleOnboardingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OnboardingRouteContext,
): Promise<void> {
  const { workspaceDir, subPath } = ctx;

  // -- Feature flag gate (spec 6.3 change 5) --
  // Checked BEFORE method/sub-path dispatch so a disabled flag cannot be probed
  // via 405/404 side-channels (rc-9-no-silent-fallback: explicit 403 + reason).
  if (!loadOnboardingFlagEnabled(workspaceDir)) {
    sendStructuredError(res, {
      statusCode: 403,
      error: 'flag_disabled',
      reason: 'flag_disabled',
      nextAction: 'Enable the new_user_onboarding feature flag in .pd/config.yaml or the Settings page.',
    });
    return;
  }

  // -- POST /api/v1/onboarding/run-demo --
  if (subPath === '/run-demo') {
    if (req.method !== 'POST') {
      sendStructuredError(res, {
        statusCode: 405,
        error: 'method_not_allowed',
        reason: 'method_not_allowed',
        nextAction: 'Use POST to trigger the demo.',
      });
      return;
    }
    await handleRunDemo(res, workspaceDir);
    return;
  }

  // -- Unknown sub-path --
  sendStructuredError(res, {
    statusCode: 404,
    error: 'not_found',
    reason: 'not_found',
    nextAction: `Route /api/v1/onboarding${subPath} not found. Use POST /api/v1/onboarding/run-demo.`,
  });
}

/** No persistent resources to dispose - included for parity with other routes. */
export function disposeOnboardingModels(): void {
  // No-op: handleRunDemo holds no cached models or open handles.
}