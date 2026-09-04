/**
 * pd health command implementation — Runtime V2 edition.
 *
 * Usage: pd health [--workspace <path>] [--json]
 *
 * Reads workspace/.pd/state.db and workspace/.state/principle_training_state.json
 * to provide Runtime V2 health diagnostics.
 * Uses read models from @principles/core/runtime-v2 (no direct ledger access).
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { PruningReadModel, PainChainReadModel, auditCandidateLedgerConsistency } from '@principles/core/runtime-v2';
import type { PainChainTrace } from '@principles/core/runtime-v2';
import { getLedgerFilePathPublic } from '@principles/core/principle-tree-ledger';
import {
  createEvaluatorRuntimeContext,
  loadHostToolDeclarations,
  resolveWorkspaceHostToolSemantics,
} from '@principles/host-runtime';
import { handleHealthCodex } from './health-codex.js';

interface LastSuccessfulChain {
  painId?: string;
  taskId: string;
  runId: string;
  artifactId: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  latencyMs?: { totalMs?: number };
  failureCategory: string | null;
  checkedAt: string;
}

/**
 * PRI-662: reliability readiness — the post-upgrade validation surface.
 * Reads the SAME durable host declarations and uses the SAME resolver /
 * evaluator runtime-context builder as the production activation and
 * evaluator replay paths, so "replay: ready" here means exactly "the
 * replay the gate will run is constructible" — no parallel truth.
 */
interface ReliabilityHealth {
  registry: {
    status: 'ok' | 'degraded';
    hosts: string[];
    declaredTools: number;
  };
  resolver: 'ready' | 'not_ready';
  replay: 'ready' | 'not_ready';
  reason?: string;
  nextAction?: string;
}

function assessReliability(workspaceDir: string): ReliabilityHealth {
  const loaded = loadHostToolDeclarations(workspaceDir);
  const resolver = resolveWorkspaceHostToolSemantics(workspaceDir);
  const replay = createEvaluatorRuntimeContext({ workspaceDir });

  if (loaded.ok) {
    return {
      registry: {
        status: 'ok',
        hosts: loaded.declarations.map((d) => d.hostKind).sort(),
        declaredTools: loaded.declarations.reduce((n, d) => n + d.mappings.length, 0),
      },
      resolver: resolver.ok ? 'ready' : 'not_ready',
      replay: replay.ok ? 'ready' : 'not_ready',
    };
  }
  // Fresh-install expected state until each host starts once — explicit, never
  // a silent baseline fallback (ERR-114). Informational: the refusal authority
  // lives in the activation/evaluator paths, so the health exit code is
  // unchanged by this section.
  return {
    registry: { status: 'degraded', hosts: [], declaredTools: 0 },
    resolver: 'not_ready',
    replay: 'not_ready',
    reason: loaded.reason,
    nextAction: loaded.nextAction,
  };
}

interface WorkspaceHealth {
  generatedAt: string;
  workspace: string;
  partialHealth?: boolean;
  pdStateDb: { path: string; exists: boolean };
  ledger: { path: string; exists: boolean; totalPrinciples: number; byStatus: Record<string, number> };
  candidates: { total: number; consumed: number; pending: number };
  tasks: { total: number; byStatus: Record<string, number> };
  candidateLedgerConsistency: { status: 'ok' | 'degraded'; missing: number };
  reliability: ReliabilityHealth;
  lastSuccessfulChain?: LastSuccessfulChain;
}

interface HealthOptions {
  workspace?: string;
  json?: boolean;
}

function painChainTraceToLastSuccessfulChain(trace: PainChainTrace): LastSuccessfulChain {
  const totalMs = (trace.latencyMs.painToTask ?? 0)
    + (trace.latencyMs.taskToRun ?? 0)
    + (trace.latencyMs.runToArtifact ?? 0);

  return {
    painId: trace.painId,
    taskId: trace.taskId,
    runId: trace.runId ?? '',
    artifactId: trace.artifactId ?? '',
    candidateIds: trace.candidateIds,
    ledgerEntryIds: trace.ledgerEntryIds,
    latencyMs: { totalMs: totalMs > 0 ? totalMs : undefined },
    failureCategory: trace.failureCategory,
    checkedAt: trace.checkedAt,
  };
}

export async function handleHealth(opts: HealthOptions = {}): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const generatedAt = new Date().toISOString();
  const pdDbPath = path.join(workspaceDir, '.pd', 'state.db');
  const ledgerStateDir = path.join(workspaceDir, '.state');
  const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);

  const pruningModel = new PruningReadModel({ workspaceDir });
  const healthSummary = pruningModel.getHealthSummary();
  const ledgerByStatus = healthSummary.byStatus;

  const { missingLedgerCount } = await auditCandidateLedgerConsistency(workspaceDir);
  const reliability = assessReliability(workspaceDir);

  let candidatesTotal = 0, candidatesConsumed = 0, candidatesPending = 0;
  let tasksTotal = 0;
  const tasksByStatus: Record<string, number> = {};
  let pdDbExists = false;
  let lastSuccessfulChain: LastSuccessfulChain | undefined = undefined;
  let partialHealth = false;

  function buildHealth(): WorkspaceHealth {
    return {
      generatedAt,
      workspace: workspaceDir,
      partialHealth,
      pdStateDb: { path: pdDbPath, exists: pdDbExists },
      ledger: {
        path: ledgerPath,
        exists: fs.existsSync(ledgerPath),
        totalPrinciples: healthSummary.totalPrinciples,
        byStatus: ledgerByStatus,
      },
      candidates: { total: candidatesTotal, consumed: candidatesConsumed, pending: candidatesPending },
      tasks: { total: tasksTotal, byStatus: tasksByStatus },
      candidateLedgerConsistency: {
        status: missingLedgerCount === 0 ? 'ok' : 'degraded',
        missing: missingLedgerCount,
      },
      reliability,
      lastSuccessfulChain,
    };
  }

  function writeHealth(): void {
    const health = buildHealth();

    if (opts.json) {
      console.log(JSON.stringify(health, null, 2));
      if (health.candidateLedgerConsistency.status === 'degraded') process.exit(1);
      return;
    }

    console.log(`generatedAt: ${health.generatedAt}`);
    console.log(`workspace: ${health.workspace}`);
    console.log(`pdStateDb.exists: ${health.pdStateDb.exists}`);
    console.log(`pdStateDb.path: ${health.pdStateDb.path}`);
    console.log(`ledger.exists: ${health.ledger.exists}`);
    console.log(`ledger.path: ${health.ledger.path}`);
    console.log(`ledger.totalPrinciples: ${health.ledger.totalPrinciples}`);
    console.log(`ledger.byStatus: ${JSON.stringify(health.ledger.byStatus)}`);
    console.log(`candidates.total: ${health.candidates.total}`);
    console.log(`candidates.consumed: ${health.candidates.consumed}`);
    console.log(`candidates.pending: ${health.candidates.pending}`);
    console.log(`tasks.total: ${health.tasks.total}`);
    console.log(`tasks.byStatus: ${JSON.stringify(health.tasks.byStatus)}`);
    console.log(`candidateLedgerConsistency.status: ${health.candidateLedgerConsistency.status}`);
    console.log(`candidateLedgerConsistency.missing: ${health.candidateLedgerConsistency.missing}`);
    console.log(`reliability.registry.status: ${health.reliability.registry.status}`);
    console.log(`reliability.registry.hosts: ${health.reliability.registry.hosts.join('+') || '(none)'}`);
    console.log(`reliability.registry.declaredTools: ${health.reliability.registry.declaredTools}`);
    console.log(`reliability.resolver: ${health.reliability.resolver}`);
    console.log(`reliability.replay: ${health.reliability.replay}`);
    if (health.reliability.reason) {
      console.log(`reliability.reason: ${health.reliability.reason}`);
      console.log(`reliability.nextAction: ${health.reliability.nextAction}`);
    }
    if (health.lastSuccessfulChain) {
      console.log('lastSuccessfulChain:');
      console.log(`  taskId:       ${health.lastSuccessfulChain.taskId}`);
      console.log(`  runId:        ${health.lastSuccessfulChain.runId}`);
      console.log(`  artifactId:   ${health.lastSuccessfulChain.artifactId}`);
      console.log(`  candidateIds: ${health.lastSuccessfulChain.candidateIds.join(', ')}`);
      console.log(`  ledgerEntries: ${health.lastSuccessfulChain.ledgerEntryIds.join(', ')}`);
    }
    console.log('');

    if (health.candidateLedgerConsistency.status === 'degraded') {
      console.warn('⚠️  Candidate/ledger consistency is DEGRADED. Run: pd candidate audit --workspace "' + workspaceDir + '" --json');
      console.warn('   To repair missing entries: pd candidate repair --candidate-id <id> --workspace "' + workspaceDir + '" --json');
      process.exit(1);
    }
  }

  if (fs.existsSync(pdDbPath)) {
    pdDbExists = true;
    const db = Database(pdDbPath, { readonly: true });
    try {
      const cRow = db.prepare('SELECT COUNT(*) as total, status FROM principle_candidates GROUP BY status').all() as { total: number; status: string }[];
      for (const r of cRow) {
        candidatesTotal += r.total;
        if (r.status === 'consumed') candidatesConsumed = r.total;
        if (r.status === 'pending') candidatesPending = r.total;
      }

      const tRows = db.prepare('SELECT COUNT(*) as total, status FROM tasks GROUP BY status').all() as { total: number; status: string }[];
      for (const r of tRows) {
        tasksTotal += r.total;
        tasksByStatus[r.status] = r.total;
      }

      const painChainModel = new PainChainReadModel({ workspaceDir });
      try {
        const chain = await painChainModel.getLastSuccessfulChain();
        if (chain) {
          lastSuccessfulChain = painChainTraceToLastSuccessfulChain(chain);
        }
      } catch {
        partialHealth = true;
      } finally {
        await painChainModel.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: could not read full state.db metrics — partial health data: ${msg}`);
      partialHealth = true;
    } finally {
      db.close();
    }
  }

  writeHealth();
}

/**
 * Handlers backing the `pd health` command. Injected so the registration
 * wiring test can exercise the real `registerHealthCommand` without executing
 * real workspace/DB I/O; production uses the defaults.
 */
interface HealthCommandHandlers {
  health?: typeof handleHealth;
  healthCodex?: typeof handleHealthCodex;
}

/**
 * Registers the `pd health` command on a Commander program.
 *
 * cli-7 test-wiring: this is the single registration used by both the CLI
 * entrypoint and the wiring test, so a test exercising it covers the real
 * production command (options + --host dispatch), not a copy.
 *
 * --host accepts only `openclaw` and `codex`; any other value is rejected with
 * a structured reason/nextAction and a non-zero exit (cli-1/cli-2/cli-6). When
 * `--json` is set, the rejection is emitted as exactly one parseable JSON
 * object on stdout.
 */
export function registerHealthCommand(program: Command, handlers: HealthCommandHandlers = {}): void {
  const healthHandler = handlers.health ?? handleHealth;
  const codexHandler = handlers.healthCodex ?? handleHealthCodex;
  program
    .command('health')
    .description('Show health diagnostics for all workspaces')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .option('--host <host>', 'Host to inspect (openclaw|codex). Defaults to openclaw workspace health.')
    .action(async (opts) => {
      const host = opts.host ?? 'openclaw';
      if (host !== 'codex' && host !== 'openclaw') {
        // cli-2: exit-stops — return after setting exitCode.
        if (opts.json) {
          console.log(JSON.stringify({
            ok: false,
            reason: 'invalid_host',
            host,
            nextAction: `Use a supported host: openclaw or codex.`,
          }));
          process.exitCode = 1;
          return;
        }
        console.error(`Invalid --host "${host}". Supported hosts: openclaw, codex.`);
        console.error(`nextAction: run \`pd health --host openclaw\` or \`pd health --host codex\`.`);
        process.exitCode = 1;
        return;
      }
      if (host === 'codex') {
        await codexHandler(opts);
        return;
      }
      await healthHandler(opts);
    });
}
