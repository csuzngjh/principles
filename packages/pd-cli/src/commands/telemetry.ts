/**
 * pd telemetry — Anonymous Product Telemetry v1 control plane
 * (PRI-597, SPEC §40-§43).
 *
 * Consent lives at the machine level (~/.pd/product-telemetry.json via
 * host-runtime); measurement (daily ID, dedup, retry, lock) is
 * workspace-scoped. The release feature flag (anonymous_product_telemetry)
 * is an INDEPENDENT gate read from the resolved workspace's .pd/config.yaml.
 *
 * Commands:
 *   pd telemetry status   — gates, consent, eligibility, bounded export status
 *   pd telemetry enable   — explicit consent (default dry-run; --confirm to write)
 *   pd telemetry disable  — deny consent + delete local identity (default dry-run)
 *   pd telemetry reset    — rotate/delete identity (default dry-run)
 *   pd telemetry preview  — exact outbound payload; never sends
 *
 * --json outputs exactly one parseable object; failures carry reason +
 * nextAction; the telemetry secret is never printed.
 */

import * as path from 'path';
import type { Command } from 'commander';
import {
  createProductTelemetryService,
  PREVIEW_BANNER,
  type ProductTelemetryStatusView,
} from '@principles/host-runtime';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { emitError, emitFlagConflict, emitResult } from '../services/cli-output.js';

// ── Output types ─────────────────────────────────────────────────────────────

export interface TelemetryStatusOutput {
  status: 'ok' | 'degraded' | 'failed';
  command: 'telemetry:status';
  consent: string;
  consentVersion: string;
  hasSecret: boolean;
  flagEnabled: boolean | null;
  flagSource: string | null;
  environmentSuppressed: boolean;
  suppressionReasons: string[];
  canExport: boolean;
  blockers: string[];
  lastAttemptedAt?: string;
  lastSucceededAt?: string;
  lastFailureCode?: string;
  nextRetryAt?: string;
  endpoint: string;
  workspaceDir?: string;
  nextAction?: string;
  reason?: string;
}

export interface TelemetryMutationOutput {
  status: 'ok' | 'failed';
  command: 'telemetry:enable' | 'telemetry:disable' | 'telemetry:reset';
  dryRun: boolean;
  applied: boolean;
  consent?: string;
  /** What the applied/dry-run mutation changes, in plain terms. */
  effect: string;
  reason?: string;
  nextAction?: string;
}

export interface TelemetryPreviewOutput {
  status: 'ok';
  command: 'telemetry:preview';
  banner: string;
  snapshot: Record<string, unknown>;
  gates: {
    flagEnabled: boolean | null;
    consent: string;
    environmentSuppressed: boolean;
    suppressionReasons: string[];
    canExport: boolean;
    blockers: string[];
  };
  notes: string[];
  secretEphemeral: boolean;
  nextAction?: string;
}

// ── Text formatting ──────────────────────────────────────────────────────────

function formatStatusText(output: TelemetryStatusOutput): string {
  const lines: string[] = [];
  lines.push('PD Anonymous Product Telemetry');
  lines.push(`consent: ${output.consent} (v${output.consentVersion})`);
  lines.push(`feature flag: ${output.flagEnabled === null ? 'unknown (no workspace)' : output.flagEnabled ? 'on' : 'off'}${output.flagSource ? ` (${output.flagSource})` : ''}`);
  lines.push(`environment: ${output.environmentSuppressed ? `suppressed (${output.suppressionReasons.join(', ')})` : 'eligible'}`);
  lines.push(`can export: ${output.canExport ? 'yes' : `no (${output.blockers.join(', ')})`}`);
  lines.push(`local secret: ${output.hasSecret ? 'present' : 'absent'}`);
  if (output.lastAttemptedAt) lines.push(`last attempted: ${output.lastAttemptedAt}`);
  if (output.lastSucceededAt) lines.push(`last succeeded: ${output.lastSucceededAt}`);
  if (output.lastFailureCode) lines.push(`last failure: ${output.lastFailureCode}`);
  if (output.nextRetryAt) lines.push(`next retry: ${output.nextRetryAt}`);
  lines.push(`collector: ${output.endpoint}`);
  lines.push('');
  lines.push('Collects: PD version, anonymous tri-state milestones (true/false/unavailable), coarse reliability.');
  lines.push('Never collects: conversations, code/files, Principle content, Pain content.');
  if (output.nextAction) lines.push(`Next action: ${output.nextAction}`);
  return lines.join('\n');
}

function formatMutationText(output: TelemetryMutationOutput): string {
  const lines: string[] = [];
  lines.push(`PD telemetry ${output.command.split(':')[1]} ${output.applied ? 'applied' : '(dry-run — not applied)'}`);
  lines.push(output.effect);
  if (!output.applied) lines.push('Re-run with --confirm to apply.');
  if (output.nextAction) lines.push(`Next action: ${output.nextAction}`);
  return lines.join('\n');
}

function formatPreviewText(output: TelemetryPreviewOutput): string {
  const lines: string[] = [];
  lines.push(output.secretEphemeral
    ? 'PD Telemetry Preview — exact payload shape (dailyTelemetryId is provisional until enabled)'
    : 'PD Telemetry Preview — exact outbound payload');
  lines.push('');
  lines.push(JSON.stringify(output.snapshot, null, 2));
  lines.push('');
    lines.push(`Collected: PD version, anonymous tri-state milestones (true/false/unavailable), coarse reliability.`);
  lines.push(`Never collected: conversations, code/files, Principle content, Pain content.`);
  lines.push(`Gates: flag=${output.gates.flagEnabled ?? 'unresolved'} consent=${output.gates.consent} environment=${output.gates.environmentSuppressed ? 'suppressed' : 'eligible'} → wouldExport=${output.gates.canExport}`);
  if (output.notes.length > 0) {
    lines.push('Notes:');
    for (const note of output.notes) lines.push(`  [!] ${note}`);
  }
  lines.push('');
  lines.push(`>>> ${PREVIEW_BANNER}`);
  return lines.join('\n');
}

// ── Shared helpers ───────────────────────────────────────────────────────────

interface TelemetryOptions {
  workspace?: string;
  json?: boolean;
  confirm?: boolean;
  dryRun?: boolean;
}

function resolveWorkspaceOrNull(opts: TelemetryOptions): string | undefined {
  if (opts.workspace) return path.resolve(opts.workspace);
  try {
    return resolveWorkspaceDir();
  } catch {
    // Consent/identity commands are machine-scope; a workspace is only needed
    // to report the workspace-scope flag gate. Absent workspace = flag unknown.
    return undefined;
  }
}

function makeService() {
  return createProductTelemetryService({});
}

function checkDryRunConfirmMutex(opts: TelemetryOptions, json: boolean): boolean {
  if (opts.dryRun === true && opts.confirm === true) {
    process.exitCode = emitFlagConflict({ json });
    return false;
  }
  return true;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function handleTelemetryStatus(opts: TelemetryOptions): Promise<void> {
  const service = makeService();
  const workspaceDir = resolveWorkspaceOrNull(opts);
  const result = service.getStatus(workspaceDir);
  if (!result.ok) {
    process.exitCode = emitError(new Error(result.reason), { json: opts.json ?? false, nextAction: result.nextAction });
    return;
  }
  const view: ProductTelemetryStatusView = result.view;
  const output: TelemetryStatusOutput = {
    status: 'ok',
    command: 'telemetry:status',
    consent: view.consent,
    consentVersion: view.consentVersion,
    hasSecret: view.hasSecret,
    flagEnabled: view.flagEnabled,
    flagSource: view.flagSource,
    environmentSuppressed: view.environmentSuppressed,
    suppressionReasons: view.suppressionReasons,
    canExport: view.canExport,
    blockers: view.blockers,
    ...(view.lastAttemptedAt !== undefined ? { lastAttemptedAt: view.lastAttemptedAt } : {}),
    ...(view.lastSucceededAt !== undefined ? { lastSucceededAt: view.lastSucceededAt } : {}),
    ...(view.lastFailureCode !== undefined ? { lastFailureCode: view.lastFailureCode } : {}),
    ...(view.nextRetryAt !== undefined ? { nextRetryAt: view.nextRetryAt } : {}),
    endpoint: view.endpoint,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(view.nextAction !== undefined ? { nextAction: view.nextAction } : {}),
  };
  emitResult(output, { json: opts.json ?? false, formatText: formatStatusText });
}

type MutationKind = 'enable' | 'disable' | 'reset';

const MUTATION_EFFECTS: Record<MutationKind, string> = {
  enable: 'Records explicit telemetry consent (granted) and creates a local random secret for daily unlinkable IDs. Nothing is exported unless the feature flag and environment eligibility also allow it.',
  disable: 'Records consent denied and deletes the local telemetry secret and export status. Future telemetry export requests: 0.',
  reset: 'Deletes the local telemetry secret and export status. If consent remains granted, a fresh secret is generated — future daily IDs are unrelated to previous ones.',
};

const MUTATION_NEXT_ACTIONS: Record<MutationKind, string> = {
  enable: 'Run "pd telemetry preview" to inspect the exact outbound payload.',
  disable: 'Telemetry is fully off. Re-enable anytime with "pd telemetry enable --confirm".',
  reset: 'Previous daily IDs can no longer be derived. See "pd telemetry status".',
};

export async function handleTelemetryMutation(kind: MutationKind, opts: TelemetryOptions): Promise<void> {
  const json = opts.json ?? false;
  if (!checkDryRunConfirmMutex(opts, json)) return;
  const applied = opts.confirm === true;
  const service = makeService();

  if (!applied) {
    const output: TelemetryMutationOutput = {
      status: 'ok',
      command: `telemetry:${kind}`,
      dryRun: true,
      applied: false,
      effect: MUTATION_EFFECTS[kind],
      nextAction: 'Re-run with --confirm to apply.',
    };
    emitResult(output, { json, formatText: formatMutationText });
    return;
  }

  const result =
    kind === 'enable' ? service.enable() : kind === 'disable' ? service.disable() : service.reset();
  if (!result.ok) {
    process.exitCode = emitError(new Error(result.reason), { json, nextAction: result.nextAction });
    return;
  }
  const output: TelemetryMutationOutput = {
    status: 'ok',
    command: `telemetry:${kind}`,
    dryRun: false,
    applied: true,
    consent: result.consent,
    effect: MUTATION_EFFECTS[kind],
    nextAction: MUTATION_NEXT_ACTIONS[kind],
  };
  emitResult(output, { json, formatText: formatMutationText });
}

export async function handleTelemetryPreview(opts: TelemetryOptions): Promise<void> {
  let workspaceDir: string;
  if (opts.workspace) {
    workspaceDir = path.resolve(opts.workspace);
  } else {
    try {
      workspaceDir = resolveWorkspaceDir();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.exitCode = emitError(new Error(`workspace_unresolvable: ${message}`), {
        json: opts.json ?? false,
        nextAction: 'Pass --workspace <path> or run from a PD workspace',
      });
      return;
    }
  }
  const service = makeService();
  const preview = service.preview(workspaceDir);
  const output: TelemetryPreviewOutput = {
    status: 'ok',
    command: 'telemetry:preview',
    banner: PREVIEW_BANNER,
    snapshot: preview.snapshot,
    gates: {
      flagEnabled: preview.gates.flagEnabled,
      consent: preview.gates.consent,
      environmentSuppressed: preview.gates.environmentSuppressed,
      suppressionReasons: preview.gates.suppressionReasons,
      canExport: preview.gates.canExport,
      blockers: preview.gates.blockers,
    },
    notes: preview.notes,
    secretEphemeral: preview.secretEphemeral,
  };
  emitResult(output, { json: opts.json ?? false, formatText: formatPreviewText });
}

// ── Registration (used by index.ts and wiring tests) ─────────────────────────

export function registerTelemetryCommand(parent: Command): Command {
  const telemetry = parent
    .command('telemetry')
    .description('Anonymous product telemetry control (opt-in, privacy-preserving)');

  telemetry
    .command('status')
    .description('Show telemetry consent, gates, eligibility, and bounded export status')
    .option('-w, --workspace <path>', 'Workspace directory (for the feature-flag gate)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleTelemetryStatus({ workspace: opts.workspace, json: opts.json });
    });

  telemetry
    .command('enable')
    .description('Grant explicit telemetry consent (default OFF until enabled)')
    .option('--dry-run', 'Show the effect without writing (default)')
    .option('--confirm', 'Apply the consent change (required to write)')
    .option('-w, --workspace <path>', 'Workspace directory (reporting only)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleTelemetryMutation('enable', { workspace: opts.workspace, json: opts.json, confirm: opts.confirm, dryRun: opts.dryRun });
    });

  telemetry
    .command('disable')
    .description('Deny consent and delete the local telemetry identity (zero future exports)')
    .option('--dry-run', 'Show the effect without writing (default)')
    .option('--confirm', 'Apply the change (required to write)')
    .option('-w, --workspace <path>', 'Workspace directory (reporting only)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleTelemetryMutation('disable', { workspace: opts.workspace, json: opts.json, confirm: opts.confirm, dryRun: opts.dryRun });
    });

  telemetry
    .command('reset')
    .description('Delete and rotate the local telemetry identity (unlink from previous daily IDs)')
    .option('--dry-run', 'Show the effect without writing (default)')
    .option('--confirm', 'Apply the change (required to write)')
    .option('-w, --workspace <path>', 'Workspace directory (reporting only)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleTelemetryMutation('reset', { workspace: opts.workspace, json: opts.json, confirm: opts.confirm, dryRun: opts.dryRun });
    });

  telemetry
    .command('preview')
    .description('Show the exact outbound telemetry payload (nothing is sent)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleTelemetryPreview({ workspace: opts.workspace, json: opts.json });
    });

  return telemetry;
}
