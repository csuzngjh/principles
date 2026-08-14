/**
 * cli-7 test-wiring: prove the real `registerHealthCommand` (used by the CLI
 * entrypoint) wires the `--host codex` flag, dispatches to handleHealthCodex,
 * and rejects unknown host values with a structured error + non-zero exit.
 *
 * Handlers are injected so the test exercises the real production registration
 * without executing real workspace/DB I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerHealthCommand } from '../../src/commands/health.js';

const mockHandleHealth = vi.fn();
const mockHandleHealthCodex = vi.fn();

const originalExitCode = process.exitCode;

function buildHealthCommand(): Command {
  const program = new Command();
  registerHealthCommand(program, { health: mockHandleHealth, healthCodex: mockHandleHealthCodex });
  return program;
}

describe('cli-7: pd health --host flag wiring (production registration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = originalExitCode;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('dispatches to handleHealthCodex when --host codex is passed', async () => {
    const program = buildHealthCommand();
    await program.parseAsync(['node', 'pd', 'health', '--host', 'codex', '--json']);
    expect(mockHandleHealthCodex).toHaveBeenCalledTimes(1);
    expect(mockHandleHealthCodex).toHaveBeenCalledWith(expect.objectContaining({ host: 'codex', json: true }));
    expect(mockHandleHealth).not.toHaveBeenCalled();
  });

  it('dispatches to handleHealth when --host is omitted (defaults to openclaw)', async () => {
    const program = buildHealthCommand();
    await program.parseAsync(['node', 'pd', 'health']);
    expect(mockHandleHealth).toHaveBeenCalledTimes(1);
    expect(mockHandleHealthCodex).not.toHaveBeenCalled();
  });

  it('dispatches to handleHealth when --host openclaw is passed', async () => {
    const program = buildHealthCommand();
    await program.parseAsync(['node', 'pd', 'health', '--host', 'openclaw']);
    expect(mockHandleHealth).toHaveBeenCalledTimes(1);
    expect(mockHandleHealthCodex).not.toHaveBeenCalled();
  });

  it('passes --workspace through to handleHealthCodex', async () => {
    const program = buildHealthCommand();
    await program.parseAsync(['node', 'pd', 'health', '--host', 'codex', '-w', '/some/path']);
    expect(mockHandleHealthCodex).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/some/path' }));
  });

  it('rejects an unknown --host value without dispatching', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = buildHealthCommand();
    await program.parseAsync(['node', 'pd', 'health', '--host', 'codxe', '--json']);
    expect(mockHandleHealth).not.toHaveBeenCalled();
    expect(mockHandleHealthCodex).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('invalid_host');
    expect(payload.host).toBe('codxe');
    expect(payload.nextAction).toBeTruthy();
    logSpy.mockRestore();
  });
});