import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecoveryReachabilityEvidence } from '@principles/core/runtime-v2';

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 3 (P1): target-environment
 * reachability evidence for the CLI-channel recovery controls, produced per
 * readiness evaluation by executing the REAL read-only status command
 * (`pd activation list --json`) as a subprocess against the TARGET
 * workspace. This proves, for the environment the promotion runs in: the
 * entry exists AND executes, its output parses, and it reflects the exact
 * workspace under review (the expected activation is visible in its
 * listing). It is deliberately NON-destructive — readiness never runs a
 * pause or deactivate; those are exercised only through the official routes
 * in isolated tests.
 *
 * Bounded: 15s timeout, stdout capped at 1 MiB. No result is cached — a
 * passing probe in one environment never certifies another.
 */

const PROBE_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 1024 * 1024;

function resolveCliEntry(): string | null {
  // Built layout: dist/commands/<this>.js with the entry at dist/index.js.
  // Under a source-tree run without a build the probe fails honestly
  // (unreachable) rather than fabricating evidence.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'index.js'),
    path.resolve(process.cwd(), 'dist', 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface ProbeOk { ok: true; stdout: string }
type ProbeRun = ProbeOk | { ok: false; detail: string };

function runStatusProbe(cliEntry: string, workspaceDir: string): Promise<ProbeRun> {
  return new Promise(resolve => {
    // Static argv list — no shell, no interpolated command string.
    const child = spawn(process.execPath, [cliEntry, 'activation', 'list', '--json', '--workspace', workspaceDir], {
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
      finish({ ok: false, detail: 'cli-status-probe timeout' });
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', () => { /* bounded diagnostics only; outcome rides on exit+stdout */ });
    child.on('error', error => finish({ ok: false, detail: `cli-status-probe spawn failed: ${error instanceof Error ? error.message : String(error)}` }));
    child.on('close', code => {
      if (code !== 0) {
        finish({ ok: false, detail: `cli-status-probe exited with code ${code}` });
        return;
      }
      finish({ ok: true, stdout });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Probe the CLI recovery status entry against the target workspace. When
 * `expectedActivationId` is supplied, workspaceMatched additionally requires
 * that activation to appear in the listing — proof the probe targeted the
 * governed workspace, not merely some workspace.
 */
export async function probeCliRecoveryReachability(workspaceDir: string, expectedActivationId?: string): Promise<RecoveryReachabilityEvidence> {
  const cliEntry = resolveCliEntry();
  if (cliEntry === null) {
    return { source: 'cli-status-probe', ok: false, workspaceMatched: false, detail: 'pd CLI entry not found (built entry missing in this environment)' };
  }
  const run = await runStatusProbe(cliEntry, workspaceDir);
  if (!run.ok) {
    return { source: 'cli-status-probe', ok: false, workspaceMatched: false, detail: run.detail };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { source: 'cli-status-probe', ok: false, workspaceMatched: false, detail: 'cli-status-probe stdout is not parseable JSON' };
  }
  const activations = isRecord(parsed) && Array.isArray(parsed.activations) ? parsed.activations : undefined;
  if (activations === undefined) {
    return { source: 'cli-status-probe', ok: false, workspaceMatched: false, detail: 'cli-status-probe output carries no activations listing' };
  }
  const listing = activations.filter(isRecord);
  if (expectedActivationId !== undefined && !listing.some(entry => entry.activationId === expectedActivationId)) {
    return { source: 'cli-status-probe', ok: false, workspaceMatched: false, detail: `cli-status-probe listing for the target workspace does not include activation ${expectedActivationId}` };
  }
  return { source: 'cli-status-probe', ok: true, workspaceMatched: true };
}
