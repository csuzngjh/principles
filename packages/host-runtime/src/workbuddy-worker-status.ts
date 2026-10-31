/**
 * WorkBuddy worker status-mode semantics — host-runtime authority (mirrors
 * the Codex Slice D placement): the CLI worker --status and any health
 * surface share ONE mode evaluation, which only depends on host-neutral
 * inputs (governance workspace directory, .pd/config.yaml flags, install
 * manifest registration). The WorkBuddy evaluation has NO ingestion step to
 * gate — the hook is the only evidence producer in the WorkBuddy MVP
 * (SPEC workbuddy-host-adapter §1 Excluded: no transcript reads).
 *
 * SPEC §15 worker mode, evaluated WITHOUT executing anything (no lease, no
 * LLM). `manual_action_required` means no Companion-registered worker serves
 * this governance workspace — manual `pd diagnose` / `pd runtime
 * internalization run-once` is the recovery route.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPdConfigForPlugin } from './pd-config.js';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime-v2';

export type WorkbuddyWorkerMode = 'ready' | 'manual_action_required' | 'paused' | 'degraded';

export interface WorkbuddyWorkerStatusEvaluation {
  readonly mode: WorkbuddyWorkerMode;
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

export function computeWorkbuddyWorkerStatusMode(input: {
  workspaceDir: string;
  registeredInInstallManifest: boolean;
}): WorkbuddyWorkerStatusEvaluation {
  const workspaceDir = path.resolve(input.workspaceDir);
  if (!directoryExists(workspaceDir)) {
    return { mode: 'degraded', reason: 'workspace_missing', nextAction: 'The governance workspace directory does not exist; run the WorkBuddy setup flow to initialize it.' };
  }
  const config = loadPdConfigForPlugin(workspaceDir);
  if (!config.ok) {
    const [first] = config.errors;
    return { mode: 'degraded', reason: `pd_config_invalid:${first?.reason ?? 'unknown'}`, nextAction: first?.nextAction ?? 'Repair the governance workspace .pd/config.yaml.' };
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.workbuddy']?.enabled !== true) {
    // PRI-1063 (review fix): single-line flow mapping — the dotted id is ONE
    // flat key inside the existing `features:` block; a second `features:`
    // block would be a duplicate-key YAML error.
    return { mode: 'paused', reason: 'host.workbuddy_disabled', nextAction: 'Enable WorkBuddy PD behavior in the governance workspace .pd/config.yaml — in the existing "features:" block set host.workbuddy: {enabled: true} (one flat key, not nested).' };
  }
  if (flags.internalization_auto_consumer?.enabled !== true) {
    return { mode: 'paused', reason: 'internalization_auto_consumer_disabled', nextAction: 'Automatic execution is paused; manual commands remain available: pd diagnose, pd runtime internalization run-once.' };
  }
  if (!input.registeredInInstallManifest) {
    return {
      mode: 'manual_action_required',
      reason: 'workspace_not_in_install_manifest',
      nextAction: `No Companion worker is registered for this governance workspace. Manual path: pd diagnose --workspace "${workspaceDir}", then pd runtime internalization run-once.`,
    };
  }
  return { mode: 'ready' };
}
