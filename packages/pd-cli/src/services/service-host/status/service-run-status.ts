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
import type { InstallIdentity } from '../install-identity.js';
import type { WorkspaceDiscoveryResult } from '../workspace-discovery.js';

export const SERVICE_RUN_STATUS_SCHEMA_VERSION = 'pd.service-run-status.v1';

/** How this run was triggered. Phase 1 only ever has the manual CLI trigger. */
export type ServiceRunTriggerSource = 'manual';

/** Top-level run outcome (distinct from per-workspace verdicts). */
export type ServiceRunOutcome =
  | 'completed'
  | 'already_running'
  | 'refused';

export interface ActiveReleaseFacts {
  readonly present: boolean;
  readonly readable: boolean;
  /** Bounded release identity when readable (never a credential). */
  readonly releaseId?: string;
  readonly productVersion?: string;
  readonly generation?: number;
  /** Structured reason when present-but-unreadable (rc-9). */
  readonly reason?: string;
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
  };
  readonly workspaces: WorkspaceDiscoveryResult['workspaces'];
  readonly nextAction: string;
}

const STATUS_DIR_NAME = 'service';
const STATUS_FILE_NAME = 'run-once-status.json';

export function serviceRunStatusPath(pdHome: string): string {
  return path.join(pdHome, STATUS_DIR_NAME, STATUS_FILE_NAME);
}

/** Maximum persisted length of any reason string (rc-8 bounded output). */
const MAX_REASON = 300;

/** Re-bound an already-discovery-bounded reason defensively before persisting. */
function persistableReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.replace(/[^\x20-\x7E]+/g, ' ');
  return clean.length > MAX_REASON ? `${clean.slice(0, MAX_REASON - 1)}…` : clean;
}

/**
 * Read the active release record (`<pdHome>/active.json`) as observational
 * install facts. Missing vs unreadable vs non-conforming stay distinct
 * (rc-3/rc-9); none of these mutate the run — active-release verification is
 * recorded, and a broken record is reported, not invented.
 */
export function readActiveReleaseFacts(activeRecordPath: string): ActiveReleaseFacts {
  let raw: string;
  try {
    raw = fs.readFileSync(activeRecordPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
      ? String(Reflect.get(error, 'code'))
      : '';
    return {
      present: false,
      readable: false,
      reason: code === 'ENOENT' ? 'active_release_missing' : `active_release_read_failed:${code}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, readable: false, reason: 'active_release_unparsable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { present: true, readable: false, reason: 'active_release_not_an_object' };
  }
  const field = (key: string): unknown => Reflect.get(parsed, key);
  const releaseId = field('releaseId');
  const productVersion = field('productVersion');
  const generation = field('generation');
  const releaseIdText = typeof releaseId === 'string' && releaseId.length > 0
    ? releaseId.slice(0, 120)
    : undefined;
  const productVersionText = typeof productVersion === 'string' && productVersion.length > 0
    ? productVersion.slice(0, 40)
    : undefined;
  const generationNumber = typeof generation === 'number' && Number.isInteger(generation)
    ? generation
    : undefined;
  return {
    present: true,
    readable: true,
    ...(releaseIdText !== undefined ? { releaseId: releaseIdText } : {}),
    ...(productVersionText !== undefined ? { productVersion: productVersionText } : {}),
    ...(generationNumber !== undefined ? { generation: generationNumber } : {}),
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
