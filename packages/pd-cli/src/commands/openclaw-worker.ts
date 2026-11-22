/**
 * pd openclaw worker command implementation (SPEC-PD-SERVICE-HOST-001 §4.3,
 * PRI-1282 Phase 4).
 *
 * The bounded OpenClaw workspace worker entry: one cycle per invocation,
 * always explicit-workspace, NEVER continuous — the Service Host OS
 * scheduler owns triggering, and this command must not become a second
 * resident loop. The cycle itself lives in the OpenClaw adapter package
 * (`principles-disciple/openclaw-worker`, the same package that ships the
 * Gateway plugin) and is lazy-imported here so a plain `pd` invocation never
 * loads the plugin bundle (the run-rulehost precedent).
 *
 * `--readiness` runs the no-consume self-check the §8.4 handover sequence
 * requires: it verifies declaration / evidence port / credentials /
 * ownership readability WITHOUT touching the task store.
 *
 * CLI gate compliance:
 * - cli-1: --json prints exactly one parseable JSON document.
 * - cli-2: exit paths stop execution.
 * - cli-5: --readiness never mutates business state (safe by construction).
 * - cli-6: paused/degraded results carry reason + nextAction.
 */
import path from 'node:path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface OpenClawWorkerOptions {
  workspace?: string;
  json?: boolean;
  once?: boolean;
  readiness?: boolean;
}

interface OpenClawWorkerCycleResultShape {
  readonly workspaceDir: string;
  readonly mode: 'ready' | 'paused' | 'degraded';
  readonly reason?: string;
  readonly nextAction?: string;
  readonly report?: {
    ownership: { state: string; generation: number; source: string };
    declaration: { persisted: boolean; validated: boolean; version?: number; reason?: string };
    downstream: { ran: boolean; runStatus?: string; skipReason?: string; taskId?: string; taskKind?: string };
    diagnostician: { served: boolean; status: string; reason?: string; taskId?: string };
  };
}

interface OpenClawWorkerReadinessResultShape {
  readonly mode: 'ready' | 'degraded';
  readonly workspaceDir: string;
  readonly checks: {
    workspaceDirectory: boolean;
    ownership: boolean;
    declaration: boolean;
    evidencePort: boolean;
    credentials: boolean;
  };
  readonly reason?: string;
  readonly nextAction?: string;
}

function printCycleReport(result: OpenClawWorkerCycleResultShape, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  const lines = [
    `OpenClaw workspace worker (${result.workspaceDir})`,
    `  mode: ${result.mode}${result.reason !== undefined ? ` (${result.reason})` : ''}`,
  ];
  if (result.report !== undefined) {
    const { report } = result;
    lines.push(`  ownership:   ${report.ownership.state} (generation ${report.ownership.generation})`);
    lines.push(`  declaration: persisted=${report.declaration.persisted} validated=${report.declaration.validated}${report.declaration.version !== undefined ? ` v${report.declaration.version}` : ''}${report.declaration.reason !== undefined ? ` reason=${report.declaration.reason}` : ''}`);
    lines.push(`  downstream:  ran=${report.downstream.ran}${report.downstream.taskKind !== undefined ? ` kind=${report.downstream.taskKind}` : ''}${report.downstream.runStatus !== undefined ? ` status=${report.downstream.runStatus}` : ''}${report.downstream.skipReason !== undefined ? ` skip=${report.downstream.skipReason}` : ''}`);
    lines.push(`  diagnostician: ${report.diagnostician.status}${report.diagnostician.taskId !== undefined ? ` (${report.diagnostician.taskId})` : ''}`);
  }
  if (result.nextAction !== undefined) lines.push(`  next action: ${result.nextAction}`);
  console.log(lines.join('\n'));
}

export async function handleOpenClawWorker(options: OpenClawWorkerOptions): Promise<void> {
  // cli-1: exactly one JSON document; the two single-output forms are --once
  // and --readiness, and they are mutually exclusive.
  if (options.json === true && options.once !== true && options.readiness !== true) {
    const error = {
      generatedAt: new Date().toISOString(),
      host: 'openclaw',
      error: 'cli_contract',
      reason: 'json_without_once_or_readiness',
      nextAction: 'Use --json with --once (one bounded cycle) or --readiness (no-consume self-check).',
    };
    console.log(JSON.stringify(error));
    process.exitCode = 1;
    return;
  }
  if (options.once === true && options.readiness === true) {
    const error = {
      generatedAt: new Date().toISOString(),
      host: 'openclaw',
      error: 'cli_contract',
      reason: 'once_and_readiness_mutually_exclusive',
      nextAction: 'Choose --once (bounded consuming cycle) or --readiness (no-consume self-check), not both.',
    };
    console.log(JSON.stringify(error));
    process.exitCode = 1;
    return;
  }
  if (options.once !== true && options.readiness !== true) {
    const error = {
      generatedAt: new Date().toISOString(),
      host: 'openclaw',
      error: 'cli_contract',
      reason: 'mode_required',
      nextAction: 'The OpenClaw worker is bounded by design: pass --once for one cycle or --readiness for the no-consume self-check. There is no continuous mode — the PD Service Host owns triggering.',
    };
    console.log(JSON.stringify(error));
    process.exitCode = 1;
    return;
  }
  if (options.workspace === undefined || options.workspace.trim().length === 0) {
    const error = {
      generatedAt: new Date().toISOString(),
      host: 'openclaw',
      error: 'cli_contract',
      reason: 'workspace_required',
      nextAction: 'Pass --workspace <canonical-workspace-dir>; the OpenClaw worker never infers a workspace from the working directory.',
    };
    if (options.json === true) console.log(JSON.stringify(error));
    else console.error(`[PD:OpenClawWorker] --workspace is required: ${error.nextAction}`);
    process.exitCode = 1;
    return;
  }

  const workspace = resolveWorkspaceDir(options.workspace);
  // Lazy import (run-rulehost precedent): keeps the plugin package out of
  // every plain `pd` startup.
  const workerModule = await import('principles-disciple/openclaw-worker');

  if (options.readiness === true) {
    const readiness: OpenClawWorkerReadinessResultShape = workerModule.computeOpenClawWorkerReadiness(workspace);
    if (options.json === true) {
      console.log(JSON.stringify(readiness));
    } else {
      const lines = [
        `OpenClaw worker readiness (no-consume self-check) (${readiness.workspaceDir})`,
        `  mode: ${readiness.mode}`,
        `  workspace directory: ${readiness.checks.workspaceDirectory ? 'ok' : 'MISSING'}`,
        `  ownership marker:   ${readiness.checks.ownership ? 'readable' : 'UNREADABLE'}`,
        `  tool declaration:  ${readiness.checks.declaration ? 'present' : 'MISSING'}`,
        `  evidence port:     ${readiness.checks.evidencePort ? 'readable' : 'UNAVAILABLE'}`,
        `  credentials:       ${readiness.checks.credentials ? 'reachable' : 'UNRESOLVED'}`,
      ];
      if (readiness.reason !== undefined) lines.push(`  reason: ${readiness.reason}`);
      if (readiness.nextAction !== undefined) lines.push(`  next action: ${readiness.nextAction}`);
      console.log(lines.join('\n'));
    }
    if (readiness.mode === 'degraded') process.exitCode = 1;
    return;
  }

  const result: OpenClawWorkerCycleResultShape = await workerModule.runOpenClawWorkspaceWorkerCycle({ workspaceDir: workspace });
  printCycleReport(result, options.json === true);
  if (result.mode === 'degraded') process.exitCode = 1;
}

/** Canonical absolute form for help/nextAction text. */
export function formatOpenClawWorkerCommand(workspaceDir: string): string {
  return `pd openclaw worker --once --json --workspace "${path.resolve(workspaceDir)}"`;
}
