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
import { checkOpenClawGateway } from './utils/env.js';
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
  /** Adapter cycles that actually produced a Worker result. */
  readonly executed: number;
  /** Executions with THIS run's task/cycle progress evidence (not carried). */
  readonly progressed: number;
  /** Service-Host-owned workspaces with no adapter binding (truthful wait). */
  readonly waitingForBinding: number;
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
  /**
   * TRUE when this fresh workspace is still legacy/no-record and the install
   * committed without ownership (no consent, scheduler not enabled, readiness
   * failed). The durable evidence record lets a LATER explicit install resume
   * initialization without weakening the upgrade protection.
   */
  readonly pendingProvisioning?: boolean;
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
  /**
   * TRUE when this call RESUMES a previously recorded pending provisioning.
   * A deferred hand-over must prove the legacy consumer is not still running
   * before it flips ownership (the marker only proves what the FIRST install
   * did, not what ran afterwards).
   */
  readonly resume?: boolean;
  /**
   * Resume-only: the caller could not verify the host binding that the pending
   * marker named. Ownership must NOT flip from an unverified binding; the
   * refusal is recorded durably with an actionable next action.
   */
  readonly bindingVerification?: { readonly ok: false; readonly reason: string; readonly nextAction: string };
}

const DEFAULT_FIRST_CYCLE_TIMEOUT_MS = 180_000;
const EVIDENCE_SCHEMA = 'pd.service-install-provisioning.v1';
const PENDING_SCHEMA = 'pd.service-pending-provisioning.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The real directory a workspace pointer resolves to (symlinks/junctions resolved). */
function stableWorkspacePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function canonicalIdentity(value: string): string {
  const form = stableWorkspacePath(value);
  return process.platform === 'win32' ? form.toLowerCase() : form;
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
      {
        probes: input.probes ?? {},
        // Worker commands do NOT register --pd-home; Commander would reject
        // the whole probe. Identity comes from the trusted home env instead.
        includePdHome: false,
        homeDir: path.dirname(input.pdHome),
      },
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

function notAttempted(reason: string): ProvisioningFirstCycle {
  return { attempted: false, ok: false, executed: 0, progressed: 0, waitingForBinding: 0, reason };
}

function countExecutions(
  doc: Record<string, unknown>,
  workspaceDir: string,
): { executed: number; progressed: number; waitingForBinding: number } {
  const managed = isRecord(doc.managed) ? doc.managed : {};
  const executions = Array.isArray(managed.executions) ? managed.executions : [];
  const expected = canonicalIdentity(workspaceDir);
  let executed = 0;
  let progressed = 0;
  let waitingForBinding = 0;
  for (const entry of executions) {
    if (!isRecord(entry)) continue;
    // `service run-once` is a GLOBAL cycle over every owned workspace. The
    // evidence for THIS provisioning target must count only its own entry,
    // otherwise a multi-host install reports the sibling's work as its own.
    if (typeof entry.canonicalDir !== 'string') continue;
    if (canonicalIdentity(entry.canonicalDir) !== expected) continue;
    if (entry.workspaceState === 'waiting_for_host_binding') {
      waitingForBinding += 1;
      continue;
    }
    // Only a REAL adapter cycle counts as execution: the no-adapter record has
    // no `execution` payload and must not be reported as work performed.
    const ranWorker = entry.admission === 'executed'
      && typeof entry.hostKind === 'string'
      && isRecord(entry.execution);
    if (!ranWorker) continue;
    executed += 1;
    // Progress must come from THIS run's evidence; a timestamp carried from a
    // previous run is not progress made by the first cycle.
    if (entry.lastProgressSource === 'task_state_change' || entry.lastProgressSource === 'cycle_evidence') {
      progressed += 1;
    }
  }
  return { executed, progressed, waitingForBinding };
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
    return { ...notAttempted(result.detail), attempted: true };
  }
  const { doc } = result;
  const outcome = typeof doc.outcome === 'string' ? doc.outcome : 'unknown';
  if (outcome === 'already_running') {
    // Overlapping OS trigger won the install-level lock: honest deferral, not
    // a failed install, and not a fabricated success either.
    return { ...notAttempted('service_run_lock_held'), attempted: true, outcome };
  }
  const { executed, progressed, waitingForBinding } = countExecutions(doc, input.workspaceDir);
  return {
    attempted: true,
    ok: result.code === 0 && (doc.ok === true || outcome === 'completed'),
    ...(outcome !== 'unknown' ? { outcome } : {}),
    ...(typeof doc.runId === 'string' ? { runId: doc.runId } : {}),
    executed,
    progressed,
    waitingForBinding,
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
  readonly pendingProvisioning: boolean;
  readonly pendingReason?: string;
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

/** Host values a pending provisioning entry may carry. */
const PENDING_HOSTS: readonly HostSelection[] = ['none', 'openclaw', 'codex', 'workbuddy', 'all'];

interface PendingRegistryEntry {
  /** The REAL resolved directory this entry owns. */
  readonly workspaceDir: string;
  /** The operator's original pointer, when it differed (display only). */
  readonly requestedWorkspaceDir?: string;
  readonly host: HostSelection;
  readonly recordedAt: string;
  readonly reason?: string;
}

interface PendingRegistryRead {
  readonly entries: readonly PendingRegistryEntry[];
  readonly warning?: string;
}

function pendingRegistryPath(pdHome: string): string {
  return path.join(pdHome, 'service', 'pending-provisioning.json');
}

function isPendingHost(value: unknown): value is HostSelection {
  return typeof value === 'string' && (PENDING_HOSTS as readonly string[]).includes(value);
}

/**
 * Read the PER-WORKSPACE pending provisioning registry.
 *
 * A single evidence document is last-write-wins, so `--host all` (OpenClaw +
 * Codex bound to different directories) lost every record but the last one.
 * The registry is keyed by canonical workspace and merged on write; each entry
 * carries the host that was being provisioned so a later resume can verify the
 * binding instead of trusting this run's (possibly `none`) host choice.
 */
function readPendingRegistry(pdHome: string): PendingRegistryRead {
  const file = pendingRegistryPath(pdHome);
  if (!fs.existsSync(file)) return { entries: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { entries: [], warning: `pending provisioning registry is unreadable (${error instanceof Error ? error.message : String(error)}).` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], warning: `pending provisioning registry is not valid JSON (${file}).` };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== PENDING_SCHEMA || !Array.isArray(parsed.entries)) {
    return { entries: [], warning: `pending provisioning registry has an unsupported shape (${file}).` };
  }
  const entries: PendingRegistryEntry[] = [];
  let invalid = 0;
  for (const entry of parsed.entries) {
    if (!isRecord(entry)) {
      invalid += 1;
      continue;
    }
    if (typeof entry.workspaceDir !== 'string' || entry.workspaceDir.length === 0) {
      invalid += 1;
      continue;
    }
    if (!isPendingHost(entry.host)) {
      invalid += 1;
      continue;
    }
    if (typeof entry.recordedAt !== 'string') {
      invalid += 1;
      continue;
    }
    entries.push({
      workspaceDir: entry.workspaceDir,
      host: entry.host,
      recordedAt: entry.recordedAt,
      ...(typeof entry.requestedWorkspaceDir === 'string' ? { requestedWorkspaceDir: entry.requestedWorkspaceDir } : {}),
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    });
  }
  return {
    entries,
    ...(invalid > 0
      ? { warning: `pending provisioning registry contains ${invalid} invalid entr${invalid === 1 ? 'y' : 'ies'} (${file}); they were ignored.` }
      : {}),
  };
}

function writePendingRegistry(pdHome: string, entries: readonly PendingRegistryEntry[]): void {
  const dir = path.join(pdHome, 'service');
  fs.mkdirSync(dir, { recursive: true });
  const target = pendingRegistryPath(pdHome);
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: PENDING_SCHEMA, entries }, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, target);
}

function upsertPending(
  pdHome: string,
  entry: PendingRegistryEntry,
  warn: (message: string) => void,
): void {
  try {
    const { entries, warning } = readPendingRegistry(pdHome);
    if (warning !== undefined) warn(`${warning} Recording a fresh pending entry for ${entry.workspaceDir}.`);
    // Persist the REAL directory the operator's pointer resolved to NOW. A
    // later resume must own that directory even if a symlink/junction has been
    // re-pointed since; the requested path is kept for display only.
    const stable = stableWorkspacePath(entry.workspaceDir);
    const identity = canonicalIdentity(stable);
    const merged = entries.filter((candidate) => canonicalIdentity(candidate.workspaceDir) !== identity);
    merged.push({
      ...entry,
      workspaceDir: stable,
      ...(stable !== entry.workspaceDir ? { requestedWorkspaceDir: entry.workspaceDir } : {}),
    });
    writePendingRegistry(pdHome, merged);
  } catch (error) {
    warn(`Pending provisioning record could not be written (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function clearPending(
  pdHome: string,
  workspaceDir: string,
  warn: (message: string) => void,
): void {
  try {
    const { entries, warning } = readPendingRegistry(pdHome);
    if (warning !== undefined) {
      // Never rewrite a registry whose current content could not be read:
      // overwriting it would silently discard the other workspaces' hints.
      warn(warning);
      return;
    }
    const identity = canonicalIdentity(workspaceDir);
    const remaining = entries.filter((candidate) => canonicalIdentity(candidate.workspaceDir) !== identity);
    if (remaining.length === entries.length) return;
    writePendingRegistry(pdHome, remaining);
  } catch (error) {
    warn(`Pending provisioning record could not be updated (${error instanceof Error ? error.message : String(error)}).`);
  }
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

  const before = readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir: input.workspaceDir });
  if (before.status === 'manifest_unreadable') {
    return {
      ownership: 'failed',
      ownershipBefore: 'manifest_unreadable',
      ownershipAfter: 'manifest_unreadable',
      generation: null,
      readiness: 'skipped',
      firstCycle: notAttempted(before.reason),
      nextAction: before.nextAction,
      warnings,
    };
  }
  if (before.status === 'service_host_owned') {
    // The workspace reached ownership another way (e.g. `pd service handover`);
    // its pending hint is stale and must not be resumed again.
    clearPending(input.pdHome, input.workspaceDir, warn);
    return {
      ownership: 'already_owned',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: 'skipped',
      firstCycle: notAttempted('already_service_host_owned'),
      nextAction: 'This workspace is already owned by the Service Host; the installer left the ownership record untouched.',
      warnings,
    };
  }
  if (before.status !== 'legacy_owned' || before.source !== 'no_record') {
    // Any recorded history (including legacy_owned) is an UPGRADE: it must go
    // through the quiescing handover, never through fresh provisioning.
    clearPending(input.pdHome, input.workspaceDir, warn);
    return {
      ownership: 'not_provisioned',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: 'skipped',
      firstCycle: notAttempted('ownership_history_present'),
      pendingProvisioning: false,
      nextAction: 'This workspace already has an ownership record, so the installer did not change it. Move it explicitly with `pd service handover --workspace <dir>` (legacy consumer quiesce + readiness) or keep the legacy lifecycle.',
      warnings,
    };
  }

  const recordPending = (
    reason: string,
    args: {
      readiness: ProvisioningReadiness;
      readinessDetail?: string;
      firstCycle: ProvisioningFirstCycle;
      ownership?: 'failed';
      nextAction: string;
    },
  ): ServiceHostProvisioningOutcome => {
    const recordedAt = (input.now?.() ?? new Date()).toISOString();
    // Per-workspace hint: `--host all` produces multiple targets, and the
    // single evidence document below is last-write-wins. The registry keeps
    // every target independently resumable, including the host it was for.
    upsertPending(input.pdHome, {
      workspaceDir: input.workspaceDir,
      host: input.host,
      recordedAt,
      reason,
    }, warn);
    let evidencePath: string | undefined;
    try {
      evidencePath = writeEvidence(input.pdHome, {
        schemaVersion: EVIDENCE_SCHEMA,
        recordedAt,
        workspaceDir: input.workspaceDir,
        host: input.host,
        scheduler: {
          state: input.scheduler.state,
          registered: input.scheduler.registered,
          enabled: input.scheduler.enabled,
          ...(input.scheduler.triggerIntervalMs !== undefined ? { triggerIntervalMs: input.scheduler.triggerIntervalMs } : {}),
        },
        ownership: { before: before.status, after: before.status, generation: before.generation },
        readiness: { status: args.readiness, ...(args.readinessDetail !== undefined ? { detail: args.readinessDetail } : {}) },
        firstCycle: args.firstCycle,
        pendingProvisioning: true,
        pendingReason: reason,
        limitations: limitationsFor(input.host, args.readiness),
      });
    } catch (error) {
      warn(`Service Host provisioning evidence could not be written (${error instanceof Error ? error.message : String(error)}).`);
    }
    return {
      ownership: args.ownership ?? 'not_provisioned',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: args.readiness,
      ...(args.readinessDetail !== undefined ? { readinessDetail: args.readinessDetail } : {}),
      firstCycle: args.firstCycle,
      ...(evidencePath !== undefined ? { evidencePath } : {}),
      pendingProvisioning: true,
      nextAction: args.nextAction,
      warnings,
    };
  };

  // Resume-only: a pending hint may name a host whose binding can no longer be
  // read/validated. Flipping ownership from an unverified binding is exactly
  // the "assume a host that may not be there" failure; refuse durably instead.
  if (input.bindingVerification !== undefined && !input.bindingVerification.ok) {
    return recordPending('binding_unverifiable', {
      readiness: 'skipped',
      firstCycle: notAttempted('binding_unverifiable'),
      nextAction: `${input.bindingVerification.nextAction} Ownership was NOT handed over because the workspace's host binding could not be verified (${input.bindingVerification.reason}).`,
    });
  }

  // Guard: ownership is only handed over when the scheduler is VERIFIED
  // enabled. A registration that failed or stayed disabled must never flip
  // the marker (no silent legacy retirement) — it records a PENDING
  // provisioning fact instead so a later explicit install can resume.
  if (input.scheduler.state !== 'enabled' || input.scheduler.enabled !== true) {
    return recordPending(`scheduler_${input.scheduler.state}`, {
      readiness: 'skipped',
      firstCycle: notAttempted(`scheduler_${input.scheduler.state}`),
      nextAction: `${input.scheduler.nextAction} Workspace ownership was NOT handed over because the scheduler is not verified enabled. This new workspace is recorded as pending; after arming the scheduler, re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
    });
  }

  // A DEFERRED resume proves only that the first install did not hand over —
  // not that no legacy consumer started afterwards. With a running OpenClaw
  // Gateway, flipping ownership here would create a second consumer; the
  // controlled handover (Gateway quiesce ack) is the only safe path.
  if (input.resume === true && (input.host === 'openclaw' || input.host === 'all')) {
    const gatewayRunning = input.probes?.gatewayRunning !== undefined
      ? await input.probes.gatewayRunning()
      : (await checkOpenClawGateway()).isRunning;
    if (gatewayRunning) {
      return recordPending('legacy_consumer_running', {
        readiness: 'skipped',
        firstCycle: notAttempted('legacy_consumer_running'),
        nextAction: `A running OpenClaw Gateway may still consume this workspace, so ownership was NOT handed over. Quiesce it through the controlled handover: pd service handover --workspace "${input.workspaceDir}" — or stop the Gateway (openclaw gateway stop) and re-run this install.`,
      });
    }
  }

  const readiness = await probeReadiness(input);
  if (readiness.readiness === 'failed') {
    return recordPending('readiness_failed', {
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: notAttempted('readiness_failed'),
      nextAction: `The active-release Worker readiness probe failed (${readiness.detail ?? 'unknown'}), so workspace ownership was NOT handed over. Fix the host adapter/workspace readiness, then re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
    });
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
    return recordPending(`cas_${provisioned.reason}`, {
      ownership: 'failed',
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: notAttempted(`cas_${provisioned.reason}`),
      nextAction: provisioned.nextAction ?? 'Repair the install manifest and retry; no ownership change was written.',
    });
  }

  // Verify the persisted fact, not the in-memory result.
  const after = readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir: input.workspaceDir });
  const owned = after.status === 'service_host_owned'
    && after.record.effectiveOwner === 'service_host'
    && after.generation >= 1;
  if (!owned) {
    warn(`Service Host ownership provisioning reported success but the persisted projection is ${after.status}.`);
    return recordPending('post_write_projection_mismatch', {
      ownership: 'failed',
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: notAttempted('post_write_projection_mismatch'),
      nextAction: 'Inspect ~/.pd/install.json (backgroundExecutions) before relying on automatic runs; the persisted ownership could not be verified.',
    });
  }

  // The durable pending hint has done its job: ownership is verified, so a
  // later install must not treat this workspace as "uninitialized" again.
  clearPending(input.pdHome, input.workspaceDir, warn);

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
      pendingProvisioning: false,
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
    pendingProvisioning: false,
    nextAction: readiness.readiness === 'waiting_for_host_binding'
      ? 'The Service Host scheduler is enabled and owns this workspace, but no host adapter is bound — install a host adapter and bind the workspace before tasks can be consumed.'
      : firstCycle.ok
        ? 'The Service Host owns this workspace and completed its first managed cycle.'
        : 'The Service Host owns this workspace; the first cycle did not complete, and the next scheduler trigger retries from persisted task/lease state.',
    warnings,
  };
}

/** Durable hint that a NEW workspace was committed without Service Host ownership. */
export interface PendingProvisioningMarker {
  /** The REAL resolved directory ownership will be written for. */
  readonly workspaceDir: string;
  /** The operator's original pointer, when it differed (display only). */
  readonly requestedWorkspaceDir?: string;
  /** The host adapter that was being provisioned when the hand-over was deferred. */
  readonly host: HostSelection;
  readonly recordedAt: string;
  readonly reason?: string;
}

/**
 * Every pending hint this PD home recorded.
 *
 * A multi-host install (`--host all`) records one entry per ACTUAL workspace
 * instead of overwriting a single document, so a later explicit enable can
 * resume all of them. This is a HINT, never an ownership authority: the caller
 * still requires explicit enable consent and an ownership record with no
 * history (`provision_fresh_install` enforces both).
 */
export function readAllPendingProvisioning(pdHome: string): {
  entries: readonly PendingProvisioningMarker[];
  warning?: string;
} {
  const { entries, warning } = readPendingRegistry(pdHome);
  return {
    entries: entries.map((entry) => ({
      workspaceDir: entry.workspaceDir,
      host: entry.host,
      recordedAt: entry.recordedAt,
      ...(entry.requestedWorkspaceDir !== undefined ? { requestedWorkspaceDir: entry.requestedWorkspaceDir } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    })),
    ...(warning !== undefined ? { warning } : {}),
  };
}

/**
 * Read the pending hint for ONE workspace.
 *
 * Unreadable/foreign records are `null` (fail-closed, never a guess); the
 * caller then leaves the workspace in legacy ownership.
 */
export function readPendingProvisioningEvidence(pdHome: string, workspaceDir: string): PendingProvisioningMarker | null {
  const { entries } = readPendingRegistry(pdHome);
  const identity = canonicalIdentity(workspaceDir);
  const found = entries.find((entry) => canonicalIdentity(entry.workspaceDir) === identity);
  return found === undefined
    ? null
    : {
        workspaceDir: found.workspaceDir,
        host: found.host,
        recordedAt: found.recordedAt,
        ...(found.requestedWorkspaceDir !== undefined ? { requestedWorkspaceDir: found.requestedWorkspaceDir } : {}),
        ...(found.reason !== undefined ? { reason: found.reason } : {}),
      };
}
