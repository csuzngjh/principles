import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecoveryCapabilityEvidence } from '@principles/core/runtime-v2';

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 4 (P1): per-capability
 * CLI-channel reachability probes, shared by the pd-cli readiness path and
 * the pd-console readiness assembly (both packages depend on host-runtime).
 *
 * Every probe executes the REAL pd CLI as a bounded subprocess against the
 * TARGET workspace — static command lists, no shell, output capped, timeout
 * enforced. Evidence is produced fresh on every call; nothing is cached and
 * nothing destructive runs:
 * - `pd_status`: `pd activation list --json` (read-only status surface);
 * - `rulecode_deactivate`: `pd activation deactivate --activation-id
 *   recovery-probe-nonexistent --dry-run --json` — the REAL deactivate entry
 *   through real parsing, workspace binding, and target-resolution
 *   preconditions, with the dry-run guard returning BEFORE any governance
 *   audit write or store mutation. A nonexistent probe id keeps the
 *   precondition honest without touching any real activation.
 *
 * Console-channel capabilities (`rulecode_global_pause`,
 * `owner_review_access`) can never be verified from a CLI subprocess — the
 * caller receives explicit NOT-VERIFIED entries for them instead of
 * fabricated ok flags (fail closed; SPEC R4 §2.4.7).
 */

const PROBE_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
export const DEACTIVATE_DRY_RUN_PROBE_ACTIVATION_ID = 'recovery-probe-nonexistent';

/**
 * Resolve the built pd CLI entry for the CURRENT environment. Both layouts
 * place the sibling packages at the same relative depth: repo checkouts at
 * `packages/host-runtime/dist` and installed runtimes at
 * `~/.pd/runtime/host-runtime/dist`, each with `pd-cli/dist/index.js` two
 * levels up. Returns null when no built entry exists (callers fail closed).
 */
export function resolveCliRecoveryEntry(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'pd-cli', 'dist', 'index.js'),
    path.resolve(process.cwd(), 'packages', 'pd-cli', 'dist', 'index.js'),
    path.resolve(process.cwd(), 'dist', 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // probe the next candidate
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ProbeRun = {
  ok: true;
  stdout: string;
} | {
  ok: false;
  detail: string;
};

function runCli(cliEntry: string, args: readonly string[], timeoutMs: number): Promise<ProbeRun> {
  return new Promise(resolve => {
    // Static argv list — no shell, no interpolated command string.
    const child = spawn(process.execPath, [cliEntry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ProbeRun): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      child.removeAllListeners();
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, detail: 'cli probe timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', () => { /* outcome rides on exit code + stdout */ });
    child.on('error', error => finish({ ok: false, detail: `spawn failed: ${error instanceof Error ? error.message : String(error)}` }));
    child.on('close', code => {
      if (code !== 0) {
        finish({ ok: false, detail: `exited with code ${code}` });
        return;
      }
      finish({ ok: true, stdout });
    });
  });
}

function pathResolved(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  let end = normalized.length;
  while (end > 0 && normalized.charCodeAt(end - 1) === 47) end -= 1;
  return normalized.slice(0, end).toLowerCase();
}

export interface CliRecoveryProbeOptions {
  /** Absolute path to the built pd CLI entry (dist/index.js). */
  cliEntry: string;
  workspaceDir: string;
  /** When supplied, the status listing must include this activation (workspace-targeting proof). */
  expectedActivationId?: string;
  /** Probe budget in ms (default 15s). A timeout fails the capability closed — tests on loaded machines may raise it. */
  timeoutMs?: number;
}

function capability(capabilityId: 'pd_status' | 'rulecode_deactivate' | 'rulecode_global_pause' | 'owner_review_access', evidence: Omit<RecoveryCapabilityEvidence, 'capabilityId' | 'channel'> & { channel: 'cli' | 'console' }): RecoveryCapabilityEvidence {
  return {
    capabilityId,
    ...evidence,
  };
}

const CONSOLE_UNVERIFIABLE_DETAIL = 'console-channel control: verifying the HTTP-only recovery entry requires the Owner Console process; a CLI subprocess cannot produce this evidence';

/** `pd activation list --json` — the pd_status status surface, read-only. */
export async function probeCliActivationStatus(options: CliRecoveryProbeOptions): Promise<RecoveryCapabilityEvidence> {
  const run = await runCli(options.cliEntry, ['activation', 'list', '--json', '--workspace', options.workspaceDir], options.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (!run.ok) return capability('pd_status', { channel: 'cli', ok: false, workspaceMatched: false, detail: `pd activation list: ${run.detail}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return capability('pd_status', { channel: 'cli', ok: false, workspaceMatched: false, detail: 'pd activation list: stdout is not parseable JSON' });
  }
  const activations = isRecord(parsed) && Array.isArray(parsed.activations) ? parsed.activations : undefined;
  if (activations === undefined) {
    return capability('pd_status', { channel: 'cli', ok: false, workspaceMatched: false, detail: 'pd activation list: output carries no activations listing' });
  }
  if (options.expectedActivationId !== undefined) {
    const listed = activations.some(entry => isRecord(entry) && entry.activationId === options.expectedActivationId);
    if (!listed) {
      return capability('pd_status', { channel: 'cli', ok: false, workspaceMatched: false, detail: `pd activation list: the target workspace listing does not include activation ${options.expectedActivationId}` });
    }
  }
  return capability('pd_status', { channel: 'cli', ok: true, workspaceMatched: true });
}

/**
 * `pd activation deactivate --dry-run` — the REAL deactivate entry (parsing,
 * workspace binding, target resolution, preconditions) without audit write or
 * store mutation. The probe id does not exist, so the precondition outcome is
 * an honest not-found while the entry itself is proven executable.
 */
export async function probeCliDeactivateDryRun(options: CliRecoveryProbeOptions): Promise<RecoveryCapabilityEvidence> {
  const run = await runCli(options.cliEntry, ['activation', 'deactivate', '--activation-id', DEACTIVATE_DRY_RUN_PROBE_ACTIVATION_ID, '--dry-run', '--json', '--workspace', options.workspaceDir], options.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (!run.ok) return capability('rulecode_deactivate', { channel: 'cli', ok: false, workspaceMatched: false, detail: `pd activation deactivate --dry-run: ${run.detail}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return capability('rulecode_deactivate', { channel: 'cli', ok: false, workspaceMatched: false, detail: 'pd activation deactivate --dry-run: stdout is not parseable JSON' });
  }
  if (!isRecord(parsed) || parsed.dryRun !== true || typeof parsed.workspaceDir !== 'string') {
    return capability('rulecode_deactivate', { channel: 'cli', ok: false, workspaceMatched: false, detail: 'pd activation deactivate --dry-run: output is not a structured dry-run result' });
  }
  if (pathResolved(options.workspaceDir) !== pathResolved(String(parsed.workspaceDir))) {
    return capability('rulecode_deactivate', { channel: 'cli', ok: false, workspaceMatched: false, detail: `pd activation deactivate --dry-run: bound to ${String(parsed.workspaceDir)}, not the governed workspace` });
  }
  return capability('rulecode_deactivate', { channel: 'cli', ok: true, workspaceMatched: true });
}

/** Both CLI-channel capabilities plus explicit NOT-VERIFIED entries for the console channel (fail closed, never fabricated). */
export async function probeCliRecoveryCapabilities(options: CliRecoveryProbeOptions): Promise<RecoveryCapabilityEvidence[]> {
  const status = await probeCliActivationStatus(options);
  const deactivate = await probeCliDeactivateDryRun(options);
  return [
    status,
    deactivate,
    capability('rulecode_global_pause', { channel: 'console', ok: false, workspaceMatched: false, detail: CONSOLE_UNVERIFIABLE_DETAIL }),
    capability('owner_review_access', { channel: 'console', ok: false, workspaceMatched: false, detail: CONSOLE_UNVERIFIABLE_DETAIL }),
  ];
}
