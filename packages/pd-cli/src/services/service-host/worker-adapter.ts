/**
 * Worker Adapter minimal unified contract (TD §2.3, SPEC §11 Phase 2).
 *
 * The Service Host knows ONLY this stable contract — it never judges Pain
 * content, candidate selection or business task internals (no second
 * Diagnostician/Internalization/Recovery/candidate pipeline; no second Task
 * Store, Queue or Lease). Each adapter wraps ONE existing bounded Worker
 * Cycle entry — `pd <host> worker --once --json --workspace <dir>` — in a
 * real subprocess of the ACTIVE RELEASE CLI (never a source worktree), and
 * normalizes its structured result into the contract fields:
 *
 *   hostKind / adapterVersion / supports / executeOnce
 *   cycleOutcome / reason / nextAction / lastProgressAt
 *   health (liveness facts) / startedAt / completedAt / durationMs.
 *
 * Unknown or malformed Worker output fails CLOSED (rc-1..rc-4): an
 * unparseable or shape-rejected result is `failed`, never a guessed
 * success. `supports` judges ONLY from validated discovery evidence — a
 * host binding claim or a persisted host-tool declaration — never from
 * `host.*` feature flags, cwd, or environment variables (TD §5.1).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getInstallLayoutPaths, getPdCliEntry } from '@principles/install-layout';
import { collectWorkspaceCredentialEnvNames, loadPdConfigForPlugin } from '@principles/host-runtime';
import type { InstallIdentity } from './install-identity.js';
import type { ActiveReleaseFacts } from './status/service-run-status.js';
import type { WorkspaceDiscoveryVerdict } from './workspace-discovery.js';
import { buildWorkerEnvironment, LAUNCH_CONTROL_ENV_VARS, type WorkerEnvironmentReport } from './worker-env.js';
import { runWorkerProcess, type WorkerProcessOptions, type WorkerProcessResult } from './worker-process.js';
import {
  diffTaskProgress,
  readTaskProgressSnapshot,
  type TaskProgressEvidence,
} from './progress-evidence.js';

export const WORKER_ADAPTER_CONTRACT_VERSION = 'pd.worker-adapter.v1';

export type WorkerHostKind = 'codex' | 'workbuddy' | 'openclaw';
/**
 * The MANAGED host set (PRI-1282 Phase 4): every host whose worker the
 * coordinator may drive for a `service_host_owned` workspace — OpenClaw
 * joins here, where the ownership admission gate is the only entry.
 */
export const MANAGED_WORKER_HOST_KINDS: readonly WorkerHostKind[] = ['codex', 'workbuddy', 'openclaw'];

export interface WorkspaceDescriptor {
  /** Canonical (realpath-preferred) absolute workspace dir. */
  readonly canonicalDir: string;
  readonly discoveryVerdict: WorkspaceDiscoveryVerdict;
  /** Hosts whose VALIDATED claims (source B) name this workspace. */
  readonly claimingHosts: readonly string[];
  /** Hosts with a persisted host-tool declaration (`.pd/host-tool-semantics/<host>.json`). */
  readonly declaredHostKinds: readonly WorkerHostKind[];
}

export type AdapterSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string; readonly nextAction: string };

export type AdapterCycleOutcome =
  | 'cycle_completed'
  | 'cycle_completed_without_business_progress'
  | 'paused'
  | 'degraded'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'unavailable';

export interface BusinessProgressEvidence {
  /** A task was created or transitioned status in the workspace state store. */
  readonly taskStateChanged: boolean;
  readonly changedTaskCount: number;
  readonly diagnosticianSucceeded: boolean;
  readonly downstreamRan: boolean;
  readonly postProcessingResumed: number;
  readonly catchUpProcessed: number;
  /** False when the pre/post task snapshots could not be read (rc-9). */
  readonly evidenceReadable: boolean;
  readonly evidenceReason?: string;
}

export interface AdapterCycleHealth {
  readonly livenessFile: string;
  readonly livenessRecorded: boolean;
  readonly lastCycleDriver: string | null;
  readonly lastCycleCompletedAt: string | null;
  readonly lastCycleMode: string | null;
  readonly runningStage: string | null;
  /**
   * The invocation id the worker recorded in its liveness file (F13, TD §5.2
   * 显式传入 invocationId): when the worker ran under this adapter the value
   * equals `invocationId`, closing the correlation loop between the
   * coordinator-side id and the shared liveness record.
   */
  readonly lastInvocationId: string | null;
}

export interface AdapterCycleResult {
  readonly hostKind: WorkerHostKind;
  readonly adapterVersion: typeof WORKER_ADAPTER_CONTRACT_VERSION;
  readonly workspaceDir: string;
  readonly invocationId: string;
  readonly cycleOutcome: AdapterCycleOutcome;
  readonly reason?: string;
  readonly nextAction?: string;
  /** THIS cycle's evidenced progress timestamp; null = none this cycle (task §6). */
  readonly lastProgressAt: string | null;
  readonly businessProgress: BusinessProgressEvidence;
  readonly health: AdapterCycleHealth;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly worker: {
    readonly cliEntry: string;
    readonly cliEntrySource: 'canonical' | 'legacy';
    readonly exitCode: number | null;
    readonly termSignal: string | null;
    readonly timedOut: boolean;
    readonly cancelled: boolean;
    readonly stdoutTruncated: boolean;
    readonly stderrTail?: string;
    /** Settled before the child's stdio fully drained (leaked descendant pipes). */
    readonly closePending?: boolean;
    readonly environmentReport: WorkerEnvironmentReport;
  };
  /** Worker mode when the CLI result parsed ('ready' | 'paused' | 'degraded'). */
  readonly workerMode?: string;
}

export interface WorkerAdapterExecuteInput {
  readonly workspaceDir: string;
  readonly activeRelease: ActiveReleaseFacts;
  readonly invocationId: string;
  readonly timeoutMs: number;
  /**
   * Absolute MONOTONIC deadline (a `performance.now()` timestamp, ms) shared
   * by every adapter bound to this workspace (P1-01 final-remediation
   * review): the whole adapter path — entry resolution, config/env build,
   * pre/post snapshots and the subprocess run — lives inside this one
   * budget, not just the child's run time. When omitted the adapter derives
   * one from `timeoutMs`. It is never persisted or used as wall clock.
   */
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
  readonly identity: InstallIdentity;
  /** Environment the allowlist is applied to (default: process.env). */
  readonly inheritedEnv?: Readonly<Record<string, string | undefined>>;
  readonly probes?: WorkerAdapterProbes;
}

export interface WorkerAdapterProbes {
  /** Subprocess boundary injection (unit tests). */
  readonly spawnWorkerProcess?: (options: WorkerProcessOptions) => Promise<WorkerProcessResult>;
  /**
   * CLI-entry resolution injection (integration tests point at a built dev
   * tree; production ALWAYS uses the active-release install, task §7.4).
   */
  readonly resolveCliEntry?: typeof resolveActiveReleaseCliEntry;
  readonly now?: () => Date;
  /**
   * Task-progress snapshot read injection (P1-02 deadline/I-O boundary
   * tests). Production ALWAYS uses the real store reader.
   */
  readonly readTaskProgressSnapshot?: typeof readTaskProgressSnapshot;
}

export interface WorkerAdapter {
  readonly hostKind: WorkerHostKind;
  readonly adapterVersion: typeof WORKER_ADAPTER_CONTRACT_VERSION;
  supports(descriptor: WorkspaceDescriptor): AdapterSupport;
  executeOnce(input: WorkerAdapterExecuteInput): Promise<AdapterCycleResult>;
}

/** Per-host differences inside the shared once-CLI adapter implementation. */
export interface CliWorkerHostConfig {
  readonly hostKind: WorkerHostKind;
  readonly livenessFileName: string;
  /** Existing per-host liveness reader (Codex today; WorkBuddy ships with this change). */
  readLiveness(workspaceDir: string): Record<string, unknown> | null;
  /** Extract corroborating evidence from the parsed cycle report (guarded per field). */
  extractCycleEvidence(parsed: Record<string, unknown>): Omit<BusinessProgressEvidence, 'taskStateChanged' | 'changedTaskCount' | 'evidenceReadable' | 'evidenceReason'>;
}

// ── runtime guards (rc-1 / rc-2 / rc-4 / rc-5) ─────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const WORKER_RESULT_MODES = new Set(['ready', 'paused', 'degraded']);

/** Same-path comparison under the workspace identity rule (win32 case-insensitive). */
function sameWorkspaceDir(a: string, b: string): boolean {
  const resolved = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return resolved(a) === resolved(b);
}

/** Resolution of the active-release CLI entry (discriminated by `kind`). */
export type ActiveReleaseCliEntry =
  | { readonly kind: 'entry'; readonly entry: string; readonly source: 'canonical' | 'legacy' }
  | { readonly kind: 'missing'; readonly reason: string; readonly nextAction: string };

/** Resolve the ACTIVE RELEASE CLI entry — canonical runtime first, legacy extension fallback. */
export function resolveActiveReleaseCliEntry(identity: InstallIdentity): ActiveReleaseCliEntry {
  const paths = getInstallLayoutPaths(identity.homeDir, {});
  const canonical = getPdCliEntry(paths, 'canonical');
  try {
    if (fs.statSync(canonical).isFile()) return { kind: 'entry', entry: canonical, source: 'canonical' };
  } catch {
    // fall through to legacy
  }
  const legacy = getPdCliEntry(paths, 'legacy');
  try {
    if (fs.statSync(legacy).isFile()) return { kind: 'entry', entry: legacy, source: 'legacy' };
  } catch {
    // fall through to refusal
  }
  return {
    kind: 'missing',
    reason: 'cli_entry_missing',
    nextAction: `No installed pd-cli entry exists for this install (looked for ${canonical} and ${legacy}). Repair the install with npx create-principles-disciple; the managed cycle refused instead of running a Worker from a source worktree.`,
  };
}

function livenessFacts(config: CliWorkerHostConfig, workspaceDir: string): AdapterCycleHealth {
  const raw = config.readLiveness(workspaceDir);
  const record = raw !== null && isPlainRecord(raw) ? raw : null;
  const runningStage = record !== null ? record.runningStage : undefined;
  return {
    livenessFile: path.join(path.resolve(workspaceDir), '.state', config.livenessFileName),
    livenessRecorded: record !== null,
    lastCycleDriver: record !== null ? readString(record, 'lastCycleDriver') : null,
    lastCycleCompletedAt: record !== null ? readString(record, 'lastCycleCompletedAt') : null,
    lastCycleMode: record !== null ? readString(record, 'lastCycleMode') : null,
    runningStage: typeof runningStage === 'string' ? runningStage : null,
    lastInvocationId: record !== null ? readString(record, 'lastInvocationId') : null,
  };
}

const STDERR_TAIL_PERSIST = 400;

/**
 * Sanitize worker-emitted free text before it reaches the persisted status
 * (F3 review fix, CWE-532): subprocess stderr and worker-reported
 * reason/nextAction strings can embed absolute filesystem paths, config
 * fragments or upstream error content — truncation alone removes none of
 * that. Discipline (EP-08 / ERR-198): strip control characters, redact
 * absolute-path-like substrings to `<path>`, and bound the remainder.
 * Closed reason codes produced by OUR worker survive verbatim; only
 * embedded path/whitespace noise is normalized.
 */
// P2-04 (final-remediation review): path redaction must not stop at the
// FIRST segment group — a Windows path containing spaces
// (`C:\Users\Jane Doe\…`) used to leak its tail because the old pattern
// required every segment to be whitespace-free. Middle segments may
// contain spaces only when followed by another separator; the final
// segment stays whitespace-bounded so an English sentence is not eaten.
// eslint-disable-next-line no-control-regex -- control chars must not break path matching; they are stripped after redaction
const WINDOWS_DRIVE_PATH = /[A-Za-z]:[\\/](?:[^\x00-\x1F\\/:*?"<>|]+[\\/])*[^\s\x00-\x1F\\/:*?"<>|]*/g;
// eslint-disable-next-line no-control-regex -- same rationale as WINDOWS_DRIVE_PATH
const WINDOWS_UNC_PATH = /\\\\[^\s\x00-\x1F\\/:*?"<>|]+[\\/](?:[^\x00-\x1F\\/:*?"<>|]+[\\/])*[^\s\x00-\x1F\\/:*?"<>|]*/g;
// eslint-disable-next-line no-control-regex -- same rationale as WINDOWS_DRIVE_PATH
const POSIX_ABS_PATH = /\/(?:[^\s"'`\\/:*?<>|\x00-\x1F]+\/)+[^\s"'`\\/:*?<>|\x00-\x1F]*/g;
// Credential material must never reach a status file or plain log: only the
// variable NAME survives (`FOO_API_KEY=<redacted>`), the value is dropped.
const CREDENTIAL_ASSIGNMENT = /\b(?:[A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*["']?[^\s"'`,;]+/g;
const BEARER_TOKEN = /\bBearer\s+[^\s"'`,;]+/g;
const API_KEY_LIKE = /\b(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs]|AIza|eyJ)[A-Za-z0-9_\-.]{7,}/g;

export function sanitizeWorkerText(value: string, max: number = STDERR_TAIL_PERSIST): string {
  const withoutSecrets = value
    .replace(BEARER_TOKEN, 'Bearer <redacted>')
    .replace(CREDENTIAL_ASSIGNMENT, '<redacted>')
    .replace(API_KEY_LIKE, '<redacted>');
  const withoutPaths = withoutSecrets
    .replace(WINDOWS_UNC_PATH, '<path>')
    .replace(WINDOWS_DRIVE_PATH, '<path>')
    .replace(POSIX_ABS_PATH, '<path>');
  const clean = withoutPaths.replace(/[^\x20-\x7E]+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Back-compat name for the stderr-tail sanitization. */
function boundedTail(value: string): string {
  return sanitizeWorkerText(value, STDERR_TAIL_PERSIST);
}

/** Env var names that can never be re-admitted through the credential allowlist (pointer set + runtime-launch steering names, worker-env.ts — one deny-list, two checkpoints). */
const POINTER_ENV_NAMES = new Set([
  'PD_EXPERIMENT_ROOT', 'PD_WORKSPACE_DIR', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME',
  'PD_COMPANION_WORKER_IPC', 'PD_INVOCATION_SOURCE', 'HOME', 'USERPROFILE', 'CODEX_HOME',
  'WORKBUDDY_CONFIG_DIR',
  ...LAUNCH_CONTROL_ENV_VARS,
]);

/**
 * Read the credential names out of an effective config value: the shared
 * host-runtime collector (PRI-1282 Phase 4 — one source for the Service
 * Host allowlist and the OpenClaw worker readiness check) minus the
 * pointer/launch deny-list, which is this package's environment-isolation
 * domain. A future shape change degrades to an empty allowlist — the
 * worker reports config problems itself — never a guess.
 */
function collectCredentialEnvNames(effective: unknown): readonly string[] {
  return collectWorkspaceCredentialEnvNames(effective)
    .filter((name) => !POINTER_ENV_NAMES.has(name.toUpperCase()));
}

/**
 * Extract the credential variable NAMES the workspace's effective runtime
 * config actually uses (`apiKeyEnv` on each runtime profile — F4 review
 * fix). Read-only: an invalid/unreadable config yields an empty list (the
 * worker will report the config problem itself); a valid config yields the
 * exact names `resolveProviderApiKey` will read from the child env. Names
 * are defensively validated and pointer names can never be re-admitted.
 */
export function readConfigCredentialEnvNames(workspaceDir: string): readonly string[] {
  try {
    const config = loadPdConfigForPlugin(workspaceDir);
    if (!config.ok) return [];
    const { effective } = config;
    return collectCredentialEnvNames(effective);
  } catch {
    return [];
  }
}

/**
 * The shared once-CLI adapter implementation: build the allowlist env, run
 * the bounded child, diff task progress, read liveness, normalize. Both
 * host adapters are thin configurations of this one implementation — the
 * Worker invocation protocol is shared, only evidence shapes differ.
 */
export function createOnceCliWorkerAdapter(config: CliWorkerHostConfig): WorkerAdapter {
  return {
    hostKind: config.hostKind,
    adapterVersion: WORKER_ADAPTER_CONTRACT_VERSION,
    supports(descriptor: WorkspaceDescriptor): AdapterSupport {
      if (descriptor.discoveryVerdict !== 'authorized') {
        return {
          supported: false,
          reason: `workspace_not_authorized:${descriptor.discoveryVerdict}`,
          nextAction: 'Only discovery-authorized workspaces may run a managed Service Host cycle; fix the workspace registration first.',
        };
      }
      const byClaim = descriptor.claimingHosts.includes(config.hostKind);
      const byDeclaration = descriptor.declaredHostKinds.includes(config.hostKind);
      if (!byClaim && !byDeclaration) {
        return {
          supported: false,
          reason: 'no_host_binding_evidence',
          nextAction: `No validated ${config.hostKind} binding (claim or host-tool declaration) exists for this workspace; host.* feature flags are not identity evidence.`,
        };
      }
      return { supported: true };
    },

    async executeOnce(input: WorkerAdapterExecuteInput): Promise<AdapterCycleResult> {
      const now = input.probes?.now ?? (() => new Date());
      const startedDate = now();
      const workspaceDir = path.resolve(input.workspaceDir);
      // P1-01: the workspace deadline is MONOTONIC and covers the entire
      // adapter path, not only the subprocess window.
      const deadlineAtMs = input.deadlineAtMs ?? (performance.now() + input.timeoutMs);
      const remainingBudgetMs = (): number => deadlineAtMs - performance.now();
      const budgetExhaustedNextAction = 'The per-workspace timeout budget was exhausted before this step finished (entry resolution/config/snapshot/post-cycle work counts against the same budget as the Worker run); raise --timeout-ms or select hosts in separate runs.';
      const adapterVersion: typeof WORKER_ADAPTER_CONTRACT_VERSION = WORKER_ADAPTER_CONTRACT_VERSION;
      const base = {
        hostKind: config.hostKind,
        adapterVersion,
        workspaceDir,
        invocationId: input.invocationId,
        startedAt: startedDate.toISOString(),
      };
      const emptyProgress: BusinessProgressEvidence = {
        taskStateChanged: false,
        changedTaskCount: 0,
        diagnosticianSucceeded: false,
        downstreamRan: false,
        postProcessingResumed: 0,
        catchUpProcessed: 0,
        evidenceReadable: false,
        evidenceReason: 'not_attempted',
      };
      const finish = (outcome: AdapterCycleOutcome, extra: { reason?: string; nextAction?: string; worker?: Partial<AdapterCycleResult['worker']>; lastProgressAt?: string; businessProgress?: BusinessProgressEvidence }) => {
        const completedDate = now();
        return {
          ...base,
          cycleOutcome: outcome,
          ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
          ...(extra.nextAction !== undefined ? { nextAction: extra.nextAction } : {}),
          lastProgressAt: extra.lastProgressAt ?? null,
          businessProgress: extra.businessProgress ?? emptyProgress,
          health: livenessFacts(config, workspaceDir),
          completedAt: completedDate.toISOString(),
          durationMs: Math.max(0, completedDate.getTime() - startedDate.getTime()),
          worker: {
            cliEntry: '',
            cliEntrySource: 'canonical',
            exitCode: null,
            termSignal: null,
            timedOut: false,
            cancelled: false,
            stdoutTruncated: false,
            ...(extra.worker ?? {}),
            environmentReport: {
              stripped: [],
              pinnedFromTrustedIdentity: [],
              passedThrough: [],
              invocationSource: 'service_host',
            },
          },
        } satisfies AdapterCycleResult;
      };

      // ── Active-release CLI entry (never a source worktree) ──
      const resolveEntry = input.probes?.resolveCliEntry ?? resolveActiveReleaseCliEntry;
      const entry = resolveEntry(input.identity);
      if (entry.kind === 'missing') {
        return finish('unavailable', { reason: entry.reason, nextAction: entry.nextAction });
      }

      // ── Allowlist environment (TD §5.2) ──
      const inherited = input.inheritedEnv ?? process.env;
      // F4 review fix: the workspace's OWN effective runtime config names its
      // credential variables (`apiKeyEnv`). Names outside the generic
      // credential pattern must still reach the child, or a workspace whose
      // operator exported a custom-named key would lose a working credential
      // versus a direct worker run (resolveProviderApiKey reads the env var
      // by that exact name before falling back to the PD credentials file).
      // Names only — values ride the inherited env untouched and are never
      // recorded.
      const credentialEnvAllowlist = readConfigCredentialEnvNames(workspaceDir);
      const { env, report: environmentReport } = buildWorkerEnvironment({
        identity: input.identity,
        hostKind: config.hostKind,
        inheritedEnv: inherited,
        credentialEnvAllowlist,
        // F13 (TD §5.2): pass the invocation id explicitly to the Worker.
        invocationId: input.invocationId,
      });

      // ── Hard deadline check BEFORE any store read or spawn (P1-01 §C /
      // P1-02): entry/config/env work may have consumed the whole budget —
      // no new read or Worker may start past it, and the refusal is a
      // timeout, not a Worker failure. ──
      if (remainingBudgetMs() <= 0) {
        return finish('timeout', { reason: 'workspace_timeout_budget_exhausted', nextAction: budgetExhaustedNextAction, worker: { cliEntry: entry.entry, cliEntrySource: entry.source } });
      }

      // ── Pre-cycle task snapshot (progress evidence, task §6): the SQLite
      // busy wait is capped by the same remaining workspace budget. ──
      const readSnapshot = input.probes?.readTaskProgressSnapshot ?? readTaskProgressSnapshot;
      const before = readSnapshot(workspaceDir, { busyTimeoutMs: remainingBudgetMs() });

      if (remainingBudgetMs() <= 0) {
        return finish('timeout', { reason: 'workspace_timeout_budget_exhausted', nextAction: budgetExhaustedNextAction, worker: { cliEntry: entry.entry, cliEntrySource: entry.source } });
      }

      // ── The bounded real cycle: pd <host> worker --once --json --workspace <dir> ──
      const runProcess = input.probes?.spawnWorkerProcess ?? runWorkerProcess;
      const proc = await runProcess({
        cliEntry: entry.entry,
        args: [config.hostKind, 'worker', '--once', '--json', '--workspace', workspaceDir],
        env,
        timeoutMs: Math.max(1, Math.floor(remainingBudgetMs())),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });

      const worker: AdapterCycleResult['worker'] = {
        cliEntry: entry.entry,
        cliEntrySource: entry.source,
        exitCode: proc.exitCode,
        termSignal: proc.termSignal,
        timedOut: proc.timedOut,
        cancelled: proc.cancelled,
        stdoutTruncated: proc.stdoutTruncated,
        ...(proc.stderrTail.length > 0 ? { stderrTail: boundedTail(proc.stderrTail) } : {}),
        ...(proc.closePending === true ? { closePending: true } : {}),
        environmentReport,
      };

      // ── Post-cycle snapshot is INSIDE the same budget (P1-02): a deadline
      // crossed before OR DURING the read is a timeout — never a normal
      // completion and never disguised as evidence-unavailable; the real
      // worker evidence (exit/termination/stdout) still rides the record.
      // The SQLite busy wait is capped by the remaining budget, which
      // bounds lock contention; an uninterruptible OS-level I/O stall can
      // still overrun, so the post-read deadline check is the second line
      // of defence. ──
      if (remainingBudgetMs() <= 0) {
        return finish('timeout', { reason: 'workspace_timeout_budget_exhausted', nextAction: budgetExhaustedNextAction, worker });
      }
      const after = readSnapshot(workspaceDir, { busyTimeoutMs: remainingBudgetMs() });
      if (remainingBudgetMs() <= 0) {
        // Still a timeout — but when the read DID succeed and shows a
        // persisted task-state change, that measured evidence rides the
        // record. Dropping it loses the change forever: the next run's
        // baseline is the post-change state, so the transition would
        // never be diffed again.
        if (before.ok && after.ok) {
          const measured = diffTaskProgress(before.snapshot, after.snapshot);
          if (measured.taskStateChanged) {
            return finish('timeout', {
              reason: 'workspace_timeout_budget_exhausted',
              nextAction: budgetExhaustedNextAction,
              worker,
              lastProgressAt: measured.changedAt ?? undefined,
              businessProgress: { ...emptyProgress, taskStateChanged: true, changedTaskCount: measured.changedCount, evidenceReadable: true },
            });
          }
        }
        return finish('timeout', { reason: 'workspace_timeout_budget_exhausted', nextAction: budgetExhaustedNextAction, worker });
      }
      let taskProgress: TaskProgressEvidence | null = null;
      let evidenceReason: string | undefined;
      if (!before.ok) evidenceReason = sanitizeWorkerText(before.reason);
      else if (!after.ok) evidenceReason = sanitizeWorkerText(after.reason);
      else taskProgress = diffTaskProgress(before.snapshot, after.snapshot);

      // ── Parse + guard the worker result (fail-closed, rc-1..rc-4) ──
      let parsed: Record<string, unknown> | null = null;
      let parseProblem: string | null = null;
      if (proc.spawnError !== undefined) parseProblem = 'spawn';
      else if (proc.timedOut) parseProblem = 'timeout';
      else if (proc.cancelled) parseProblem = 'cancelled';
      else {
        try {
          const raw: unknown = JSON.parse(proc.stdout);
          if (!isPlainRecord(raw)) parseProblem = 'worker_result_not_object';
          else parsed = raw;
        } catch {
          parseProblem = 'worker_result_unparseable';
        }
      }
      if (parsed !== null) {
        const resultWorkspace = readString(parsed, 'workspaceDir');
        const mode = readString(parsed, 'mode');
        if (resultWorkspace === null || !sameWorkspaceDir(resultWorkspace, workspaceDir)) {
          parseProblem = `worker_result_rejected:workspace_mismatch${resultWorkspace === null ? '' : `(${sanitizeWorkerText(resultWorkspace, 120)})`}`;
          parsed = null;
        } else if (mode === null || !WORKER_RESULT_MODES.has(mode)) {
          parseProblem = `worker_result_rejected:unknown_mode${mode === null ? '' : `(${mode.slice(0, 40)})`}`;
          parsed = null;
        }
      }

      const completedDate = now();
      const health = livenessFacts(config, workspaceDir);
      const assemble = (args: {
        outcome: AdapterCycleOutcome;
        reason?: string;
        nextAction?: string;
        lastProgressAt?: string | null;
        businessProgress: BusinessProgressEvidence;
        workerMode?: string;
      }): AdapterCycleResult => ({
        ...base,
        cycleOutcome: args.outcome,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args.nextAction !== undefined ? { nextAction: args.nextAction } : {}),
        lastProgressAt: args.lastProgressAt ?? null,
        businessProgress: args.businessProgress,
        health,
        completedAt: completedDate.toISOString(),
        durationMs: Math.max(0, completedDate.getTime() - startedDate.getTime()),
        worker,
        ...(args.workerMode !== undefined ? { workerMode: args.workerMode } : {}),
      });

      // Process-level outcomes first (never fabricate a success over a kill).
      if (proc.spawnError !== undefined) {
        // P2-04: spawn errors are free-form OS text (paths, config
        // fragments) — sanitize before the status file like stderr.
        return assemble({ outcome: 'unavailable', reason: sanitizeWorkerText(proc.spawnError), nextAction: 'The Worker child could not be started; check the active release install and Node executable.', businessProgress: emptyProgress });
      }
      if (proc.timedOut) {
        return assemble({
          outcome: 'timeout',
          reason: `worker_timeout:${input.timeoutMs}ms`,
          nextAction: 'The bounded deadline fired and the Worker child was terminated (SIGTERM→SIGKILL). Any held task lease recovers through the existing Lease TTL / Recovery Sweep on a later Service Host cycle; investigate the hang before the next trigger.',
          businessProgress: emptyProgress,
        });
      }
      if (proc.cancelled) {
        return assemble({
          outcome: 'cancelled',
          reason: 'worker_cancelled',
          nextAction: 'The caller aborted the managed execution; any held task lease recovers through the existing Lease TTL / Recovery Sweep.',
          businessProgress: emptyProgress,
        });
      }
      if (proc.termSignal !== null) {
        // CodeRabbit review fix: a signal kill that is neither our deadline
        // nor our cancel is an EXTERNAL termination (e.g. OOM/SIGTERM) — it
        // must not be classified by whatever stdout was captured.
        return assemble({
          outcome: 'failed',
          reason: `worker_terminated_by_signal:${proc.termSignal}`,
          nextAction: 'The Worker child was terminated by a signal outside the bounded-timeout/cancel paths; investigate the external kill before re-running.',
          businessProgress: { ...emptyProgress, evidenceReason: evidenceReason ?? 'not_attempted' },
        });
      }
      if (parsed === null) {
        const reason = parseProblem === 'timeout' || parseProblem === 'cancelled' || parseProblem === 'spawn'
          ? 'worker_result_missing'
          : (parseProblem ?? 'worker_result_unparseable');
        return assemble({
          outcome: 'failed',
          reason: `${reason}:exit=${proc.exitCode ?? 'none'}`,
          nextAction: 'The Worker output could not be validated against the adapter contract (fail-closed). Inspect the stderr tail and the workspace liveness record, then re-run.',
          businessProgress: { ...emptyProgress, evidenceReason: evidenceReason ?? 'not_attempted' },
        });
      }
      const mode = readString(parsed, 'mode') ?? 'unknown';
      // F3: worker-reported free text is sanitized before persistence (paths
      // redacted, control chars stripped, bounded) — the manual worker CLI
      // prints the full detail; the status carries the desensitized form.
      const rawReason = readString(parsed, 'reason');
      const rawNextAction = readString(parsed, 'nextAction');
      const workerReason = rawReason !== null ? sanitizeWorkerText(rawReason, 300) : undefined;
      const workerNextAction = rawNextAction !== null ? sanitizeWorkerText(rawNextAction, 300) : undefined;
      const reportEvidence = config.extractCycleEvidence(parsed);
      const evidenceReadable = taskProgress !== null;
      const businessProgress: BusinessProgressEvidence = {
        taskStateChanged: taskProgress?.taskStateChanged ?? false,
        changedTaskCount: taskProgress?.changedCount ?? 0,
        ...reportEvidence,
        evidenceReadable,
        ...(evidenceReason !== undefined ? { evidenceReason } : {}),
      };

      // P2-02 (final-remediation + final-closure review): cycle OUTCOME and
      // business PROGRESS are independent facts — a paused/degraded cycle
      // can still record real progress, and `lastProgressAt` then carries
      // the evidenced timestamp. Strict precedence:
      //   1. the trusted task-diff `changedAt` (real task state change);
      //   2. the worker's persisted liveness completion time — ONLY when it
      //      belongs to THIS invocation (`lastInvocationId` match, present
      //      and parseable): a stale record from an older/foreign worker can
      //      never smuggle a historical timestamp into this cycle;
      //   3. the adapter's own `completedAt` — the SPEC-sanctioned fallback
      //      for corroborating report evidence without usable liveness;
      //   no evidence → null, never a fabricated timestamp.
      const corroboratingEvidence = reportEvidence.diagnosticianSucceeded
        || reportEvidence.downstreamRan
        || reportEvidence.postProcessingResumed > 0
        || reportEvidence.catchUpProcessed > 0;
      const currentInvocationLivenessAt = health.lastInvocationId === input.invocationId
        && health.lastCycleCompletedAt !== null
        && Number.isFinite(Date.parse(health.lastCycleCompletedAt))
        ? health.lastCycleCompletedAt
        : null;
      const progressAt = taskProgress?.taskStateChanged === true
        ? taskProgress.changedAt
        : corroboratingEvidence
          ? (currentInvocationLivenessAt ?? completedDate.toISOString())
          : null;

      if (mode === 'paused') {
        // CodeRabbit review fix: a paused cycle may still carry non-blocking
        // degradations (WorkBuddy runs catch-up before the pause early-return).
        // Dropping them would exit 0 over a real failure — surface them as a
        // degraded outcome instead.
        const degradations = Array.isArray(parsed.degradations)
          ? parsed.degradations.filter((d): d is string => typeof d === 'string' && d.length > 0).slice(0, 5)
          : [];
        if (degradations.length > 0) {
          return assemble({
            outcome: 'degraded',
            reason: `paused_with_degradations:${degradations.join('|').slice(0, 160)}`,
            nextAction: workerNextAction ?? 'The cycle paused AND reported non-blocking degradations; investigate the degradation before treating the pause as clean.',
            lastProgressAt: progressAt,
            businessProgress,
            workerMode: mode,
          });
        }
        return assemble({ outcome: 'paused', reason: workerReason ?? 'paused', nextAction: workerNextAction, lastProgressAt: progressAt, businessProgress, workerMode: mode });
      }
      if (mode === 'degraded') {
        // F7 review fix: a degraded CYCLE and persisted business progress are
        // independent facts — the worker may have completed a diagnosis
        // before a later step degraded. When the trusted task diff shows a
        // real state change, the evidenced timestamp is recorded here (the
        // outcome stays truthfully degraded); without one, no timestamp.
        return assemble({
          outcome: 'degraded',
          reason: workerReason ?? 'degraded',
          nextAction: workerNextAction,
          lastProgressAt: progressAt,
          businessProgress,
          workerMode: mode,
        });
      }
      // mode === 'ready'
      if (proc.exitCode !== 0 && proc.exitCode !== null) {
        return assemble({
          outcome: 'failed',
          reason: `worker_exit_nonzero:${proc.exitCode}`,
          nextAction: 'The Worker reported a non-ready result with a non-zero exit; inspect its stderr tail and the workspace state.',
          businessProgress,
          workerMode: mode,
        });
      }
      if (!evidenceReadable) {
        return assemble({
          outcome: 'degraded',
          reason: `progress_evidence_unavailable:${evidenceReason ?? 'unknown'}`,
          nextAction: 'The cycle completed but the task-progress evidence could not be read from the workspace state store; the reported progress is degraded, not guessed.',
          businessProgress,
          workerMode: mode,
        });
      }
      const cycleEvidence = reportEvidence.diagnosticianSucceeded
        || reportEvidence.downstreamRan
        || reportEvidence.postProcessingResumed > 0
        || reportEvidence.catchUpProcessed > 0;
      if (taskProgress !== null && (taskProgress.taskStateChanged || cycleEvidence)) {
        return assemble({
          outcome: 'cycle_completed',
          lastProgressAt: progressAt ?? completedDate.toISOString(),
          businessProgress,
          workerMode: mode,
        });
      }
      return assemble({
        outcome: 'cycle_completed_without_business_progress',
        businessProgress,
        workerMode: mode,
      });
    },
  };
}

/** Guarded report-evidence readers shared by the host adapter configs. */
export function readReportSection(parsed: Record<string, unknown>, section: string): Record<string, unknown> | null {
  const { report } = parsed;
  if (!isPlainRecord(report)) return null;
  const inner = report[section];
  return isPlainRecord(inner) ? inner : null;
}

export function readReportEvidence(parsed: Record<string, unknown>): {
  diagnosticianSucceeded: boolean;
  downstreamRan: boolean;
} {
  const diagnostician = readReportSection(parsed, 'diagnostician');
  const downstream = readReportSection(parsed, 'downstream');
  // F5 review fix: `downstream.ran` alone records an ATTEMPT (the shared
  // consumer cycle started), not a persisted business outcome — only a
  // succeeded run is progress evidence. Attempts that retried/failed are
  // visible to the task-status diff instead.
  const runStatus = downstream !== null ? downstream.runStatus : undefined;
  return {
    diagnosticianSucceeded: diagnostician !== null && readString(diagnostician, 'status') === 'succeeded',
    downstreamRan: downstream !== null && downstream.ran === true && runStatus === 'succeeded',
  };
}

/** Array-field length (e.g. postProcessing.resumedTaskIds, catchUp.rollouts) or numeric count (catchUp.ingested). */
export function readReportCount(parsed: Record<string, unknown>, section: string, key: string): number {
  const inner = readReportSection(parsed, section);
  if (inner === null) return 0;
  const value = inner[key];
  if (Array.isArray(value)) return value.length;
  return readNumber(value);
}
