/**
 * Onboarding route — POST /api/v1/onboarding/run-demo
 *
 * Spec: docs/superpowers/specs/2026-06-30-new-user-onboarding-design.md §6.3 改动 5
 *
 * Spawns `pd demo story-a --workspace <path> --json` as a subprocess and returns
 * 202 Accepted immediately. The console backend NEVER writes SQLite directly —
 * all DB I/O happens inside the pd-cli subprocess (EP-06 Source of Truth).
 *
 * Feature flag gate: `new_user_onboarding` (default true, registered in
 * packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts).
 *
 * ERR entries considered:
 * - EP-02 (Production Path Wiring): registered in server/index.ts handleRequest
 * - EP-03 (Fail Loud): spawn failure → 500 with reason + nextAction;
 *   flag disabled → 403 with reason + nextAction (rc-9-no-silent-fallback)
 * - EP-06 (Source of Truth): reuses pd-cli demo command, no direct DB writes
 * - EP-08 (Security Boundary): shell: true on Windows so the spawn can resolve
 *   the `pd` shim installed under AppData\Roaming\npm
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
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

/** Resolve the pd CLI binary name. Uses PATH resolution via shell on Windows. */
function findPdBin(): string {
  // The `pd` binary is installed globally (npm i -g @principles/pd-cli) and
  // resolved through PATH. On Windows we spawn with shell: true so the OS
  // resolves the `pd.cmd` shim under AppData\Roaming\npm.
  return 'pd';
}

/**
 * Spawn `pd demo story-a` and return 202 Accepted immediately.
 *
 * The demo runs asynchronously (typically < 30s). The frontend polls the
 * existing /api/v1/approvals and /api/v1/activations endpoints to observe
 * demo artifacts as they appear — the console backend does NOT block on the
 * subprocess, and does NOT parse demo stdout into the response (that would
 * couple the API to pd-cli's output schema and risk ERR-001 `as` casts on
 * untrusted JSON).
 *
 * Failure modes (rc-9-no-silent-fallback):
 *   - spawn throws synchronously (e.g. ENOENT) → 500 with reason + nextAction
 *   - child emits 'error' after spawn → logged, but response already sent (202)
 */
async function handleRunDemo(
  res: ServerResponse,
  workspaceDir: string,
): Promise<void> {
  let child;
  try {
    const pdBin = findPdBin();
    // EP-06: pd-cli subprocess owns all DB writes. Console only spawns.
    // EP-08: shell: true on Windows so spawn can resolve the pd.cmd shim.
    child = spawn(pdBin, ['demo', 'story-a', '--workspace', workspaceDir, '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendStructuredError(res, {
      statusCode: 500,
      error: 'demo_spawn_failed',
      reason: `spawn failed: ${message}`,
      nextAction: 'Check that the pd CLI is installed (npm i -g @principles/pd-cli) and on PATH.',
    });
    return;
  }

  // Attach listeners so the subprocess does not crash on unhandled stdout/stderr
  // data, and so 'error' events are logged (not silently swallowed — rc-9).
  // We intentionally do NOT await close() here: returning 202 immediately keeps
  // the API responsive and decouples the response shape from pd-cli's stdout.
  child.stdout?.on('data', (data: Buffer) => {
    console.log('[pd-console] onboarding demo stdout:', data.toString().trim());
  });
  child.stderr?.on('data', (data: Buffer) => {
    console.error('[pd-console] onboarding demo stderr:', data.toString().trim());
  });
  child.on('error', (err: Error) => {
    // Subprocess failed AFTER spawn() returned. Response (202) is already sent,
    // so we log to console.error — the operator sees it in the server log.
    console.error('[pd-console] onboarding demo subprocess error:', err.message);
  });
  child.on('close', (code: number | null) => {
    if (code !== 0) {
      console.error('[pd-console] onboarding demo exited with code', code);
    }
  });

  // 202 Accepted — demo started; frontend polls /approvals + /activations.
  sendJson(res, 202, {
    success: true,
    data: {
      simulated: true,
      status: 'started',
    },
  });
}

export async function handleOnboardingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OnboardingRouteContext,
): Promise<void> {
  const { workspaceDir, subPath } = ctx;

  // ── Feature flag gate (spec §6.3 改动 5) ────────────────────────────────
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

  // ── POST /api/v1/onboarding/run-demo ───────────────────────────────────
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

  // ── Unknown sub-path ───────────────────────────────────────────────────
  sendStructuredError(res, {
    statusCode: 404,
    error: 'not_found',
    reason: 'not_found',
    nextAction: `Route /api/v1/onboarding${subPath} not found. Use POST /api/v1/onboarding/run-demo.`,
  });
}

/** No persistent resources to dispose — included for parity with other routes. */
export function disposeOnboardingModels(): void {
  // No-op: handleRunDemo holds no cached models or open handles.
}
