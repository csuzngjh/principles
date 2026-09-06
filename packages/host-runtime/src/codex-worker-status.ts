/**
 * Codex worker status-mode semantics — moved to host-runtime in Slice D
 * (PRI-625): the §15 health surface needs the SAME mode authority in the CLI,
 * the Console, and the worker itself, and this evaluation only depends on
 * host-neutral inputs (workspace directory, .pd/config.yaml flags, install
 * manifest registration). codex-adapter re-exports it for compatibility.
 *
 * SPEC §15 worker mode, evaluated WITHOUT executing anything (no lease, no
 * LLM, no transcript I/O). `manual_action_required` means no
 * Companion-registered worker serves this workspace — the manual CLI path
 * (catch-up / diagnose / run-once) is the recovery route. 'ready' here means
 * "an automatic worker would run and hold the workspace task leases";
 * live-worker liveness surfacing belongs to the Slice D health surface.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPdConfigForPlugin } from './pd-config.js';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime-v2';

export type CodexWorkerMode = 'ready' | 'manual_action_required' | 'paused' | 'degraded';

export interface CodexWorkerStatusEvaluation {
  readonly mode: CodexWorkerMode;
  readonly reason?: string;
  readonly nextAction?: string;
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function computeCodexWorkerStatusMode(input: {
  workspaceDir: string;
  registeredInInstallManifest: boolean;
}): CodexWorkerStatusEvaluation {
  const workspaceDir = path.resolve(input.workspaceDir);
  if (!directoryExists(workspaceDir)) {
    return { mode: 'degraded', reason: 'workspace_missing', nextAction: 'The workspace directory does not exist; restore it or remove it from the install manifest.' };
  }
  const config = loadPdConfigForPlugin(workspaceDir);
  if (!config.ok) {
    const [first] = config.errors;
    return { mode: 'degraded', reason: `pd_config_invalid:${first?.reason ?? 'unknown'}`, nextAction: first?.nextAction ?? 'Repair .pd/config.yaml.' };
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.codex']?.enabled !== true) {
    return { mode: 'paused', reason: 'host.codex_disabled', nextAction: 'Set features.host.codex.enabled=true in the Workspace .pd/config.yaml to enable Codex PD behavior.' };
  }
  if (flags.internalization_auto_consumer?.enabled !== true) {
    return { mode: 'paused', reason: 'internalization_auto_consumer_disabled', nextAction: 'Automatic execution is paused; manual commands remain available: pd diagnose, pd runtime internalization run-once.' };
  }
  if (!input.registeredInInstallManifest) {
    return {
      mode: 'manual_action_required',
      reason: 'workspace_not_in_install_manifest',
      nextAction: `No Companion worker is registered for this workspace. Manual path: pd codex ingest catch-up --workspace "${workspaceDir}", then pd diagnose / pd runtime internalization run-once.`,
    };
  }
  return { mode: 'ready' };
}
