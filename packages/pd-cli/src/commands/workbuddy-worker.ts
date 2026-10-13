/**
 * pd workbuddy worker command implementation (SPEC workbuddy-host-adapter
 * §5 Part 5; ADR-0020 third host).
 *
 * Runs the governance-workspace worker cycle — reconciliation → one
 * Diagnostician execution → one bounded downstream consumer cycle — either
 * once (manual / Companion-supervised restart mode) or continuously. The
 * Codex catch-up step is deliberately absent: the WorkBuddy MVP has no
 * transcript ingestion; the hook is the only evidence producer.
 *
 * `status` answers the §15 worker-mode question without executing anything:
 * `manual_action_required` means no Companion-registered worker serves this
 * governance workspace and the manual commands are the recovery path.
 *
 * CLI gate compliance (mirrors the Codex worker command):
 * - cli-1: --json is restricted to the single-output forms (--once / --status)
 *   so stdout is exactly one parseable JSON object; continuous mode streams
 *   human-readable reports instead.
 * - cli-2: exit paths stop execution.
 * - cli-6: paused/degraded modes carry reason + nextAction.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { runWorkbuddyWorkspaceWorkerCycle, type WorkbuddyWorkerCycleResult } from '@principles/workbuddy-adapter';
import { computeWorkbuddyWorkerStatusMode } from '@principles/host-runtime';
import { getInstallLayoutPaths, parseInstallManifest } from '@principles/install-layout';

const DEFAULT_INTERVAL_MS = 120_000;

interface WorkbuddyWorkerOptions {
  workspace?: string;
  json?: boolean;
  once?: boolean;
  intervalMs?: number;
  status?: boolean;
}

export interface WorkbuddyWorkerStatusReport {
  generatedAt: string;
  host: 'workbuddy';
  workspace: string;
  mode: 'ready' | 'manual_action_required' | 'paused' | 'degraded';
  registeredInInstallManifest: boolean;
  reason?: string;
  nextAction?: string;
}

async function printStatusReport(workspace: string, json: boolean): Promise<void> {
  const generatedAt = new Date().toISOString();
  const paths = getInstallLayoutPaths(os.homedir());
  let registered = false;
  let manifestError: string | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as unknown;
    const parsed = parseInstallManifest(raw);
    if (parsed.manifest !== undefined) {
      registered = parsed.manifest.workspaces?.some((entry) => path.resolve(entry) === path.resolve(workspace)) ?? false;
    } else {
      manifestError = parsed.error;
    }
  } catch {
    manifestError = 'install_manifest_unreadable';
  }

  // The status scan runs the mode evaluation ONLY — a real cycle is NOT run
  // (no execution, no lease, no LLM, no transcript I/O).
  const evaluation = computeWorkbuddyWorkerStatusMode({ workspaceDir: workspace, registeredInInstallManifest: registered });

  const report: WorkbuddyWorkerStatusReport = {
    generatedAt,
    host: 'workbuddy',
    workspace,
    mode: evaluation.mode,
    registeredInInstallManifest: registered,
    ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
    ...(evaluation.nextAction !== undefined ? { nextAction: evaluation.nextAction } : {}),
    ...(manifestError !== undefined ? { reason: `${evaluation.reason ?? manifestError}` } : {}),
  };
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  const lines = [
    `WorkBuddy governance worker status (${workspace})`,
    `  mode: ${report.mode}`,
    `  registered in install manifest: ${registered}`,
  ];
  if (report.reason !== undefined) lines.push(`  reason: ${report.reason}`);
  if (report.nextAction !== undefined) lines.push(`  next action: ${report.nextAction}`);
  console.log(lines.join('\n'));
  if (report.mode === 'degraded') process.exitCode = 1;
}

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

export async function handleWorkbuddyWorker(options: WorkbuddyWorkerOptions): Promise<void> {
  // cli-1: continuous mode streams one report per cycle — that is NOT one
  // parseable JSON document. --json is only valid for the single-output
  // forms (--once / --status), enforced here.
  if (options.json === true && options.once !== true && options.status !== true) {
    const error = {
      generatedAt: new Date().toISOString(),
      host: 'workbuddy',
      error: 'cli_contract',
      reason: 'json_without_once_or_status',
      nextAction: 'Use --json with --once (single cycle) or --status (no-op scan); continuous mode streams human-readable reports instead.',
    };
    console.log(JSON.stringify(error));
    process.exitCode = 1;
    return;
  }

  const workspace = resolveWorkspaceDir(options.workspace);

  if (options.status === true) {
    await printStatusReport(workspace, options.json === true);
    return;
  }

  if (options.once === true) {
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: workspace });
    printCycleReport(result, options.json === true);
    if (result.mode === 'degraded') process.exitCode = 1;
    return;
  }

  const interval = typeof options.intervalMs === 'number' && options.intervalMs >= 1000 ? options.intervalMs : DEFAULT_INTERVAL_MS;
  let stopped = false;
  const onSignal = (): void => {
    stopped = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    while (!stopped) {
      // One escaping cycle exception must not kill the daemon (same
      // PRI-655 discipline as the Codex worker): report, keep looping.
      try {
        const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: workspace });
        printCycleReport(result, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[PD:WorkbuddyWorker] cycle failed: ${message}`);
        console.error(`  continuing in ${interval}ms. Investigate: pd workbuddy worker --status --workspace "${workspace}"`);
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
