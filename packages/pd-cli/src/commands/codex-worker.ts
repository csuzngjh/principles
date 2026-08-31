/**
 * pd codex worker command implementation (Codex Governance Closure Slice C,
 * PRI-624; SPEC §13/§15; ADR-0020 §11.1).
 *
 * Runs the Workspace-scoped worker cycle — catch-up → reconciliation → one
 * Diagnostician execution → one bounded downstream consumer cycle — either
 * once (manual / Companion-supervised restart mode) or continuously.
 *
 * `status` answers the SPEC §15 worker-mode question without executing
 * anything: `manual_action_required` means no Companion-registered worker
 * serves this workspace (it is not in the install manifest) and the manual
 * commands below are the recovery path.
 *
 * CLI gate compliance:
 * - cli-1: --json outputs exactly one parseable JSON object per cycle/scan.
 * - cli-2: exit paths stop execution.
 * - cli-6: paused/degraded modes carry reason + nextAction.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { runCodexWorkspaceWorkerCycle, type CodexWorkerCycleResult } from '@principles/codex-adapter';
import { getInstallLayoutPaths, parseInstallManifest } from '@principles/install-layout';

const DEFAULT_INTERVAL_MS = 120_000;

interface CodexWorkerOptions {
  workspace?: string;
  json?: boolean;
  once?: boolean;
  intervalMs?: number;
  status?: boolean;
}

export interface CodexWorkerStatusReport {
  generatedAt: string;
  host: 'codex';
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

  // The status scan itself delegates mode computation to the cycle module's
  // flag/config semantics by running a paused-compatible evaluation: a real
  // cycle is NOT run (no execution, no lease, no transcript I/O).
  const { computeCodexWorkerStatusMode } = await import('@principles/codex-adapter');
  const evaluation = computeCodexWorkerStatusMode({ workspaceDir: workspace, registeredInInstallManifest: registered });

  const report: CodexWorkerStatusReport = {
    generatedAt,
    host: 'codex',
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
    `Codex workspace worker status (${workspace})`,
    `  mode: ${report.mode}`,
    `  registered in install manifest: ${registered}`,
  ];
  if (report.reason !== undefined) lines.push(`  reason: ${report.reason}`);
  if (report.nextAction !== undefined) lines.push(`  next action: ${report.nextAction}`);
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

export async function handleCodexWorker(options: CodexWorkerOptions): Promise<void> {
  const workspace = resolveWorkspaceDir(options.workspace);

  if (options.status === true) {
    await printStatusReport(workspace, options.json === true);
    return;
  }

  if (options.once === true) {
    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: workspace, env: { CODEX_HOME: process.env.CODEX_HOME } });
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
      const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: workspace, env: { CODEX_HOME: process.env.CODEX_HOME } });
      printCycleReport(result, options.json === true);
      if (result.mode === 'degraded' && options.json === true) {
        // Keep looping — degraded is reportable, not fatal (provider outages
        // recover through the existing retry semantics). Exit code stays 0 so
        // a supervisor restart loop cannot spin on transient degradation.
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** SPEC §15 worker mode, evaluated without executing anything. */