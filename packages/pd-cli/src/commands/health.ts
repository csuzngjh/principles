/**
 * pd health command implementation — Runtime edition.
 *
 * Usage: pd health [--workspace <path>] [--json]
 *
 * Reads workspace/.pd/state.db and workspace/.state/principle_training_state.json
 * to provide Runtime health diagnostics.
 * Uses read models from @principles/core/runtime (no direct ledger access).
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { PruningReadModel, PainChainReadModel, auditCandidateLedgerConsistency } from '@principles/core/runtime';
import type { PainChainTrace } from '@principles/core/runtime';
import { getLedgerFilePathPublic } from '@principles/core/principle-tree-ledger';
import {
  createEvaluatorRuntimeContext,
  loadHostToolDeclarations,
  resolveWorkspaceHostToolSemantics,
} from '@principles/host-runtime';
import { handleHealthCodex } from './health-codex.js';
import {
  assessMcpHealth,
  formatMcpHealthLines,
  resolveHealthHome,
  selectMcpHostForWorkspace,
  formatMcpHostSelectionLine,
} from './health-mcp.js';
import type { McpHealthSection, McpHostSelection } from './health-mcp.js';
import { assessWorkbuddyHostFacts, formatWorkbuddyHostFactLines } from './health-workbuddy.js';
import type { WorkbuddyHostFacts } from './health-workbuddy.js';
import { assessIngestionHealth, formatIngestionHealthLines } from './health-ingestion.js';
import type { IngestionHealthSection } from './health-ingestion.js';

/**
 * MCP statuses that describe an absent host rather than a broken one. Every
 * other non-HEALTHY status is a real install/config defect and must fail
 * `pd health` by exit code (PRI-1130).
 */
const MCP_EXIT_NEUTRAL_STATUSES: ReadonlySet<McpHealthSection['status']> = new Set([
  'HEALTHY',
  'HOST_NOT_FOUND',
  'NOT_INSTALLED',
]);

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
  /**
   * PRI-1071 Gate 4 / PRI-1130: shared MCP lifecycle diagnostics (binding,
   * install, version, host config, declared-entry integrity, restart) for the
   * selected host. Read-only and independent of the ledger, but a broken host
   * install IS a health failure: a non-HEALTHY MCP section sets exit code 1 so
   * exit-code-only automation cannot mistake a missing payload file for success.
   * HOST_NOT_FOUND / NOT_INSTALLED stay exit-code neutral (not a defect).
   */
  mcp: McpHealthSection;
  /**
   * PRI-1186: how the MCP host was chosen. Without --host the serving
   * binding (mcp-binding.json workspaceDir) selects the host; an unresolvable
   * or ambiguous workspace keeps the openclaw default and says so here, so
   * the MCP section is never silently about the wrong host.
   */
  mcpHostSelection: McpHostSelection;
  /**
   * PRI-939 Option A: last semantic reuse evaluation degradation read from the
   * workspace's own critical-events.jsonl (same durable sink the gate writes).
   * Read-only summary — the authority stays the event file itself.
   */
  reuseEvaluation: ReuseEvaluationHealth;
  lastSuccessfulChain?: LastSuccessfulChain;
  /**
   * 2026-11-07 (WorkBuddy host-fact truthfulness): the FOUR independent host
   * facts — plugin registration, plugin enablement, governance flag, runtime
   * truthfulness — present ONLY for `pd health --host workbuddy`. Read-only;
   * none of the facts is inferred from the MCP section, and the runtime
   * boundary (probe never performed, model tool call not verified) is stated
   * explicitly instead of implied.
   */
  workbuddyHostFacts?: WorkbuddyHostFacts;
  /**
   * PRI-1171 ticket ⑦: unified three-host conversation-ingestion health
   * (SPEC v0.2 §6, TD §9). Host-neutral section embedded in the main report;
   * the `--host codex` path keeps its own detailed governance report. Every
   * degraded field carries reason + nextAction (rc-9); openclaw is an
   * explicit `not_wired` row until P3 ticket ⑨ wires its live bypass.
   */
  ingestion: IngestionHealthSection;
}

interface ReuseEvaluationHealth {
  criticalEventsFile: string;
  lastUnavailable?: { at: string; candidateId?: string; reason: string };
}

function assessReuseEvaluationTelemetry(workspaceDir: string): ReuseEvaluationHealth {
  const criticalEventsFile = path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
  try {
    if (!fs.existsSync(criticalEventsFile)) return { criticalEventsFile };
    const lines = fs.readFileSync(criticalEventsFile, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i];
      if (raw === undefined) continue;
      const line = raw.trim();
      if (line === '') continue;
      let evt: unknown;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // skip malformed lines — the sink appends best-effort
      }
      if (
        evt && typeof evt === 'object'
        && (evt as { eventType?: unknown }).eventType === 'reuse_evaluation_unavailable'
      ) {
        // rc-1/rc-3 (PRI-939 review fix, Codex P1): the JSONL is append-only
        // runtime data — a truncated/corrupt record must be SKIPPED, never
        // reported as an incident with empty fields. Require the fields the
        // only producer (the reuse gate) always writes.
        const { timestamp: rawTimestamp, payload } = evt as { timestamp?: unknown; payload?: Record<string, unknown> };
        const { candidateId: rawCandidateId, reason: rawReason } = payload ?? {};
        if (typeof rawTimestamp !== 'string' || rawTimestamp === '') continue;
        if (typeof rawReason !== 'string' || rawReason === '') continue;
        const candidateId = typeof rawCandidateId === 'string' ? rawCandidateId : undefined;
        return {
          criticalEventsFile,
          lastUnavailable: {
            at: rawTimestamp,
            ...(candidateId !== undefined ? { candidateId } : {}),
            reason: rawReason.slice(0, 200),
          },
        };
      }
    }
    return { criticalEventsFile };
  } catch {
    // Non-fatal: health must not fail because an optional telemetry file is
    // unreadable; the section reports the path so the Owner can inspect it.
    return { criticalEventsFile };
  }
}

interface HealthOptions {
  workspace?: string;
  json?: boolean;
  /** MCP diagnostics host. When omitted, the workspace's serving binding selects it (PRI-1186). */
  host?: 'openclaw' | 'workbuddy';
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
  const healthHome = resolveHealthHome();
  const mcpHostSelection: McpHostSelection = opts.host !== undefined
    ? { host: opts.host, selectedBy: 'explicit-flag', matchedHosts: [] }
    : selectMcpHostForWorkspace(workspaceDir, { homeDir: healthHome.homeDir });
  const mcp = assessMcpHealth({ host: mcpHostSelection.host, homeDir: healthHome.homeDir });
  // "MCP not installed" and "the PD home could not be resolved" are different
  // facts; surface the second one instead of letting the first stand in for it.
  if (healthHome.unresolvedReason) {
    mcp.reason = healthHome.unresolvedReason;
    mcp.nextAction = 'Fix the PD home inputs (PD_EXPERIMENT_ROOT / PD_WORKSPACE_DIR or OPENCLAW_STATE_DIR), then rerun pd health.';
  }
  // 2026-11-07: the four host facts ride along ONLY for the workbuddy host —
  // they are WorkBuddy-specific truths, never an openclaw/codex section.
  const workbuddyHostFacts = opts.host === 'workbuddy' ? assessWorkbuddyHostFacts() : undefined;
  // PRI-1171 ticket ⑦: host-neutral three-host ingestion section (read-only;
  // checkpoint/observation reads + transcript SIZE stats, never content).
  // Awaited: host adapters lazy-load inside (PRI-1061 host-agnostic startup).
  const ingestion = await assessIngestionHealth({ workspaceDir });

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
      mcp,
      mcpHostSelection,
      reuseEvaluation: assessReuseEvaluationTelemetry(workspaceDir),
      lastSuccessfulChain,
      ...(workbuddyHostFacts !== undefined ? { workbuddyHostFacts } : {}),
      ingestion,
    };
  }

  function writeHealth(): void {
    const health = buildHealth();
    const mcpFailed = !MCP_EXIT_NEUTRAL_STATUSES.has(health.mcp.status);

    if (opts.json) {
      console.log(JSON.stringify(health, null, 2));
      if (health.candidateLedgerConsistency.status === 'degraded' || mcpFailed) process.exit(1);
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
    console.log(formatMcpHostSelectionLine(health.mcpHostSelection));
    for (const line of formatMcpHealthLines(health.mcp)) console.log(line);
    // 2026-11-07: the four independent WorkBuddy facts — printed AFTER the
    // MCP block so a full MCP section visibly does NOT imply a registered or
    // enabled plugin (install ≠ enable ≠ governance ≠ MCP ≠ runtime).
    if (health.workbuddyHostFacts !== undefined) {
      for (const line of formatWorkbuddyHostFactLines(health.workbuddyHostFacts)) console.log(line);
    }
    // PRI-1171 ticket ⑦: three-host ingestion health — degraded fields carry
    // their nextAction inline (rc-9), openclaw prints its explicit not_wired row.
    for (const line of formatIngestionHealthLines(health.ingestion)) console.log(line);
    console.log(`reuseEvaluation.criticalEventsFile: ${health.reuseEvaluation.criticalEventsFile}`);
    if (health.reuseEvaluation.lastUnavailable) {
      console.log('reuseEvaluation.lastUnavailable:');
      console.log(`  at:          ${health.reuseEvaluation.lastUnavailable.at}`);
      if (health.reuseEvaluation.lastUnavailable.candidateId !== undefined) {
        console.log(`  candidateId: ${health.reuseEvaluation.lastUnavailable.candidateId}`);
      }
      console.log(`  reason:      ${health.reuseEvaluation.lastUnavailable.reason}`);
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
    if (mcpFailed) {
      console.warn(`⚠️  MCP host health is ${health.mcp.status} (${health.mcp.reason ?? 'unspecified'}).`);
      if (health.mcp.nextAction !== undefined) console.warn(`   nextAction: ${health.mcp.nextAction}`);
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
    .option('--host <host>', 'Host to inspect (openclaw|codex|workbuddy). Defaults to the host whose mcp-binding.json serves the workspace.')
    .action(async (opts) => {
      const {host} = opts;
      if (host !== undefined && host !== 'codex' && host !== 'openclaw' && host !== 'workbuddy') {
        // cli-2: exit-stops — return after setting exitCode.
        if (opts.json) {
          console.log(JSON.stringify({
            ok: false,
            reason: 'invalid_host',
            host,
            nextAction: `Use a supported host: openclaw, codex or workbuddy.`,
          }));
          process.exitCode = 1;
          return;
        }
        console.error(`Invalid --host "${host}". Supported hosts: openclaw, codex, workbuddy.`);
        console.error(`nextAction: run \`pd health --host openclaw\`, \`pd health --host codex\` or \`pd health --host workbuddy\`.`);
        process.exitCode = 1;
        return;
      }
      if (host === 'codex') {
        await codexHandler(opts);
        return;
      }
      // PRI-1186: without --host, handleHealth selects the serving host from
      // the workspace's bindings; undefined keeps that choice downstream.
      await healthHandler({ ...opts, host });
    });
}
