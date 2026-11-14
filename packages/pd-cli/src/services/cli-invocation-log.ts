/**
 * CLI invocation record — one durable line per `pd` process.
 *
 * Why this exists (2026-11-14 CLI usage audit): nothing recorded WHICH `pd`
 * command ran, so questions like "which commands are used, by whom, and which
 * never run" were unanswerable. Domain events (pain_events, tasks, runs) only
 * show side effects, and `pd health` reads the same sink for its own event type.
 *
 * Sink choice: `<workspace>/.pd/telemetry/critical-events.jsonl` — the existing
 * workspace-scoped, NON-rotated telemetry sink (PRI-634 A3). The event log
 * (`.pd/logs/events_<date>.jsonl`) is deleted after 7 days, which would destroy
 * any trend before it could be read.
 *
 * Envelope: the registered `TelemetryEvent` shape from @principles/core, with
 * `eventType: 'cli_invocation'` registered in the same union (the single naming
 * authority). It is written by the CLI process directly, not through
 * StoreEventEmitter, because no host runtime is assembled at argv-parse time.
 *
 * Failure contract: recording is best-effort and MUST NOT change the command
 * result. Every failure path is swallowed here — this module never throws and
 * never writes to stdout/stderr (cli-1-strict-json).
 */
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WORKSPACE_ENV } from '../resolve-workspace.js';
import { discoverWorkspaceDefault } from './pd-config-loader.js';

/** Registered telemetry event name for one CLI process. */
export const CLI_INVOCATION_EVENT_TYPE = 'cli_invocation';

/**
 * Environment variable a real spawn point sets to name itself.
 *
 * Values set today: console | companion | installer | plugin-script.
 * Absent = a person typed the command. Agent-typed invocations from skills also
 * land here: no skill wrapper spawns `pd` today (the skill scripts run other
 * scripts, not the CLI), so there is no `agent-skill` spawn point to instrument.
 * A present-but-unknown value is recorded verbatim rather than relabelled.
 */
export const INVOCATION_SOURCE_ENV = 'PD_INVOCATION_SOURCE';

/** Marker used when a field could not be determined (never a zero/empty default). */
export const UNKNOWN = 'UNKNOWN';

/** Exit code as recorded; `null` means "not determinable". */
export type RecordedExitCode = number | null;

export interface CliInvocation {
  readonly workspaceDir: string | null;
  readonly command: string | null;
  readonly exitCode: RecordedExitCode;
  readonly rawSource: string | undefined;
  readonly now?: Date;
}

/** Sink path for a workspace. */
export function invocationLogPath(workspaceDir: string): string {
  return join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
}

/**
 * Resolve the invocation source from the environment.
 *
 * A present-but-unknown value is recorded verbatim (lowercased, bounded): an
 * unregistered spawner must stay visible instead of being relabelled. Only an
 * absent/blank variable becomes `human`, because that is what it means.
 */
export function resolveInvocationSource(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return 'human';
  return value.slice(0, 40);
}

/**
 * Record one CLI process. Never throws, never prints.
 * Returns the written path, or null when nothing could be recorded.
 *
 * Deliberately does NOT create `.pd/telemetry` OR the sink file: a read-only
 * command (`pd pain recall`, `pd health`, `pd task list`, …) must leave the
 * workspace byte-identical — no files AND no new directories (pain-recall.golden
 * contract). Both are bootstrapped once by `pd runtime init`.
 *
 * The write opens the EXISTING sink with `O_APPEND | O_WRONLY` (no `O_CREAT`)
 * and writes through that descriptor: a check-then-act on the path would let a
 * concurrent delete/create swap the inode between check and write.
 */
export function recordCliInvocation(invocation: CliInvocation): string | null {
  try {
    if (invocation.workspaceDir === null) return null;
    const file = invocationLogPath(invocation.workspaceDir);
    const event = {
      eventType: 'cli_invocation',
      traceId: `cli-${process.pid}`,
      timestamp: (invocation.now ?? new Date()).toISOString(),
      sessionId: '',
      agentId: 'pd-cli',
      payload: {
        command: invocation.command ?? UNKNOWN,
        exitCode: invocation.exitCode === null ? UNKNOWN : invocation.exitCode,
        source: resolveInvocationSource(invocation.rawSource),
      },
    };
    // ENOENT (no bootstrapped sink) is a normal, silent no-op: no file is
    // created. Opening without O_CREAT is what enforces that.
    const fd = openSync(file, constants.O_APPEND | constants.O_WRONLY);
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`);
    } finally {
      closeSync(fd);
    }
    return file;
  } catch {
    // Best effort by contract: losing a usage line must never fail the command.
    return null;
  }
}

/**
 * Workspace to attribute the invocation to, resolved WITHOUT side effects.
 *
 * `resolveWorkspaceDir()` writes warnings/statements to stderr and may throw;
 * replaying that at exit would pollute the CLI's output contract and could
 * change behaviour. This quiet variant mirrors only its non-observable steps:
 * explicit flag → PD_WORKSPACE_DIR → discovered `.pd/config.yaml`.
 * Discovery is called with `{ silent: true }` so a config that cannot be parsed
 * does NOT emit a second `[PD:workspace]` warning on stderr after the command
 * has already produced its output.
 */
export function resolveRecordedWorkspace(explicit: string | undefined): string | null {
  const fromFlag = explicit?.trim();
  if (fromFlag !== undefined && fromFlag !== '') return resolve(fromFlag);

  const fromEnv = process.env[WORKSPACE_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);

  try {
    const discovered = discoverWorkspaceDefault({ silent: true });
    if (discovered?.kind === 'resolved' && discovered.workspaceDefault) {
      return resolve(discovered.workspaceDefault);
    }
  } catch {
    return null;
  }
  return null;
}
