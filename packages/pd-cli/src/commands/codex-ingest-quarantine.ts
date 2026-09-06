/**
 * pd codex ingest quarantine — audited recovery for permanently invalid
 * governance observations (Codex Governance Closure Slice D, PRI-625;
 * SPEC rev 2 §15).
 *
 * Contract (§15 verbatim requirements):
 * - dry run by DEFAULT; `--confirm` is required to actually quarantine;
 * - the quarantine record captures digest, reason, operator, timestamp, and
 *   the neighbor gap;
 * - the Codex transcript is NEVER edited or read (only the workspace
 *   trajectory.db opens — asserted by the store tests via a port spy);
 * - promoted (Owner-decided) evidence is refused;
 * - --json emits exactly one documented object; failed validation mutates
 *   nothing.
 *
 * CLI gate compliance: cli-1 (single JSON object), cli-2 (exit paths stop),
 * cli-5 (failed validation performs no mutation), cli-6 (reason + nextAction
 * on every refusal).
 */
import * as os from 'os';
import { quarantineGovernanceObservation } from '@principles/host-runtime';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface CodexIngestQuarantineOptions {
  workspace?: string;
  rollout?: string;
  record?: string;
  reason?: string;
  operator?: string;
  confirm?: boolean;
  json?: boolean;
}

function defaultOperator(): string {
  try {
    return os.userInfo().username.slice(0, 40) || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function handleCodexIngestQuarantine(options: CodexIngestQuarantineOptions): Promise<void> {
  const generatedAt = new Date().toISOString();

  const refuse = (reason: string, nextAction: string): void => {
    const report = { generatedAt, host: 'codex', op: 'quarantine', status: 'refused', confirmed: options.confirm === true, reason, nextAction };
    if (options.json) {
      console.log(JSON.stringify(report));
    } else {
      console.log('Codex observation quarantine');
      console.log(`  status: ${report.status}`);
      console.log(`  reason: ${reason}`);
      console.log(`  next action: ${nextAction}`);
    }
    process.exitCode = 1;
  };

  const rollout = typeof options.rollout === 'string' ? options.rollout.trim() : '';
  if (rollout.length === 0) {
    refuse('rollout_required', 'Pass --rollout <id> (the rollout identity whose record is invalid).');
    return;
  }
  const recordRaw = typeof options.record === 'string' ? options.record.trim() : '';
  const recordId = /^\d+$/.test(recordRaw) ? Number.parseInt(recordRaw, 10) : Number.NaN;
  if (!Number.isInteger(recordId) || recordId <= 0) {
    refuse('record_required', 'Pass --record <id> with the numeric governance_observations.id to quarantine.');
    return;
  }
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (reason.length === 0 || reason.length > 200) {
    refuse('reason_required', 'Pass --reason "<why>" (1-200 chars) describing why the record is permanently invalid.');
    return;
  }
  const operator = (typeof options.operator === 'string' && options.operator.trim().length > 0 ? options.operator.trim() : defaultOperator()).slice(0, 80);

  const result = quarantineGovernanceObservation({
    workspaceDir: resolveWorkspaceDir(options.workspace),
    hostKind: 'codex',
    rolloutIdentity: rollout,
    recordId,
    reason,
    operator,
    confirm: options.confirm === true,
  });

  if (!result.ok) {
    refuse(result.reason, result.nextAction);
    return;
  }

  const report = {
    generatedAt,
    host: 'codex',
    op: 'quarantine',
    status: 'ok',
    dryRun: result.dryRun,
    alreadyQuarantined: result.alreadyQuarantined,
    confirmed: options.confirm === true,
    record: result.record,
    ...(result.dryRun ? { nextAction: 'Dry run only — nothing was mutated. Re-run with --confirm to quarantine this record.' } : {}),
    transcriptTouched: false,
  };
  if (options.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log('Codex observation quarantine');
    console.log(`  status:      ${result.dryRun ? 'dry-run' : 'quarantined'}`);
    if (result.alreadyQuarantined) console.log('  note:        record was already quarantined (idempotent)');
    console.log(`  record id:   ${result.record.id} (${result.record.kind}, ${result.record.retentionClass})`);
    console.log(`  logical key: ${result.record.logicalKey}`);
    console.log(`  observed at: ${result.record.observedAt}`);
    console.log(`  digest:      ${result.record.digest}`);
    console.log(`  gap:         ${result.record.gap}`);
    if (result.dryRun) console.log('  next action: Dry run only — nothing was mutated. Re-run with --confirm to quarantine this record.');
  }
}
