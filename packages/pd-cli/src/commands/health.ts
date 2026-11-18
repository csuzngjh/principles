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
import { assessConsole, type ConsoleHealthSection } from './health-console.js';
import {
  createEvaluatorRuntimeContext,
  loadHostToolDeclarations,
  resolveWorkspaceHostToolSemantics,
  readDegradedEnforcement,
} from '@principles/host-runtime';
import type { DegradedEnforcementReading } from '@principles/host-runtime';
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
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';

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

// ─── Derived agent acceptance summary (ERR-182: each clause from its own witness) ──

export interface HealthSummaryItem {
  status: 'ok' | 'attention' | 'error' | 'not_applicable';
  detail?: string;
  nextAction?: string;
}

export interface HealthSummary {
  overall: 'healthy' | 'attention' | 'error';
  /** The CLI answering this command IS the witness (self-evident, no probe). */
  cli: { status: 'ok'; note: string };
  mcp: HealthSummaryItem;
  console: HealthSummaryItem;
  skills: HealthSummaryItem;
  /** Whether any host has started and declared tools since install (host-tool-semantics). */
  hostLoaded: HealthSummaryItem;
  restart: HealthSummaryItem;
}

/** MCP clause — witness: the mcp section's status/reason/nextAction. */
function summarizeMcp(mcp: WorkspaceHealth['mcp']): HealthSummaryItem {
  if (mcp.status === 'HEALTHY' || mcp.status === 'RESTART_REQUIRED') {
    return {
      status: 'ok',
      detail: `static install health OK (${mcp.host}); active check: pd mcp probe`,
    };
  }
  if (mcp.status === 'NOT_INSTALLED' || mcp.status === 'HOST_NOT_FOUND') {
    return { status: 'not_applicable', detail: mcp.status };
  }
  return {
    status: 'error',
    detail: `${mcp.status}${mcp.reason ? `: ${mcp.reason}` : ''}`,
    nextAction: mcp.nextAction ?? 'Re-run the PD host setup for this host, then rerun pd health.',
  };
}

function summarizeConsole(console: WorkspaceHealth['console']): HealthSummaryItem {
  switch (console.status) {
    case 'installed_running':
      return { status: 'ok', detail: `running at ${console.running.url}` };
    case 'installed_not_running':
      return { status: 'ok', detail: 'installed, not running (on-demand — start with: pd console open)' };
    case 'not_installed':
      return { status: 'not_applicable', detail: 'console not installed for this home' };
    case 'broken':
      return {
        status: 'error',
        detail: `${console.reason ?? 'broken'}${console.integrity ? `: ${console.integrity}` : ''}`,
        nextAction: console.nextAction ?? 'Re-run installer: npx create-principles-disciple',
      };
  }
}

function summarizeSkills(mcp: WorkspaceHealth['mcp']): HealthSummaryItem {
  if (mcp.status === 'NOT_INSTALLED' || mcp.status === 'HOST_NOT_FOUND') {
    return { status: 'not_applicable', detail: 'no installed payload to declare skills' };
  }
  // declaredEntries covers ALL payload declarations (mcp entries, skills, hook
  // commands); the skills clause reads only the skills-keyed subset.
  const skillsEntries = mcp.declaredEntries;
  const skillsMissing = skillsEntries.missing.filter((entry) => entry.declaration.includes('#skills'));
  const skillsUnverifiable = skillsEntries.unverifiable.filter((entry) => entry.declaration.includes('#skills'));
  if (skillsMissing.length > 0) {
    return {
      status: 'error',
      detail: `${skillsMissing.length} declared skill path(s) missing (${skillsMissing.map((e) => e.declaration).slice(0, 3).join(', ')}${skillsMissing.length > 3 ? ', …' : ''})`,
      nextAction: 'Re-run the PD host setup for this host so the payload (skills included) is reinstalled.',
    };
  }
  if (skillsUnverifiable.length > 0) {
    return {
      status: 'attention',
      detail: `${skillsUnverifiable.length} declared skill path(s) unverifiable`,
      nextAction: 'Inspect the plugin payload declaration; re-run the PD host setup if it persists.',
    };
  }
  return { status: 'ok', detail: 'declared skill paths present' };
}

function summarizeHostLoaded(reliability: WorkspaceHealth['reliability']): HealthSummaryItem {
  const {hosts} = reliability.registry;
  if (hosts.length > 0) {
    return { status: 'ok', detail: `host(s) started and declared tools: ${hosts.join(', ')}` };
  }
  return {
    status: 'attention',
    detail: 'no host has started PD since install (hooks/MCP not yet proven live)',
    nextAction: 'Start or restart the host (OpenClaw: openclaw gateway --force; Codex/WorkBuddy: start a new session), then rerun pd health.',
  };
}

function summarizeRestart(mcp: WorkspaceHealth['mcp']): HealthSummaryItem {
  if (mcp.restart.required === true) {
    return {
      status: 'attention',
      detail: `host restart required (${mcp.restart.reason ?? 'binding newer than host start'})`,
      nextAction: 'Restart the host (or start a new session) so it picks up the current binding, then rerun pd health.',
    };
  }
  if (mcp.restart.required === false) {
    return { status: 'ok', detail: 'binding already picked up by the running host' };
  }
  return {
    status: 'attention',
    detail: `restart need unverifiable (${mcp.restart.reason ?? 'host process start not observable'})`,
  };
}

/**
 * Pure derivation — every item reads its OWN witness field on the health
 * report; nothing is inferred from a sibling section. Exit-1 grades that are
 * not summary items (ledger consistency, enforcement) still gate `overall` so
 * the summary can never read 'healthy' on a report that exits 1.
 */
export function buildHealthSummary(
  health: Pick<WorkspaceHealth, 'mcp' | 'console' | 'reliability' | 'candidateLedgerConsistency' | 'enforcement'>,
): HealthSummary {
  const mcpItem = summarizeMcp(health.mcp);
  const consoleItem = summarizeConsole(health.console);
  const skillsItem = summarizeSkills(health.mcp);
  const hostLoadedItem = summarizeHostLoaded(health.reliability);
  const restartItem = summarizeRestart(health.mcp);

  const items: HealthSummaryItem[] = [mcpItem, consoleItem, skillsItem, hostLoadedItem, restartItem];
  const hardFailed =
    items.some((item) => item.status === 'error')
    || health.candidateLedgerConsistency.status === 'degraded'
    || health.enforcement.state !== 'healthy';
  const overall = hardFailed
    ? 'error'
    : items.some((item) => item.status === 'attention')
      ? 'attention'
      : 'healthy';
  return {
    overall,
    cli: { status: 'ok', note: 'pd CLI executed this command' },
    mcp: mcpItem,
    console: consoleItem,
    skills: skillsItem,
    hostLoaded: hostLoadedItem,
    restart: restartItem,
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
   * PRI-1210: durable degraded-enforcement marker read (`~/.pd/enforcement-health/`).
   * Three states — `healthy` (no marker), `degraded` (enforcement fail-opened at
   * least once; reason + first/last seen), `unknown` (marker unreadable or
   * malformed). `unknown` is never reported as healthy and never as 0.
   */
  enforcement: DegradedEnforcementReading;
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
  /**
   * Console install/liveness facts for the resolved PD home. Read-only (health
   * never starts the console); `installed_not_running` is the normal on-demand
   * state, `broken` fails the health exit code (broken install = health
   * failure, same grade as the MCP section's non-neutral defects).
   */
  console: ConsoleHealthSection;
  /**
   * Derived agent acceptance view (post-install QA): one verdict per
   * component (cli/mcp/console/skills/hostLoaded/restart) + overall. Pure
   * derivation from the sections above — never a second truth (P4).
   */
  summary: HealthSummary;
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
  const pdDbPath = resolveStateDbPath(workspaceDir);
  const ledgerStateDir = path.join(workspaceDir, '.state');
  const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);

  const pruningModel = new PruningReadModel({ workspaceDir });
  const healthSummary = pruningModel.getHealthSummary();
  const ledgerByStatus = healthSummary.byStatus;

  const { missingLedgerCount } = await auditCandidateLedgerConsistency(workspaceDir);
  const reliability = assessReliability(workspaceDir);
  // PRI-1210: read the durable degraded-enforcement marker. Its authority is
  // the marker file itself; this is a read-only projection for the Owner.
  const enforcement = readDegradedEnforcement(workspaceDir);
  const healthHome = resolveHealthHome();
  const mcpHostSelection: McpHostSelection = opts.host !== undefined
    ? { host: opts.host, selectedBy: 'explicit-flag', matchedHosts: [] }
    : selectMcpHostForWorkspace(workspaceDir, { homePaths: healthHome.homePaths ?? undefined });
  const mcp = assessMcpHealth({
    host: mcpHostSelection.host,
    homePaths: healthHome.homePaths ?? undefined,
  });
  // "MCP not installed" and "the PD home could not be resolved" are different
  // facts; surface the second one instead of letting the first stand in for it.
  if (healthHome.unresolvedReason) {
    mcp.reason = healthHome.unresolvedReason;
    mcp.nextAction = 'Fix the PD home inputs (PD_EXPERIMENT_ROOT / PD_WORKSPACE_DIR or OPENCLAW_STATE_DIR), then rerun pd health.';
  }
  // 2026-11-07: the four host facts ride along ONLY for the workbuddy host —
  // they are WorkBuddy-specific truths, never an openclaw/codex section.
  const workbuddyHostFacts = opts.host === 'workbuddy' && healthHome.homePaths
    ? assessWorkbuddyHostFacts({ homePaths: healthHome.homePaths })
    : undefined;
  // PRI-1171 ticket ⑦: host-neutral three-host ingestion section (read-only;
  // checkpoint/observation reads + transcript SIZE stats, never content).
  // Awaited: host adapters lazy-load inside (PRI-1061 host-agnostic startup).
  // The already-resolved PD Home rides along so the ingestion section derives
  // its transcript roots from the SAME single parse — never os.homedir() again.
  const ingestion = await assessIngestionHealth({ workspaceDir, homePaths: healthHome.homePaths ?? undefined });
  // Console install/liveness — read-only, home-scoped (not workspace-scoped).
  const consoleSection = await assessConsole(healthHome.homeDir, healthHome.homePaths ?? undefined);

  let candidatesTotal = 0, candidatesConsumed = 0, candidatesPending = 0;
  let tasksTotal = 0;
  const tasksByStatus: Record<string, number> = {};
  let pdDbExists = false;
  let lastSuccessfulChain: LastSuccessfulChain | undefined = undefined;
  let partialHealth = false;

  function buildHealth(): WorkspaceHealth {
    const health: WorkspaceHealth = {
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
      enforcement,
      mcp,
      mcpHostSelection,
      reuseEvaluation: assessReuseEvaluationTelemetry(workspaceDir),
      lastSuccessfulChain,
      ...(workbuddyHostFacts !== undefined ? { workbuddyHostFacts } : {}),
      ingestion,
      console: consoleSection,
      // Derived last, from the finished report (never a second truth).
      summary: buildHealthSummary({
        mcp,
        console: consoleSection,
        reliability,
        candidateLedgerConsistency: {
          status: missingLedgerCount === 0 ? 'ok' : 'degraded',
          missing: missingLedgerCount,
        },
        enforcement,
      }),
    };
    return health;
  }

  function writeHealth(): void {
    const health = buildHealth();
    const mcpFailed = !MCP_EXIT_NEUTRAL_STATUSES.has(health.mcp.status);
    // PRI-1210: a recorded fail-open (degraded) or an unreadable marker
    // (unknown) must fail `pd health` by exit code. "unknown" is NOT healthy.
    const enforcementFailed = health.enforcement.state !== 'healthy';
    // A broken console install is the same grade as a broken MCP install:
    // a real install-integrity defect, not an absent optional component.
    const consoleFailed = health.console.status === 'broken';

    if (opts.json) {
      console.log(JSON.stringify(health, null, 2));
      if (health.candidateLedgerConsistency.status === 'degraded' || mcpFailed || enforcementFailed || consoleFailed) process.exit(1);
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
    console.log(`enforcement.state: ${health.enforcement.state}`);
    console.log(`enforcement.markerPath: ${health.enforcement.markerPath}`);
    if (health.enforcement.reason !== undefined) console.log(`enforcement.reason: ${health.enforcement.reason}`);
    if (health.enforcement.firstSeenAt !== undefined) console.log(`enforcement.firstSeenAt: ${health.enforcement.firstSeenAt}`);
    if (health.enforcement.lastSeenAt !== undefined) console.log(`enforcement.lastSeenAt: ${health.enforcement.lastSeenAt}`);
    if (health.enforcement.occurrences !== undefined) console.log(`enforcement.occurrences: ${health.enforcement.occurrences}`);
    if (health.enforcement.unreadableReason !== undefined) console.log(`enforcement.unreadableReason: ${health.enforcement.unreadableReason}`);
    if (health.enforcement.nextAction !== undefined) console.log(`enforcement.nextAction: ${health.enforcement.nextAction}`);
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
    console.log(`console.status: ${health.console.status}${health.console.running.url ? ` (${health.console.running.url})` : ''}`);
    if (health.console.reason !== undefined) console.log(`console.reason: ${health.console.reason}`);
    // Derived agent acceptance view — one line per component + overall.
    console.log(`summary.overall: ${health.summary.overall}`);
    console.log(`summary.cli: ok (${health.summary.cli.note})`);
    for (const [name, item] of ([
      ['mcp', health.summary.mcp],
      ['console', health.summary.console],
      ['skills', health.summary.skills],
      ['hostLoaded', health.summary.hostLoaded],
      ['restart', health.summary.restart],
    ] as const) as readonly (readonly [string, HealthSummaryItem])[]) {
      console.log(`summary.${name}: ${item.status}${item.detail ? ` — ${item.detail}` : ''}`);
      if (item.nextAction !== undefined) console.log(`summary.${name}.nextAction: ${item.nextAction}`);
    }
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
    if (enforcementFailed) {
      console.warn(health.enforcement.state === 'unknown'
        ? `⚠️  Rule enforcement state is UNKNOWN — the degraded-enforcement marker could not be read (${health.enforcement.unreadableReason ?? 'unspecified'}).`
        : `⚠️  Rule enforcement is DEGRADED — the RuleHost gate fail-opened for this workspace (${health.enforcement.reason ?? 'unspecified'}; last seen ${health.enforcement.lastSeenAt ?? 'unknown'}).`);
      if (health.enforcement.nextAction !== undefined) console.warn(`   nextAction: ${health.enforcement.nextAction}`);
      console.warn(`   marker: ${health.enforcement.markerPath}`);
      process.exit(1);
    }
    if (consoleFailed) {
      console.warn(`⚠️  Console install is BROKEN (${health.console.reason ?? 'unspecified'}).`);
      if (health.console.integrity !== null) console.warn(`   integrity: ${health.console.integrity}`);
      if (health.console.nextAction !== undefined) console.warn(`   nextAction: ${health.console.nextAction}`);
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
