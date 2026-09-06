#!/usr/bin/env node
/**
 * pd CLI — Principles Disciple command-line interface.
 *
 * Usage:
 *   pd pain record --reason <text> [--score N] [--source manual]
 */

import { Command } from 'commander';
import { handlePainRecord } from './commands/pain-record.js';
import { registerPainRetryCommand } from './commands/pain-retry.js';
import { handlePainEvidence } from './commands/pain-evidence.js';
import { handlePainList } from './commands/pain-list.js';
import { handleSamplesList } from './commands/samples-list.js';
import { handleSamplesReview } from './commands/samples-review.js';
import { handleEvolutionTasksList } from './commands/evolution-tasks-list.js';
import { handleEvolutionTasksShow } from './commands/evolution-tasks-show.js';
import { registerHealthCommand } from './commands/health.js';
import { registerVersionCommand } from './commands/version.js';
import { buildVersionReport, formatShortVersion, VersionReportError } from './services/version-report.js';
import { handleTaskShow, registerTaskListCommand } from './commands/task.js';
import { handleRunList, handleRunShow } from './commands/run.js';
import { handleTrajectoryLocate } from './commands/trajectory.js';
import { handleHistoryQuery } from './commands/history.js';
import { handleContextBuild } from './commands/context.js';
import { handleLegacyImportOpenClaw } from './commands/legacy-import.js';
import { handleLegacyCleanup } from './commands/legacy-cleanup.js';
import { handleDiagnoseStatus, handleDiagnoseRun } from './commands/diagnose.js';
import { registerRuntimeProbeCommand } from './commands/runtime.js';
import { handleFlowShow } from './commands/flow.js';
import { handleTraceShow } from './commands/trace.js';
import { handlePruningReport, handlePruningExplain, handlePruningReview, handlePruningRollback, handlePruningOrphans } from './commands/runtime-pruning.js';
import { handleRuntimeHealthSnapshot } from './commands/runtime-health-snapshot.js';
import { handleRuntimeGfiSnapshot } from './commands/runtime-gfi-snapshot.js';
import { handleRuntimeUat } from './commands/runtime-uat.js';
import { handleRuntimeInternalizationQueue } from './commands/runtime-internalization-queue.js';
import { handleRuntimeInternalizationWakeOnce } from './commands/runtime-internalization-wake-once.js';
import { handleRuntimeInternalizationRunOnce } from './commands/runtime-internalization-run-once.js';
import { handleRuntimeInternalizationRetry } from './commands/runtime-internalization-retry.js';
import { registerRunRuleHostCommand } from './commands/runtime-internalization-run-rulehost.js';
import { handleCandidateList, handleCandidateShow, handleCandidateIntake, handleCandidateAudit, handleCandidateRepair, handleCandidateRoute, handleCandidateInternalize, handleCandidateInternalizationBackfill } from './commands/candidate.js';
import { handleArtifactShow } from './commands/artifact.js';
import { handleRuntimeCanary } from './commands/runtime-canary.js';
import { handleRuntimeSyntheticBaseline } from './commands/runtime-synthetic-baseline.js';
import { handleRuntimePainFlood } from './commands/runtime-pain-flood-simulation.js';
import { handleRuntimeInternalizationIntegrity } from './commands/runtime-internalization-integrity.js';
import { handleRuntimeInternalizationIntegrityRepair } from './commands/runtime-internalization-integrity-repair.js';
import { handleRuntimeInternalizationEnqueueSuccessors } from './commands/runtime-internalization-enqueue-successors.js';
import { handleRuntimeInternalizationContextTrace } from './commands/runtime-internalization-context-trace.js';
import { handleRuntimeDiagnosticsExport } from './commands/runtime-diagnostics-export.js';
import { registerRuntimeCompatibilityScanCommand } from './commands/runtime-compatibility-scan.js';
import { handleRuntimeRecoverySweep } from './commands/runtime-recovery.js';
import { handleRuntimeRecoveryFailedTasks } from './commands/runtime-recovery-failed-tasks.js';
import { handleRuntimeArtifactRepair } from './commands/runtime-artifact-repair.js';
import {
  handleRuntimeActivationDeactivate,
  handleRuntimeActivationList,
  handleRuntimeActivationEdit,
  registerRuntimeActivationPromoteCommand,
  registerRuntimeActivationDeactivateCommand,
  registerRuntimeActivationListCommand,
  registerRuntimeActivationDispatchCommand,
  registerRuntimeActivationApproveCommand,
} from './commands/runtime-activation.js';
import { handleProvenChannelBaseline } from './commands/proven-channel-baseline.js';
import { handleDemoStoryA } from './commands/demo-story-a.js';
import { handleRuntimeFeaturesStatus } from './commands/runtime-features.js';
import { handleConfigDoctor } from './commands/config-doctor.js';
import { registerMvpCommands } from './commands/mvp-smoke.js';
import { registerRulecodeCommand } from './commands/rulecode.js';
import { registerIntentCommand } from './commands/intent.js';
import { registerErrorsListCommand } from './commands/errors-list.js';
import { registerPrinciplesCommand } from './commands/principles-stats.js';
import { registerTelemetryCommand } from './commands/telemetry.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

// SPEC §12: `pd --version` prints the canonical product version when a
// supported installation exists; a development checkout falls back to the
// CLI package version with an explicit marker instead of impersonating an
// installed release.
function handleVersionFlag(args: readonly string[]): boolean {
  if (!args.includes('--version') && !args.includes('-V')) return false;
  try {
    console.log(formatShortVersion(buildVersionReport()));
    return true;
  } catch (error) {
    if (error instanceof VersionReportError && error.reason === 'not_installed') {
      console.log(`Principles Disciple ${pkg.version} (development-checkout)`);
      return true;
    }
    if (error instanceof VersionReportError) {
      console.error(error.message);
      console.error(`Next: ${error.nextAction}`);
      process.exitCode = 1;
      return true;
    }
    throw error;
  }
}

program
  .name('pd')
  .description('PD CLI — Pain recording, sample management, and evolution tasks')
  .option('-V, --version', 'output the canonical PD product version')
  .enablePositionalOptions();

registerVersionCommand(program);

const painCmd = program
  .command('pain')
  .description('Pain signal management');

painCmd
  .command('record')
  .description('Record a pain signal via Runtime v2 bridge')
  .option('-r, --reason <text>', 'Reason for the pain signal (required)')
  .option('-s, --score <number>', 'Pain score 0-100', parseInt)
  .option('-S, --source <text>', 'Source of the pain signal', 'manual')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--session <id>', 'Session ID to bind (validated against this workspace\'s trajectory.db; without it the record is unbound: no trajectory evidence, candidates likely gated by the admission threshold)')
  .option('--wait', 'Wait for diagnosis to complete (sync mode, overrides async flag)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handlePainRecord(opts);
  });

registerPainRetryCommand(painCmd);

painCmd
  .command('list')
  .description('List canonical pain events with host attribution (PRI-640)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-l, --limit <number>', 'Max entries to show (default: 20)', parseInt)
  .option('--host <kind>', 'Filter by host: openclaw | codex | unknown')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handlePainList(opts);
  });

painCmd
  .command('evidence')
  .description('Show recent TRIGGER_DECISION log entries — pain admission gate decisions only (PEAT-B2)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-l, --limit <number>', 'Max entries to show (default: 20)', parseInt)
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handlePainEvidence(opts);
  });

const samplesCmd = program
  .command('samples', { hidden: true })
  .description('Correction sample management');

samplesCmd
  .command('list')
  .description('List correction samples')
  .option('-s, --status <pending|approved|rejected>', 'Filter by review status', 'pending')
  .action(async (opts) => {
    await handleSamplesList(opts);
  });

samplesCmd
  .command('review')
  .description('Review a correction sample')
  .argument('<sample-id>', 'The sample ID to review')
  .argument('<approve|reject>', 'Review decision')
  .argument('[note]', 'Optional review note')
  .action(async (sampleId, decision, note) => {
    if (decision !== 'approve' && decision !== 'reject') {
      console.error('Error: decision must be "approve" or "reject"');
      process.exit(1);
    }
    await handleSamplesReview({ sampleId, decision: decision === 'approve' ? 'approved' : 'rejected', note });
  });

const evolutionCmd = program
  .command('evolution', { hidden: true })
  .description('Evolution task management');

const tasksCmd = evolutionCmd
  .command('tasks')
  .description('List and show evolution tasks');

tasksCmd
  .command('list')
  .description('List evolution tasks')
  .option('-s, --status <status>', 'Filter by status (pending|in_progress|completed|all)', 'all')
  .option('-l, --limit <number>', 'Maximum tasks to return', parseInt, 50)
  .option('-f, --date-from <date>', 'Filter tasks created on or after this date')
  .option('-t, --date-to <date>', 'Filter tasks created on or before this date')
  .action(async (opts) => {
    await handleEvolutionTasksList(opts);
  });

tasksCmd
  .command('show')
  .description('Show full details for an evolution task')
  .argument('<id>', 'Task ID (numeric or string taskId)')
  .action(async (id, _opts) => {
    await handleEvolutionTasksShow({ id });
  });

registerHealthCommand(program);

// ── Anonymous Product Telemetry v1 control plane (PRI-595~603) ────────────────

registerTelemetryCommand(program);

// ── Runtime v2 task/run commands ──────────────────────────────────────────────鈹€鈹€鈹€鈹€鈹€鈹€

const rtTaskCmd = program
  .command('task')
  .description('Runtime v2 task inspection');

registerTaskListCommand(rtTaskCmd);

rtTaskCmd
  .command('show <taskId>')
  .description('Show detailed task information')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (taskId, opts) => {
    await handleTaskShow({ id: taskId, json: opts.json, workspace: opts.workspace });
  });

const rtRunCmd = program
  .command('run', { hidden: true })
  .description('Runtime v2 run inspection');

rtRunCmd
  .command('list <taskId>')
  .description('List all runs for a task')
  .action(async (taskId) => {
    await handleRunList({ taskId });
  });

rtRunCmd
  .command('show <runId>')
  .description('Show detailed run information')
  .action(async (runId) => {
    await handleRunShow({ id: runId });
  });

// ── Runtime v2 trajectory/history/context commands ────────────────────────────鈹€鈹€

const trajectoryCmd = program
  .command('trajectory', { hidden: true })
  .description('Runtime v2 trajectory location');

trajectoryCmd
  .command('locate')
  .description('Locate a trajectory by task ID, run ID, or time range')
  .option('-t, --task <taskId>', 'Locate by task ID')
  .option('-r, --run <runId>', 'Locate by run ID')
  .option('--from <date>', 'Start of time range (ISO string)')
  .option('--to <date>', 'End of time range (ISO string)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleTrajectoryLocate(opts);
  });

const historyCmd = program
  .command('history', { hidden: true })
  .description('Runtime v2 history query');

historyCmd
  .command('query <taskId>')
  .description('Query run history for a task')
  .option('-l, --limit <number>', 'Limit number of entries', parseInt)
  .option('-c, --cursor <cursor>', 'Pagination cursor')
  .option('--from <date>', 'Start of time range (ISO string)')
  .option('--to <date>', 'End of time range (ISO string)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (taskId, opts) => {
    await handleHistoryQuery(taskId, opts);
  });

const contextCmd = program
  .command('context', { hidden: true })
  .description('Runtime v2 context assembly');

contextCmd
  .command('build <taskId>')
  .description('Assemble diagnostician context for a task')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (taskId, opts) => {
    await handleContextBuild(taskId, opts);
  });

// ── Legacy import command ──────────────────────────────────────────────────────鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const legacyCmd = program
  .command('legacy', { hidden: true })
  .description('Legacy data management (import and cleanup)');

const importCmd = legacyCmd.command('import');
importCmd
  .command('openclaw')
  .description(
    'Import OpenClaw legacy data into PD Runtime v2 SQLite. ' +
      'Run this once per workspace before using trajectory/history/context commands.',
  )
  .option('-w, --workspace <path>', 'Workspace directory (required)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleLegacyImportOpenClaw(opts);
  });

// ── Diagnostician run/status commands ─────────────────────────────────────────鈹€鈹€鈹€鈹€

const diagnoseCmd = program
  .command('diagnose')
  .description('Diagnostician execution and status inspection');

diagnoseCmd
  .command('status')
  .description('Inspect diagnostician task status')
  .requiredOption('-t, --task-id <taskId>', 'Task ID to inspect')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--stalled-threshold <seconds>', 'Age threshold in seconds for classifying task as stalled')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleDiagnoseStatus(opts);
  });

diagnoseCmd
  .command('run')
  .description('Execute diagnostician runner for a task')
  .requiredOption('-t, --task-id <taskId>', 'Task ID to execute')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-r, --runtime <kind>', "Runtime kind: 'openclaw-cli', 'test-double', 'pi-ai'. If omitted, resolved from .pd/config.yaml; refuses if no binding (no test-double default).")
  .option('--openclaw-local', 'Use local OpenClaw (mutually exclusive with --openclaw-gateway)')
  .option('--openclaw-gateway', 'Use gateway OpenClaw (mutually exclusive with --openclaw-local)')
  .option('-a, --agent <agentId>', 'Agent ID to invoke')
  .option('--provider <name>', 'LLM provider (e.g., openrouter) — for pi-ai, falls back to policy')
  .option('--model <id>', 'Model ID (e.g., anthropic/claude-sonnet-4) — for pi-ai, falls back to policy')
  .option('--apiKeyEnv <name>', 'Env var name for API key — for pi-ai, falls back to policy')
  .option('--baseUrl <url>', 'Custom base URL — for pi-ai, falls back to policy')
  .option('--maxRetries <n>', 'Max retry attempts for LLM failures — for pi-ai, falls back to policy', parseInt)
  .option('--timeoutMs <ms>', 'Timeout in milliseconds — for pi-ai, falls back to policy', parseInt)
  .option('--no-intake', 'Skip candidate intake after successful diagnosis')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleDiagnoseRun(opts);
  });

// ── Runtime probe command (HG-01 HARD GATE) ───────────────────────────────────鈹€鈹€鈹€鈹€

const runtimeCmd = program
  .command('runtime')
  .description('Runtime inspection and health checks');

runtimeCmd
  .command('canary', { hidden: true })
  .description('One-shot control plane health canary')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeCanary({ workspace: opts.workspace, json: opts.json });
  });

// pd runtime init — Initialize all PD SQLite databases for a workspace.
// Lazy import: avoids loading `principles-disciple` at module init time, which
// would crash `pd --version` in packaged installs where the plugin's transitive
// deps are not resolvable from pd-cli's node_modules. The import only executes
// when `pd runtime init` is actually invoked.
runtimeCmd
  .command('init')
  .description('Initialize all PD SQLite databases (state.db, trajectory.db, subagent_workflows.db)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Show what would be initialized without writing (default)')
  .option('--confirm', 'Actually initialize the databases (required to write)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const { handleRuntimeInit } = await import('./commands/runtime-init.js');
    await handleRuntimeInit({
      workspace: opts.workspace,
      dryRun: opts.dryRun === true,
      confirm: opts.confirm === true,
      json: opts.json === true,
    });
  });

registerRuntimeCompatibilityScanCommand(runtimeCmd);

const synthCmd = runtimeCmd
  .command('synthetic', { hidden: true })
  .description('Synthetic workload baseline commands');

synthCmd
  .command('baseline')
  .description('Run synthetic PD workload baseline (PRI-206) — deterministic, no LLM required')
  .option('-w, --workspace <path>', 'Workspace directory (default: temp workspace)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeSyntheticBaseline({ workspace: opts.workspace, json: opts.json });
  });

synthCmd
  .command('flood')
  .description('Run pain flood simulation (PRI-208) — deterministic dedup/stress test, no LLM required')
  .option('-w, --workspace <path>', 'Workspace directory (default: temp workspace)')
  .option('--json', 'Output raw JSON')
  .option('--identical-count <n>', 'Number of identical pain signals (default: 10)', parseInt)
  .option('--similar-count <n>', 'Number of similar pain signals (default: 10)', parseInt)
  .option('--stress-count <n>', 'Number of stress test pain signals (default: 50)', parseInt)
  .action(async (opts) => {
    await handleRuntimePainFlood({
      workspace: opts.workspace,
      json: opts.json,
      identicalCount: opts.identicalCount,
      similarCount: opts.similarCount,
      stressCount: opts.stressCount,
    });
  });

synthCmd
  .command('proven-channel')
  .description('Run MVP activation continuity baseline (PRI-240) — deterministic, no LLM required')
  .option('-w, --workspace <path>', 'Workspace directory (default: temp workspace)')
  .option('--json', 'Output raw JSON')
  .option('--channels <channels>', 'Comma-separated channel list (prompt,code_tool_hook,defer_archive)')
  .action(async (opts) => {
    await handleProvenChannelBaseline({
      workspace: opts.workspace,
      json: opts.json,
      channels: opts.channels,
    });
  });

runtimeCmd
  .command('features')
  .description('Show feature flag status (PRI-239)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeFeaturesStatus({
      workspace: opts.workspace,
      json: opts.json,
    });
  });

// ── PRI-455: Promoted owner commands (trace + activation) ────────────────────
// These are promoted from runtime subcommands to top-level for discoverability.
// The old paths (pd runtime trace show, pd runtime activation list) remain as
// hidden aliases — they still work but are not shown in --help.

const traceTopCmd = program
  .command('trace')
  .description('Trace full pain-to-ledger chain (Story A\' Step 6: Observe)');

traceTopCmd
  .command('show')
  .description('Show full trace for a pain ID')
  .requiredOption('--pain-id <id>', 'Pain ID to trace')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleTraceShow({ painId: opts.painId, workspace: opts.workspace, json: opts.json });
  });

const activationTopCmd = program
  .command('activation')
  .description('Activation management — list active activations, deactivate (Story A\' Steps 5-6)');

registerRuntimeActivationListCommand(activationTopCmd);

registerRuntimeActivationDeactivateCommand(activationTopCmd);

// Bug-M fix: CLI closed loop — approve a pending approval and dispatch its activation.
// Reuses the same ApprovalQueue + ApprovalCompletionService as the Console model.
registerRuntimeActivationApproveCommand(activationTopCmd);

registerRuntimeActivationPromoteCommand(activationTopCmd);

const configCmd = program
  .command('config')
  .description('PD configuration discovery and diagnosis');

configCmd
  .command('doctor')
  .description('Show PD + OpenClaw config locations, feature flags, and provider connectivity (PRI-299)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleConfigDoctor({ workspace: opts.workspace, json: opts.json });
  });

const demoCmd = program
  .command('demo', { hidden: true })
  .description('Demo scenarios for MVP validation');

demoCmd
  .command('story-a')
  .alias('first-principle')
  .description('Run Story A\'s proven-channel demo (PRI-246) — full evidence→proposal→approval→activation→observation chain')
  .option('-w, --workspace <path>', 'Workspace directory (default: temp workspace)')
  .option('--json', 'Output raw JSON')
  .option('--channels <channels>', 'Comma-separated channel list (prompt,code_tool_hook,defer_archive)')
  .option('--allow-demo-write-to-existing-workspace', 'Developer override: permit writing demo artifacts into a workspace that already contains PD state (demo isolation guard)')
  .action(async (opts) => {
    await handleDemoStoryA({
      workspace: opts.workspace,
      json: opts.json,
      channels: opts.channels,
      allowDemoWriteToExistingWorkspace: opts.allowDemoWriteToExistingWorkspace === true,
    });
  });

registerRuntimeProbeCommand(runtimeCmd);

const flowCmd = runtimeCmd
  .command('flow', { hidden: true })
  .description('Workflow funnel inspection');

flowCmd
  .command('show')
  .description('Show all workflow funnel definitions from workflows.yaml')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleFlowShow(opts);
  });

const traceCmd = runtimeCmd
  .command('trace', { hidden: true })
  .description('Trace full pain-to-ledger chain (hidden alias — use pd trace show)');

traceCmd
  .command('show')
  .description('Show full trace for a pain ID')
  .requiredOption('--pain-id <id>', 'Pain ID to trace')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleTraceShow({ painId: opts.painId, workspace: opts.workspace, json: opts.json });
  });

runtimeCmd
  .command('uat', { hidden: true })
  .description('Runtime V2 chain UAT baseline runner')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--count <n>', 'Number of iterations (default: 5, max: 50)', parseInt)
  .option('--min-success-rate <rate>', 'Minimum success rate threshold (default: 1.0)', parseFloat)
  .option('--json', 'Output machine-readable JSON summary')
  .option('--allow-production-workspace-for-uat', 'DANGEROUS: Allow UAT to write to production workspace (NOT RECOMMENDED)')
  .action(async (opts) => {
    await handleRuntimeUat({
      workspace: opts.workspace,
      count: opts.count,
      minSuccessRate: opts.minSuccessRate,
      json: opts.json,
      allowProductionWorkspaceForUat: opts.allowProductionWorkspaceForUat,
    });
  });

const runtimeHealthCmd = runtimeCmd
  .command('health', { hidden: true })
  .description('Runtime V2 health inspection');

runtimeHealthCmd
  .command('snapshot')
  .description('Operator health snapshot combining chain, ledger, and pruning status')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeHealthSnapshot({ workspace: opts.workspace, json: opts.json });
  });

// ── pd codex reconcile — Codex governance continuation recovery ───────────────
// Codex Governance Closure Slice B (PRI-623, SPEC §13/§20): runs the idempotent
// cross-store reconciliation pass (admitted pain → missing Diagnostician task,
// task-before-link, pending promotion tails) exposed for the CLI now and the
// Slice C Companion worker later.
const codexCmd = program
  .command('codex')
  .description('Codex host governance operations');

// ── pd codex setup — consent UX for conversation ingestion (Slice D) ─────────
// PRI-625, SPEC rev 2 §17 + G2A frozen disclosure: the ONE authority that can
// enable codex_conversation_ingestion — presents the frozen disclosure and
// records the explicit Owner decision BEFORE flipping the flag. Declining
// leaves all existing governance unchanged and reads no transcript.
codexCmd
  .command('setup')
  .description('Present the frozen ingestion disclosure and record the explicit consent decision (accept enables codex_conversation_ingestion; decline keeps everything off)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--accept', 'Explicitly accept after the disclosure has been presented (non-interactive)')
  .option('--decline', 'Explicitly decline; the ingestion flag stays off and no transcript is ever read')
  .option('--show-disclosure', 'Print the frozen disclosure text (zh default, --lang en) and exit without mutating anything')
  .option('--lang <zh|en>', 'Disclosure language for presentation', undefined)
  .option('--json', 'Output raw JSON (decision must be explicit: --accept or --decline)')
  .action(async (opts) => {
    const { handleCodexSetup } = await import('./commands/codex-setup.js');
    await handleCodexSetup({
      workspace: opts.workspace,
      json: opts.json === true,
      accept: opts.accept === true,
      decline: opts.decline === true,
      showDisclosure: opts.showDisclosure === true,
      ...(typeof opts.lang === 'string' ? { lang: opts.lang } : {}),
    });
  });

codexCmd
  .command('reconcile')
  .description('Reconcile admitted Codex pains with Diagnostician tasks and promotion tails (idempotent)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--limit <n>', 'Maximum admitted pains to reconcile per pass (1-200, default 50)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const { handleCodexReconcile } = await import('./commands/codex-reconcile.js');
    const limit = typeof opts.limit === 'string' ? Number.parseInt(opts.limit, 10) : undefined;
    await handleCodexReconcile({
      workspace: opts.workspace,
      json: opts.json === true,
      ...(limit !== undefined && Number.isInteger(limit) ? { limit } : {}),
    });
  });

// ── pd codex ingest catch-up — bounded manual transcript lag recovery ────────
// Codex Governance Closure Slice C (PRI-624, SPEC §15): the manual-mode
// counterpart of the Companion worker's catch-up step. Zero transcript I/O
// when codex_conversation_ingestion is disabled.
const codexIngestCmd = codexCmd
  .command('ingest')
  .description('Codex conversation-ingestion operations');

codexIngestCmd
  .command('catch-up')
  .description('Catch up transcript lag from durable checkpoints (bounded, non-destructive, no LLM)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--max-rollouts <n>', 'Maximum rollouts to catch up per pass (1-32, default 8)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const { handleCodexIngestCatchUp } = await import('./commands/codex-ingest-catchup.js');
    const maxRollouts = typeof opts.maxRollouts === 'string' ? Number.parseInt(opts.maxRollouts, 10) : undefined;
    await handleCodexIngestCatchUp({
      workspace: opts.workspace,
      json: opts.json === true,
      ...(maxRollouts !== undefined && Number.isInteger(maxRollouts) ? { maxRollouts } : {}),
    });
  });

// ── pd codex ingest quarantine — audited recovery for invalid records ────────
// Codex Governance Closure Slice D (PRI-625, SPEC §15): dry-run by default,
// --confirm required to mutate; records digest/reason/operator/timestamp/gap;
// never edits the Codex transcript; promoted evidence is refused.
codexIngestCmd
  .command('quarantine')
  .description('Quarantine a permanently invalid governance observation (dry-run by default; --confirm to apply; never touches the transcript)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--rollout <id>', 'Rollout identity that owns the record (required)')
  .option('--record <id>', 'Numeric governance_observations.id to quarantine (required)')
  .option('--reason <text>', 'Why the record is permanently invalid, 1-200 chars (required)')
  .option('--operator <id>', 'Operator identity recorded in the audit metadata (default: current OS user)')
  .option('--confirm', 'Apply the quarantine; without this flag the command is a dry run')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const { handleCodexIngestQuarantine } = await import('./commands/codex-ingest-quarantine.js');
    await handleCodexIngestQuarantine({
      workspace: opts.workspace,
      rollout: opts.rollout,
      record: opts.record,
      reason: opts.reason,
      ...(typeof opts.operator === 'string' ? { operator: opts.operator } : {}),
      confirm: opts.confirm === true,
      json: opts.json === true,
    });
  });

// ── pd codex worker — Workspace-scoped governance worker ─────────────────────
// Codex Governance Closure Slice C (PRI-624, SPEC §13; ADR-0020 §11.1): the
// one Owner-approved background worker (catch-up → reconciliation → one
// Diagnostician execution → one bounded downstream consumer cycle). The
// Companion spawns this per registered workspace; --once is the manual and
// supervised-restart form.
codexCmd
  .command('worker')
  .description('Run the Codex workspace governance worker (catch-up, reconciliation, diagnostician, downstream)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--once', 'Run exactly one bounded cycle and exit')
  .option('--interval <ms>', 'Cycle interval for continuous mode (default 120000, minimum 1000)')
  .option('--status', 'Report the SPEC §15 worker mode without executing anything')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const { handleCodexWorker } = await import('./commands/codex-worker.js');
    const intervalMs = typeof opts.interval === 'string' ? Number.parseInt(opts.interval, 10) : undefined;
    await handleCodexWorker({
      workspace: opts.workspace,
      json: opts.json === true,
      once: opts.once === true,
      status: opts.status === true,
      ...(intervalMs !== undefined && Number.isInteger(intervalMs) ? { intervalMs } : {}),
    });
  });

runtimeHealthCmd
  .command('gfi')
  .description('GFI workspace snapshot — active vs stale session breakdown')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeGfiSnapshot({ workspace: opts.workspace, json: opts.json });
  });

const internalizationCmd = runtimeCmd
  .command('internalization')
  .description('Internalization Engine operator visibility');

internalizationCmd
  .command('queue')
  .description('Show PI task queue health snapshot')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationQueue({ workspace: opts.workspace, json: opts.json });
  });

internalizationCmd
  .command('wake-once')
  .description('Dry-run lease evaluation for the next leasable PI task')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Evaluate lease without acquiring (required)', false)
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationWakeOnce({ workspace: opts.workspace, dryRun: opts.dryRun, json: opts.json });
  });

internalizationCmd
  .command('retry')
  .description('Requeue a needs_human_review task (owner attention queue out-edge)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .requiredOption('--task <taskId>', 'Task id to requeue')
  .option('--confirm', 'Actually requeue (default is dry-run)')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationRetry({ workspace: opts.workspace, taskId: opts.task, confirm: opts.confirm, json: opts.json });
  });

internalizationCmd
  .command('run-once')
  .description('Wake-and-run: lease the next PI task and execute it')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--runner <kind>', 'Runner kind to execute (default: dreamer)', 'dreamer')
  .option('--runtime <kind>', 'Runtime adapter kind: config (from workflows.yaml), pi-ai, openclaw-cli, test-double (default: config)', 'config')
  .option('--allow-test-double', 'Acknowledge that test-double runtime will mutate real queue state')
  .option('--no-enqueue-next', 'Skip successor enqueue after successful runner (default: auto-enqueue)')
  .option('--timeout-ms <ms>', 'Runner timeout in milliseconds (default: 300000, overrides workflows.yaml)', parseInt)
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationRunOnce({ workspace: opts.workspace, json: opts.json, runtime: opts.runtime, runner: opts.runner, allowTestDouble: opts.allowTestDouble, enqueueNext: opts.enqueueNext, timeoutMs: opts.timeoutMs });
  });

registerRunRuleHostCommand(internalizationCmd);

internalizationCmd
  .command('integrity')
  .description('Check internalization chain integrity')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationIntegrity({ workspace: opts.workspace, json: opts.json });
  });

internalizationCmd
  .command('integrity-repair')
  .description('Repair broken internalization chain links (operator repair path)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Report only, no modifications')
  .option('--confirm', 'Actually repair broken links')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationIntegrityRepair({ workspace: opts.workspace, confirm: opts.confirm, dryRun: opts.dryRun, json: opts.json });
  });

internalizationCmd
  .command('enqueue-successors')
  .description('Enqueue successor tasks for succeeded internalization tasks missing successors')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Report only, no modifications (default)')
  .option('--confirm', 'Actually create successor tasks')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: opts.workspace, dryRun: opts.dryRun, confirm: opts.confirm, json: opts.json });
  });

// Layer 3 (design §6.7, PR 5): read-only context-trace command.
internalizationCmd
  .command('context-trace')
  .description('Trace the internalization context chain: summaries, three-segment diagnosis, truncations, degradations')
  .requiredOption('-t, --task <taskId>', 'Task ID to trace')
  .option('-a, --artifact <artifactId>', 'Specific artifact ID to start from')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON (default)')
  .action(async (opts) => {
    await handleRuntimeInternalizationContextTrace({ workspace: opts.workspace, task: opts.task, artifact: opts.artifact, json: opts.json });
  });

const activationCmd = runtimeCmd
  .command('activation', { hidden: true })
  .description('Activation dispatch operations (hidden — use pd activation for list/deactivate)');

registerRuntimeActivationDispatchCommand(activationCmd);

// PRI-408 Contract E: Owner-initiated rollback/deactivate of an activation.
// Idempotent — calling twice on the same ID is safe and returns ok=false with reason.
activationCmd
  .command('deactivate')
  .description('Deactivate (rollback) an active activation — idempotent (PRI-408 Contract E)')
  .option('-a, --activation-id <id>', 'Activation ID to deactivate')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeActivationDeactivate({
      workspace: opts.workspace,
      activationId: opts.activationId,
      json: opts.json,
    });
  });

// PRI-408 Contract D: Owner observability — list current activations.
activationCmd
  .command('list')
  .description('List activations (default: active only) — PRI-408 Contract D observability')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-c, --channel <channel>', 'Filter by channel (prompt|code_tool_hook)')
  .option('--include-deactivated', 'Include deactivated records in output')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeActivationList({
      workspace: opts.workspace,
      channel: opts.channel,
      includeDeactivated: opts.includeDeactivated,
      json: opts.json,
    });
  });

// P1 #2 fix: Owner edit entry point — swap a pending approval's artifact.
// Required because ApprovalQueue.edit() was dead code with no CLI/OpenClaw entry.
// P2 #5: use .option() instead of .requiredOption() so missing-flag errors
// produce structured JSON output via the handler, not Commander's pre-handler exit.
activationCmd
  .command('edit')
  .description('Edit a pending approval to swap its artifact — P1 #2 owner edit entry point')
  .option('-a, --approval-id <id>', 'Approval ID to edit (must be pending)')
  .option('-n, --new-artifact-id <id>', 'New PIArtifact ID to swap to')
  .option('-r, --edit-reason <text>', 'Reason for the edit')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeActivationEdit({
      workspace: opts.workspace,
      approvalId: opts.approvalId,
      newArtifactId: opts.newArtifactId,
      editReason: opts.editReason,
      json: opts.json,
    });
  });

const diagnosticsCmd = runtimeCmd
  .command('diagnostics', { hidden: true })
  .description('Control plane diagnostic bundle operations');

const recoveryCmd = runtimeCmd
  .command('recovery', { hidden: true })
  .description('Runtime V2 lease recovery operations');

// PRI-555 phase 1: dry-run-only artifact identity drift repair planner.
runtimeCmd
  .command('artifact-repair')
  .description('Plan repairs for unreachable scribe artifacts (dry-run only; writes migration-plan.json, never modifies state.db)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Build migration-plan.json only (default)')
  .option('--confirm', 'Not implemented in this phase — refused')
  .option('--out <path>', 'Output path for migration-plan.json (default: ./migration-plan.json)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeArtifactRepair({
      workspace: opts.workspace,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
      out: opts.out,
      json: opts.json,
    });
  });


recoveryCmd
  .command('sweep')
  .description('Detect and optionally recover expired leases')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Report only, no modifications (default)')
  .option('--confirm', 'Actually recover expired leases')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeRecoverySweep({ workspace: opts.workspace, dryRun: opts.dryRun, confirm: opts.confirm, json: opts.json });
  });

recoveryCmd
  .command('failed-tasks')
  .description('Recover failed internalization tasks')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Report only, no modifications (default)')
  .option('--confirm', 'Actually recover failed tasks')
  .option('--force', 'Force recovery of tasks that exhausted max attempts')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeRecoveryFailedTasks({
      workspace: opts.workspace,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
      force: opts.force,
      json: opts.json,
    });
  });

diagnosticsCmd
  .command('export')
  .description('Export diagnostic bundle for AI assistant analysis')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--out <dir>', 'Output directory (must be within workspace)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeDiagnosticsExport({ workspace: opts.workspace, out: opts.out, json: opts.json });
  });

const pruningCmd = runtimeCmd
  .command('pruning', { hidden: true })
  .description('Non-destructive pruning metrics and health signals');

pruningCmd
  .command('report')
  .description('Show pruning health report — watch/review principle signals')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    handlePruningReport({ workspace: opts.workspace, json: opts.json });
  });

pruningCmd
  .command('explain')
  .description('Explain why a specific principle was flagged')
  .requiredOption('--principle-id <id>', 'Principle ID to explain')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    handlePruningExplain({ principleId: opts.principleId, workspace: opts.workspace, json: opts.json });
  });

pruningCmd
  .command('review')
  .description('Record a human pruning decision for a flagged principle')
  .requiredOption('--principle-id <id>', 'Principle ID to review')
  .requiredOption('--decision <decision>', "Decision: keep, defer, or archive-candidate")
  .option('--note <text>', 'Review note (required for archive-candidate)')
  .option('--reviewer <name>', 'Reviewer name', 'operator')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    handlePruningReview({
      principleId: opts.principleId,
      decision: opts.decision,
      note: opts.note,
      reviewer: opts.reviewer,
      workspace: opts.workspace,
      json: opts.json,
    });
  });

pruningCmd
  .command('rollback')
  .description('Restore a masked principle to injection by overriding archive-candidate')
  .requiredOption('--principle-id <id>', 'Principle ID to restore')
  .option('--note <text>', 'Reason for rollback')
  .option('--reviewer <name>', 'Reviewer name', 'operator')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    handlePruningRollback({
      principleId: opts.principleId,
      note: opts.note,
      reviewer: opts.reviewer,
      workspace: opts.workspace,
      json: opts.json,
    });
  });

pruningCmd
  .command('orphans')
  .description('List orphan derived candidates not found in state.db')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Report only, no modifications (default)')
  .option('--confirm', 'Actually remove orphan references from ledger')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    handlePruningOrphans({
      workspace: opts.workspace,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
      json: opts.json,
    });
  });

// ── Candidate inspection commands ─────────────────────────────────────────────

const candidateCmd = program
  .command('candidate')
  .description('Principle candidate inspection');

candidateCmd
  .command('list')
  .description('List principle candidates for a task')
  .requiredOption('-t, --task-id <taskId>', 'Task ID to query')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleCandidateList(opts);
  });

candidateCmd
  .command('show [candidateId]')
  .description('Show detail for a single principle candidate')
  .requiredOption('-w, --workspace <path>', 'Workspace directory')
  .option('--candidate-id <id>', 'Candidate ID (alternative to positional arg)')
  .option('--json', 'Output raw JSON')
  .action(async (candidateId, opts) => {
    const resolvedId = opts.candidateId ?? candidateId;
    if (!resolvedId) {
      console.error('Error: candidate ID is required (positional or --candidate-id)');
      process.exitCode = 1;
      return;
    }
    if (candidateId && opts.candidateId && candidateId !== opts.candidateId) {
      console.error(`Error: conflicting candidate IDs: positional="${candidateId}", --candidate-id="${opts.candidateId}"`);
      process.exitCode = 1;
      return;
    }
    await handleCandidateShow({ candidateId: resolvedId, ...opts });
  });

candidateCmd
  .command('intake')
  .description('Intake a principle candidate into the ledger')
  .requiredOption('--candidate-id <id>', 'Candidate ID to intake')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output as JSON')
  .option('--dry-run', 'Show what would be written without writing')
  .action(async (opts) => {
    await handleCandidateIntake(opts);
  });

candidateCmd
  .command('audit')
  .description('Audit candidate/ledger consistency for Runtime v2')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await handleCandidateAudit(opts);
  });

candidateCmd
  .command('repair')
  .description('Repair consumed candidate with missing ledger entry')
  .requiredOption('--candidate-id <id>', 'Candidate ID to repair')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await handleCandidateRepair(opts);
  });

candidateCmd
  .command('route')
  .description('Show internalization route decision for a candidate')
  .requiredOption('--candidate-id <id>', 'Candidate ID to inspect')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await handleCandidateRoute(opts);
  });

candidateCmd
  .command('internalize')
  .description('Seed internalization Dreamer task from a candidate')
  .requiredOption('--candidate-id <id>', 'Candidate ID to internalize')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output as JSON')
  .option('--dry-run', 'Preview without writing to database')
  .action(async (opts) => {
    await handleCandidateInternalize(opts);
  });

const candidateInternalizationCmd = candidateCmd
  .command('internalization')
  .description('Internalization pipeline operations for candidates');

candidateInternalizationCmd
  .command('backfill')
  .description('Backfill dreamer tasks for consumed candidates created before Internalization Engine')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Report only, no modifications (default)')
  .option('--confirm', 'Actually create missing dreamer tasks')
  .option('--include-pending', 'Include pending candidates (intake first, then seed dreamer)')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await handleCandidateInternalizationBackfill({ workspace: opts.workspace, dryRun: opts.dryRun, confirm: opts.confirm, includePending: opts.includePending, json: opts.json });
  });

// ── Artifact inspection commands ──────────────────────────────────────────────

const artifactCmd = program
  .command('artifact', { hidden: true })
  .description('Artifact registry inspection');

artifactCmd
  .command('show <artifactId>')
  .description('Show artifact content and its associated candidates')
  .requiredOption('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (artifactId, opts) => {
    await handleArtifactShow({ artifactId, ...opts });
  });

const _legacyCleanupCmd = legacyCmd
  .command('cleanup')
  .description('Clean legacy empathy/diagnostician artifacts and V1 Artificer artifacts from workspace')
  .requiredOption('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Show what would be cleaned without applying (default)')
  .option('--apply', 'Actually apply the cleanup')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    // CLI gate rule 4: --dry-run and --apply are mutually exclusive
    if (opts.dryRun && opts.apply) {
      const msg = 'Error: --dry-run and --apply are mutually exclusive';
      if (opts.json) {
        console.log(JSON.stringify({ status: 'failed', reason: msg, nextAction: 'Specify either --dry-run or --apply, not both' }, null, 2));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }
    // Default to dry-run if neither flag is set (CLI gate rule 4).
    // Pass undefined through — the handler's logic
    // (opts.apply === true ? false : opts.dryRun !== false) correctly
    // defaults to dry-run when both are undefined.
    await handleLegacyCleanup({
      workspacePath: opts.workspace,
      dryRun: opts.dryRun,
      apply: opts.apply,
      json: opts.json ?? false,
    });
  });

// ─── MVP Smoke (PRI-397) ────────────────────────────────────────────────────

registerMvpCommands(program);

// ─── RuleCode CLI (PRI-439 Phase 5) ─────────────────────────────────────────
// Read-only commands: spec, validate, replay. No DB mutation, no artifact writes.

registerRulecodeCommand(program);

// ─── Intent Engineering (PRI-466) ───────────────────────────────────────────
// Owner-authored INTENT.md management: init (create), show (read-only summary).

registerIntentCommand(program);

// ─── Errors List (Task 14: Feedback Pipeline Observability) ────────────────
// Operator diagnostic: aggregates SQLite failed/needs_human_review tasks +
// worker-status.json errors array. Read-only.

registerErrorsListCommand(program);

// ─── Principles Stats (PRI-562 Phase 0) ─────────────────────────────────────
// Owner-facing observability: principle injection volume/cost/duplicates/
// application evidence. Read-only aggregation over event logs + receipt ledger.

registerPrinciplesCommand(program);

const consoleCmd = program
  .command('console')
  .description('Start the pd-console web UI for principle review (default: fallback launcher)')
  .passThroughOptions()
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-p, --port <port>', 'Port to listen on', '3100')
  .option('--no-auth', 'Disable authentication (local dev only)')
  .option('--json', 'Output JSON status', false);

consoleCmd
  .command('start')
  .description('Legacy launcher — start the pd-console on the requested port (no reuse, no browser open)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-p, --port <port>', 'Port to listen on', '3100')
  .option('--no-auth', 'Disable authentication (local dev only)')
  .option('--json', 'Output JSON status', false)
  .action(async (opts) => {
    const { handleConsole } = await import('./commands/console.js');
    await handleConsole({
      workspace: opts.workspace,
      port: opts.port,
      noAuth: opts.auth === false,
      json: opts.json,
    });
  });

// PRI-300: seed-friendly Console launcher with reuse + auto-port + browser open
consoleCmd
  .command('open')
  .description('Open the pd-console in your browser (PRI-300) — auto-port, reuses running console, loopback-only')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-p, --port <port>', 'Preferred port (default 3100; auto-falls back to next free port)')
  .option('--host <host>', 'Loopback host (default 127.0.0.1; non-loopback refused)')
  .option('--no-auth', 'Disable authentication (local dev only)')
  .option('--token <token>', 'Auth token for the Console (or set PD_CONSOLE_TOKEN env var)')
  .option('--no-browser', 'Do not open the system browser on success')
  .option('--json', 'Output JSON status (suppresses browser open)', false)
  .action(async (opts) => {
    const { handleConsoleOpen } = await import('./commands/console.js');
    await handleConsoleOpen({
      workspace: opts.workspace,
      port: opts.port,
      host: opts.host,
      noAuth: opts.auth === false,
      token: opts.token,
      noBrowser: opts.browser === false,
      json: opts.json,
    });
  });

// Default `pd console` → legacy launcher (backward compat)
consoleCmd.action(async (opts) => {
  const { handleConsole } = await import('./commands/console.js');
  await handleConsole({
    workspace: opts.workspace,
    port: opts.port,
    noAuth: opts.auth === false,
    json: opts.json,
  });
});

// ─── Quality Scorecard (PRI-361) ──────────────────────────────────

const qualityCmd = program
  .command('quality', { hidden: true })
  .description('Quality scoring and evaluation');

qualityCmd
  .command('scorecard')
  .description('Generate quality scorecard report for PD pain→diagnosis→principle chain')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--local-model <id>', 'LM Studio model ID', 'qwen3.6-27b-mtp')
  .option('--local-url <url>', 'LM Studio base URL', 'http://localhost:12341/v1')
  .option('--strong-model <id>', 'Strong model for adjudication (provider/model)')
  .option('--skip-strong-model', 'Skip strong model adjudication', false)
  .option('--min-score <n>', 'Minimum pain score to evaluate', '50')
  .option('--limit <n>', 'Max episodes to evaluate (0=all)', '0')
  .option('--format <fmt>', 'Output format: json, markdown, html', 'markdown')
  .option('--output <path>', 'Output file path')
  .option('--json', 'Output as JSON', false)
  .action(async (opts) => {
    const { handleQualityScorecard } = await import('./commands/quality-scorecard.js');
    await handleQualityScorecard(opts);
  });

if (!handleVersionFlag(process.argv.slice(2))) {
  program.parse();
}
