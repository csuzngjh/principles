/**
 * pd codex worker command implementation.
 *
 * The Codex worker is bounded by design: one cycle per `--once` invocation.
 * There is no continuous mode — the PD Service Host is the only background
 * runtime and owns triggering. A consuming cycle is admitted only for a
 * `service_host_owned` workspace and holds the per-workspace Service Host
 * mutex for the cycle duration.
 *
 * CLI gate compliance:
 * - cli-1: --json is restricted to the single-output forms (--once / --status)
 *   so stdout is exactly one parseable JSON object.
 * - cli-2: exit paths stop execution.
 * - cli-6: paused/degraded modes carry reason + nextAction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { runCodexWorkspaceWorkerCycle, type CodexWorkerCycleResult } from '@principles/codex-adapter';
import { parseInstallManifest } from '@principles/install-layout';
import { retentionWarning, runTrajectoryRetention } from '@principles/host-runtime';
import { admitServiceWorkerCycle, readServiceWorkerOwnership } from './worker-service-host-gate.js';

/**
 * SPEC-PD-TR-001 §4.1: the worker cycle is the retention scheduler. It runs
 * OUTSIDE any hook, after a consumed cycle, never blocks the cycle's own
 * deadline, and never writes stdout — the `--json --once` contract must stay
 * one JSON document.
 */
function runRetentionAfterCycle(workspaceDir: string): void {
  try {
    const report = runTrajectoryRetention({ workspaceDir, trigger: 'worker' });
    const warning = retentionWarning(report);
    if (warning !== null) {
      console.error(`[PD:CodexWorker] ${warning}`);
      return;
    }
    if (report.outcome === 'deferred:busy') return;
    const deleted = Object.values(report.deletedByTable).reduce((sum, count) => sum + count, 0);
    if (report.outcome === 'skipped' && deleted === 0) return;
    console.error(
      `[PD:CodexWorker] trajectory retention ${report.outcome}`
      + ` deleted=${deleted} batches=${report.batches} durationMs=${report.totalDurationMs}`
      + (report.reason === null ? '' : ` reason=${report.reason}`),
    );
    if (report.nextAction !== undefined) console.error(`  next action: ${report.nextAction}`);
  } catch (error) {
    // A maintenance failure must never take down the governance worker.
    console.error(`[PD:CodexWorker] trajectory retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface CodexWorkerOptions {
  workspace?: string;
  json?: boolean;
  once?: boolean;
  status?: boolean;
}

export interface CodexWorkerStatusReport {
  generatedAt: string;
  host: 'codex';
  workspace: string;
  mode: 'ready' | 'paused' | 'degraded';
  registeredInInstallManifest: boolean;
  serviceHostManaged: boolean;
  ownership: {
    state: string;
    generation?: number;
    source?: string;
  };
  reason?: string;
  nextAction?: string;
}

function ownershipNextAction(): string {
  return 'Provision or repair this workspace with the PD installer (npx create-principles-disciple) so it is marked service_host_owned, then verify pd service status. Manual worker invocation does not consume non-Service-Host-owned workspaces.';
}

async function printStatusReport(workspace: string, json: boolean): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ownershipRead = readServiceWorkerOwnership(workspace);
  let registered = false;
  let manifestError: string | undefined;
  if (ownershipRead.ok) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ownershipRead.pdHome, 'install.json'), 'utf8')) as unknown;
      const parsed = parseInstallManifest(raw);
      if (parsed.manifest !== undefined) {
        registered = parsed.manifest.workspaces?.some((entry) => path.resolve(entry) === path.resolve(workspace)) ?? false;
      } else {
        manifestError = parsed.error;
      }
    } catch {
      manifestError = 'install_manifest_unreadable';
    }
  } else {
    manifestError = ownershipRead.result.reason;
  }

  // The status scan itself delegates config/flag readiness to the cycle
  // module's semantics without executing anything: no lease, no transcript
  // catch-up, no downstream consumption.
  const { computeCodexWorkerStatusMode, readCodexWorkerLiveness } = await import('@principles/codex-adapter');
  const evaluation = computeCodexWorkerStatusMode({ workspaceDir: workspace, registeredInInstallManifest: registered });

  const ownership = ownershipRead.ok ? ownershipRead.ownership : null;
  const ownershipState = ownership === null ? 'unreadable' : ownership.status;
  const serviceHostManaged = ownership?.status === 'service_host_owned';

  let mode: CodexWorkerStatusReport['mode'];
  let reason: string | undefined;
  let nextAction: string | undefined;
  if (!ownershipRead.ok) {
    mode = 'degraded';
    ({ reason, nextAction } = ownershipRead.result);
  } else if (ownership?.status === 'manifest_unreadable') {
    mode = 'degraded';
    reason = `codex_owner_marker_unreadable:${ownership.reason}`;
    ({ nextAction } = ownership);
  } else if (evaluation.mode === 'degraded') {
    mode = 'degraded';
    ({ reason, nextAction } = evaluation);
  } else if (!serviceHostManaged) {
    mode = 'paused';
    reason = `codex_workspace_not_service_host_owned:${ownershipState}`;
    nextAction = ownershipNextAction();
  } else if (evaluation.mode === 'manual_action_required') {
    // A service_host_owned record cannot exist for an unregistered workspace
    // through the alias-safe reader; if inconsistent input ever produces this
    // combination, report the manifest defect without invoking retired
    // Companion recovery copy.
    mode = 'paused';
    reason = 'workspace_not_in_install_manifest';
    nextAction = 'Repair the install manifest/provisioning record with the PD installer; the Service Host can manage only manifest-registered workspaces.';
  } else {
    mode = evaluation.mode === 'ready' ? 'ready' : 'paused';
    ({ reason, nextAction } = evaluation);
  }
  if (manifestError !== undefined && mode !== 'degraded' && reason === undefined) {
    reason = manifestError;
  }

  // Readiness (ownership/config) and liveness (recent real cycles) are
  // separate facts — a ready workspace with no recent cycle evidence reports
  // no_recent_cycle, never "running".
  const liveness = readCodexWorkerLiveness(workspace);
  const livenessReport: Record<string, unknown> = liveness === null
    ? { state: 'no_liveness_record' }
    : { state: 'recorded', ...liveness };
  if (liveness !== null) {
    const lastCompleted = typeof liveness.lastCycleCompletedAt === 'string' ? Date.parse(liveness.lastCycleCompletedAt) : NaN;
    const runningStage = typeof liveness.runningStage === 'string' ? liveness.runningStage : null;
    const stageDeadline = typeof liveness.stageDeadline === 'string' ? Date.parse(liveness.stageDeadline) : NaN;
    const ageMs = Number.isFinite(lastCompleted) ? Date.now() - lastCompleted : null;
    if (ageMs !== null) livenessReport.ageMs = ageMs;
    if (runningStage !== null && Number.isFinite(stageDeadline)) {
      livenessReport.withinStageDeadline = Date.now() <= stageDeadline;
    }
    // Two poll windows (default 240s) with no cycle evidence and no running
    // stage within its deadline = the worker is not cycling. A fresh paused
    // heartbeat is an intentional config pause, not a stall; a stale one is.
    const lastStarted = typeof liveness.lastCycleStartedAt === 'string' ? Date.parse(liveness.lastCycleStartedAt) : NaN;
    const pausedRecently = runningStage === 'paused'
      && Number.isFinite(lastStarted)
      && Date.now() - lastStarted <= 240_000;
    const stalled = (ageMs === null || ageMs > 240_000)
      && !(runningStage !== null && Number.isFinite(stageDeadline) && Date.now() <= stageDeadline)
      && !pausedRecently;
    livenessReport.verdict = pausedRecently && !stalled ? 'paused' : (stalled ? 'no_recent_cycle' : 'live');
    const driver = typeof liveness.lastCycleDriver === 'string' ? liveness.lastCycleDriver : null;
    livenessReport.lastCycleDriver = driver ?? 'unknown';
    if (stalled) {
      livenessReport.stallReason = driver === 'companion'
        ? 'historical_legacy_driver_retired: the last cycle was driven by the retired Companion runtime; Companion is no longer a worker driver'
        : driver === 'service_host'
          ? 'service_driver_not_resident: the last cycle was service-host-driven; automatic cycles require an enabled OS scheduler registration'
          : driver === 'manual'
            ? 'no_resident_driver: the last cycle was a manual invocation; manual invocation never creates automatic Service Host cycles'
            : 'no_recent_cycle_evidence';
      livenessReport.nextAction = driver === 'companion'
        ? 'Treat the Companion record as historical only. Verify pd service status; if the workspace is service_host_owned, install/enable the Service Host scheduler — do not restart Companion.'
        : driver === 'service_host'
          ? 'Run pd service status; install or enable the Service Host scheduler if it is missing/disabled, or run pd service run-once --json for one managed cycle.'
          : 'Use the PD Service Host for automatic cycles: provision the workspace as service_host_owned, then verify pd service status.';
    }
  }

  const report: CodexWorkerStatusReport & { liveness?: Record<string, unknown> } = {
    generatedAt,
    host: 'codex',
    workspace,
    mode,
    registeredInInstallManifest: registered,
    serviceHostManaged,
    ownership: {
      state: ownershipState,
      ...(ownership !== null && 'generation' in ownership ? { generation: ownership.generation } : {}),
      ...(ownership !== null && 'source' in ownership && typeof ownership.source === 'string' ? { source: ownership.source } : {}),
    },
    ...(reason !== undefined ? { reason } : {}),
    ...(nextAction !== undefined ? { nextAction } : {}),
    liveness: livenessReport,
  };
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  const lines = [
    `Codex workspace worker status (${workspace})`,
    `  mode: ${report.mode}`,
    `  registered in install manifest: ${registered}`,
    `  Service Host managed: ${serviceHostManaged}`,
    `  ownership: ${ownershipState}`,
  ];
  if (report.reason !== undefined) lines.push(`  reason: ${report.reason}`);
  if (report.nextAction !== undefined) lines.push(`  next action: ${report.nextAction}`);
  lines.push(`  liveness state: ${String(livenessReport.state)}${livenessReport.verdict !== undefined ? ` (${String(livenessReport.verdict)})` : ''}`);
  if (typeof livenessReport.lastCycleCompletedAt === 'string') lines.push(`  last cycle completed: ${livenessReport.lastCycleCompletedAt}`);
  if (typeof livenessReport.lastCycleMode === 'string') lines.push(`  last cycle mode: ${livenessReport.lastCycleMode}`);
  if (typeof livenessReport.lastCycleDriver === 'string') lines.push(`  last cycle driver: ${livenessReport.lastCycleDriver}`);
  if (typeof livenessReport.stallReason === 'string') lines.push(`  stall reason: ${livenessReport.stallReason}`);
  if (typeof livenessReport.nextAction === 'string') lines.push(`  liveness next action: ${livenessReport.nextAction}`);
  console.log(lines.join('\n'));
  if (report.mode === 'degraded') process.exitCode = 1;
}

function printCycleReport(result: CodexWorkerCycleResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  const lines = [
    `Codex workspace worker (${result.workspaceDir})`,
    `  mode: ${result.mode}${result.reason !== undefined ? ` (${result.reason})` : ''}`,
  ];
  if (result.report !== undefined) {
    const {catchUp} = result.report;
    const catchUpSummary = catchUp.status === 'skipped' ? `skipped (${catchUp.reason})` : `${catchUp.status} — processed=${catchUp.rollouts.length} lag=${catchUp.remainingLagRollouts.length}`;
    lines.push(`  catch-up:    ${catchUpSummary}`);
    lines.push(`  reconcile:   ok=${result.report.reconcile.ok} ensured=${result.report.reconcile.tasksEnsured} linksRepaired=${result.report.reconcile.linksRepaired}`);
    if (result.report.diagnostician !== null) {
      lines.push(`  diagnostician: ${result.report.diagnostician.status} (${result.report.diagnostician.taskId})`);
    } else {
      lines.push('  diagnostician: none pending');
    }
    if (result.report.downstream !== null) {
      lines.push(`  downstream:  ran=${result.report.downstream.ran}${result.report.downstream.taskKind !== undefined ? ` kind=${result.report.downstream.taskKind}` : ''}${result.report.downstream.skipReason !== undefined ? ` skip=${result.report.downstream.skipReason}` : ''}`);
    }
  }
  if (result.nextAction !== undefined) lines.push(`  next action: ${result.nextAction}`);
  console.log(lines.join('\n'));
}

function printModeError(options: CodexWorkerOptions, reason: string, nextAction: string): void {
  const error = {
    generatedAt: new Date().toISOString(),
    host: 'codex',
    error: 'cli_contract',
    reason,
    nextAction,
  };
  if (options.json === true) console.log(JSON.stringify(error));
  else console.error(`[PD:CodexWorker] ${reason}: ${nextAction}`);
  process.exitCode = 1;
}

export async function handleCodexWorker(options: CodexWorkerOptions): Promise<void> {
  if (options.once === true && options.status === true) {
    printModeError(options, 'once_and_status_mutually_exclusive', 'Choose --once (one bounded consuming cycle) or --status (no-op scan), not both.');
    return;
  }
  if (options.once !== true && options.status !== true) {
    printModeError(options, 'mode_required', 'The Codex worker is bounded by design: pass --once for one cycle or --status for the no-op scan. There is no continuous mode — the PD Service Host owns triggering.');
    return;
  }

  const workspace = resolveWorkspaceDir(options.workspace);

  if (options.status === true) {
    await printStatusReport(workspace, options.json === true);
    return;
  }

  const gate = admitServiceWorkerCycle('codex', workspace);
  if (!gate.admitted) {
    printCycleReport(gate.result, options.json === true);
    if (gate.result.mode === 'degraded') process.exitCode = 1;
    return;
  }
  try {
    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: workspace, env: { CODEX_HOME: process.env.CODEX_HOME }, emitEvent: (event, payloadJson) => console.error(`[PD:CodexWorker] ${event}: ${payloadJson}`) });
    runRetentionAfterCycle(workspace);
    printCycleReport(result, options.json === true);
    if (result.mode === 'degraded') process.exitCode = 1;
  } finally {
    gate.release();
  }
}
