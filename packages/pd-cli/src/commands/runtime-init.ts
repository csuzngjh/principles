/**
 * pd runtime init — Initialize all PD SQLite databases for a workspace.
 *
 * Creates state.db, trajectory.db, and subagent_workflows.db with full schema
 * (tables + indexes + views + migrations). Idempotent: safe to run on existing
 * workspaces (all CREATE statements use IF NOT EXISTS).
 *
 * Output contract (cli-1 strict-json, cli-4 dry-run/confirm mutex, cli-6 nextAction):
 * - Default mode is --dry-run (no writes); use --confirm to actually initialize.
 * - --json emits a single parseable JSON object on stdout.
 * - Failures emit { ok: false, reason, nextAction } with exit code 1.
 *
 * ERR refs:
 * - ERR-001/ERR-005: no `as` casts; DB rows typed via type guards
 * - ERR-002: degraded paths include reason + nextAction
 * - ERR-009/ERR-010: missing required fields fail loud
 * - ERR-014: safe JSON.stringify on known output shapes
 */

import * as path from 'path';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { SchemaConformanceReadModel } from '@principles/core/runtime-v2';
import { initTrajectorySchema, initWorkflowSchema } from 'principles-disciple';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { emitResult, emitFlagConflict, emitError } from '../services/cli-output.js';

// ── Output types ─────────────────────────────────────────────────────────────

export interface DatabaseInitResult {
  name: string;
  path: string;
  tables: string[];
  status: 'initialized' | 'verified' | 'skipped' | 'failed';
  warnings: string[];
}

export interface RuntimeInitOutput {
  ok: boolean;
  mode: 'dry-run' | 'confirm';
  workspace: string;
  databases: DatabaseInitResult[];
  warnings: string[];
  reason?: string;
  nextAction?: string;
}

// ── Build output ─────────────────────────────────────────────────────────────

const DB_NAMES = {
  state: 'state.db',
  trajectory: 'trajectory.db',
  workflow: 'subagent_workflows.db',
} as const;

export function buildRuntimeInitOutput(workspaceDir: string, confirm: boolean): RuntimeInitOutput {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const warnings: string[] = [];
  const databases: DatabaseInitResult[] = [];

  // 1. state.db (via SqliteConnection, which triggers initSchema + migrateSchema)
  const stateDbPath = path.join(resolvedWorkspace, '.pd', 'state.db');
  if (!confirm) {
    // dry-run: report what would be initialized without touching disk
    databases.push({
      name: DB_NAMES.state,
      path: stateDbPath,
      tables: ['tasks', 'runs', 'artifacts', 'commits', 'principle_candidates',
        'pi_artifacts', 'approvals', 'activations', 'intent_decisions', 'schema_version'],
      status: 'skipped',
      warnings: [],
    });
  } else {
    try {
      const conn = new SqliteConnection({ workspaceDir: resolvedWorkspace, readonly: false });
      try {
        conn.getDb(); // triggers initSchema + migrateSchema
        const connWarnings = conn.getSchemaInitWarnings();
        if (connWarnings.length > 0) {
          warnings.push(...connWarnings.map(w => `${DB_NAMES.state}: ${w}`));
        }
        databases.push({
          name: DB_NAMES.state,
          path: stateDbPath,
          tables: ['tasks', 'runs', 'artifacts', 'commits', 'principle_candidates',
            'pi_artifacts', 'approvals', 'activations', 'intent_decisions', 'schema_version'],
          status: 'initialized',
          warnings: connWarnings,
        });
      } finally {
        conn.close();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      databases.push({
        name: DB_NAMES.state,
        path: stateDbPath,
        tables: [],
        status: 'failed',
        warnings: [reason],
      });
      return {
        ok: false,
        mode: 'confirm',
        workspace: resolvedWorkspace,
        databases,
        warnings,
        reason: `state.db initialization failed: ${reason}`,
        nextAction: 'Check workspace directory permissions and disk space, then retry.',
      };
    }
  }

  // 2. trajectory.db (via initTrajectorySchema)
  if (!confirm) {
    databases.push({
      name: DB_NAMES.trajectory,
      path: path.join(resolvedWorkspace, '.state', 'trajectory.db'),
      tables: ['schema_version', 'ingest_checkpoint', 'sessions', 'assistant_turns',
        'user_turns', 'tool_calls', 'pain_events', 'gate_blocks', 'trust_changes',
        'principle_events', 'task_outcomes', 'correction_samples', 'sample_reviews',
        'exports_audit', 'evolution_tasks', 'evolution_events'],
      status: 'skipped',
      warnings: [],
    });
  } else {
    try {
      const result = initTrajectorySchema(resolvedWorkspace);
      if (result.warnings.length > 0) {
        warnings.push(...result.warnings.map(w => `${DB_NAMES.trajectory}: ${w}`));
      }
      databases.push({
        name: DB_NAMES.trajectory,
        path: path.join(resolvedWorkspace, '.state', 'trajectory.db'),
        tables: result.tables,
        status: 'initialized',
        warnings: result.warnings,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      databases.push({
        name: DB_NAMES.trajectory,
        path: path.join(resolvedWorkspace, '.state', 'trajectory.db'),
        tables: [],
        status: 'failed',
        warnings: [reason],
      });
      return {
        ok: false,
        mode: 'confirm',
        workspace: resolvedWorkspace,
        databases,
        warnings,
        reason: `trajectory.db initialization failed: ${reason}`,
        nextAction: 'Check workspace directory permissions and disk space, then retry.',
      };
    }
  }

  // 3. subagent_workflows.db (via initWorkflowSchema)
  if (!confirm) {
    databases.push({
      name: DB_NAMES.workflow,
      path: path.join(resolvedWorkspace, '.state', 'subagent_workflows.db'),
      tables: ['schema_version', 'subagent_workflows', 'subagent_workflow_events'],
      status: 'skipped',
      warnings: [],
    });
  } else {
    try {
      const result = initWorkflowSchema(resolvedWorkspace);
      if (result.warnings.length > 0) {
        warnings.push(...result.warnings.map(w => `${DB_NAMES.workflow}: ${w}`));
      }
      databases.push({
        name: DB_NAMES.workflow,
        path: path.join(resolvedWorkspace, '.state', 'subagent_workflows.db'),
        tables: result.tables,
        status: 'initialized',
        warnings: result.warnings,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      databases.push({
        name: DB_NAMES.workflow,
        path: path.join(resolvedWorkspace, '.state', 'subagent_workflows.db'),
        tables: [],
        status: 'failed',
        warnings: [reason],
      });
      return {
        ok: false,
        mode: 'confirm',
        workspace: resolvedWorkspace,
        databases,
        warnings,
        reason: `subagent_workflows.db initialization failed: ${reason}`,
        nextAction: 'Check workspace directory permissions and disk space, then retry.',
      };
    }
  }

  // Verify state.db schema conformance after initialization (confirm mode only)
  if (confirm) {
    try {
      const conformance = new SchemaConformanceReadModel({ workspaceDir: resolvedWorkspace });
      const result = conformance.check();
      if (result.overallStatus === 'error') {
        warnings.push(`state.db schema conformance check returned 'error' — some tables or indexes may be missing`);
      }
    } catch (err) {
      // Non-fatal: schema conformance check is a post-verification step
      warnings.push(`schema conformance verification skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: true,
    mode: confirm ? 'confirm' : 'dry-run',
    workspace: resolvedWorkspace,
    databases,
    warnings,
  };
}

// ── Text formatting ──────────────────────────────────────────────────────────

function formatTextOutput(output: RuntimeInitOutput): string {
  const lines: string[] = [];

  lines.push('PD Runtime Init');
  lines.push(`mode: ${output.mode}`);
  lines.push(`workspace: ${output.workspace}`);
  lines.push('');

  for (const db of output.databases) {
    const icon = db.status === 'initialized' ? '[+]' :
                 db.status === 'verified' ? '[v]' :
                 db.status === 'skipped' ? '[ ]' : '[x]';
    lines.push(`${icon} ${db.name} (${db.status})`);
    lines.push(`    path: ${db.path}`);
    if (db.tables.length > 0) {
      lines.push(`    tables: ${db.tables.length} (${db.tables.slice(0, 5).join(', ')}${db.tables.length > 5 ? ', ...' : ''})`);
    }
    for (const w of db.warnings) {
      lines.push(`    warning: ${w}`);
    }
  }

  if (output.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of output.warnings) {
      lines.push(`  [!] ${w}`);
    }
  }

  if (!output.ok && output.reason) {
    lines.push('');
    lines.push(`Error: ${output.reason}`);
    if (output.nextAction) {
      lines.push(`→ ${output.nextAction}`);
    }
  }

  return lines.join('\n');
}

// ── CLI handler ──────────────────────────────────────────────────────────────

export interface RuntimeInitOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

export async function handleRuntimeInit(opts: RuntimeInitOptions): Promise<void> {
  // cli-4: --dry-run and --confirm are mutually exclusive
  if (opts.dryRun && opts.confirm) {
    process.exitCode = emitFlagConflict({ json: opts.json ?? false });
    return;
  }

  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  // Default is dry-run; --confirm opts in to actual initialization
  const confirm = opts.confirm === true;

  try {
    const output = buildRuntimeInitOutput(workspaceDir, confirm);
    emitResult(output, { json: opts.json ?? false, formatText: formatTextOutput });

    if (!output.ok) {
      process.exitCode = 1; // cli-2: set exit code, no process.exit()
    }
  } catch (err) {
    process.exitCode = emitError(err, {
      json: opts.json ?? false,
      nextAction: 'Check workspace directory and permissions, then retry.',
    });
  }
}

