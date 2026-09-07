/**
 * CodexGovernanceHealthModel — Console adapter for the §15 Codex governance
 * health block (Codex Governance Closure Slice D, PRI-625; review round 2
 * authority convergence).
 *
 * The readiness computation has ONE authority: the production CLI
 * `pd health --host codex --json` (packages/pd-cli health-codex.ts). This
 * Console model executes that command in a fresh subprocess against the
 * workspace and returns its report verbatim — the Console MUST NOT copy the
 * readiness calculation, or CLI and Console could disagree about the same
 * governance facts (P4: one source of truth).
 *
 * Failure is explicit (rc-9): if the CLI cannot run, the model returns
 * `status: 'unknown'` with `ready: false` and a `health_collection_failed`
 * blocker — "unable to determine health" is never rendered as healthy.
 *
 * This is a *verbatim* report passthrough, not a projection: no field is
 * recomputed or filtered here.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * The report shape mirrors the CLI's CodexHealthReport exactly (the Console
 * renders it read-only). Declared structurally so a CLI contract change
 * surfaces as a Console compile-time review point, not a silent drift.
 */
export interface CodexGovernanceHealth {
  /** 'ok' = the CLI authority produced a real report (verbatim passthrough). */
  status: 'ok';
  generatedAt: string;
  host: 'codex';
  workspace: string;
  adapterVersion: string;
  runtimeVersion: string;
  codexIngestionMinVersion: string;
  codexIngestionVerifiedVersion: string;
  ingestionFlag: { enabled: boolean; source: string };
  consent: { state: string; disclosureStale?: boolean; failureReason?: string; nextAction?: string };
  workspaceInit: { initialized: boolean; reason?: string };
  hooksTrust: { detectable: boolean; trusted?: boolean; reason?: string };
  dualRegistration: { detected: boolean; legacyAsyncPostToolUse?: boolean; nextAction?: string };
  worker: { mode: string; registeredInInstallManifest: boolean; reason?: string; nextAction?: string };
  rollouts: { checkpoints?: { rolloutIdentity: string; lagBytes: number | null; incompleteTail: boolean; updatedAt: string }[]; reason?: string };
  observations: Record<string, unknown>;
  admissions: Record<string, unknown>;
  diagnosticianTasks: Record<string, unknown>;
  ready: boolean;
  readyBlockers: string[];
  warnings: string[];
}

export type CodexGovernanceHealthResult =
  | { status: 'ok'; health: CodexGovernanceHealth }
  | {
    status: 'unknown';
    ready: false;
    readyBlockers: string[];
    reason: string;
    nextAction: string;
    productClaim: 'degraded';
  };

const require = createRequire(import.meta.url);

function resolvePdCliEntry(): string | null {
  // pd-cli dist entry, resolvable through the workspace node_modules links.
  try {
    const pkgJsonPath = require.resolve('@principles/pd-cli/package.json');
    const packageRoot = path.dirname(pkgJsonPath);
    const entry = path.join(packageRoot, 'dist', 'index.js');
    const packageRootDir = path.resolve(packageRoot);
    if (!path.resolve(entry).startsWith(packageRootDir + path.sep)) return null;
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

export class CodexGovernanceHealthModel {
  private readonly workspaceDir: string;
  private readonly cliEntryOverride: string | null;

  constructor(workspaceDir: string, cliEntryOverride?: string) {
    this.workspaceDir = workspaceDir;
    this.cliEntryOverride = cliEntryOverride ?? null;
  }

  async collect(): Promise<CodexGovernanceHealthResult> {
    const entry = this.cliEntryOverride ?? resolvePdCliEntry();
    if (entry === null) {
      return {
        status: 'unknown',
        ready: false,
        readyBlockers: ['health_collection_failed: pd_cli_unavailable'],
        reason: 'pd_cli_unavailable',
        nextAction: 'Install or build @principles/pd-cli (npm i -g @principles/pd-cli) so the Console can run `pd health --host codex`.',
        productClaim: 'degraded',
      };
    }
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [entry, 'health', '--host', 'codex', '--workspace', this.workspaceDir, '--json'],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      const jsonLine = stdout.trim().split('\n').filter((line) => line.startsWith('{')).pop();
      if (jsonLine === undefined) {
        return {
          status: 'unknown',
          ready: false,
          readyBlockers: ['health_collection_failed: cli_output_not_json'],
          reason: 'cli_output_not_json',
          nextAction: 'Run `pd health --host codex --json` manually and inspect its output.',
          productClaim: 'degraded',
        };
      }
      // runtime-contract-exempt: ERR-001 CLI health authority report passed
      // through VERBATIM by design (review round 2, single-authority
      // requirement): field-by-field revalidation here would duplicate the
      // CLI's own validation and recreate the two-truths problem. The report
      // is never rendered as healthy unless `ready` came from the CLI, and
      // every consumer-visible failure mode is an explicit unknown block.
      const health = JSON.parse(jsonLine) as CodexGovernanceHealth;
      return { status: 'ok', health };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
      return {
        status: 'unknown',
        ready: false,
        readyBlockers: [`health_collection_failed: ${message}`],
        reason: 'health_collection_failed',
        nextAction: 'Run `pd health --host codex --workspace <dir>` manually to see the structured reason.',
        productClaim: 'degraded',
      };
    }
  }
}
