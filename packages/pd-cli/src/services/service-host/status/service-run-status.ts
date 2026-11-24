/**
 * Versioned operational status (SPEC-PD-SERVICE-HOST-001 §9, TD §7.1).
 *
 * ONE small versioned file per install — `<pdHome>/service/run-once-status.json`
 * — answering: when did run-once last execute, which install identity ran it,
 * what was discovered, what is each Workspace's owner state, what failed and
 * why, and what should happen next. Latest-run semantics (the file is
 * replaced atomically by each run), because the OS-scheduler and operator
 * question is "what happened LAST", not "list every historical run" (SPEC
 * §9: 运行状态优先复用现有 read model；安装级文件只记录调度元数据).
 *
 * Security contract (task §六): the status carries run/discovery METADATA
 * only — verdicts, reasons, workspace DIR PATHS (needed for the operator's
 * workspace-level judgment) and owner state. NEVER pain content, task
 * payload, conversation/trajectory data, credentials, or arbitrary file
 * contents. Reason strings are bounded and control-character-sanitized
 * (rc-8); nothing here is user/agent free text.
 *
 * This module owns the ONLY write in the coordinator: a temp-file + rename
 * atomic replace onto the PD-owned `<pdHome>/service/` directory — never the
 * canonical runtime tree, never `install.json`, never any Workspace's
 * business data (`.pd/state.db` etc.).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readActiveReleaseRecord, type ActiveReleaseFailureReason } from '@principles/install-layout';
import type { InstallIdentity } from '../install-identity.js';
import type { WorkspaceDiscoveryResult } from '../workspace-discovery.js';
import type { AdapterCycleResult, ShadowHostKind, WorkerHostKind } from '../worker-adapter.js';

export const SERVICE_RUN_STATUS_SCHEMA_VERSION = 'pd.service-run-status.v1';

/**
 * How this run was triggered (task §4): `manual` = a human at the CLI;
 * `scheduler` = the OS-level registration invoked the managed entry.
 * `installer` = the fresh-install provisioning run (PRI-1278 Phase 5) executed
 * the first bounded cycle before the OS trigger ever fired.
 * The two OS trigger flavours (login vs periodic) are deliberately NOT
 * distinguished — no platform reports that reliably, so PD never fabricates
 * a finer source than it can prove.
 */
export type ServiceRunTriggerSource = 'manual' | 'scheduler' | 'installer';

/** Top-level run outcome (distinct from per-workspace verdicts). */
export type ServiceRunOutcome =
  | 'completed'
  | 'already_running'
  | 'refused'
  | 'failed';

/**
 * The five task-required read verdicts (missing / read_failed / unparsable /
 * not_an_object / invalid) plus `ok`. Only `ok` marks a conforming record —
 * `readable` alone NEVER does (P1-3).
 */
export type ActiveReleaseVerdict =
  | 'ok'
  | 'missing'
  | 'read_failed'
  | 'unparsable'
  | 'not_an_object'
  | 'invalid';

export interface ActiveReleaseFacts {
  /** The record file exists. */
  readonly present: boolean;
  /** The record parsed into a JSON object (diagnostic only). */
  readonly readable: boolean;
  /** The record conforms to the authoritative schema — the ONLY validity bit. */
  readonly valid: boolean;
  readonly verdict: ActiveReleaseVerdict;
  /** Bounded release identity when valid (never a credential). */
  readonly releaseId?: string;
  readonly productVersion?: string;
  readonly generation?: number;
  /** Structured reason when not valid (rc-9). */
  readonly reason?: string;
}

/**
 * Per-host root report (P1-2): where the coordinator looked for each host's
 * claims, whether the root came from an env override, and whether it could
 * actually be read. A root that cannot be read is NEVER silently folded
 * into "no workspaces" — it is reported.
 */
export interface HostRootReport {
  readonly host: 'openclaw' | 'codex' | 'workbuddy';
  readonly root: string;
  readonly source: 'default' | 'env';
  readonly status: 'readable' | 'missing' | 'not_directory' | 'unreadable';
}

export interface ServiceRunStatus {
  readonly schemaVersion: typeof SERVICE_RUN_STATUS_SCHEMA_VERSION;
  readonly runId: string;
  readonly outcome: ServiceRunOutcome;
  readonly dryRun: boolean;
  readonly triggerSource: ServiceRunTriggerSource;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly installation: {
    readonly pdHome: string;
    readonly homeDir: string;
    readonly homeSource: InstallIdentity['homeSource'];
    readonly mode: InstallIdentity['mode'];
    readonly activeRelease: ActiveReleaseFacts;
  };
  readonly environmentIsolation: {
    /** PD_EXPERIMENT_ROOT was inherited and stripped before identity resolution. */
    readonly pdExperimentRootStripped: boolean;
    /** HOME/USERPROFILE present in the inherited env but ignored for identity. */
    readonly ignoredIdentityEnvVars: readonly string[];
    /** Host-root overrides present in the inherited env (steered discovery when honored). */
    readonly inheritedHostRootEnvVars: readonly string[];
    /**
     * Host-root overrides present in the inherited env but NOT honored
     * (shadow runs resolve host roots from the trusted home only — F1
     * review fix). Empty in dry-run mode, where overrides are honored.
     */
    readonly ignoredHostRootEnvVars?: readonly string[];
  };
  readonly manifest: {
    /** ok | missing | read_failed | unparsable | invalid | version_mismatch */
    readonly verdict: 'ok' | 'missing' | 'read_failed' | 'unparsable' | 'invalid' | 'version_mismatch';
    readonly reason?: string;
    readonly hosts: readonly string[];
    readonly unknownHosts: readonly string[];
    readonly workspacesCount: number;
  };
  readonly discovery: {
    readonly discoveredTotal: number;
    readonly counts: WorkspaceDiscoveryResult['counts'];
    /** Every host root consulted this run (P1-2 evidence; never silent). */
    readonly hostRoots: readonly HostRootReport[];
    /**
     * True when at least one consulted host root exists but could not be
     * LISTED (status `unreadable` / `not_directory`, P2-1): the workspace
     * list below may be missing entries, so a zero/low count is never the
     * same fact as a finished discovery.
     */
    readonly incomplete: boolean;
  };
  readonly workspaces: WorkspaceDiscoveryResult['workspaces'];
  /**
   * Phase 2 shadow section (optional, additive — v1 schema evolution):
   * present only for shadow runs. `dryRun: false` on the same status
   * document distinguishes the two modes. Carries per-workspace execution
   * records ONLY — never Pain content, task payloads, or environment
   * values (security contract above; worker environment reports carry
   * variable NAMES, not values).
   */
  readonly shadow?: ShadowRunStatusSection;
  /**
   * Phase 3 managed section (optional, additive — v1 schema evolution):
   * present only for managed runs (`pd service run-once --json`, the
   * scheduler entry). Carries per-workspace admission/executions for
   * `effectiveOwner=service_host` workspaces ONLY — the same security
   * contract as the shadow section applies (no payloads, no env values).
   */
  readonly managed?: ManagedRunStatusSection;
  readonly nextAction: string;
}

/** Persisted per-execution record inside the shadow section (task §10). */
export interface ShadowExecutionRecord {
  /** The operator's requested --workspace argument (evidence, lexical form). */
  readonly requestedDir: string;
  /** Matched canonical discovery dir, or null when no authorized entry matched. */
  readonly canonicalDir: string | null;
  readonly hostKind: ShadowHostKind | null;
  readonly admission: 'admitted' | 'refused';
  readonly refusalReason?: string;
  readonly refusalNextAction?: string;
  /** §8.3/§10 workspace state — `process_started`/`cycle_completed`/business_progress stay strictly distinct in `execution`. */
  readonly workspaceState: 'completed' | 'paused' | 'degraded' | 'failed' | 'unavailable' | 'waiting_for_host_binding';
  /** Final carried-forward progress timestamp (this cycle or previous run; task §6). */
  readonly lastProgressAt: string | null;
  readonly lastProgressSource: 'task_state_change' | 'cycle_evidence' | 'previous_run' | null;
  /** Full adapter contract result (subset-persisted fields only, no env values). */
  readonly execution?: AdapterCycleResult;
}

export interface ShadowRunStatusSection {
  readonly requestedWorkspaces: readonly string[];
  readonly hostFilter?: ShadowHostKind;
  readonly perWorkspaceTimeoutMs: number;
  /**
   * Health of the cross-run progress projection read at run start (F6):
   * `missing` = no store yet; `corrupt`/`unreadable` degrade to "no previous
   * progress" observably instead of silently.
   */
  readonly progressCarryVerdict: 'ok' | 'missing' | 'corrupt' | 'unreadable';
  readonly executions: readonly ShadowExecutionRecord[];
}

/**
 * Phase 3 managed-run per-workspace record (task §4 admission matrix). A
 * workspace is either executed (service_host_owned + authorized + bound
 * adapter) or skipped with a structured reason — legacy workspaces keep
 * their legacy owner, transition states are never consumed.
 *
 * PRI-1282 Phase 4 (additive, still v1): `hostKind` widens to include
 * `openclaw` — a managed execution may now be driven by the OpenClaw worker
 * adapter after the workspace's §8.4 handover. Shadow records stay on the
 * narrow codex|workbuddy set.
 */
export interface ManagedExecutionRecord {
  readonly canonicalDir: string;
  readonly hostKind: WorkerHostKind | null;
  /** `executed` = a real Worker cycle ran for this workspace. */
  readonly admission: 'executed' | 'skipped';
  /** Structured skip reason (skipped records only): owner state, authorization, adapter or budget. */
  readonly skipReason?: string;
  readonly skipNextAction?: string;
  readonly workspaceState: 'completed' | 'paused' | 'degraded' | 'failed' | 'unavailable' | 'waiting_for_host_binding';
  readonly lastProgressAt: string | null;
  readonly lastProgressSource: 'task_state_change' | 'cycle_evidence' | 'previous_run' | null;
  readonly execution?: AdapterCycleResult;
}

export interface ManagedRunStatusSection {
  readonly triggerSource: ServiceRunTriggerSource;
  readonly perWorkspaceTimeoutMs: number;
  readonly progressCarryVerdict: 'ok' | 'missing' | 'corrupt' | 'unreadable';
  /**
   * Set when NO workspace was in the service_host_owned state this run —
   * the legal empty execution (task §4): no Worker started, nothing failed.
   */
  readonly emptyReason?: 'no_service_host_owned_workspaces';
  readonly executions: readonly ManagedExecutionRecord[];
}

const STATUS_DIR_NAME = 'service';
const STATUS_FILE_NAME = 'run-once-status.json';

export function serviceRunStatusPath(pdHome: string): string {
  return path.join(pdHome, STATUS_DIR_NAME, STATUS_FILE_NAME);
}

export type ServiceRunStatusRead =
  | { readonly ok: true; readonly status: ServiceRunStatus }
  | { readonly ok: false; readonly verdict: 'missing' | 'unreadable' | 'corrupt'; readonly detail?: string };

/**
 * Read the latest persisted run-once status (Phase 3 `pd service status`).
 * The file is UNTRUSTED runtime data (rc-1): missing / unreadable /
 * unparsable / non-conforming stay distinct (rc-3) — a corrupt status file
 * is `corrupt`, never "no run ever happened".
 */
export function readServiceRunStatus(pdHome: string): ServiceRunStatusRead {
  const file = serviceRunStatusPath(pdHome);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const { code } = error as Error & { code?: string };
    if (code === 'ENOENT') return { ok: false, verdict: 'missing' };
    return { ok: false, verdict: 'unreadable', detail: code ?? 'read_failed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, verdict: 'corrupt', detail: error instanceof Error ? error.message.slice(0, 120) : 'unparsable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, verdict: 'corrupt', detail: 'not_an_object' };
  }
  const doc = parsed as Record<string, unknown>;
  if (
    !Object.hasOwn(doc, 'schemaVersion') || doc.schemaVersion !== SERVICE_RUN_STATUS_SCHEMA_VERSION
    || !Object.hasOwn(doc, 'runId') || typeof doc.runId !== 'string'
    || !Object.hasOwn(doc, 'outcome') || (doc.outcome !== 'completed' && doc.outcome !== 'already_running' && doc.outcome !== 'refused' && doc.outcome !== 'failed')
    || !Object.hasOwn(doc, 'triggerSource') || (doc.triggerSource !== 'manual' && doc.triggerSource !== 'scheduler' && doc.triggerSource !== 'installer')
  ) {
    return { ok: false, verdict: 'corrupt', detail: 'schema_mismatch' };
  }
  return { ok: true, status: parsed as ServiceRunStatus };
}

/** Maximum persisted length of any reason string (rc-8 bounded output). */
const MAX_REASON = 300;

/** Re-bound an already-discovery-bounded reason defensively before persisting. */
function persistableReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.replace(/[^\x20-\x7E]+/g, ' ');
  return clean.length > MAX_REASON ? `${clean.slice(0, MAX_REASON - 1)}…` : clean;
}

/** Map a shared-authority failure reason to the status's stable reason code. */
function activeReleaseReasonCode(reason: ActiveReleaseFailureReason): string {
  switch (reason) {
    case 'active_record_absent':
      return 'active_release_missing';
    case 'active_record_read_failed':
      return 'active_release_read_failed';
    case 'active_record_json_invalid':
      return 'active_release_unparsable';
    case 'active_record_not_object':
      return 'active_release_not_an_object';
    default:
      // Every schema-level failure keeps its field name so an operator can
      // tell WHICH field failed, e.g. `active_release_invalid:generation`.
      return `active_release_invalid:${reason.replace(/^active_record_/, '').replace(/_invalid$/, '')}`;
  }
}

/** Map a shared-authority failure reason to the run's read verdict. */
function activeReleaseVerdictFor(reason: ActiveReleaseFailureReason): ActiveReleaseVerdict {
  switch (reason) {
    case 'active_record_absent':
      return 'missing';
    case 'active_record_read_failed':
      return 'read_failed';
    case 'active_record_json_invalid':
      return 'unparsable';
    case 'active_record_not_object':
      return 'not_an_object';
    default:
      return 'invalid';
  }
}

/**
 * Read the active release record (`<pdHome>/active.json`) against the ONE
 * authoritative schema in `@principles/install-layout` (P1-3): a record is
 * `valid` only when it is the record the installer's commit point writes —
 * schemaVersion 1, non-empty releaseId, positive-safe-integer generation,
 * 64-hex digest, transactionId, productVersion (+ strict optional
 * sourceCommit). Missing vs unreadable vs malformed JSON vs non-object vs
 * schema-nonconforming stay distinct (rc-3/rc-9); a record that parses but
 * fails schema is reported as `invalid`, NEVER as a healthy release.
 */
export function readActiveReleaseFacts(activeRecordPath: string): ActiveReleaseFacts {
  const verdict = readActiveReleaseRecord(activeRecordPath);
  if (verdict.ok) {
    const { record } = verdict;
    return {
      present: true,
      readable: true,
      valid: true,
      verdict: 'ok',
      releaseId: record.releaseId.slice(0, 120),
      productVersion: record.productVersion.slice(0, 40),
      generation: record.generation,
    };
  }
  return {
    present: verdict.reason !== 'active_record_absent',
    readable: false,
    valid: false,
    verdict: activeReleaseVerdictFor(verdict.reason),
    reason: `${activeReleaseReasonCode(verdict.reason)} — ${persistableReason(verdict.detail) ?? 'invalid record'}`,
  };
}

/**
 * Persist the status atomically (temp file in the same directory + rename).
 * A failed write is LOUD (rc-9): the returned result distinguishes an
 * unwritable directory from a rename failure instead of silently dropping
 * the record. The rename overwrite semantics rely on Node's fs.renameSync
 * POSIX behavior; on Windows a pre-existing destination is replaced (the
 * established repo-wide atomic-write pattern, e.g. worker liveness files).
 */
export function writeServiceRunStatus(
  pdHome: string,
  status: ServiceRunStatus,
): { ok: true; path: string } | { ok: false; reason: string; nextAction: string } {
  const dir = path.join(pdHome, STATUS_DIR_NAME);
  const target = path.join(dir, STATUS_FILE_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `service_status_dir_unwritable:${persistableReason(message) ?? 'unknown'}`,
      nextAction: `Check the permissions of ${dir} and retry.`,
    };
  }
  const temp = path.join(dir, `.run-once-status.${randomUUID().replace(/-/g, '').slice(0, 12)}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, target);
    return { ok: true, path: target };
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // best effort cleanup of our own temp file
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `service_status_write_failed:${persistableReason(message) ?? 'unknown'}`,
      nextAction: 'Fix the reported filesystem problem and re-run; a partial status file is never left behind.',
    };
  }
}
