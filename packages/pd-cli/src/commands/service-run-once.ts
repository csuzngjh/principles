/**
 * `pd service run-once` — the PD Service Host run-once coordinator CLI
 * (SPEC-PD-SERVICE-HOST-001 §11 Phase 1 + Phase 2).
 *
 * Two mutually exclusive modes (cli-4):
 *  - `--dry-run` (Phase 1): the read-only discovery dry-run — NO worker,
 *    NO ownership change, no business writes.
 *  - `--shadow` (Phase 2, PRI-1280): an explicit, bounded REAL worker cycle
 *    for each `--workspace <dir>` selection through the unified Worker
 *    Adapter. Shadow calls the real worker — business tasks may advance —
 *    and is therefore never a zero-side-effect dry-run. Requires explicit
 *    workspace selection; never registered, never scheduled, never touches
 *    the owner marker.
 *
 * A run with neither flag is refused (fail-closed, default-off).
 *
 * cli-1: `--json` stdout carries exactly one machine-readable document;
 * diagnostics go to stderr. cli-2/cli-5: refusals set the exit code without
 * mutating anything. cli-6: every refusal carries reason + nextAction.
 */
import { runServiceRunOnce, runServiceShadowOnce, type RunOnceResult, type ShadowRunResult } from '../services/service-host/index.js';
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
  /** Per-workspace bounded execution time (default 45 min, minimum 1000 ms). */
  readonly timeoutMs?: number;
  readonly json: boolean;
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

/** Render one refusal for humans. */
function printHumanRefusal(reason: string, nextAction: string): void {
  console.error(`pd service run-once refused: ${reason}`);
  console.error(`Next action: ${nextAction}`);
}

/** Human rendering of one shadow execution (task §10: outcome + progress + health stay distinct). */
function printHumanShadow(result: Extract<ShadowRunResult, { outcome: 'completed' }>): void {
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
      console.log(`    [${record.workspaceState}] ${record.requestedDir} (${record.hostKind ?? '?'}) — adapter failure`);
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

  // Mode gate: exactly one of --dry-run / --shadow, default-off (cli-4).
  if (args.dryRun && args.shadow) {
    const reason = 'dry_run_shadow_mutually_exclusive';
    const nextAction = 'Choose one mode: --dry-run (read-only discovery) or --shadow (real bounded worker cycles).';
    if (args.json) {
      const output: JsonOutput = { schemaVersion: 'pd.service-run-status.v1', outcome: 'refused', dryRun: true, runId: 'n/a', reason, nextAction };
      console.log(JSON.stringify(output));
    } else {
      printHumanRefusal(reason, nextAction);
    }
    process.exitCode = 1;
    return;
  }
  if (!args.dryRun && !args.shadow) {
    const reason = 'mode_required_phase2';
    const nextAction = 'Select a mode: --dry-run (Phase 1 read-only discovery) or --shadow --workspace <dir> (Phase 2 explicit bounded worker cycles). Default-off is deliberate.';
    if (args.json) {
      const output: JsonOutput = { schemaVersion: 'pd.service-run-status.v1', outcome: 'refused', dryRun: false, runId: 'n/a', reason, nextAction };
      console.log(JSON.stringify(output));
    } else {
      printHumanRefusal(reason, nextAction);
    }
    process.exitCode = 1;
    return;
  }

  if (args.shadow) {
    const result = await runServiceShadowOnce({
      workspaces: args.workspaces,
      ...(args.host !== undefined ? { hostFilter: args.host } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    });

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

  // ── Phase 1 dry-run (unchanged contract) ──
  const result = runServiceRunOnce();

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
