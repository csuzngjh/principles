/**
 * PRI-1221 (cli-7): real command-registration contract for
 * `pd runtime internalization run-once`.
 *
 * The handler-level parser tests use a hand-copied command, so they cannot catch
 * a regression that restores the `--runner` default in src/program.ts. This reads
 * the ACTUAL registered option from buildPdProgram() — the same object the CLI
 * ships — and asserts omitting --runner leaves it undefined (auto-discovery),
 * which is the wiring the handler's `opts.runner === undefined` branch relies on.
 */
import { describe, it, expect } from 'vitest';
import type { Command, Option } from 'commander';
import { buildPdProgram } from '../../src/program.js';

function findRunOnce(): Command {
  const program = buildPdProgram();
  const runtime = program.commands.find((c) => c.name() === 'runtime');
  expect(runtime, 'runtime command must be registered').toBeDefined();
  const internalization = runtime!.commands.find((c) => c.name() === 'internalization');
  expect(internalization, 'internalization command must be registered').toBeDefined();
  const runOnce = internalization!.commands.find((c) => c.name() === 'run-once');
  expect(runOnce, 'run-once command must be registered').toBeDefined();
  return runOnce!;
}

describe('PRI-1221: run-once real registration (cli-7)', () => {
  it('--runner has no default value (omission yields undefined → auto-discovery)', () => {
    const runOnce = findRunOnce();
    const runnerOption = runOnce.options.find((o: Option) => o.long === '--runner');
    expect(runnerOption, '--runner option must be registered').toBeDefined();
    // Restoring the legacy 'dreamer' default here would silently disable
    // auto-discovery; this assertion fails closed if that regression returns.
    expect(runnerOption!.defaultValue).toBeUndefined();
  });

  it('--runner is optional to pass but takes a required value when present', () => {
    const runOnce = findRunOnce();
    const runnerOption = runOnce.options.find((o: Option) => o.long === '--runner');
    expect(runnerOption!.mandatory).toBe(false); // not a requiredOption — omission is legal
    expect(runnerOption!.required).toBe(true);   // --runner <kind> requires a value when passed
  });
});