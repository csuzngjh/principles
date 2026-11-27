/**
 * pd workbuddy worker command implementation.
 *
 * The WorkBuddy worker is bounded by design: one cycle per `--once`
 * invocation. There is no continuous mode — the PD Service Host is the only
 * background runtime and owns triggering. A consuming cycle is admitted only
 * for a `service_host_owned` workspace and holds the per-workspace Service
 * Host mutex for the cycle duration. Catch-up drains lag left by a missed or
 * bounded Stop hook and is gated by the same flag AND v3 consent record the
 * hook reads; it is NOT the Codex catch-up.
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
import { resolvePdHome, parseInstallManifest } from '@principles/install-layout';
import { runWorkbuddyWorkspaceWorkerCycle, type WorkbuddyWorkerCycleResult } from '@principles/workbuddy-adapter';
import { computeWorkbuddyWorkerStatusMode, loadPdConfigForPlugin, retentionWarning, runTrajectoryRetention } from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime';
import { admitServiceWorkerCycle, readServiceWorkerOwnership } from './worker-service-host-gate.js';

/** Retention runs after a consumed cycle, outside hooks, bounded, and never on stdout. */
function runRetentionAfterCycle(workspaceDir: string): void {
  try {
    const report = runTrajectoryRetention({ workspaceDir, trigger: 'worker' });
    const warning = retentionWarning(report);
    if (warning !== null) {
      console.error(`[PD:WorkbuddyWorker] ${warning}`);
      return;
    }
    if (report.outcome === 'deferred:busy') return;
    const deleted = Object.values(report.deletedByTable).reduce((sum, count) => sum + count, 0);
    if (report.outcome === 'skipped' && deleted === 0) return;
    console.error(
      `[PD:WorkbuddyWorker] trajectory retention ${report.outcome}`
      + ` deleted=${deleted} batches=${report.batches} durationMs=${report.totalDurationMs}`
      + (report.reason === null ? '' : ` reason=${report.reason}`),
    );
    if (report.nextAction !== undefined) console.error(`  next action: ${report.nextAction}`);
  } catch (error) {
    console.error(`[PD:WorkbuddyWorker] trajectory retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface WorkbuddyWorkerOptions {
  workspace?: string;
  json?: boolean;
  once?: boolean;
  status?: boolean;
}

export interface WorkbuddyWorkerStatusReport {
  generatedAt: string;
  host: 'workbuddy';
  workspace: string;
  mode: 'ready' | 'paused' | 'degraded';
  registeredInInstallManifest: boolean;
  serviceHostManaged: boolean;
  ownership: {
    state: string;
    generation?: number;
    source?: string;
  };
  keywordPain: { enabled: boolean; mode: 'off' | 'keyword_only'; source: string };
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

  // The status scan runs the mode evaluation ONLY — no lease, no LLM, no
  // transcript catch-up, no downstream consumption.
  const evaluation = computeWorkbuddyWorkerStatusMode({ workspaceDir: workspace, registeredInInstallManifest: registered });
  const ownership = ownershipRead.ok ? ownershipRead.ownership : null;
  const ownershipState = ownership === null ? 'unreadable' : ownership.status;
  const serviceHostManaged = ownership?.status === 'service_host_owned';

  let mode: WorkbuddyWorkerStatusReport['mode'];
  let reason: string | undefined;
  let nextAction: string | undefined;
  if (!ownershipRead.ok) {
    mode = 'degraded';
    ({ reason, nextAction } = ownershipRead.result);
  } else if (ownership?.status === 'manifest_unreadable') {
    mode = 'degraded';
    reason = `workbuddy_owner_marker_unreadable:${ownership.reason}`;
    ({ nextAction } = ownership);
  } else if (evaluation.mode === 'degraded') {
    mode = 'degraded';
    ({ reason, nextAction } = evaluation);
  } else if (!serviceHostManaged) {
    mode = 'paused';
    reason = `workbuddy_workspace_not_service_host_owned:${ownershipState}`;
    nextAction = ownershipNextAction();
  } else if (evaluation.mode === 'manual_action_required') {
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

  const keywordConfig = loadPdConfigForPlugin(workspace);
  const keywordFlags = keywordConfig.ok ? computeFeatureFlagsFromConfig(keywordConfig.effective).flags : null;
  const keywordFlag = keywordFlags?.workbuddy_live_keyword_pain;
  const keywordEnabled = keywordFlags?.['host.workbuddy']?.enabled === true && keywordFlag?.enabled === true;
  const report: WorkbuddyWorkerStatusReport = {
    generatedAt,
    host: 'workbuddy',
    workspace,
    mode,
    registeredInInstallManifest: registered,
    serviceHostManaged,
    ownership: {
      state: ownershipState,
      ...(ownership !== null && 'generation' in ownership ? { generation: ownership.generation } : {}),
      ...(ownership !== null && 'source' in ownership && typeof ownership.source === 'string' ? { source: ownership.source } : {}),
    },
    keywordPain: { enabled: keywordEnabled, mode: keywordEnabled ? 'keyword_only' : 'off', source: keywordFlag?.source ?? 'unknown' },
    ...(reason !== undefined ? { reason } : {}),
    ...(nextAction !== undefined ? { nextAction } : {}),
  };
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  const lines = [
    `WorkBuddy governance worker status (${workspace})`,
    `  mode: ${report.mode}`,
    `  registered in install manifest: ${registered}`,
    `  Service Host managed: ${serviceHostManaged}`,
    `  ownership: ${ownershipState}`,
    '  automatic Pain detection: NOT AVAILABLE in WorkBuddy — record pain with the explicit "PD记录痛苦：" prefix',
    `  keyword flag: ${report.keywordPain.mode} (source=${report.keywordPain.source}; has no effect in WorkBuddy)`,
  ];
  if (report.reason !== undefined) lines.push(`  reason: ${report.reason}`);
  if (report.nextAction !== undefined) lines.push(`  next action: ${report.nextAction}`);
  console.log(lines.join('\n'));
  if (report.mode === 'degraded') process.exitCode = 1;
}

/** Print one worker-cycle result: exactly one JSON object under `--json`, else a human summary. */
function printCycleReport(result: WorkbuddyWorkerCycleResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  const lines = [
    `WorkBuddy governance worker (${result.workspaceDir})`,
    `  mode: ${result.mode}${result.reason !== undefined ? ` (${result.reason})` : ''}`,
  ];
  if (result.report !== undefined) {
    const {catchUp} = result.report;
    lines.push(`  catch-up:    ${catchUp.status} examined=${catchUp.examined} ingested=${catchUp.ingested}${catchUp.reason !== undefined ? ` reason=${catchUp.reason}` : ''}`);
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

function printModeError(options: WorkbuddyWorkerOptions, reason: string, nextAction: string): void {
  const error = {
    generatedAt: new Date().toISOString(),
    host: 'workbuddy',
    error: 'cli_contract',
    reason,
    nextAction,
  };
  if (options.json === true) console.log(JSON.stringify(error));
  else console.error(`[PD:WorkbuddyWorker] ${reason}: ${nextAction}`);
  process.exitCode = 1;
}

export async function handleWorkbuddyWorker(options: WorkbuddyWorkerOptions): Promise<void> {
  if (options.once === true && options.status === true) {
    printModeError(options, 'once_and_status_mutually_exclusive', 'Choose --once (one bounded consuming cycle) or --status (no-op scan), not both.');
    return;
  }
  if (options.once !== true && options.status !== true) {
    printModeError(options, 'mode_required', 'The WorkBuddy worker is bounded by design: pass --once for one cycle or --status for the no-op scan. There is no continuous mode — the PD Service Host owns triggering.');
    return;
  }

  // SPEC §4.1: the default workspace is the OD-07 governance workspace —
  // NEVER the generic config default. Resolve it through the same fail-closed
  // PD Home authority as the host hook. Explicit workspaces do not need this
  // resolution because their ownership gate resolves its own pinned PD home.
  let workspace: string;
  if (options.workspace !== undefined && options.workspace.trim().length > 0) {
    workspace = resolveWorkspaceDir(options.workspace);
  } else {
    const pdHome = resolvePdHome();
    if (!pdHome.ok) {
      const error = {
        generatedAt: new Date().toISOString(),
        host: 'workbuddy',
        error: 'pd_home_resolution_failed',
        reason: pdHome.reason,
        nextAction: pdHome.nextAction,
      };
      if (options.json === true) console.log(JSON.stringify(error));
      else console.error(`[PD:WorkbuddyWorker] ${pdHome.reason}: ${pdHome.message}\n  next action: ${pdHome.nextAction}`);
      process.exitCode = 1;
      return;
    }
    workspace = pdHome.workbuddyWorkspaceDir;
  }

  if (options.status === true) {
    await printStatusReport(workspace, options.json === true);
    return;
  }

  const gate = admitServiceWorkerCycle('workbuddy', workspace);
  if (!gate.admitted) {
    printCycleReport(gate.result, options.json === true);
    if (gate.result.mode === 'degraded') process.exitCode = 1;
    return;
  }
  try {
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: workspace, emitEvent: (event, payloadJson) => console.error(`[PD:WorkbuddyWorker] ${event}: ${payloadJson}`) });
    runRetentionAfterCycle(workspace);
    printCycleReport(result, options.json === true);
    if (result.mode === 'degraded') process.exitCode = 1;
  } finally {
    gate.release();
  }
}
