/**
 * pd runtime compatibility-scan — scan active RuleCode for retired
 * RuleHost contract dependencies (2026-08-19).
 *
 * Read-only operator command and the installer's upgrade preflight entry
 * point. Loads ACTIVE code_tool_hook activations (activations ⋈ pi_artifacts
 * from .pd/state.db) and reports every rule whose implementationCode still
 * references a contract symbol this runtime removed (recentThinking,
 * planStatus, hasPlanFile, getPlanStatus(), hasPlanFile()).
 *
 * Output contract (cli-1 strict-json, cli-5 no mutation, cli-6 nextAction):
 * - --json emits exactly one parseable JSON object on stdout.
 * - clean / no_state_db → exit 0; legacy_dependency / scan_failed → exit 1
 *   with reason + nextAction. The command never writes to the workspace.
 *
 * ERR refs: ERR-001/ERR-005 (rows validated from unknown), ERR-002 (every
 * refusal carries reason + nextAction), ERR-014 (bounded JSON output of
 * known shapes).
 */

import * as path from 'path';
import type { Command } from 'commander';
import {
  ActivationCompatibilityReadModel,
  formatLegacyRuleContractRemediation,
  type ActivationCompatibilityScanResult,
  type LegacyRuleContractFinding,
} from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { emitResult, emitError } from '../services/cli-output.js';

function formatFinding(f: LegacyRuleContractFinding): string {
  const rule = f.ruleId ?? f.artifactId;
  const activation = f.activationId ? ` (activation ${f.activationId})` : '';
  return `  ${rule}${activation}: ${f.symbol}`;
}

function formatTextOutput(output: ActivationCompatibilityScanResult): string {
  const lines: string[] = [];
  lines.push('PD Runtime Compatibility Scan');
  lines.push(`workspace: ${output.workspaceDir}`);
  lines.push(`status: ${output.status}`);
  lines.push(`scannedActivations: ${output.scannedActivations}`);
  lines.push('');
  if (output.findings.length > 0) {
    lines.push('Retired-contract dependencies (these rules will NOT execute on this runtime):');
    for (const f of output.findings) lines.push(formatFinding(f));
  } else {
    lines.push('No active rule references a retired RuleHost contract symbol.');
  }
  if (output.reason) lines.push(`reason: ${output.reason}`);
  if (output.nextAction) lines.push(`nextAction: ${output.nextAction}`);
  return lines.join('\n');
}

export interface RuntimeCompatibilityScanOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleRuntimeCompatibilityScan(opts: RuntimeCompatibilityScanOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  try {
    const output = new ActivationCompatibilityReadModel({ workspaceDir }).scan();
    if (output.status === 'legacy_dependency') {
      // Surface the full remediation text in the payload (cli-6) while
      // keeping --json a single parseable object.
      const enriched = { ...output, remediation: formatLegacyRuleContractRemediation(output.findings) };
      emitResult(enriched, { json: opts.json ?? false, formatText: formatTextOutput });
      process.exitCode = 1; // cli-2: exit code only, no process.exit()
      return;
    }
    emitResult(output, { json: opts.json ?? false, formatText: formatTextOutput });
    if (!output.ok) {
      process.exitCode = 1;
    }
  } catch (err) {
    process.exitCode = emitError(err, {
      json: opts.json ?? false,
      nextAction: 'Check workspace directory and permissions, then retry.',
    });
  }
}

/**
 * Register the compatibility-scan subcommand on the `pd runtime` command
 * group. Exported so parser-level wiring tests exercise the same
 * registration index.ts uses (cli-7).
 */
export function registerRuntimeCompatibilityScanCommand(runtimeCmd: Command): void {
  runtimeCmd
    .command('compatibility-scan', { hidden: true })
    .description('Scan active RuleCode for retired RuleHost contract dependencies (read-only; used by the installer upgrade preflight)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      await handleRuntimeCompatibilityScan({
        workspace: opts.workspace,
        json: opts.json === true,
      });
    });
}
