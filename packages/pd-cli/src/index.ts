#!/usr/bin/env node
/**
 * pd CLI — Principles Disciple command-line interface.
 *
 * Usage:
 *   pd pain record --reason <text> [--score N] [--source manual]
 */

import { Command } from 'commander';
import { handlePainRecord } from './commands/pain-record.js';
import { handleSamplesList } from './commands/samples-list.js';
import { handleSamplesReview } from './commands/samples-review.js';
import { handleEvolutionTasksList } from './commands/evolution-tasks-list.js';
import { handleEvolutionTasksShow } from './commands/evolution-tasks-show.js';
import { handleHealth } from './commands/health.js';
import { handleCentralSync } from './commands/central-sync.js';
import { handleTaskList, handleTaskShow } from './commands/task.js';
import { handleRunList, handleRunShow } from './commands/run.js';
import { handleTrajectoryLocate } from './commands/trajectory.js';
import { handleHistoryQuery } from './commands/history.js';
import { handleContextBuild } from './commands/context.js';
import { handleLegacyImportOpenClaw } from './commands/legacy-import.js';
import { handleLegacyCleanup } from './commands/legacy-cleanup.js';
import { handleDiagnoseStatus, handleDiagnoseRun } from './commands/diagnose.js';
import { handleRuntimeProbe } from './commands/runtime.js';
import { handleFlowShow } from './commands/flow.js';
import { handleTraceShow } from './commands/trace.js';
import { handlePruningReport, handlePruningExplain, handlePruningReview, handlePruningRollback, handlePruningOrphans } from './commands/runtime-pruning.js';
import { handleRuntimeHealthSnapshot } from './commands/runtime-health-snapshot.js';
import { handleRuntimeGfiSnapshot } from './commands/runtime-gfi-snapshot.js';
import { handleRuntimeUat } from './commands/runtime-uat.js';
import { handleRuntimeInternalizationQueue } from './commands/runtime-internalization-queue.js';
import { handleRuntimeInternalizationWakeOnce } from './commands/runtime-internalization-wake-once.js';
import { handleRuntimeInternalizationRunOnce } from './commands/runtime-internalization-run-once.js';
import { handleCandidateList, handleCandidateShow, handleCandidateIntake, handleCandidateAudit, handleCandidateRepair, handleCandidateRoute, handleCandidateInternalize, handleCandidateInternalizationBackfill } from './commands/candidate.js';
import { handleArtifactShow } from './commands/artifact.js';
import { handleRuntimeCanary } from './commands/runtime-canary.js';
import { handleRuntimeSyntheticBaseline } from './commands/runtime-synthetic-baseline.js';
import { handleRuntimeInternalizationIntegrity } from './commands/runtime-internalization-integrity.js';
import { handleRuntimeInternalizationIntegrityRepair } from './commands/runtime-internalization-integrity-repair.js';
import { handleRuntimeInternalizationEnqueueSuccessors } from './commands/runtime-internalization-enqueue-successors.js';
import { handleRuntimeDiagnosticsExport } from './commands/runtime-diagnostics-export.js';
import { handleRuntimeRecoverySweep } from './commands/runtime-recovery.js';
import { handleRuntimeIdleTriggerEvaluate } from './commands/runtime-idle-trigger.js';
import { handleRuntimeActivationDispatch } from './commands/runtime-activation.js';

const program = new Command();

program
  .name('pd')
  .description('PD CLI — Pain recording, sample management, and evolution tasks')
  .version('0.1.0');

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
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handlePainRecord(opts);
  });

const samplesCmd = program
  .command('samples')
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
  .command('evolution')
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

program
  .command('health')
  .description('Show health diagnostics for all workspaces')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleHealth(opts);
  });

const centralCmd = program
  .command('central')
  .description('Central server management');

centralCmd
  .command('sync')
  .description('Trigger a sync cycle and report results')
  .action(async () => {
    await handleCentralSync();
  });

// ── Runtime v2 task/run commands ──────────────────────────────────────────────

const rtTaskCmd = program
  .command('task')
  .description('Runtime v2 task inspection');

rtTaskCmd
  .command('list')
  .description('List runtime tasks')
  .option('-s, --status <status>', 'Filter by status (pending, leased, retry_wait, succeeded, failed)')
  .option('-k, --kind <kind>', 'Filter by task kind')
  .option('-l, --limit <number>', 'Limit number of results', parseInt, 50)
  .action(async (opts) => {
    await handleTaskList(opts);
  });

rtTaskCmd
  .command('show <taskId>')
  .description('Show detailed task information')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (taskId, opts) => {
    await handleTaskShow({ id: taskId, json: opts.json, workspace: opts.workspace });
  });

const rtRunCmd = program
  .command('run')
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

// ── Runtime v2 trajectory/history/context commands ───────────────────────────

const trajectoryCmd = program
  .command('trajectory')
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
  .command('history')
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
  .command('context')
  .description('Runtime v2 context assembly');

contextCmd
  .command('build <taskId>')
  .description('Assemble diagnostician context for a task')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (taskId, opts) => {
    await handleContextBuild(taskId, opts);
  });

// ── Legacy import command ───────────────────────────────────────────────────────

const legacyCmd = program
  .command('legacy')
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

// ── Diagnostician run/status commands ─────────────────────────────────────

const diagnoseCmd = program
  .command('diagnose')
  .description('Diagnostician execution and status inspection');

diagnoseCmd
  .command('status')
  .description('Inspect diagnostician task status')
  .requiredOption('-t, --task-id <taskId>', 'Task ID to inspect')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleDiagnoseStatus(opts);
  });

diagnoseCmd
  .command('run')
  .description('Execute diagnostician runner for a task')
  .requiredOption('-t, --task-id <taskId>', 'Task ID to execute')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-r, --runtime <kind>', "Runtime kind: 'openclaw-cli', 'test-double', 'pi-ai'")
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

// ── Runtime probe command (HG-01 HARD GATE) ─────────────────────────────────

const runtimeCmd = program
  .command('runtime')
  .description('Runtime inspection and health checks');

runtimeCmd
  .command('canary')
  .description('One-shot control plane health canary')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeCanary({ workspace: opts.workspace, json: opts.json });
  });

runtimeCmd
  .command('synthetic')
  .description('Synthetic workload baseline commands')
  .command('baseline')
  .description('Run synthetic PD workload baseline (PRI-206) — deterministic, no LLM required')
  .option('-w, --workspace <path>', 'Workspace directory (default: temp workspace)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeSyntheticBaseline({ workspace: opts.workspace, json: opts.json });
  });

runtimeCmd
  .command('probe')
  .description('Probe runtime health and capabilities (HG-01 HARD GATE)')
  .requiredOption('-r, --runtime <kind>', "Runtime kind: 'openclaw-cli' or 'pi-ai'")
  .option('--openclaw-local', 'Use local OpenClaw (mutually exclusive with --openclaw-gateway)')
  .option('--openclaw-gateway', 'Use gateway OpenClaw (mutually exclusive with --openclaw-local)')
  .option('-a, --agent <agentId>', 'Agent ID to probe')
  .option('--provider <name>', 'LLM provider (e.g., openrouter) — for pi-ai, falls back to --workspace workflows.yaml')
  .option('--model <id>', 'Model ID (e.g., anthropic/claude-sonnet-4) — for pi-ai, falls back to --workspace workflows.yaml')
  .option('--apiKeyEnv <name>', 'Env var name for API key (e.g., OPENROUTER_API_KEY) — for pi-ai, falls back to --workspace workflows.yaml')
  .option('--baseUrl <url>', 'Custom base URL for OpenAI-compatible providers — for pi-ai, falls back to --workspace workflows.yaml')
  .option('--maxRetries <n>', 'Max retry attempts for LLM failures', parseInt)
  .option('--timeoutMs <ms>', 'Timeout in milliseconds for probe', parseInt)
  .option('-w, --workspace <path>', 'Workspace directory — loads pi-ai policy from .state/workflows.yaml')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeProbe(opts);
  });

const flowCmd = runtimeCmd
  .command('flow')
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
  .command('trace')
  .description('Trace full pain-to-ledger chain');

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
  .command('uat')
  .description('Runtime V2 chain UAT baseline runner')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--count <n>', 'Number of iterations (default: 5, max: 50)', parseInt)
  .option('--min-success-rate <rate>', 'Minimum success rate threshold (default: 1.0)', parseFloat)
  .option('--json', 'Output machine-readable JSON summary')
  .action(async (opts) => {
    await handleRuntimeUat({
      workspace: opts.workspace,
      count: opts.count,
      minSuccessRate: opts.minSuccessRate,
      json: opts.json,
    });
  });

const runtimeHealthCmd = runtimeCmd
  .command('health')
  .description('Runtime V2 health inspection');

runtimeHealthCmd
  .command('snapshot')
  .description('Operator health snapshot combining chain, ledger, and pruning status')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeHealthSnapshot({ workspace: opts.workspace, json: opts.json });
  });

runtimeHealthCmd
  .command('gfi')
  .description('GFI workspace snapshot — active vs stale session breakdown')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeGfiSnapshot({ workspace: opts.workspace, json: opts.json });
  });

// PRI-82: pd runtime gfi snapshot — canonical operator command (alias of runtime health gfi)
runtimeCmd
  .command('gfi')
  .description('GFI workspace snapshot — active vs stale session breakdown')
  .command('snapshot')
  .description('GFI workspace snapshot for the operator (alias: pd runtime health gfi)')
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
  .command('run-once')
  .description('Wake-and-run: lease the next PI task and execute it')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--runner <kind>', 'Runner kind to execute (default: dreamer)', 'dreamer')
  .option('--runtime <kind>', 'Runtime adapter kind: config (from workflows.yaml), pi-ai, openclaw-cli, test-double (default: config)', 'config')
  .option('--allow-test-double', 'Acknowledge that test-double runtime will mutate real queue state')
  .option('--enqueue-next', 'After successful runner execution, commit successor task to queue')
  .option('--timeout-ms <ms>', 'Runner timeout in milliseconds (default: 300000, overrides workflows.yaml)', parseInt)
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeInternalizationRunOnce({ workspace: opts.workspace, json: opts.json, runtime: opts.runtime, runner: opts.runner, allowTestDouble: opts.allowTestDouble, enqueueNext: opts.enqueueNext, timeoutMs: opts.timeoutMs });
  });

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

const idleTriggerCmd = runtimeCmd
  .command('idle-trigger')
  .description('Idle trigger decision model (read-only)');

idleTriggerCmd
  .command('evaluate')
  .description('Evaluate whether idle trigger should fire (read-only, no mutations)')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output raw JSON')
  .option('--enabled <boolean>', 'Override config enabled', v => v === 'true')
  .option('--idle-threshold-ms <number>', 'Override idle threshold in ms', parseInt)
  .option('--jitter-max-ms <number>', 'Override jitter max in ms', parseInt)
  .option('--activity-cooldown-ms <number>', 'Override activity cooldown in ms', parseInt)
  .option('--jitter-seed <string>', 'Jitter seed for deterministic evaluation')
  .action(async (opts) => {
    await handleRuntimeIdleTriggerEvaluate({
      workspace: opts.workspace,
      json: opts.json,
      enabled: opts.enabled,
      idleThresholdMs: opts.idleThresholdMs,
      jitterMaxMs: opts.jitterMaxMs,
      activityCooldownMs: opts.activityCooldownMs,
      jitterSeed: opts.jitterSeed,
    });
  });

const activationCmd = runtimeCmd
  .command('activation')
  .description('Activation dispatch operations');

activationCmd
  .command('dispatch')
  .description('Dispatch an activation for a rollout-reviewed artifact')
  .requiredOption('-a, --artifact-id <id>', 'PIArtifact ID to activate')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-c, --channel <channel>', 'Activation channel (prompt|defer_archive)', 'prompt')
  .option('--dry-run', 'Dry-run mode (default, no writes)')
  .option('--confirm', 'Confirm and write activation record')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await handleRuntimeActivationDispatch({
      workspace: opts.workspace,
      artifactId: opts.artifactId,
      channel: opts.channel,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
      json: opts.json,
    });
  });

const diagnosticsCmd = runtimeCmd
  .command('diagnostics')
  .description('Control plane diagnostic bundle operations');

const recoveryCmd = runtimeCmd
  .command('recovery')
  .description('Runtime V2 lease recovery operations');

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
  .command('pruning')
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

// ── Candidate inspection commands ───────────────────────────────────────────

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
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await handleCandidateInternalizationBackfill({ workspace: opts.workspace, dryRun: opts.dryRun, confirm: opts.confirm, json: opts.json });
  });

// ── Artifact inspection commands ────────────────────────────────────────────

const artifactCmd = program
  .command('artifact')
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
  .description('Clean legacy empathy/diagnostician artifacts from workspace')
  .requiredOption('-w, --workspace <path>', 'Workspace directory')
  .option('--dry-run', 'Show what would be cleaned without applying', false)
  .option('--apply', 'Actually apply the cleanup', false)
  .action(async (opts) => {
    const apply = opts.apply ?? false;
    if (!apply && !opts.dryRun) {
      console.error('Specify --dry-run or --apply');
      process.exit(1);
    }
    await handleLegacyCleanup(opts.workspace, apply);
  });

program.parse();
