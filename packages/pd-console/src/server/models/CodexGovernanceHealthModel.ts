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
 * blocker — "unable to determine health" is never rendered as healthy. The
 * CLI's own location is resolved from the install layout authority
 * (`resolveUpdateLayout()`), not from the npm dependency graph — PRI-1013.
 *
 * A non-zero CLI exit is NOT by itself a collection failure: the CLI exits 1
 * when the report it produced says governance is not ready (cli-2), and
 * not-ready is the very signal this panel renders — PRI-1013 review found both
 * halves of the same symptom (entry never resolved, then the resolved
 * report discarded on exit 1).
 *
 * This is a *verbatim* report passthrough, not a projection: no field is
 * recomputed or filtered here.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { resolveUpdateLayout } from '../utils/installed-layout.js';

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

export type PdCliEntryResolution =
  | { ok: true; entry: string }
  | { ok: false; reason: string; nextAction: string };

/**
 * Repair action for a machine whose install layout DOES resolve (§1.1: the
 * installer/updater is the only legitimate writer of the install face, so the
 * Owner is pointed at the update chain, never at hand-editing the runtime).
 */
const INSTALLED_REPAIR_ACTION =
  'Finish or re-run the update from the Console update page; if that page reports the layout itself as unusable, repair the install with `npx create-principles-disciple`. Do not edit the runtime directory by hand, and do NOT install the CLI globally with npm — this resolver reads the install layout, not a global npm install.';

/** Repair action for a source checkout with no install to resolve against. */
const DEV_BUILD_ACTION =
  'No PD install layout resolves for this home, so the Console used its own workspace dependency graph for pd-cli. In a source checkout run `npm run build` to emit packages/pd-cli/dist/index.js; on a user machine install PD with `npx create-principles-disciple`.';

const require = createRequire(import.meta.url);

/** rc-1/rc-2: the failure shape from fs is unknown — read `code` only if present. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** rc-8: bounded rendering of an unknown value that goes into an API payload. */
function boundedDetail(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).slice(0, 160);
}

const MANUAL_RUN_ACTION =
  'Run `pd health --host codex --workspace <dir>` manually to see the structured reason.';

/**
 * The degraded result for "the CLI authority produced nothing usable".
 * `reason` separates the two failure classes (rc-9) — the subprocess could not
 * be read at all vs. it printed something that is not a report — while the
 * blocker keeps the single `health_collection_failed` family the panel renders.
 */
function degradedCollection(reason: string, detail: string): CodexGovernanceHealthResult {
  return {
    status: 'unknown',
    ready: false,
    readyBlockers: [`health_collection_failed: ${reason}`],
    reason,
    nextAction: detail.length > 0 ? `${MANUAL_RUN_ACTION} (${detail})` : MANUAL_RUN_ACTION,
    productClaim: 'degraded',
  };
}

/**
 * rc-1..rc-4: stdout from a subprocess is untrusted runtime data even when the
 * subprocess is our own CLI, so the report-bearing fields are checked before the
 * passthrough cast. This is what distinguishes a real report ("not ready" is a
 * valid report) from a usage/rejection JSON or truncated output — the cast below
 * stays a verbatim passthrough of the CLI's documented contract (ERR-001,
 * runtime-contract-exempt per PRI-625 review round 2) because it sits behind it.
 */
function parseCodexReport(text: string): CodexGovernanceHealth | undefined {
  if (text.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  if (Reflect.get(parsed, 'host') !== 'codex') return undefined;
  if (typeof Reflect.get(parsed, 'ready') !== 'boolean') return undefined;
  if (typeof Reflect.get(parsed, 'generatedAt') !== 'string') return undefined;
  const blockers = Reflect.get(parsed, 'readyBlockers');
  if (!Array.isArray(blockers) || !blockers.every((b: unknown) => typeof b === 'string')) {
    return undefined;
  }
  return parsed as CodexGovernanceHealth; // runtime-contract-exempt: ERR-001 verbatim passthrough of our own CLI's documented JSON contract after the field guards above — single authority, see PRI-625 review round 2.
}

/** rc-1/rc-2: the rejection object's shape is unknown — read `stdout` only if present. */
function stdoutFromExecError(error: unknown): string {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'stdout')) return '';
  const { stdout } = error as { stdout?: unknown };
  return typeof stdout === 'string' ? stdout : '';
}

/** rc-1/rc-2: distinguish a process that EXITED from one that was KILLED. A
 * timeout kill, a signal, or a spawn/system error (code is a string, killed is
 * true, or signal is set) means the process failed — stdout on that path is
 * partial or stale output, never a report (PRI-1013 review round 2, P2). */
function execFailureKind(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const rec = error as Record<string, unknown>;
  if (rec.killed === true) return 'killed';
  if (typeof rec.signal === 'string' && rec.signal.length > 0) return `signal ${rec.signal}`;
  if (typeof rec.code === 'string') return rec.code;
  return undefined;
}

/** rc-1/rc-2: same guard for the exit code, used only for the bounded operator detail. */
function exitCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'number' ? code : undefined;
}

/**
 * Classify the entry the INSTALL LAYOUT pointed at. Each failure class gets its
 * own reason so "not wired" (the PRI-1013 constant) can never be mistaken for
 * "the runtime is actually broken" (rc-9, rc-3): ENOENT means the component was
 * never delivered or an update was interrupted, a stat error other than ENOENT
 * means the path could not be read, and a non-file means something else lives
 * there.
 */
function installedEntryVerdict(entry: string): PdCliEntryResolution {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(entry);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, reason: 'pd_cli_entry_missing', nextAction: `${INSTALLED_REPAIR_ACTION} (missing: ${entry})` };
    }
    return {
      ok: false,
      reason: 'pd_cli_entry_unreadable',
      nextAction: `${INSTALLED_REPAIR_ACTION} (stat ${entry} failed: ${code ?? boundedDetail(error)})`,
    };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'pd_cli_entry_invalid', nextAction: `${INSTALLED_REPAIR_ACTION} (${entry} is not a regular file)` };
  }
  return { ok: true, entry };
}

/**
 * Resolve the pd-cli entry to exec — PRI-1013.
 *
 * The install layout is the authority: components are delivered as siblings
 * under `<runtime>/`, and console deliberately does NOT declare
 * `@principles/pd-cli`, so `require.resolve` on that package name threw
 * MODULE_NOT_FOUND on every installed machine and the item degraded forever
 * (the delivery-surface half of this class is ERR-040: declaring the dependency
 * would mean extending bundle-plugin, the installer link sync AND the console
 * inline updater in one change — strictly more durable complexity than wiring
 * the existing layout authority in here).
 *
 * The package graph is consulted only when NO install layout resolves, i.e. a
 * source checkout: there the workspace links are the developer's own build.
 * When the layout does resolve its answer is final — falling through to the npm
 * graph could point at a different pd-cli generation than the install reports.
 */
export function resolvePdCliEntry(): PdCliEntryResolution {
  let layout: ReturnType<typeof resolveUpdateLayout>;
  try {
    layout = resolveUpdateLayout();
  } catch (error) {
    // rc-9: a throwing layout reader is its own failure class, never folded
    // into "not installed" — the repair action differs.
    return {
      ok: false,
      reason: 'install_layout_error',
      nextAction: `${INSTALLED_REPAIR_ACTION} (layout read failed: ${boundedDetail(error)})`,
    };
  }
  if (layout !== undefined) {
    return installedEntryVerdict(path.join(layout.pdCliDir, 'dist', 'index.js'));
  }
  try {
    const pkgJsonPath = require.resolve('@principles/pd-cli/package.json');
    const packageRoot = path.dirname(pkgJsonPath);
    const entry = path.join(packageRoot, 'dist', 'index.js');
    const packageRootDir = path.resolve(packageRoot);
    if (!path.resolve(entry).startsWith(packageRootDir + path.sep)) {
      return { ok: false, reason: 'pd_cli_entry_invalid', nextAction: `${DEV_BUILD_ACTION} (resolved entry escaped the package root ${packageRootDir})` };
    }
    // Deliberately no existsSync preflight — same reasoning as the onboarding
    // route's `findPdCli()`: the Console test job runs before pd-cli is built,
    // so an unbuilt entry must surface as the subprocess's own structured
    // failure, not as an install-layout verdict.
    return { ok: true, entry };
  } catch (error) {
    if (errnoCode(error) === 'MODULE_NOT_FOUND') {
      return { ok: false, reason: 'install_layout_unresolved', nextAction: DEV_BUILD_ACTION };
    }
    return { ok: false, reason: 'install_layout_unresolved', nextAction: `${DEV_BUILD_ACTION} (${boundedDetail(error)})` };
  }
}

export class CodexGovernanceHealthModel {
  private readonly workspaceDir: string;
  private readonly cliEntryOverride: string | null;
  private readonly execTimeoutMs: number;

  constructor(workspaceDir: string, cliEntryOverride?: string, options?: { execTimeoutMs?: number }) {
    this.workspaceDir = workspaceDir;
    this.cliEntryOverride = cliEntryOverride ?? null;
    // PRI-1013 review round 2 (P2): the timeout stays a production default;
    // the option exists only so a regression test can trigger a REAL timeout
    // kill without waiting 30s — never used in production wiring.
    this.execTimeoutMs = options?.execTimeoutMs ?? 30_000;
  }

  async collect(): Promise<CodexGovernanceHealthResult> {
    const resolution: PdCliEntryResolution = this.cliEntryOverride !== null
      ? { ok: true, entry: this.cliEntryOverride }
      : resolvePdCliEntry();
    if (!resolution.ok) {
      return {
        status: 'unknown',
        ready: false,
        readyBlockers: [`health_collection_failed: ${resolution.reason}`],
        reason: resolution.reason,
        nextAction: resolution.nextAction,
        productClaim: 'degraded',
      };
    }
    let stdout: string;
    try {
      const result = await execFileAsync(
        process.execPath,
        [resolution.entry, 'health', '--host', 'codex', '--workspace', this.workspaceDir, '--json'],
        { encoding: 'utf8', timeout: this.execTimeoutMs, windowsHide: true },
      );
      ({ stdout } = result);
    } catch (error) {
      // cli-2 + PRI-1013: `pd health --host codex` exits 1 when the report it
      // produced says NOT READY — non-readiness is the actionable governance
      // signal this panel exists to show, so a non-zero exit only counts as a
      // collection failure when stdout carries no report. On a machine where the
      // Codex host is disabled that was the normal case, and the panel rendered
      // the constant failure instead of the CLI's real blockers.
      //
      // PRI-1013 review round 2 (P2): the ONLY exit that may carry a report
      // out of this catch is the CLI's DESIGNED not-ready signal — exit 1 with
      // ready === false (health-codex.ts sets exitCode = 1 iff !report.ready).
      // A timeout kill, a signal, a spawn/system error, or any other exit code
      // means the process failed; stdout on those paths is partial or stale
      // output and must never render as `status:'ok'`.
      const failureKind = execFailureKind(error);
      const exitCode = exitCodeOf(error);
      if (failureKind === undefined && exitCode === 1) {
        const report = parseCodexReport(stdoutFromExecError(error));
        if (report !== undefined && report.ready === false) return { status: 'ok', health: report };
      }
      return degradedCollection(
        'health_collection_failed',
        `${boundedDetail(error)}${exitCode === undefined ? '' : ` [exit ${exitCode}]`}${failureKind === undefined ? '' : ` [${failureKind}]`}`,
      );
    }
    // cli-1: the CLI's --json mode prints exactly one (pretty-printed) JSON
    // object on stdout — parse the whole stdout, not just the first `{` line.
    const report = parseCodexReport(stdout);
    if (report === undefined) {
      return degradedCollection('report_unusable', boundedDetail(stdout));
    }
    return { status: 'ok', health: report };
  }
}
