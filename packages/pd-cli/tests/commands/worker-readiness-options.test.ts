/**
 * PRI-1278 Phase 5 review — the host WORKER commands and `pd service` do NOT
 * share an option surface. `--pd-home` is registered only on `pd service …`;
 * a worker probe that appends it is rejected by Commander before the handler
 * runs, which used to leave every fresh workspace in legacy ownership.
 *
 * cli-7: inspect the REAL program registration (no handler execution).
 */
import { describe, expect, it } from 'vitest';
import { buildPdProgram } from '../../src/program.js';

function workerCommand(program: ReturnType<typeof buildPdProgram>, host: 'openclaw' | 'codex' | 'workbuddy') {
  return program.commands.find((c) => c.name() === host)?.commands.find((c) => c.name() === 'worker');
}

describe('worker readiness option surface (real Commander registration)', () => {
  it.each(['openclaw', 'codex', 'workbuddy'] as const)('%s worker does NOT register --pd-home', (host) => {
    const worker = workerCommand(buildPdProgram(), host);
    expect(worker).toBeDefined();
    expect(worker!.options.some((opt) => opt.long === '--pd-home')).toBe(false);
  });

  it('openclaw worker registers the no-consume readiness mode and a workspace', () => {
    const worker = workerCommand(buildPdProgram(), 'openclaw');
    expect(worker!.options.some((opt) => opt.long === '--readiness')).toBe(true);
    expect(worker!.options.some((opt) => opt.long === '--workspace')).toBe(true);
  });

  it.each(['codex', 'workbuddy'] as const)('%s worker registers the no-consume status mode and a workspace', (host) => {
    const worker = workerCommand(buildPdProgram(), host);
    expect(worker!.options.some((opt) => opt.long === '--status')).toBe(true);
    expect(worker!.options.some((opt) => opt.long === '--workspace')).toBe(true);
  });

  it('pd service run-once DOES register --pd-home (the trusted injection seam)', () => {
    const program = buildPdProgram();
    const runOnce = program.commands.find((c) => c.name() === 'service')?.commands.find((c) => c.name() === 'run-once');
    expect(runOnce!.options.some((opt) => opt.long === '--pd-home')).toBe(true);
  });
});
