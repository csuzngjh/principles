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
import type { InstallIdentity } from './install-identity.js';
import type { ActiveReleaseFacts } from './status/service-run-status.js';
import type { WorkspaceDiscoveryVerdict } from './workspace-discovery.js';
import { buildWorkerEnvironment, type WorkerEnvironmentReport } from './worker-env.js';
import { runWorkerProcess, type WorkerProcessOptions, type WorkerProcessResult } from './worker-process.js';
import {
  diffTaskProgress,
  readTaskProgressSnapshot,
  type TaskProgressEvidence,
} from './progress-evidence.js';

export const WORKER_ADAPTER_CONTRACT_VERSION = 'pd.worker-adapter.v1';

export type WorkerHostKind = 'codex' | 'workbuddy';
export const WORKER_HOST_KINDS: readonly WorkerHostKind[] = ['codex', 'workbuddy'];

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
    nextAction: `No installed pd-cli entry exists for this install (looked for ${canonical} and ${legacy}). Repair the install with npx create-principles-disciple; the shadow cycle refused instead of running a Worker from a source worktree.`,
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
  };
}

const STDERR_TAIL_PERSIST = 400;

function boundedTail(value: string): string {
  return value.length > STDERR_TAIL_PERSIST ? `…${value.slice(-STDERR_TAIL_PERSIST)}` : value;
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
          nextAction: 'Only discovery-authorized workspaces may run a shadow cycle; fix the workspace registration first.',
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
      const finish = (outcome: AdapterCycleOutcome, extra: { reason?: string; nextAction?: string; worker?: Partial<AdapterCycleResult['worker']> }) => {
        const completedDate = now();
        return {
          ...base,
          cycleOutcome: outcome,
          ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
          ...(extra.nextAction !== undefined ? { nextAction: extra.nextAction } : {}),
          lastProgressAt: null,
          businessProgress: emptyProgress,
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
      const { env, report: environmentReport } = buildWorkerEnvironment({
        identity: input.identity,
        hostKind: config.hostKind,
        inheritedEnv: inherited,
      });

      // ── Pre-cycle task snapshot (progress evidence, task §6) ──
      const before = readTaskProgressSnapshot(workspaceDir);

      // ── The bounded real cycle: pd <host> worker --once --json --workspace <dir> ──
      const runProcess = input.probes?.spawnWorkerProcess ?? runWorkerProcess;
      const proc = await runProcess({
        cliEntry: entry.entry,
        args: [config.hostKind, 'worker', '--once', '--json', '--workspace', workspaceDir],
        env,
        timeoutMs: input.timeoutMs,
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
        environmentReport,
      };

      // ── Post-cycle snapshot + diff ──
      const after = readTaskProgressSnapshot(workspaceDir);
      let taskProgress: TaskProgressEvidence | null = null;
      let evidenceReason: string | undefined;
      if (!before.ok) evidenceReason = before.reason;
      else if (!after.ok) evidenceReason = after.reason;
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
          parseProblem = `worker_result_rejected:workspace_mismatch${resultWorkspace === null ? '' : `(${resultWorkspace.slice(0, 120)})`}`;
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
        return assemble({ outcome: 'unavailable', reason: proc.spawnError, nextAction: 'The Worker child could not be started; check the active release install and Node executable.', businessProgress: emptyProgress });
      }
      if (proc.timedOut) {
        return assemble({
          outcome: 'timeout',
          reason: `worker_timeout:${input.timeoutMs}ms`,
          nextAction: 'The bounded deadline fired and the Worker child was terminated (SIGTERM→SIGKILL). Any held task lease recovers through the existing Lease TTL / Recovery Sweep on a later cycle; re-run the shadow cycle after investigating the hang.',
          businessProgress: emptyProgress,
        });
      }
      if (proc.cancelled) {
        return assemble({
          outcome: 'cancelled',
          reason: 'worker_cancelled',
          nextAction: 'The caller aborted the shadow execution; any held task lease recovers through the existing Lease TTL / Recovery Sweep.',
          businessProgress: emptyProgress,
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
      const workerReason = readString(parsed, 'reason') ?? undefined;
      const workerNextAction = readString(parsed, 'nextAction') ?? undefined;
      const reportEvidence = config.extractCycleEvidence(parsed);
      const evidenceReadable = taskProgress !== null;
      const businessProgress: BusinessProgressEvidence = {
        taskStateChanged: taskProgress?.taskStateChanged ?? false,
        changedTaskCount: taskProgress?.changedCount ?? 0,
        ...reportEvidence,
        evidenceReadable,
        ...(evidenceReason !== undefined ? { evidenceReason } : {}),
      };

      if (mode === 'paused') {
        return assemble({ outcome: 'paused', reason: workerReason ?? 'paused', nextAction: workerNextAction, businessProgress, workerMode: mode });
      }
      if (mode === 'degraded') {
        return assemble({ outcome: 'degraded', reason: workerReason ?? 'degraded', nextAction: workerNextAction, businessProgress, workerMode: mode });
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
          lastProgressAt: taskProgress.changedAt ?? completedDate.toISOString(),
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
  return {
    diagnosticianSucceeded: diagnostician !== null && readString(diagnostician, 'status') === 'succeeded',
    downstreamRan: downstream !== null && downstream.ran === true,
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
