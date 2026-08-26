/**
 * Production eligibility — Anonymous Product Telemetry v1
 * (PRI-597, SPEC §35-§37).
 *
 * Environment suppression is evaluated independently of consent and the
 * feature flag (both are AND-ed by the service). Every suppression reason is
 * named in the result so `pd telemetry status` can show exactly why export is
 * off (rc-9 — no silent suppression).
 *
 * Dev/CI/test detection follows the repository's explicit-marker philosophy
 * (PD_E2E_MODE precedent): env markers and build-layout facts, never
 * user-path heuristics.
 */

import fs from 'node:fs';
import path from 'node:path';

export type TelemetrySuppressionReason =
  | 'env_kill_switch'
  | 'ci_environment'
  | 'vitest_environment'
  | 'e2e_mode'
  | 'workspace_environment'
  | 'install_layout_missing'
  | 'repo_checkout';

export interface TelemetryEnvironmentInput {
  env: {
    /** PD_TELEMETRY_DISABLED raw value. */
    killSwitch?: string;
    /** process.env.CI raw value. */
    ci?: string;
    /** process.env.VITEST raw value (set by vitest workers). */
    vitest?: string;
    /** PD_E2E_MODE raw value. */
    e2eMode?: string;
  };
  /** workspace.environment from .pd/config.yaml (PRI-587); 'unknown' when absent. */
  workspaceEnvironment: 'production' | 'development' | 'demo' | 'test' | 'unknown';
  /** Install layout mode; 'missing' = nothing installed. */
  installMode: 'canonical' | 'legacy' | 'missing';
  /** Directory of the executing telemetry module (repo-checkout detection). */
  moduleDir: string;
}

export interface TelemetryEnvironmentResult {
  suppressed: boolean;
  reasons: TelemetrySuppressionReason[];
}

/** Boolean-style env flags follow the PD_SKIP_* convention: '1' or 'true'. */
export function isEnvFlagActive(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

/**
 * True when the executing module lives inside a PD monorepo checkout.
 *
 * Build-layout fact, not a path heuristic: an installed runtime (canonical
 * `~/.pd/runtime/host-runtime/...` or legacy extension dir) never has a
 * sibling `packages/principles-core` + `packages/host-runtime` tree, while
 * a checkout always does. Prevents maintainer/AI development activity from
 * polluting production telemetry.
 */
export function isRepoCheckoutModuleDir(moduleDir: string): boolean {
  let current = path.resolve(moduleDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const hasCore = fs.existsSync(path.join(current, 'packages', 'principles-core'));
    const hasHostRuntime = fs.existsSync(path.join(current, 'packages', 'host-runtime'));
    if (hasCore && hasHostRuntime) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/**
 * Evaluate environment suppression. Kill switch outranks everything; the
 * result lists every active reason.
 */
export function computeTelemetryEnvironment(input: TelemetryEnvironmentInput): TelemetryEnvironmentResult {
  const reasons: TelemetrySuppressionReason[] = [];
  if (isEnvFlagActive(input.env.killSwitch)) reasons.push('env_kill_switch');
  if (isTruthyEnv(input.env.ci)) reasons.push('ci_environment');
  if (isTruthyEnv(input.env.vitest)) reasons.push('vitest_environment');
  if (input.env.e2eMode === '1') reasons.push('e2e_mode');
  if (input.workspaceEnvironment === 'test' || input.workspaceEnvironment === 'demo' || input.workspaceEnvironment === 'development') {
    reasons.push('workspace_environment');
  }
  if (input.installMode === 'missing') reasons.push('install_layout_missing');
  if (isRepoCheckoutModuleDir(input.moduleDir)) reasons.push('repo_checkout');
  return { suppressed: reasons.length > 0, reasons };
}
