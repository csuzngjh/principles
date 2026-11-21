/**
 * `pd service run-once` — the PD Service Host run-once coordinator CLI
 * (SPEC-PD-SERVICE-HOST-001 §11 Phase 1 + Phase 2 + Phase 3).
 *
 * Three modes (cli-4):
 *  - bare / `--json` (Phase 3, PRI-1281): the MANAGED execution — the OS
 *    scheduler's entry. Auto-discovers workspaces and executes ONLY
 *    `effectiveOwner=service_host` ones (§8.4); zero such workspaces is a
 *    legal empty run.
 *  - `--dry-run` (Phase 1): the read-only discovery dry-run — NO worker,
 *    NO ownership change, no business writes.
 *  - `--shadow` (Phase 2, PRI-1280): an explicit, bounded REAL worker cycle
 *    for each `--workspace <dir>` selection through the unified Worker
 *    Adapter. Shadow calls the real worker — business tasks may advance —
 *    and requires explicit workspace selection; never scheduled.
 *
 * `--trigger manual|scheduler` records the truthful trigger source (task
 * §4): the scheduler registers `--trigger scheduler`; login vs periodic is
 * deliberately NOT distinguished (no platform reports it reliably).
 *
 * cli-1: `--json` stdout carries exactly one machine-readable document;
 * diagnostics go to stderr. cli-2/cli-5: refusals set the exit code without
 * mutating anything. cli-6: every refusal carries reason + nextAction.
 */
import {
  runServiceRunOnce,
  runServiceShadowOnce,
  runServiceManagedOnce,
  type RunOnceResult,
  type ShadowRunResult,
  type ManagedRunResult,
  type ServiceRunTriggerSource,
} from '../services/service-host/index.js';
import type { WorkerHostKind } from '../services/service-host/index.js';

export interface ServiceRunOnceArgs {
  readonly dryRun: boolean;
  readonly shadow: boolean;
  /** Explicit workspace selections for shadow mode (at least one required). */
  readonly workspaces: readonly string[];
  /** Restrict shadow to one host adapter (codex | workbuddy). */
  readonly host?: WorkerHostKind;
  /** Set when --host was given a value outside codex|workbuddy (fail-closed). */
  readonly invalidHost?: string;
  /** Truthful trigger source for the status record (default manual). */
  readonly trigger?: ServiceRunTriggerSource;
  /** Set when --trigger was given a value outside manual|scheduler (fail-closed). */
  readonly invalidTrigger?: string;
  /** Trusted home injection (scheduler registration / installer / tests). */
  readonly pdHome?: string;
  /**
   * The RAW --timeout-ms argument string (F8 review fix): validated in full
   * here — a partial parse like `5m` → 5 used to start a REAL cycle with a
   * 1-second deadline, and an unparseable value silently fell back to the
   * 45-minute default. Both paths now refuse before any execution.
   */
  readonly timeoutMsRaw?: string;
  /**
   * Caller-provided cancellation (F11 review fix). When absent, the CLI
   * wires terminal SIGINT/SIGTERM to an internal controller so a terminal
   * interrupt aborts the in-flight worker child through the SAME signal
   * path. Tests inject a signal directly.
   */
  readonly signal?: AbortSignal;
  readonly json: boolean;
}

/** Node timers support 2^31-1 ms; above that setTimeout overflows to ~1ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MIN_TIMEOUT_MS = 1_000;
const DEFAULT_TIMEOUT_FALLBACK_MS = 45 * 60_000;

/**
 * F8: validate the full --timeout-ms value BEFORE any real execution. The
 * whole string must be a decimal integer inside the supported range —
 * partial parses (`5m` → 5) and silent defaults (`five` → 45min) are
 * refused with a structured reason instead of starting a mis-bounded
 * worker.
 */
export function parseShadowTimeoutMs(raw: string | undefined): { ok: true; timeoutMs: number } | { ok: false; reason: string; nextAction: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, timeoutMs: DEFAULT_TIMEOUT_FALLBACK_MS };
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    return {
      ok: false,
      reason: `invalid_timeout_ms:${value.slice(0, 40)}`,
      nextAction: '--timeout-ms must be a plain millisecond integer (e.g. 2700000). Values like "5m" are not accepted; omit the flag for the 45-minute default.',
    };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    return {
      ok: false,
      reason: `timeout_ms_out_of_range:${value.slice(0, 40)}`,
      nextAction: `--timeout-ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds (a per-workspace bound of at least one second, at most the Node timer ceiling).`,
    };
  }
  return { ok: true, timeoutMs: parsed };
}

interface JsonOutput {
  readonly schemaVersion: 'pd.service-run-status.v1';
  readonly outcome: 'completed' | 'already_running' | 'refused';
  readonly dryRun: boolean;
  readonly runId: string;
  readonly installation?: unknown;
  readonly environmentIsolation?: unknown;
  readonly manifest?: unknown;
  readonly discovery?: unknown;
  readonly workspaces?: unknown;
  readonly activeRelease?: unknown;
  readonly shadow?: unknown;
  readonly managed?: unknown;
  readonly executions?: unknown;
  readonly statusWrite?: unknown;
  readonly reason?: string;
  readonly nextAction: string;
  readonly statusPath?: string;
}

/** Render the completed dry-run for humans (JSON mode prints the status verbatim). */
function printHumanCompleted(result: Extract<RunOnceResult, { outcome: 'completed' }>): void {
  const { discovery, manifest, activeRelease, identity } = result;
  console.log(`pd service run-once (dry-run) — install identity resolved`);
  console.log(`  pdHome:        ${identity.pdHome}`);
  console.log(`  home:          ${identity.homeDir} (${identity.homeSource})`);
  console.log(`  activeRelease: ${activeRelease.valid ? (activeRelease.releaseId ?? 'unknown identity') : (activeRelease.reason ?? 'unavailable')}`);
  console.log(`  manifest:      ${manifest.verdict} (hosts: ${manifest.hosts.join(', ') || 'none'}, workspaces: ${manifest.workspacesCount})`);
  const counts = Object.entries(discovery.counts)
    .map(([verdict, count]) => `${verdict}=${count}`)
    .join(' ');
  console.log(`  discovery:     ${discovery.discoveredTotal} workspace(s) — ${counts}`);
  for (const ws of discovery.workspaces) {
    const reasonSuffix = ws.reason !== undefined ? ` — ${ws.reason}` : '';
    console.log(`    [${ws.verdict}] ${ws.canonicalDir}${reasonSuffix}`);
    console.log(`        owner: ${ws.owner.state} (effectiveOwner=${ws.owner.effectiveOwner}, generation=${ws.owner.generation}, source=${ws.owner.source}); hosts: ${ws.hosts.join(', ') || 'none'}`);
  }
  if (result.statusWrite.ok) {
    console.log(`  status:        ${result.statusWrite.path}`);
  } else {
    console.error(`  status write FAILED: ${result.statusWrite.reason}`);
    console.error(`  next action:   ${result.statusWrite.nextAction}`);
  }
  console.log(`  next:          ${result.status.nextAction}`);
}

/**
 * Wire the terminal's OS signals into ONE AbortController (F11 + P1-01
 * final-closure review): SIGINT, SIGTERM and — on POSIX — SIGHUP all drive
 * the same cancellation path the in-flight worker child already honours
 * (process-group SIGTERM → bounded grace → SIGKILL → bounded stdio drain).
 * A dropped SSH/terminal session must terminate the detached worker group
 * through the coordinator's normal cleanup instead of leaving an
 * uncontrolled worker — and a released lock — behind. Windows keeps its
 * existing semantics: SIGHUP is never registered there.
 *
 * Returns the teardown that removes every listener it installed; callers
 * invoke it exactly once when the coordinated work settles.
 */
export function wireTerminalAbortSignals(controller: AbortController): () => void {
  const onOsSignal = (): void => controller.abort();
  process.on('SIGINT', onOsSignal);
  process.on('SIGTERM', onOsSignal);
  const posixHangup = process.platform !== 'win32';
  if (posixHangup) process.on('SIGHUP', onOsSignal);
  return () => {
    process.removeListener('SIGINT', onOsSignal);
    process.removeListener('SIGTERM', onOsSignal);
    if (posixHangup) process.removeListener('SIGHUP', onOsSignal);
  };
}

/** Render one refusal for humans. */
function printHumanRefusal(reason: string, nextAction: string): void {
  console.error(`pd service run-once refused: ${reason}`);
  console.error(`Next action: ${nextAction}`);
}

/** Human rendering of one shadow execution (task §10: outcome + progress + health stay distinct). */
export function printHumanShadow(result: Extract<ShadowRunResult, { outcome: 'completed' }>): void {
  const { identity, activeRelease } = result;
  console.log(`pd service run-once (shadow) — install identity resolved`);
  console.log(`  pdHome:        ${identity.pdHome}`);
  console.log(`  activeRelease: ${activeRelease.valid ? (activeRelease.releaseId ?? 'unknown identity') : (activeRelease.reason ?? 'unavailable')}`);
  for (const record of result.executions) {
    if (record.admission === 'refused') {
      console.log(`    [refused] ${record.requestedDir} — ${record.refusalReason ?? 'refused'}`);
      console.log(`        next: ${record.refusalNextAction ?? ''}`);
      continue;
    }
    const { execution } = record;
    if (execution === undefined) {
      // P2-04: records with no Worker execution (workspace_timeout_budget_
      // exhausted, adapter_threw, worker_spawn_failed) still owe the human
      // output their recorded reason and nextAction, not a bare label.
      console.log(`    [${record.workspaceState}] ${record.requestedDir} (${record.hostKind ?? '?'}) — ${record.refusalReason ?? 'adapter failure'}`);
      if (record.refusalNextAction !== undefined) console.log(`        next: ${record.refusalNextAction}`);
      continue;
    }
    const progress = record.lastProgressAt !== null ? record.lastProgressAt : 'none yet';
    const driver = execution.health.lastCycleDriver ?? 'unknown';
    console.log(`    [${record.workspaceState}] ${execution.workspaceDir} (${execution.hostKind} via ${execution.worker.cliEntrySource}) — ${execution.cycleOutcome}${execution.reason !== undefined ? ` (${execution.reason})` : ''}`);
    console.log(`        progress: last=${progress} (source=${record.lastProgressSource ?? 'none'}); tasks changed=${execution.businessProgress.changedTaskCount}; driver=${driver}; duration=${execution.durationMs}ms`);
    if (execution.nextAction !== undefined) console.log(`        next: ${execution.nextAction}`);
  }
  if (result.statusWrite.ok) {
    console.log(`  status:        ${result.statusWrite.path}`);
  } else {
    console.error(`  status write FAILED: ${result.statusWrite.reason}`);
    console.error(`  next action:   ${result.statusWrite.nextAction}`);
  }
  console.log(`  next:          ${result.status.nextAction}`);
}

/** Human rendering of one managed execution (task §4 admission matrix). */
export function printHumanManaged(result: Extract<ManagedRunResult, { outcome: 'completed' }>): void {
  const { identity, activeRelease } = result;
  console.log(`pd service run-once (managed, trigger=${result.status.triggerSource}) — install identity resolved`);
  console.log(`  pdHome:        ${identity.pdHome}`);
  console.log(`  activeRelease: ${activeRelease.valid ? activeRelease.releaseId ?? 'unknown identity' : activeRelease.reason ?? 'unavailable'}`);
  const section = result.status.managed;
  if (section !== undefined && section.emptyReason !== undefined) {
    console.log(`  result:        legal empty run (${section.emptyReason}) — no Worker started`);
  }
  for (const record of result.executions) {
    if (record.admission === 'skipped') {
      console.log(`    [skipped] ${record.canonicalDir} — ${record.skipReason ?? 'skipped'}`);
      if (record.skipNextAction !== undefined) console.log(`        next: ${record.skipNextAction}`);
      continue;
    }
    if (record.execution === undefined) {
      console.log(`    [${record.workspaceState}] ${record.canonicalDir} (${record.hostKind ?? '?'}) — ${record.skipReason ?? 'failed before cycle'}`);
      if (record.skipNextAction !== undefined) console.log(`        next: ${record.skipNextAction}`);
      continue;
    }
    const {execution} = record;
    const progress = record.lastProgressAt !== null ? record.lastProgressAt : 'none yet';
    console.log(`    [${record.workspaceState}] ${execution.workspaceDir} (${execution.hostKind} via ${execution.worker.cliEntrySource}) — ${execution.cycleOutcome}${execution.reason !== undefined ? ` (${execution.reason})` : ''}`);
    console.log(`        progress: last=${progress} (source=${record.lastProgressSource ?? 'none'}); tasks changed=${execution.businessProgress.changedTaskCount}; duration=${execution.durationMs}ms`);
    if (execution.nextAction !== undefined) console.log(`        next: ${execution.nextAction}`);
  }
  if (result.statusWrite.ok) {
    console.log(`  status:        ${result.statusWrite.path}`);
  } else {
    console.error(`  status write FAILED: ${result.statusWrite.reason}`);
    console.error(`  next action:   ${result.statusWrite.nextAction}`);
  }
  console.log(`  next:          ${result.status.nextAction}`);
}

export async function handleServiceRunOnce(args: ServiceRunOnceArgs): Promise<void> {
  // Invalid --host value: fail closed before any mode runs (cli-6).
  if (args.invalidHost !== undefined) {
    const reason = `invalid_host_kind:${args.invalidHost.slice(0, 40)}`;
    const nextAction = 'Use --host codex or --host workbuddy (or omit --host to run every bound adapter).';
    if (args.json) {
      const output: JsonOutput = { schemaVersion: 'pd.service-run-status.v1', outcome: 'refused', dryRun: false, runId: 'n/a', reason, nextAction };
      console.log(JSON.stringify(output));
    } else {
      printHumanRefusal(reason, nextAction);
    }
    process.exitCode = 1;
    return;
  }

  // Invalid --trigger value: fail closed before any mode runs (cli-6).
  if (args.invalidTrigger !== undefined) {
    const reason = `invalid_trigger:${args.invalidTrigger.slice(0, 40)}`;
    const nextAction = 'Use --trigger manual or --trigger scheduler. Login vs periodic is deliberately not distinguishable — PD never fabricates a finer trigger source than it can prove.';
    if (args.json) {
      const output: JsonOutput = { schemaVersion: 'pd.service-run-status.v1', outcome: 'refused', dryRun: false, runId: 'n/a', reason, nextAction };
      console.log(JSON.stringify(output));
    } else {
      printHumanRefusal(reason, nextAction);
    }
    process.exitCode = 1;
    return;
  }

  // Mode gate (cli-4): --dry-run and --shadow stay mutually exclusive; a
  // bare run is the Phase 3 MANAGED execution (the scheduler entry).
  if (args.dryRun && args.shadow) {
    const reason = 'dry_run_shadow_mutually_exclusive';
    const nextAction = 'Choose one mode: --dry-run (read-only discovery), --shadow --workspace <dir> (explicit bounded worker cycles), or a bare run (managed execution — service_host_owned workspaces only).';
    if (args.json) {
      const output: JsonOutput = { schemaVersion: 'pd.service-run-status.v1', outcome: 'refused', dryRun: true, runId: 'n/a', reason, nextAction };
      console.log(JSON.stringify(output));
    } else {
      printHumanRefusal(reason, nextAction);
    }
    process.exitCode = 1;
    return;
  }

  const triggerSource: ServiceRunTriggerSource = args.trigger ?? 'manual';

  if (args.shadow) {
    // F8: full-value validation BEFORE the coordinator acquires the lock or
    // spawns any real cycle.
    const timeout = parseShadowTimeoutMs(args.timeoutMsRaw);
    if (!timeout.ok) {
      if (args.json) {
        const output: JsonOutput = { schemaVersion: 'pd.service-run-status.v1', outcome: 'refused', dryRun: false, runId: 'n/a', reason: timeout.reason, nextAction: timeout.nextAction };
        console.log(JSON.stringify(output));
      } else {
        printHumanRefusal(timeout.reason, timeout.nextAction);
      }
      process.exitCode = 1;
      return;
    }

    // F11: cancellation reaches the coordinator and the in-flight worker
    // child through ONE AbortSignal — injected by tests, or wired here to
    // terminal SIGINT/SIGTERM/SIGHUP so an operator interrupt (or a dropped
    // terminal) behaves identically.
    let unwireOsSignals: (() => void) | undefined;
    const { signal: injectedSignal } = args;
    let signal = injectedSignal;
    if (signal === undefined) {
      const controller = new AbortController();
      ({ signal } = controller);
      unwireOsSignals = wireTerminalAbortSignals(controller);
    }

    let result: ShadowRunResult;
    try {
      result = await runServiceShadowOnce({
        workspaces: args.workspaces,
        ...(args.host !== undefined ? { hostFilter: args.host } : {}),
        timeoutMs: timeout.timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
        ...(args.pdHome !== undefined ? { trustedHomeDir: args.pdHome } : {}),
      });
    } finally {
      unwireOsSignals?.();
    }

    if (result.outcome === 'refused') {
      if (args.json) {
        const output: JsonOutput = {
          schemaVersion: 'pd.service-run-status.v1',
          outcome: 'refused',
          dryRun: false,
          runId: result.runId,
          reason: result.reason,
          nextAction: result.nextAction,
          ...(result.statusWrite !== undefined ? { statusWrite: result.statusWrite } : {}),
        };
        console.log(JSON.stringify(output));
      } else {
        printHumanRefusal(result.reason, result.nextAction);
        if (result.statusWrite !== undefined && !result.statusWrite.ok) {
          console.error(`  status write FAILED: ${result.statusWrite.reason}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    if (result.outcome === 'already_running') {
      if (args.json) {
        const output: JsonOutput = {
          schemaVersion: 'pd.service-run-status.v1',
          outcome: 'already_running',
          dryRun: false,
          runId: result.runId,
          reason: result.reason,
          nextAction: result.nextAction,
        };
        console.log(JSON.stringify(output));
      } else {
        console.log(`pd service run-once (shadow): already running (lock held).`);
        console.log(`  holder: ${result.holderBodyHash}`);
        console.log(`  next:   ${result.nextAction}`);
      }
      process.exitCode = 0;
      return;
    }

    if (args.json) {
      const output: JsonOutput = {
        schemaVersion: 'pd.service-run-status.v1',
        outcome: 'completed',
        dryRun: false,
        runId: result.runId,
        installation: result.status.installation,
        environmentIsolation: result.status.environmentIsolation,
        manifest: result.manifest,
        activeRelease: result.activeRelease,
        discovery: {
          discoveredTotal: result.discovery.discoveredTotal,
          counts: result.discovery.counts,
          hostRoots: result.status.discovery.hostRoots,
          incomplete: result.status.discovery.incomplete,
        },
        workspaces: result.discovery.workspaces,
        shadow: result.status.shadow,
        executions: result.executions,
        statusWrite: result.statusWrite,
        nextAction: result.status.nextAction,
        ...(result.statusWrite.ok ? { statusPath: result.statusWrite.path } : {}),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      printHumanShadow(result);
    }
    // Exit-code policy: 0 only when at least one cycle ran and every
    // admitted execution ended completed/paused; refusals, failures,
    // timeouts, degradations and a failed status write are non-zero.
    const admitted = result.executions.filter((e) => e.admission === 'admitted');
    const allHealthy = admitted.length > 0
      && admitted.every((e) => e.workspaceState === 'completed' || e.workspaceState === 'paused');
    const statusFailed = !result.statusWrite.ok;
    const anyRefused = result.executions.some((e) => e.admission === 'refused');
    process.exitCode = allHealthy && !statusFailed && !anyRefused ? 0 : 1;
    return;
  }

  // ── Phase 3 managed execution (bare run — the OS scheduler entry) ──
  if (!args.dryRun) {
    const timeout = parseShadowTimeoutMs(args.timeoutMsRaw);
    if (!timeout.ok) {
      if (args.json) {
        const output: JsonOutput = { schemaVersion: 'pd.service-run-status.v1', outcome: 'refused', dryRun: false, runId: 'n/a', reason: timeout.reason, nextAction: timeout.nextAction };
        console.log(JSON.stringify(output));
      } else {
        printHumanRefusal(timeout.reason, timeout.nextAction);
      }
      process.exitCode = 1;
      return;
    }

    let unwireOsSignals: (() => void) | undefined;
    const { signal: injectedSignal } = args;
    let signal = injectedSignal;
    if (signal === undefined) {
      const controller = new AbortController();
      ({ signal } = controller);
      unwireOsSignals = wireTerminalAbortSignals(controller);
    }

    let result: ManagedRunResult;
    try {
      result = await runServiceManagedOnce({
        triggerSource,
        timeoutMs: timeout.timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
        ...(args.pdHome !== undefined ? { trustedHomeDir: args.pdHome } : {}),
      });
    } finally {
      unwireOsSignals?.();
    }

    if (result.outcome === 'refused') {
      if (args.json) {
        const output: JsonOutput = {
          schemaVersion: 'pd.service-run-status.v1',
          outcome: 'refused',
          dryRun: false,
          runId: result.runId,
          reason: result.reason,
          nextAction: result.nextAction,
          ...(result.statusWrite !== undefined ? { statusWrite: result.statusWrite } : {}),
        };
        console.log(JSON.stringify(output));
      } else {
        printHumanRefusal(result.reason, result.nextAction);
        if (result.statusWrite !== undefined && !result.statusWrite.ok) {
          console.error(`  status write FAILED: ${result.statusWrite.reason}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    if (result.outcome === 'already_running') {
      if (args.json) {
        const output: JsonOutput = {
          schemaVersion: 'pd.service-run-status.v1',
          outcome: 'already_running',
          dryRun: false,
          runId: result.runId,
          reason: result.reason,
          nextAction: result.nextAction,
        };
        console.log(JSON.stringify(output));
      } else {
        console.log(`pd service run-once (managed): already running (lock held).`);
        console.log(`  holder: ${result.holderBodyHash}`);
        console.log(`  next:   ${result.nextAction}`);
      }
      // Overlap convergence worked as designed (AC-08) — not an error.
      process.exitCode = 0;
      return;
    }

    if (args.json) {
      const output: JsonOutput = {
        schemaVersion: 'pd.service-run-status.v1',
        outcome: 'completed',
        dryRun: false,
        runId: result.runId,
        installation: result.status.installation,
        environmentIsolation: result.status.environmentIsolation,
        manifest: result.manifest,
        activeRelease: result.activeRelease,
        discovery: {
          discoveredTotal: result.discovery.discoveredTotal,
          counts: result.discovery.counts,
          hostRoots: result.status.discovery.hostRoots,
          incomplete: result.status.discovery.incomplete,
        },
        workspaces: result.discovery.workspaces,
        managed: result.status.managed,
        executions: result.executions,
        statusWrite: result.statusWrite,
        nextAction: result.status.nextAction,
        ...(result.statusWrite.ok ? { statusPath: result.statusWrite.path } : {}),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      printHumanManaged(result);
    }
    // Exit-code policy: 0 only when the status write succeeded AND every
    // EXECUTED workspace ended completed/paused. Skips (legacy-owned,
    // transition states) are by-design non-executions, not failures; a run
    // with zero service_host_owned workspaces is a legal empty success.
    const executed = result.executions.filter((e) => e.admission === 'executed');
    const allHealthy = executed.every((e) => e.workspaceState === 'completed' || e.workspaceState === 'paused');
    const statusFailed = !result.statusWrite.ok;
    process.exitCode = !statusFailed && allHealthy ? 0 : 1;
    return;
  }

  // ── Phase 1 dry-run (unchanged contract) ──
  const result = runServiceRunOnce({
    ...(args.pdHome !== undefined ? { trustedHomeDir: args.pdHome } : {}),
  });

  if (result.outcome === 'refused') {
    if (args.json) {
      const output: JsonOutput = {
        schemaVersion: 'pd.service-run-status.v1',
        outcome: 'refused',
        dryRun: true,
        runId: result.runId,
        reason: result.reason,
        nextAction: result.nextAction,
        ...(result.statusWrite !== undefined ? { statusWrite: result.statusWrite } : {}),
      };
      console.log(JSON.stringify(output));
    } else {
      printHumanRefusal(result.reason, result.nextAction);
      if (result.statusWrite !== undefined && !result.statusWrite.ok) {
        console.error(`  status write FAILED: ${result.statusWrite.reason}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  if (result.outcome === 'already_running') {
    if (args.json) {
      const output: JsonOutput = {
        schemaVersion: 'pd.service-run-status.v1',
        outcome: 'already_running',
        dryRun: true,
        runId: result.runId,
        reason: result.reason,
        nextAction: result.nextAction,
      };
      console.log(JSON.stringify(output));
    } else {
      console.log(`pd service run-once: already running (lock held).`);
      console.log(`  holder: ${result.holderBodyHash}`);
      console.log(`  next:   ${result.nextAction}`);
    }
    // Mutual exclusion worked as designed — a normal outcome (AC-08), not an error.
    process.exitCode = 0;
    return;
  }

  if (args.json) {
    const output: JsonOutput = {
      schemaVersion: 'pd.service-run-status.v1',
      outcome: 'completed',
      dryRun: true,
      runId: result.runId,
      installation: result.status.installation,
      environmentIsolation: result.status.environmentIsolation,
      manifest: result.manifest,
      activeRelease: result.activeRelease,
      discovery: {
        discoveredTotal: result.discovery.discoveredTotal,
        counts: result.discovery.counts,
        hostRoots: result.status.discovery.hostRoots,
        incomplete: result.status.discovery.incomplete,
      },
      workspaces: result.discovery.workspaces,
      statusWrite: result.statusWrite,
      nextAction: result.status.nextAction,
      ...(result.statusWrite.ok ? { statusPath: result.statusWrite.path } : {}),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHumanCompleted(result);
  }
  // P2-3: a completed run whose operational status could NOT be persisted
  // failed its real contract — the exit code must be non-zero, and the JSON
  // above already carries both the real outcome and the write failure
  // reason. No fake statusPath is emitted (the field is absent).
  process.exitCode = result.statusWrite.ok ? 0 : 1;
}
