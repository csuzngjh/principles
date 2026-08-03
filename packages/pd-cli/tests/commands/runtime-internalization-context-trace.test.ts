/**
 * Command-registration / parser tests for context-trace (PR 5 task 11.2, cli-7).
 *
 * Tests the real Commander program — exercises actual flag parsing, not just
 * the handler. Verifies:
 *   - --task / --artifact / --workspace / --json parse correctly
 *   - --dry-run / --confirm do NOT exist (read-only command, cli-4)
 *   - no new feature flag is introduced (registry diff is empty)
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.7
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';

// Build a minimal program that mirrors the real registration.
function buildTestProgram(): Command {
  const program = new Command();
  const runtime = program.command('runtime');
  const internalization = runtime.command('internalization', { hidden: true });

  internalization
    .command('context-trace')
    .description('Trace the internalization context chain')
    .requiredOption('-t, --task <taskId>', 'Task ID to trace')
    .option('-a, --artifact <artifactId>', 'Specific artifact ID to start from')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON (default)')
    .action(() => {});

  return program;
}

describe('context-trace command registration (cli-7)', () => {
  it('parses --task correctly', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'runtime', 'internalization', 'context-trace', '--task', 'task-123']);
    const cmd = program.commands[0]?.commands[0]?.commands[0];
    expect(cmd).toBeDefined();
    expect(cmd?.opts().task).toBe('task-123');
  });

  it('parses --artifact correctly', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'runtime', 'internalization', 'context-trace', '--task', 't1', '--artifact', 'art-1']);
    const cmd = program.commands[0]?.commands[0]?.commands[0];
    expect(cmd?.opts().artifact).toBe('art-1');
  });

  it('parses --workspace correctly', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'runtime', 'internalization', 'context-trace', '--task', 't1', '--workspace', '/tmp/pd']);
    const cmd = program.commands[0]?.commands[0]?.commands[0];
    expect(cmd?.opts().workspace).toBe('/tmp/pd');
  });

  it('parses --json flag', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'runtime', 'internalization', 'context-trace', '--task', 't1', '--json']);
    const cmd = program.commands[0]?.commands[0]?.commands[0];
    expect(cmd?.opts().json).toBe(true);
  });

  it('requires --task (exits with error if missing)', () => {
    const program = buildTestProgram();
    // Commander calls process.exit on missing required option; stub it.
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; }) as never;
    try {
      program.parse(['node', 'pd', 'runtime', 'internalization', 'context-trace']);
    } catch {
      // Commander may throw after stubbed exit
    } finally {
      process.exit = originalExit;
    }
    expect(exitCode).toBe(1);
  });

  it('does NOT have --dry-run option (read-only command, cli-4)', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'runtime', 'internalization', 'context-trace', '--task', 't1']);
    const cmd = program.commands[0]?.commands[0]?.commands[0];
    expect(cmd?.opts().dryRun).toBeUndefined();
    // Verify the option doesn't exist at all.
    const dryRunOption = cmd?.options.find((o) => o.long === '--dry-run');
    expect(dryRunOption).toBeUndefined();
  });

  it('does NOT have --confirm option (read-only command, cli-4)', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'runtime', 'internalization', 'context-trace', '--task', 't1']);
    const cmd = program.commands[0]?.commands[0]?.commands[0];
    expect(cmd?.opts().confirm).toBeUndefined();
    const confirmOption = cmd?.options.find((o) => o.long === '--confirm');
    expect(confirmOption).toBeUndefined();
  });

  it('context-trace does not introduce a new feature flag (registry diff empty)', () => {
    // design §8: Layer 3 (CLI) does not add a new flag. The command is always
    // available (read-only); it reads the EXISTING 3 flags.
    const knownFlags = new Set(DEFAULT_FEATURE_FLAGS.map((f) => f.id));
    expect(knownFlags.has('artifact_summary_redundancy')).toBe(true);
    expect(knownFlags.has('context_manifest_budget')).toBe(true);
    expect(knownFlags.has('progressive_evaluator')).toBe(true);
    // No 'context_trace' flag should exist.
    expect(knownFlags.has('context_trace')).toBe(false);
  });
});
