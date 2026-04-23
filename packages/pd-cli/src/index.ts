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
  .description('Record a pain signal')
  .option('-r, --reason <text>', 'Reason for the pain signal (required)')
  .option('-s, --score <number>', 'Pain score 0-100', parseInt)
  .option('-S, --source <text>', 'Source of the pain signal', 'manual')
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
  .option('-w, --workspace <path>', 'Workspace directory (required for trajectory/history/context commands)')
  .action(async (_opts) => {
    await handleHealth();
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
  .action(async (taskId) => {
    await handleTaskShow({ id: taskId });
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

program.parse();
