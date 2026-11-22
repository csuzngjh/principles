/**
 * pd service handover / pd service rollback command implementation
 * (SPEC-PD-SERVICE-HOST-001 §8.4, PRI-1282 Phase 4).
 *
 * Operator surface over the per-Workspace atomic ownership transition. The
 * sequence lives in `services/service-host/workspace-handover.ts`; this file
 * is argument parsing, JSON contract and exit codes.
 *
 * CLI gate compliance:
 * - cli-1: --json prints exactly one parseable JSON document.
 * - cli-2: exit paths stop execution (blocked/failed ⇒ exit 1).
 * - cli-5: a refused handover leaves the workspace in its PREVIOUS ownership
 *   (abort_handover restores legacy before returning blocked).
 * - cli-6: every blocked/failed result carries reason + nextAction.
 */
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { runWorkspaceHandover, runWorkspaceRollback } from '../services/service-host/workspace-handover.js';

interface ServiceHandoverOptions {
  workspace?: string;
  json?: boolean;
  pdHome?: string;
  ackWaitMs?: number;
  abort?: boolean;
  resumeOperationId?: string;
}

function invalidUsage(options: ServiceHandoverOptions, json: boolean, kind: 'handover' | 'rollback'): void {
  const error = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 'pd.service-handover-op.v1',
    kind,
    error: 'cli_contract',
    reason: 'workspace_required',
    nextAction: 'Pass --workspace <canonical-workspace-dir>; ownership is per-Workspace and never inferred.',
  };
  if (json) console.log(JSON.stringify(error));
  else console.error(`[PD:ServiceHandover] --workspace is required: ${error.nextAction}`);
  process.exitCode = 1;
}

function wireTerminalAbortSignals(onAbort: () => void): void {
  const handler = (): void => {
    onAbort();
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  process.once('SIGHUP', handler);
}

export async function handleServiceHandover(options: ServiceHandoverOptions): Promise<void> {
  const json = options.json === true;
  if (options.workspace === undefined || options.workspace.trim().length === 0) {
    invalidUsage(options, json, 'handover');
    return;
  }
  const controller = new AbortController();
  wireTerminalAbortSignals(() => controller.abort());
  const workspace = resolveWorkspaceDir(options.workspace);
  const result = await runWorkspaceHandover(workspace, {
    ...(options.pdHome !== undefined ? { pdHomeOverride: options.pdHome } : {}),
    ...(options.ackWaitMs !== undefined ? { ackWaitMs: options.ackWaitMs } : {}),
    ...(options.resumeOperationId !== undefined ? { resumeOperationId: options.resumeOperationId } : {}),
    ...(options.abort === true ? { abort: true } : {}),
    signal: controller.signal,
  });
  if (json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log([
      `OpenClaw workspace handover completed (${result.workspaceDir})`,
      `  operationId:      ${result.operationId}`,
      `  generation:       ${result.generation}`,
      `  readiness:        ${result.readiness}`,
      `  gateway quiesce:  ${result.quiesceAck.outcome} (via ${result.quiesceAck.startedVia}, generation ${result.quiesceAck.generation})`,
      `  worker cycle:     ${result.workerCycle.mode} (exit ${result.workerCycle.exitCode ?? 'n/a'})`,
      `  evidence:         ${result.evidencePath}`,
    ].join('\n'));
  } else {
    console.error([
      `OpenClaw workspace handover ${result.outcome} (${workspace})`,
      `  reason:      ${result.reason}`,
      `  next action: ${result.nextAction}`,
    ].join('\n'));
  }
  if (!result.ok) process.exitCode = 1;
}

export async function handleServiceRollback(options: ServiceHandoverOptions): Promise<void> {
  const json = options.json === true;
  if (options.workspace === undefined || options.workspace.trim().length === 0) {
    invalidUsage(options, json, 'rollback');
    return;
  }
  const controller = new AbortController();
  wireTerminalAbortSignals(() => controller.abort());
  const workspace = resolveWorkspaceDir(options.workspace);
  const result = await runWorkspaceRollback(workspace, {
    ...(options.pdHome !== undefined ? { pdHomeOverride: options.pdHome } : {}),
    signal: controller.signal,
  });
  if (json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log([
      `Workspace rollback completed (${result.workspaceDir})`,
      `  operationId:         ${result.operationId}`,
      `  generation:          ${result.generation}`,
      `  gateway resumption:  ${result.gatewayResumption}`,
      `  evidence:            ${result.evidencePath}`,
    ].join('\n'));
  } else {
    console.error([
      `Workspace rollback ${result.outcome} (${workspace})`,
      `  reason:      ${result.reason}`,
      `  next action: ${result.nextAction}`,
    ].join('\n'));
  }
  if (!result.ok) process.exitCode = 1;
}
