/**
 * Fresh-install Service Host provisioning (PRI-1278 Phase 5).
 *
 * A brand-new PD install hands its NEW workspace to the PD-owned Service Host
 * in the same installer run:
 *
 *   1. the workspace is already registered in the canonical manifest;
 *   2. a no-consume Worker readiness probe runs through the ACTIVE RELEASE
 *      (`pd <host> worker --readiness` / `--status`), never through the
 *      installer's own code;
 *   3. the §8.4 CAS provision transition writes `service_host_owned`
 *      atomically (generation 1) — there is no legacy consumer to quiesce,
 *      and the marker itself blocks every legacy consumer from starting;
 *   4. one bounded REAL managed cycle runs (`pd service run-once`);
 *   5. an auditable provisioning record is written under `<pdHome>/service/`.
 *
 * Boundaries (deliberate):
 *  - this module NEVER owns scheduler lifecycle or ownership semantics — both
 *    are delegated to their existing single implementations (`pd service …`
 *    and `@principles/install-layout`);
 *  - it only runs for a FRESH install whose scheduler was verified ENABLED;
 *    a failed/absent scheduler never flips ownership (no silent migration);
 *  - an upgrade never calls it — existing workspaces migrate through
 *    `pd service handover`;
 *  - no credential, token or environment snapshot is written to argv, the
 *    evidence file or logs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readWorkspaceBackgroundOwnership,
  transitionWorkspaceBackgroundExecution,
  type BackgroundExecutionRecord,
} from '@principles/install-layout';
import {
  runInstalledCliJson,
  type ServiceHostBridgeProbes,
  type ServiceHostSchedulerOutcome,
} from './service-host-bridge.js';
import type { HostSelection } from './installers/index.js';

export type ProvisioningReadiness =
  | 'ready'
  | 'waiting_for_host_binding'
  | 'failed'
  | 'skipped';

export interface ProvisioningFirstCycle {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly outcome?: string;
  readonly runId?: string;
  readonly executed: number;
  readonly progressed: number;
  readonly reason?: string;
}

export interface ServiceHostProvisioningOutcome {
  readonly ownership: 'service_host_owned' | 'already_owned' | 'not_provisioned' | 'failed';
  readonly ownershipBefore: string;
  readonly ownershipAfter: string;
  readonly generation: number | null;
  readonly readiness: ProvisioningReadiness;
  readonly readinessDetail?: string;
  readonly firstCycle: ProvisioningFirstCycle;
  readonly evidencePath?: string;
  readonly nextAction: string;
  readonly warnings: readonly string[];
}

export interface ProvisioningInput {
  readonly pdHome: string;
  readonly workspaceDir: string;
  readonly host: HostSelection;
  readonly scheduler: ServiceHostSchedulerOutcome;
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
  readonly probes?: ServiceHostBridgeProbes;
  /** Bounded first-cycle budget (default 180s). */
  readonly firstCycleTimeoutMs?: number;
  /** Test seam: real fs by default. */
  readonly now?: () => Date;
}

const DEFAULT_FIRST_CYCLE_TIMEOUT_MS = 180_000;
const EVIDENCE_SCHEMA = 'pd.service-install-provisioning.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readinessProbeArgs(host: Exclude<HostSelection, 'all' | 'none'>, workspaceDir: string): string[] {
  // OpenClaw has a dedicated no-consume readiness mode; Codex / WorkBuddy
  // answer the same question through their `--status` mode (no cycle runs).
  return host === 'openclaw'
    ? ['openclaw', 'worker', '--readiness', '--json', '--workspace', workspaceDir]
    : [host, 'worker', '--status', '--json', '--workspace', workspaceDir];
}

function hostsToProbe(host: HostSelection): Exclude<HostSelection, 'all' | 'none'>[] {
  if (host === 'none') return [];
  if (host === 'all') return ['openclaw', 'codex'];
  return [host];
}

async function probeReadiness(input: ProvisioningInput): Promise<{
  readiness: ProvisioningReadiness;
  detail?: string;
}> {
  const hosts = hostsToProbe(input.host);
  if (hosts.length === 0) {
    return {
      readiness: 'waiting_for_host_binding',
      detail: 'no_host_adapter_installed',
    };
  }
  for (const host of hosts) {
    const probe = await runInstalledCliJson(
      input.pdHome,
      readinessProbeArgs(host, input.workspaceDir),
      { probes: input.probes ?? {} },
    );
    if (!probe.ok) {
      return { readiness: 'failed', detail: `${host}:${probe.detail}` };
    }
    const doc = isRecord(probe.doc) ? probe.doc : {};
    const mode = typeof doc.mode === 'string' ? doc.mode : 'unknown';
    // 'paused' is a GOVERNANCE state (PD disabled in this workspace), not an
    // install-wiring failure: the Service Host honors flags at cycle time.
    if (mode !== 'ready' && mode !== 'paused') {
      return { readiness: 'failed', detail: `${host}:worker_mode_${mode}` };
    }
  }
  return { readiness: 'ready', detail: hosts.join('+') };
}

function countExecutions(doc: Record<string, unknown>): { executed: number; progressed: number } {
  const managed = isRecord(doc.managed) ? doc.managed : {};
  const executions = Array.isArray(managed.executions) ? managed.executions : [];
  let executed = 0;
  let progressed = 0;
  for (const entry of executions) {
    if (!isRecord(entry)) continue;
    if (entry.admission === 'executed') executed += 1;
    if (typeof entry.lastProgressAt === 'string' && entry.lastProgressAt.length > 0) progressed += 1;
  }
  return { executed, progressed };
}

async function runFirstCycle(input: ProvisioningInput): Promise<ProvisioningFirstCycle> {
  const result = await runInstalledCliJson(
    input.pdHome,
    ['service', 'run-once', '--trigger', 'installer', '--json'],
    {
      probes: input.probes ?? {},
      timeoutMs: input.firstCycleTimeoutMs ?? DEFAULT_FIRST_CYCLE_TIMEOUT_MS,
    },
  );
  if (!result.ok || !isRecord(result.doc)) {
    return { attempted: true, ok: false, executed: 0, progressed: 0, reason: result.detail };
  }
  const { doc } = result;
  const outcome = typeof doc.outcome === 'string' ? doc.outcome : 'unknown';
  if (outcome === 'already_running') {
    // Overlapping OS trigger won the install-level lock: honest deferral, not
    // a failed install, and not a fabricated success either.
    return { attempted: true, ok: false, outcome, executed: 0, progressed: 0, reason: 'service_run_lock_held' };
  }
  const { executed, progressed } = countExecutions(doc);
  return {
    attempted: true,
    ok: result.code === 0 && (doc.ok === true || outcome === 'completed'),
    ...(outcome !== 'unknown' ? { outcome } : {}),
    ...(typeof doc.runId === 'string' ? { runId: doc.runId } : {}),
    executed,
    progressed,
    ...(typeof doc.reason === 'string' ? { reason: doc.reason } : {}),
  };
}

interface ProvisioningEvidence {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA;
  readonly recordedAt: string;
  readonly workspaceDir: string;
  readonly host: HostSelection;
  readonly scheduler: {
    state: string;
    registered: boolean | null;
    enabled: boolean | null;
    triggerIntervalMs?: number | null;
  };
  readonly ownership: {
    before: string;
    after: string;
    generation: number | null;
    record?: BackgroundExecutionRecord;
  };
  readonly readiness: { status: ProvisioningReadiness; detail?: string };
  readonly firstCycle: ProvisioningFirstCycle;
  readonly limitations: readonly string[];
}

function writeEvidence(pdHome: string, evidence: ProvisioningEvidence): string {
  const dir = path.join(pdHome, 'service');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'install-provisioning.json');
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, target);
  return target;
}

function limitationsFor(host: HostSelection, readiness: ProvisioningReadiness): string[] {
  const limitations: string[] = [];
  if (host === 'none') {
    limitations.push('Service-Host-only install: no host adapter is installed, so the workspace reports waiting_for_host_binding until a host adapter is installed and bound.');
  }
  if (readiness === 'waiting_for_host_binding') {
    limitations.push('Worker readiness was not proven because no host adapter is bound; the scheduler owns the cycle but has no adapter to dispatch.');
  }
  return limitations;
}

/**
 * Provision ONE fresh-install workspace into Service Host ownership.
 * Returns a structured outcome; never throws for expected refusals (rc-9).
 */
export async function provisionFreshInstallWorkspace(input: ProvisioningInput): Promise<ServiceHostProvisioningOutcome> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    input.warn(message);
  };
  const manifestPath = path.join(input.pdHome, 'install.json');

  // Guard: ownership is only handed over when the scheduler is VERIFIED
  // enabled. A registration that failed or stayed disabled must never flip
  // the marker (no silent legacy retirement).
  if (input.scheduler.state !== 'enabled' || input.scheduler.enabled !== true) {
    return {
      ownership: 'not_provisioned',
      ownershipBefore: 'unknown',
      ownershipAfter: 'unknown',
      generation: null,
      readiness: 'skipped',
      firstCycle: { attempted: false, ok: false, executed: 0, progressed: 0, reason: `scheduler_${input.scheduler.state}` },
      nextAction: `${input.scheduler.nextAction} Workspace ownership was NOT handed over because the scheduler is not verified enabled.`,
      warnings,
    };
  }

  const before = readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir: input.workspaceDir });
  if (before.status === 'manifest_unreadable') {
    return {
      ownership: 'failed',
      ownershipBefore: 'manifest_unreadable',
      ownershipAfter: 'manifest_unreadable',
      generation: null,
      readiness: 'skipped',
      firstCycle: { attempted: false, ok: false, executed: 0, progressed: 0, reason: before.reason },
      nextAction: before.nextAction,
      warnings,
    };
  }
  if (before.status === 'service_host_owned') {
    return {
      ownership: 'already_owned',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: 'skipped',
      firstCycle: { attempted: false, ok: false, executed: 0, progressed: 0, reason: 'already_service_host_owned' },
      nextAction: 'This workspace is already owned by the Service Host; the installer left the ownership record untouched.',
      warnings,
    };
  }
  if (before.status !== 'legacy_owned' || before.source !== 'no_record') {
    // Any recorded history (including legacy_owned) is an UPGRADE: it must go
    // through the quiescing handover, never through fresh provisioning.
    return {
      ownership: 'not_provisioned',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: 'skipped',
      firstCycle: { attempted: false, ok: false, executed: 0, progressed: 0, reason: 'ownership_history_present' },
      nextAction: 'This workspace already has an ownership record, so the installer did not change it. Move it explicitly with `pd service handover --workspace <dir>` (legacy consumer quiesce + readiness) or keep the legacy lifecycle.',
      warnings,
    };
  }

  const readiness = await probeReadiness(input);
  if (readiness.readiness === 'failed') {
    return {
      ownership: 'not_provisioned',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: { attempted: false, ok: false, executed: 0, progressed: 0, reason: 'readiness_failed' },
      nextAction: `The active-release Worker readiness probe failed (${readiness.detail ?? 'unknown'}), so workspace ownership was NOT handed over. Fix the host adapter/workspace readiness, then run \`pd service handover --workspace "${input.workspaceDir}"\`.`,
      warnings,
    };
  }

  const operationId = `install-provision-${input.now?.().getTime() ?? Date.now()}-${process.pid}`;
  const provisioned = transitionWorkspaceBackgroundExecution({
    manifestPath,
    workspaceDir: input.workspaceDir,
    kind: 'provision_fresh_install',
    operationId,
    freshInstall: true,
    registerWorkspace: true,
    expectedGeneration: before.generation,
  });
  if (!provisioned.ok) {
    warn(`Service Host ownership provisioning failed (${provisioned.reason}: ${provisioned.message}). ${provisioned.nextAction ?? ''}`.trim());
    return {
      ownership: 'failed',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: { attempted: false, ok: false, executed: 0, progressed: 0, reason: `cas_${provisioned.reason}` },
      nextAction: provisioned.nextAction ?? 'Repair the install manifest and retry; no ownership change was written.',
      warnings,
    };
  }

  // Verify the persisted fact, not the in-memory result.
  const after = readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir: input.workspaceDir });
  const owned = after.status === 'service_host_owned'
    && after.record.effectiveOwner === 'service_host'
    && after.generation >= 1;
  if (!owned) {
    warn(`Service Host ownership provisioning reported success but the persisted projection is ${after.status}.`);
    return {
      ownership: 'failed',
      ownershipBefore: before.status,
      ownershipAfter: after.status,
      generation: after.status === 'manifest_unreadable' ? null : after.generation,
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: { attempted: false, ok: false, executed: 0, progressed: 0, reason: 'post_write_projection_mismatch' },
      nextAction: 'Inspect ~/.pd/install.json (backgroundExecutions) before relying on automatic runs; the persisted ownership could not be verified.',
      warnings,
    };
  }

  const firstCycle = await runFirstCycle(input);
  if (!firstCycle.ok) {
    warn(`The first managed Service Host cycle did not complete cleanly (${firstCycle.reason ?? firstCycle.outcome ?? 'unknown'}); the workspace ownership is valid and the next scheduler trigger retries.`);
  }

  const record = after.status === 'service_host_owned' ? after.record : undefined;
  const limitations = limitationsFor(input.host, readiness.readiness);
  let evidencePath: string | undefined;
  try {
    evidencePath = writeEvidence(input.pdHome, {
      schemaVersion: EVIDENCE_SCHEMA,
      recordedAt: (input.now?.() ?? new Date()).toISOString(),
      workspaceDir: input.workspaceDir,
      host: input.host,
      scheduler: {
        state: input.scheduler.state,
        registered: input.scheduler.registered,
        enabled: input.scheduler.enabled,
        ...(input.scheduler.triggerIntervalMs !== undefined ? { triggerIntervalMs: input.scheduler.triggerIntervalMs } : {}),
      },
      ownership: {
        before: before.status,
        after: after.status,
        generation: after.generation,
        ...(record !== undefined ? { record } : {}),
      },
      readiness: {
        status: readiness.readiness,
        ...(readiness.detail !== undefined ? { detail: readiness.detail } : {}),
      },
      firstCycle,
      limitations,
    });
    input.info?.(`Provisioning evidence: ${evidencePath}`);
  } catch (error) {
    // The ownership write already happened and is the authority; a failed
    // evidence write must be visible, not rolled back or hidden (rc-9).
    warn(`Service Host provisioning evidence could not be written (${error instanceof Error ? error.message : String(error)}). The ownership record itself is intact; inspect ~/.pd/install.json.`);
  }

  input.info?.(`Service Host owns workspace ${input.workspaceDir} (generation ${after.generation}, owner=service_host).`);

  return {
    ownership: provisioned.changed ? 'service_host_owned' : 'already_owned',
    ownershipBefore: before.status,
    ownershipAfter: after.status,
    generation: after.generation,
    readiness: readiness.readiness,
    ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
    firstCycle,
    evidencePath,
    nextAction: readiness.readiness === 'waiting_for_host_binding'
      ? 'The Service Host scheduler is enabled and owns this workspace, but no host adapter is bound — install a host adapter and bind the workspace before tasks can be consumed.'
      : firstCycle.ok
        ? 'The Service Host owns this workspace and completed its first managed cycle.'
        : 'The Service Host owns this workspace; the first cycle did not complete, and the next scheduler trigger retries from persisted task/lease state.',
    warnings,
  };
}
