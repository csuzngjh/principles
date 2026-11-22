/**
 * OpenClaw standalone workspace worker cycle (SPEC-PD-SERVICE-HOST-001
 * §4.2/§4.3, PRI-1282 Phase 4).
 *
 * This is the OpenClaw twin of the Codex / WorkBuddy workspace workers: the
 * bounded, host-specific cycle a Service Host (or an operator via
 * `pd openclaw worker --once`) runs OUTSIDE the OpenClaw Gateway process.
 * The business logic is NOT re-implemented here — the shared
 * `runInternalizationConsumerCycle` and `runPendingDiagnosticianOnce`
 * (`@principles/host-runtime`) are the same implementations the Gateway's
 * InternalizationAutoConsumerService drives; this module only supplies the
 * OpenClaw host facts (tool catalog, tool semantics, hostKinds, evidence
 * port) and the worker-owned machinery the Gateway never needed: liveness
 * evidence (TD §2.3 — OpenClaw had no equivalent of the Codex worker
 * liveness file), invocation attribution, the §8.4 ownership gate and the
 * persisted tool declaration.
 *
 * Ownership gate: a workspace is consumable by this worker ONLY while the
 * install manifest's `backgroundExecutions` record says
 * `service_host_owned` (fail-closed on an unreadable manifest). This closes
 * the manual-invocation double-consumer hole — running this command against
 * a legacy-owned (Gateway-consumed) workspace refuses.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HOST_TOOL_DECLARATION_VERSION,
  collectWorkspaceCredentialEnvNames,
  createWorkspaceBehaviorEvidencePort,
  loadHostToolDeclarations,
  loadPdConfigForPlugin,
  runInternalizationConsumerCycle,
  runPendingDiagnosticianOnce,
  saveHostToolDeclaration,
  type ConsumerCycleLogger,
  type InternalizationConsumerCycleOutcome,
  type PendingDiagnosticianRunResult,
} from '@principles/host-runtime';
import {
  getInstallLayoutPathsFromPdHome,
  readWorkspaceBackgroundOwnership,
  resolvePdHome,
  type WorkspaceBackgroundOwnership,
} from '@principles/install-layout';
import { pdProviderCredentials } from '@principles/core/runtime';
import { AGENT_TOOL_NAMES, HIGH_RISK_TOOL_NAMES, LOW_RISK_WRITE_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from './constants/tools.js';
import { OPENCLAW_TOOL_SEMANTICS, OPENCLAW_TOOL_SEMANTIC_MAPPINGS } from './constants/tool-semantics.js';
import { SystemLogger } from './core/system-logger.js';

// Handover-command read surface: the pd-cli handover/rollback commands need
// the ack READER; re-exported here so they consume ONE subpath
// (`principles-disciple/openclaw-worker`) instead of plugin internals.
export {
  GATEWAY_QUIESCE_ACK_SCHEMA_VERSION,
  readGatewayQuiesceAck,
  type GatewayQuiesceAck,
} from './service/gateway-quiesce-ack.js';

// ─── Result contract (pd.worker-adapter.v1 worker side) ─────────────────────

export type OpenClawWorkerMode = 'ready' | 'paused' | 'degraded';

export interface OpenClawWorkerCycleStepReport {
  ownership: { state: string; generation: number; source: string };
  declaration: { persisted: boolean; validated: boolean; version?: number; reason?: string };
  downstream: { ran: boolean; runStatus?: string; skipReason?: string; taskId?: string; taskKind?: string };
  diagnostician: { served: boolean; status: 'succeeded' | 'no_candidate' | 'skipped' | 'failed'; reason?: string; taskId?: string };
}

export interface OpenClawWorkerCycleResult {
  readonly workspaceDir: string;
  readonly mode: OpenClawWorkerMode;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly report?: OpenClawWorkerCycleStepReport;
}

export interface OpenClawWorkerCycleOptions {
  readonly workspaceDir: string;
  readonly now?: Date;
  readonly logger?: ConsumerCycleLogger;
  readonly emitEvent?: (event: string, payloadJson: string) => void;
  /** Test seam: ownership resolution override (default: real manifest read). */
  readonly ownership?: () => WorkspaceBackgroundOwnership;
}

// ─── Liveness (worker-owned runtime state, CR-08 §9.3 pattern) ──────────────

export const OPENCLAW_WORKER_LIVENESS_FILE = 'openclaw-worker-liveness.json';

const LIVENESS_STAGE_DEADLINE_MS = {
  ownership_check: 60_000,
  declaration: 60_000,
  downstream_cycle: 10 * 60_000,
  diagnosis_execution: 15 * 60_000,
} as const;

export type OpenClawWorkerStage = keyof typeof LIVENESS_STAGE_DEADLINE_MS;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Same attribution contract as the Codex worker (PRI-1264 / TD §5.2 F13). */
export function openclawWorkerCycleDriver(): 'companion' | 'service_host' | 'manual' {
  const source = process.env.PD_INVOCATION_SOURCE;
  if (source === 'companion') return 'companion';
  if (source === 'service_host') return 'service_host';
  return 'manual';
}

function invocationIdLivenessPatch(): Record<string, unknown> {
  const invocationId = process.env.PD_INVOCATION_ID;
  return typeof invocationId === 'string' && invocationId.length > 0
    ? { lastInvocationId: invocationId }
    : { lastInvocationId: null };
}

export function readOpenClawWorkerLiveness(workspaceDir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(path.resolve(workspaceDir), '.state', OPENCLAW_WORKER_LIVENESS_FILE), 'utf8'),
    );
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLiveness(workspaceDir: string, patch: Record<string, unknown>): void {
  try {
    const root = path.resolve(workspaceDir);
    const stateDir = path.join(root, '.state');
    const file = path.join(stateDir, OPENCLAW_WORKER_LIVENESS_FILE);
    if (!file.startsWith(root + path.sep)) return;
    if (!directoryExists(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    let current: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isPlainRecord(parsed)) current = parsed;
    } catch {
      current = {};
    }
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    // O_EXCL random temp + rename (CodeQL insecure-temp-file posture, same as
    // the Codex worker's liveness writer).
    const tmp = path.join(
      stateDir,
      `${OPENCLAW_WORKER_LIVENESS_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
    );
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(merged));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch {
    // Liveness bookkeeping must never break the cycle (rc-9: the cycle report
    // remains the observable degradation channel).
  }
}

function beginStage(workspaceDir: string, stage: OpenClawWorkerStage): void {
  writeLiveness(workspaceDir, {
    runningStage: stage,
    stageDeadline: new Date(Date.now() + LIVENESS_STAGE_DEADLINE_MS[stage]).toISOString(),
    lastCycleStartedAt: new Date().toISOString(),
    lastCycleDriver: openclawWorkerCycleDriver(),
    ...invocationIdLivenessPatch(),
  });
}

function finalizeLiveness(
  workspaceDir: string,
  cycleStartedAt: Date,
  settlement: { mode: OpenClawWorkerMode; reason?: string },
): void {
  writeLiveness(workspaceDir, {
    runningStage: null,
    stageDeadline: null,
    lastCycleCompletedAt: new Date().toISOString(),
    lastCycleDurationMs: Date.now() - cycleStartedAt.getTime(),
    lastCycleMode: settlement.mode,
    lastCycleDriver: openclawWorkerCycleDriver(),
    ...(settlement.reason !== undefined ? { lastDegradedReason: settlement.reason } : {}),
    ...invocationIdLivenessPatch(),
  });
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function workerLogger(logger?: ConsumerCycleLogger): ConsumerCycleLogger {
  return logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

// ─── Ownership gate ──────────────────────────────────────────────────────────

/**
 * Resolve the §8.4 ownership projection for a workspace through the real
 * install manifest (trusted `resolvePdHome` chain — the same resolution the
 * plugin's isolation guard uses). Exported for the readiness check and the
 * pd-cli command.
 */
export function readOpenClawWorkspaceOwnership(workspaceDir: string): WorkspaceBackgroundOwnership {
  const home = resolvePdHome();
  if (!home.ok) {
    return {
      status: 'manifest_unreadable',
      reason: `pd_home_resolution_refused:${home.reason}`,
      nextAction: home.message ?? 'Fix the PD home resolution (experiment root) before running the OpenClaw worker.',
    };
  }
  const paths = getInstallLayoutPathsFromPdHome(home);
  return readWorkspaceBackgroundOwnership({ manifestPath: paths.manifest, workspaceDir });
}

// ─── Readiness (no-consume self-check for the handover sequence) ────────────

export interface OpenClawWorkerReadinessResult {
  readonly mode: 'ready' | 'degraded';
  readonly workspaceDir: string;
  readonly checks: {
    workspaceDirectory: boolean;
    ownership: boolean;
    declaration: boolean;
    evidencePort: boolean;
    credentials: boolean;
  };
  readonly reason?: string;
  readonly nextAction?: string;
}

/**
 * No-consume readiness (handover step: "Service Host 以不消费模式完成就绪自
 * 自检"). Verifies every dependency the consuming cycle needs WITHOUT
 * touching the task store, the lease table or the trajectory rows: workspace
 * directory, §8.4 ownership readability, a loadable tool declaration, a
 * readable trajectory evidence port and resolvable provider credentials.
 */
export function computeOpenClawWorkerReadiness(workspaceDir: string, options?: {
  ownership?: () => WorkspaceBackgroundOwnership;
}): OpenClawWorkerReadinessResult {
  const workspaceDirResolved = path.resolve(workspaceDir);
  const checks = {
    workspaceDirectory: directoryExists(workspaceDirResolved),
    ownership: false,
    declaration: false,
    evidencePort: false,
    credentials: false,
  };

  const ownership = options?.ownership
    ? options.ownership()
    : readOpenClawWorkspaceOwnership(workspaceDirResolved);
  // Readiness does not require service_host ownership yet (the handover
  // verifies readiness BEFORE the CAS flip); it requires the marker to be
  // READABLE — an undecidable marker must block the handover.
  checks.ownership = ownership.status !== 'manifest_unreadable';

  const loaded = loadHostToolDeclarations(workspaceDirResolved);
  const openclawDeclaration = loaded.ok
    ? loaded.declarations.find((declaration) => declaration.hostKind === 'openclaw')
    : undefined;
  checks.declaration = openclawDeclaration !== undefined;

  try {
    const port = createWorkspaceBehaviorEvidencePort(workspaceDirResolved, OPENCLAW_TOOL_SEMANTICS);
    // The port resolves the trajectory DB path lazily per assemble; probe the
    // file's existence the same way the workspace evidence port does.
    const trajectoryDb = path.join(workspaceDirResolved, '.state', 'trajectory.db');
    checks.evidencePort = typeof port.assemble === 'function' && fs.existsSync(trajectoryDb);
  } catch {
    checks.evidencePort = false;
  }

  // Credentials: resolve through the SAME resolver the consuming cycle uses
  // (resolveProviderApiKey): env wins when non-empty, otherwise the console-
  // saved credentials file (<home>/.pd/credentials.yaml) is the fallback —
  // name-presence alone would wrongly refuse a workspace whose key only
  // exists in the file (PRI-1282 review). An empty env var does NOT count.
  try {
    const config = loadPdConfigForPlugin(workspaceDirResolved);
    const names = config.ok ? collectWorkspaceCredentialEnvNames(config.effective) : [];
    checks.credentials = names.some((name: string) => pdProviderCredentials.resolve(name).value !== null);
  } catch {
    checks.credentials = false;
  }

  const failed = (Object.keys(checks) as Array<keyof typeof checks>).filter((key) => !checks[key]);
  if (failed.length > 0) {
    return {
      mode: 'degraded',
      workspaceDir: workspaceDirResolved,
      checks,
      reason: `openclaw_worker_readiness_failed:${failed.join('|')}`,
      nextAction: failed.includes('declaration')
        ? 'Run the OpenClaw gateway once in this workspace so it persists the host tool declaration, then retry the handover.'
        : failed.includes('evidencePort')
          ? 'The workspace has no readable trajectory database yet; let the OpenClaw gateway collect evidence, then retry.'
          : failed.includes('credentials')
            ? 'Export the provider API key the workspace config references (see .pd/config.yaml apiKeyEnv), then retry.'
            : 'Fix the failing readiness checks and retry the handover.',
    };
  }
  return { mode: 'ready', workspaceDir: workspaceDirResolved, checks };
}

// ─── The cycle ───────────────────────────────────────────────────────────────

const WORKER_OWNER = 'service-host-worker';

export async function runOpenClawWorkspaceWorkerCycle(
  options: OpenClawWorkerCycleOptions,
): Promise<OpenClawWorkerCycleResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const logger = workerLogger(options.logger);
  const emitEvent = options.emitEvent ?? ((event: string, payloadJson: string) => SystemLogger.log(workspaceDir, event, payloadJson));
  const cycleStartedAt = options.now ?? new Date();

  if (!directoryExists(workspaceDir)) {
    return {
      workspaceDir,
      mode: 'degraded',
      reason: 'openclaw_workspace_directory_missing',
      nextAction: 'Point --workspace at the canonical OpenClaw workspace directory registered in the install manifest.',
    };
  }

  // ── Ownership gate (§8.4): only service_host_owned is consumable. ──
  beginStage(workspaceDir, 'ownership_check');
  const ownership = options.ownership ? options.ownership() : readOpenClawWorkspaceOwnership(workspaceDir);
  if (ownership.status === 'manifest_unreadable') {
    const result: OpenClawWorkerCycleResult = {
      workspaceDir,
      mode: 'degraded',
      reason: `openclaw_owner_marker_unreadable:${ownership.reason}`,
      nextAction: ownership.nextAction,
    };
    finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'degraded', reason: result.reason });
    return result;
  }
  if (ownership.status !== 'service_host_owned') {
    const result: OpenClawWorkerCycleResult = {
      workspaceDir,
      mode: 'paused',
      reason: `openclaw_workspace_not_service_host_owned:${ownership.status}`,
      nextAction: 'The workspace is still owned by the legacy consumer; complete the §8.4 handover (pd service handover) before driving it with the OpenClaw worker.',
    };
    finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'paused', reason: result.reason });
    return result;
  }

  // ── Declaration: persist (host fact from code constants, codex-worker
  // pattern) then load + validate — a worker whose declaration cannot land
  // must degrade instead of running host-neutral consumers without it. ──
  beginStage(workspaceDir, 'declaration');
  const declarationReport: OpenClawWorkerCycleStepReport['declaration'] = { persisted: false, validated: false };
  try {
    const persisted = saveHostToolDeclaration(workspaceDir, {
      version: HOST_TOOL_DECLARATION_VERSION,
      hostKind: 'openclaw',
      mappings: OPENCLAW_TOOL_SEMANTIC_MAPPINGS,
      declaredAt: new Date().toISOString(),
    });
    declarationReport.persisted = persisted.ok;
    if (!persisted.ok) declarationReport.reason = persisted.reason;
  } catch (error) {
    declarationReport.reason = error instanceof Error ? error.message : String(error);
  }
  try {
    const loaded = loadHostToolDeclarations(workspaceDir);
    if (loaded.ok) {
      const declaration = loaded.declarations.find((entry) => entry.hostKind === 'openclaw');
      if (declaration !== undefined) {
        declarationReport.validated = true;
        declarationReport.version = declaration.version;
      } else if (declarationReport.reason === undefined) {
        declarationReport.reason = 'openclaw_declaration_missing';
      }
    } else if (declarationReport.reason === undefined) {
      declarationReport.reason = loaded.reason;
    }
  } catch (error) {
    if (declarationReport.reason === undefined) {
      declarationReport.reason = error instanceof Error ? error.message : String(error);
    }
  }
  if (!declarationReport.persisted || !declarationReport.validated) {
    const reason = `openclaw_tool_declaration_unavailable:${declarationReport.reason ?? 'unknown'}`;
    const result: OpenClawWorkerCycleResult = {
      workspaceDir,
      mode: 'degraded',
      reason,
      nextAction: 'Run the OpenClaw gateway once in this workspace (it refreshes .pd/host-tool-semantics/openclaw.json), then retry the worker cycle.',
      report: {
        ownership: { state: ownership.status, generation: ownership.generation, source: 'record' },
        declaration: declarationReport,
        downstream: { ran: false, skipReason: 'declaration_unavailable' },
        diagnostician: { served: false, status: 'skipped', reason: 'declaration_unavailable' },
      },
    };
    finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'degraded', reason });
    return result;
  }

  // ── The shared bounded downstream cycle — the SAME implementation the
  // Gateway's InternalizationAutoConsumerService drives (PRI-624 slice C),
  // with the SAME OpenClaw host facts: catalog, semantics, hostKinds, the
  // SystemLogger event stream (identical module → the handover does not
  // change where an Owner reads INTERNALIZATION_CONSUMER_* events). ──
  beginStage(workspaceDir, 'downstream_cycle');
  let outcome: InternalizationConsumerCycleOutcome | undefined;
  let cycleError: Error | undefined;
  try {
    outcome = await runInternalizationConsumerCycle(workspaceDir, {
      owner: WORKER_OWNER,
      logLabel: 'OpenClawWorker',
      logger,
      emitEvent,
      hostToolCatalog: {
        readOnlyTools: READ_ONLY_TOOL_NAMES,
        writeTools: [...LOW_RISK_WRITE_TOOL_NAMES, ...HIGH_RISK_TOOL_NAMES, ...AGENT_TOOL_NAMES],
      },
      toolSemantics: OPENCLAW_TOOL_SEMANTICS,
      hostKinds: ['openclaw'],
      // Host-neutral read-only trajectory evidence (the Codex worker's
      // production pattern): no TrajectoryRegistry singleton to own or
      // dispose, no Gateway process required.
      behaviorEvidence: createWorkspaceBehaviorEvidencePort(workspaceDir, OPENCLAW_TOOL_SEMANTICS),
    });
  } catch (error) {
    cycleError = error instanceof Error ? error : new Error(String(error));
    logger.error(`[PD:OpenClawWorker] Internalization consumer cycle failed: ${cycleError.message}`);
    emitEvent('INTERNALIZATION_CONSUMER_CYCLE_FAILED', JSON.stringify({ message: cycleError.message.slice(0, 200), driver: openclawWorkerCycleDriver() }));
  }

  // ── L3 — one bounded diagnosis per cycle, same contract as the Gateway
  // tick (flag + capability + consent checks live inside). ──
  beginStage(workspaceDir, 'diagnosis_execution');
  let diagnostician: PendingDiagnosticianRunResult | undefined;
  let diagnosticianFailed = false;
  try {
    diagnostician = await runPendingDiagnosticianOnce({ workspaceDir });
  } catch (error) {
    diagnosticianFailed = true;
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    emitEvent('DIAGNOSTICIAN_AUTO_RUN_FAILED', JSON.stringify({ message }));
  }

  const downstream = outcome !== undefined
    ? {
        ran: outcome.ran,
        ...(outcome.runStatus !== undefined ? { runStatus: outcome.runStatus } : {}),
        ...(outcome.skipReason !== undefined ? { skipReason: outcome.skipReason } : {}),
        ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
        ...(outcome.taskKind !== undefined ? { taskKind: outcome.taskKind } : {}),
      }
    : { ran: false, skipReason: cycleError !== undefined ? 'cycle_error' : 'not_attempted' };
  const diagnosticianReport: OpenClawWorkerCycleStepReport['diagnostician'] = diagnostician !== undefined
    ? {
        served: diagnostician.served,
        status: diagnostician.served ? 'succeeded' : diagnostician.reason === 'no_candidate' ? 'no_candidate' : 'skipped',
        ...(diagnostician.reason !== undefined ? { reason: diagnostician.reason } : {}),
        ...(diagnostician.taskId !== undefined ? { taskId: diagnostician.taskId } : {}),
      }
    : { served: false, status: diagnosticianFailed ? 'failed' : 'skipped' };

  const report: OpenClawWorkerCycleStepReport = {
    ownership: { state: ownership.status, generation: ownership.generation, source: 'record' },
    declaration: declarationReport,
    downstream,
    diagnostician: diagnosticianReport,
  };

  if (cycleError !== undefined) {
    const result: OpenClawWorkerCycleResult = {
      workspaceDir,
      mode: 'degraded',
      reason: `openclaw_consumer_cycle_error:${cycleError.message.slice(0, 160)}`,
      nextAction: 'Inspect the SystemLogger INTERNALIZATION_CONSUMER_* events for this workspace; the task state is durable and the next cycle retries.',
      report,
    };
    finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'degraded', reason: result.reason });
    return result;
  }

  // ready: the bounded cycle completed. `ran=false` is a legal empty cycle —
  // business progress evidence comes from the task-state diff, not from
  // process success (FR-10 / pd.worker-adapter.v1 semantics).
  finalizeLiveness(workspaceDir, cycleStartedAt, { mode: 'ready' });
  return { workspaceDir, mode: 'ready', report };
}
