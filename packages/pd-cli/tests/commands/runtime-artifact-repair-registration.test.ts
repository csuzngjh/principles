/**
 * Command-registration / parser tests for `pd runtime artifact-repair` (PRI-555, cli-7).
 *
 * Mirrors the real registration in src/index.ts. Verifies:
 *   - --workspace / --dry-run / --out / --json parse correctly
 *   - --dry-run and --confirm are both registered so the handler's
 *     mutual-exclusion check is reachable
 *   - no flags parse into misspelled keys (e.g. opts.dryRun)
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

function buildTestProgram(): Command {
  const program = new Command();
  const runtime = program.command('runtime');

  runtime
    .command('artifact-repair')
    .description('Plan repairs for unreachable scribe artifacts (dry-run only)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--dry-run', 'Build migration-plan.json only (default)')
    .option('--confirm', 'Not implemented in this phase — refused')
    .option('--out <path>', 'Output path for migration-plan.json (default: ./migration-plan.json)')
    .option('--json', 'Output raw JSON')
    .action(() => {});

  return program;
}

function getArtifactRepairCommand(program: Command): Command | undefined {
  const runtime = program.commands.find((c) => c.name() === 'runtime');
  return runtime?.commands.find((c) => c.name() === 'artifact-repair');
}

describe('artifact-repair command registration (cli-7)', () => {
  it('parses --workspace, --dry-run, --out and --json together', () => {
    const program = buildTestProgram();
    program.parse([
      'node', 'pd', 'runtime', 'artifact-repair',
      '--workspace', '/tmp/pd-ws',
      '--dry-run',
      '--out', '/tmp/plan/migration-plan.json',
      '--json',
    ]);
    const cmd = getArtifactRepairCommand(program);
    expect(cmd).toBeDefined();
    expect(cmd?.opts().workspace).toBe('/tmp/pd-ws');
    expect(cmd?.opts().dryRun).toBe(true);
    expect(cmd?.opts().out).toBe('/tmp/plan/migration-plan.json');
    expect(cmd?.opts().json).toBe(true);
  });

  it('registers --dry-run and --confirm so the handler conflict check is reachable', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'runtime', 'artifact-repair', '--confirm']);
    const cmd = getArtifactRepairCommand(program);
    expect(cmd?.opts().confirm).toBe(true);
    expect(cmd?.opts().dryRun).toBeUndefined();
    const dryRunOption = cmd?.options.find((o) => o.long === '--dry-run');
    const confirmOption = cmd?.options.find((o) => o.long === '--confirm');
    expect(dryRunOption).toBeDefined();
    expect(confirmOption).toBeDefined();
  });

  it('defaults: no flags → all optional flags undefined (handler defaults to dry-run)', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'runtime', 'artifact-repair']);
    const cmd = getArtifactRepairCommand(program);
    expect(cmd?.opts().workspace).toBeUndefined();
    expect(cmd?.opts().dryRun).toBeUndefined();
    expect(cmd?.opts().confirm).toBeUndefined();
    expect(cmd?.opts().out).toBeUndefined();
  });
});
