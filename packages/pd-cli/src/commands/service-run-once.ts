/**
 * `pd service run-once` — the PD Service Host run-once coordinator CLI
 * (SPEC-PD-SERVICE-HOST-001 §11 Phase 1).
 *
 * Phase 1 contract: `--dry-run` is REQUIRED. The coordinator executes the
 * real pipeline (install identity → single-instance lock → active release →
 * install manifest → validated claims → workspace discovery → read-only
 * owner projection → versioned operational status) and starts NO Worker and
 * changes NO consumer ownership. A run without `--dry-run` is refused
 * (fail-closed) rather than silently doing less than the operator asked.
 *
 * cli-1: `--json` stdout carries exactly one machine-readable document;
 * diagnostics go to stderr. cli-2/cli-5: refusals set the exit code without
 * mutating anything. cli-6: every refusal carries reason + nextAction.
 */
import { runServiceRunOnce, type RunOnceResult } from '../services/service-host/index.js';

export interface ServiceRunOnceArgs {
  readonly dryRun: boolean;
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

export async function handleServiceRunOnce(args: ServiceRunOnceArgs): Promise<void> {
  // Phase 1 admission boundary: only the read-only dry-run exists.
  if (!args.dryRun) {
    const reason = 'dry_run_required_phase1';
    const nextAction = 'Phase 1 supports the read-only dry-run only: re-run with --dry-run. Real worker cycles arrive with a later phase (PRI-1280).';
    if (args.json) {
      const output: JsonOutput = { schemaVersion: 'pd.service-run-status.v1', outcome: 'refused', dryRun: false, runId: 'n/a', reason, nextAction };
      console.log(JSON.stringify(output));
    } else {
      printHumanRefusal(reason, nextAction);
    }
    process.exitCode = 1;
    return;
  }

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
