/**
 * `pd service install|enable|disable|status|uninstall` — the Phase 3
 * lifecycle command handlers (SPEC §8.1/§11 Phase 3, task §5).
 *
 * cli-1: `--json` stdout carries exactly ONE machine document (diagnostics
 * to stderr). cli-2/6: every failure exits non-zero with reason +
 * nextAction; an OS permission denial is NEVER rendered as "not installed".
 * All operations are idempotent; `install` defaults to installed_disabled
 * and never auto-enables.
 */
import {
  runSchedulerLifecycle,
  composeServiceHostStatus,
  type SchedulerLifecycleOperation,
  type SchedulerLifecycleResult,
} from '../services/service-host/index.js';
import { SERVICE_HOST_STATUS_SCHEMA_VERSION, type ServiceHostStatusDocument } from '../services/service-host/index.js';
import { resolveCoordinatorInstallIdentity } from '../services/service-host/install-identity.js';
import { acquireServiceRunLock, releaseServiceRunLock } from '../services/service-host/locking/service-run-lock.js';

export interface ServiceLifecycleArgs {
  readonly json: boolean;
  /** Trusted home injection (installer / automation) — never env-derived. */
  readonly pdHome?: string;
  /** Install-only: raw --interval-ms string, fully validated here (F8 pattern). */
  readonly intervalMsRaw?: string;
}

const OP_SCHEMA = 'pd.service-scheduler-op.v1' as const;

interface OpJsonOk {
  readonly schemaVersion: typeof OP_SCHEMA;
  readonly operation: SchedulerLifecycleOperation;
  readonly ok: true;
  readonly changed: boolean;
  readonly platform: string;
  readonly taskName: string;
  readonly registered: boolean | null;
  readonly enabled: boolean | null;
  readonly triggerIntervalMs?: number | null;
  readonly osLastRunAt?: string | null;
  readonly osLastResult?: string | null;
  readonly nextAction: string;
}

interface OpJsonRefused {
  readonly schemaVersion: typeof OP_SCHEMA;
  readonly operation: SchedulerLifecycleOperation;
  readonly ok: false;
  readonly reason: string;
  readonly nextAction: string;
}

/** Full-value --interval-ms validation BEFORE any OS mutation (F8 pattern). */
export function parseInstallIntervalMs(raw: string | undefined): { ok: true; intervalMs?: number } | { ok: false; reason: string; nextAction: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true };
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    return {
      ok: false,
      reason: `invalid_interval_ms:${value.slice(0, 40)}`,
      nextAction: '--interval-ms must be a plain millisecond integer (e.g. 120000). Partial values like "2m" are refused.',
    };
  }
  return { ok: true, intervalMs: Number(value) };
}

function opNextAction(result: SchedulerLifecycleResult): string {
  if (result.ok) {
    switch (result.operation) {
      case 'install':
        return result.facts.enabled === true
          ? 'The scheduler registration was created and is ENABLED (an existing registration preserved its enabled state). Managed runs fire on the configured interval; inspect with pd service status --json.'
          : 'The scheduler registration was created in the DISABLED state (installed_disabled). Run pd service enable to arm automatic triggers; nothing runs until then.';
      case 'enable':
        return 'Automatic triggers are armed. The next OS trigger runs one bounded managed cycle; inspect with pd service status --json.';
      case 'disable':
        return 'Future automatic triggers are stopped. The registration, Workspace data, pending tasks, Ledger and Trajectory are all preserved; re-arm with pd service enable.';
      case 'uninstall':
        return 'The OS scheduler registration was removed. Workspace data, .pd/state.db, Ledger, Trajectory and evidence are untouched; manual pd service run-once / worker --once remain available.';
      default:
        return 'Scheduler state read from the OS above; each field is its own witness.';
    }
  }
  return result.nextAction;
}

/** Human rendering (JSON mode prints the document verbatim). */
function printHumanOp(result: SchedulerLifecycleResult, nextAction: string): void {
  if (result.ok) {
    const state = result.facts.enabled === null ? 'enabled=unknown' : result.facts.enabled ? 'ENABLED' : 'disabled';
    console.log(`pd service ${result.operation}: ok (${result.facts.platform} task "${result.facts.taskName}" — registered=${result.facts.registered}, ${state}${result.changed ? '' : ', no change (idempotent)'})`);
    console.log(`  next: ${nextAction}`);
    return;
  }
  console.error(`pd service ${result.operation} FAILED: ${result.reason}`);
  console.error(`  next: ${nextAction}`);
}

export async function handleServiceLifecycle(operation: SchedulerLifecycleOperation, args: ServiceLifecycleArgs): Promise<void> {
  let intervalMs: number | undefined;
  if (operation === 'install' && args.intervalMsRaw !== undefined) {
    const parsed = parseInstallIntervalMs(args.intervalMsRaw);
    if (!parsed.ok) {
      const output: OpJsonRefused = { schemaVersion: OP_SCHEMA, operation, ok: false, reason: parsed.reason, nextAction: parsed.nextAction };
      if (args.json) console.log(JSON.stringify(output));
      else printHumanOp({ ok: false, operation, reason: parsed.reason, nextAction: parsed.nextAction }, parsed.nextAction);
      process.exitCode = 1;
      return;
    }
    ({ intervalMs } = parsed);
  }

  // PRI-1282 r4 §9: mutating lifecycle operations serialize with handover,
  // rollback and managed run-once through the SHARED install-level run
  // lock — a `pd service disable` landing mid-handover would otherwise flip
  // the trigger under an in-flight ownership transition. `status` stays
  // lock-free (read-only).
  const identity = resolveCoordinatorInstallIdentity(process.env, args.pdHome !== undefined ? { trustedHomeDir: args.pdHome } : {});
  if (!identity.ok) {
    const output: OpJsonRefused = { schemaVersion: OP_SCHEMA, operation, ok: false, reason: `install_identity_unresolved:${identity.reason}`, nextAction: identity.nextAction };
    if (args.json) console.log(JSON.stringify(output));
    else printHumanOp({ ok: false, operation, reason: output.reason, nextAction: output.nextAction }, output.nextAction);
    process.exitCode = 1;
    return;
  }
  const runLock = acquireServiceRunLock(identity.identity.pdHome);
  if (!runLock.ok) {
    const output: OpJsonRefused = {
      schemaVersion: OP_SCHEMA,
      operation,
      ok: false,
      reason: `service_run_in_progress:${runLock.kind}`,
      nextAction: 'A managed run-once, handover or rollback is currently executing on this install; wait for it to finish and retry the lifecycle operation.',
    };
    if (args.json) console.log(JSON.stringify(output));
    else printHumanOp({ ok: false, operation, reason: output.reason, nextAction: output.nextAction }, output.nextAction);
    process.exitCode = 1;
    return;
  }

  let result: SchedulerLifecycleResult;
  try {
    result = await runSchedulerLifecycle(operation, {
      ...(args.pdHome !== undefined ? { trustedHomeDir: args.pdHome } : {}),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
    });
  } finally {
    releaseServiceRunLock(runLock.handle);
  }
  const nextAction = opNextAction(result);

  if (args.json) {
    const output: OpJsonOk | OpJsonRefused = result.ok
      ? {
          schemaVersion: OP_SCHEMA,
          operation,
          ok: true,
          changed: result.changed,
          platform: result.facts.platform,
          taskName: result.facts.taskName,
          registered: result.facts.registered,
          enabled: result.facts.enabled,
          ...(result.facts.triggerIntervalMs !== undefined ? { triggerIntervalMs: result.facts.triggerIntervalMs } : {}),
          osLastRunAt: result.facts.lastRunAt,
          osLastResult: result.facts.lastResult,
          nextAction,
        }
      : { schemaVersion: OP_SCHEMA, operation, ok: false, reason: result.reason, nextAction };
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHumanOp(result, nextAction);
  }
  process.exitCode = result.ok ? 0 : 1;
}

function printHumanStatus(status: ServiceHostStatusDocument): void {
  const s = status.scheduler;
  console.log(`pd service status (${status.platform}) — generated ${status.generatedAt}`);
  console.log(`  pdHome:        ${status.installation.pdHome}`);
  console.log(`  activeRelease: ${status.installation.activeRelease.valid ? status.installation.activeRelease.releaseId ?? 'unknown' : status.installation.activeRelease.reason ?? 'unavailable'}`);
  if (s.available) {
    const enabled = s.enabled === null ? 'unknown' : s.enabled ? 'ENABLED' : 'disabled';
    console.log(`  scheduler:     registered=${s.registered}, ${enabled} (task "${s.taskName}")`);
    if (s.triggerConfiguration !== null) {
      console.log(`  trigger:       every ${s.triggerConfiguration.intervalMs ?? '?'}ms → node "${s.triggerConfiguration.nodePath}" "${s.triggerConfiguration.cliEntry}"`);
    }
    console.log(`  osLastRun:     ${s.osLastRunAt ?? 'none'} (result ${s.osLastResult ?? 'n/a'})`);
  } else {
    console.log(`  scheduler:     UNAVAILABLE — ${s.reason ?? 'unknown'}`);
    if (s.nextAction !== undefined) console.log(`                 next: ${s.nextAction}`);
  }
  if (status.lastRun !== null) {
    console.log(`  lastRun:       ${status.lastRun.mode}/${status.lastRun.outcome} via ${status.lastRun.triggerSource} at ${status.lastRun.startedAt} (${status.lastRun.durationMs}ms)`);
  } else {
    console.log(`  lastRun:       none recorded (${status.lastRunRead})`);
  }
  console.log(`  lastProgressAt: ${status.lastProgressAt ?? 'none yet'}`);
  if (status.workspaces.length > 0) {
    console.log(`  workspaces:`);
    for (const ws of status.workspaces) {
      console.log(`    [${ws.discoveryVerdict}] ${ws.canonicalDir} — owner=${ws.ownerState} (effectiveOwner=${ws.effectiveOwner}); hosts: ${ws.hosts.join(', ') || 'none'}`);
    }
  } else {
    console.log(`  workspaces:    none discovered`);
  }
  if (status.degradedReasons.length > 0) {
    console.log(`  degraded:      ${status.degradedReasons.join('; ')}`);
  }
  console.log(`  next:          ${status.nextAction}`);
}

/** `pd service status` — the unified read-only contract document. */
export async function handleServiceStatus(args: ServiceLifecycleArgs): Promise<void> {
  const result = await composeServiceHostStatus({
    ...(args.pdHome !== undefined ? { trustedHomeDir: args.pdHome } : {}),
  });
  if (result.ok) {
    if (args.json) {
      console.log(JSON.stringify(result.status, null, 2));
    } else {
      printHumanStatus(result.status);
    }
    // A status read with degraded witnesses is still a successful READ —
    // the degradations are data, not a failed command (exit 0). A total
    // refusal (identity unavailable) is the only non-zero path.
    process.exitCode = 0;
    return;
  }
  if (args.json) {
    console.log(JSON.stringify({ schemaVersion: SERVICE_HOST_STATUS_SCHEMA_VERSION, ok: false, reason: result.reason, nextAction: result.nextAction }));
  } else {
    console.error(`pd service status FAILED: ${result.reason}`);
    console.error(`  next: ${result.nextAction}`);
  }
  process.exitCode = 1;
}

