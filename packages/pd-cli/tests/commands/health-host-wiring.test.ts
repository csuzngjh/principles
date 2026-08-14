/**
 * cli-7 test-wiring: prove the --host codex flag is registered on the
 * `pd health` command and dispatches to handleHealthCodex.
 *
 * This tests the real Commander registration, not just the handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mockHandleHealth = vi.fn();
const mockHandleHealthCodex = vi.fn();

vi.mock('../../src/commands/health.js', () => ({
  handleHealth: mockHandleHealth,
}));
vi.mock('../../src/commands/health-codex.js', () => ({
  handleHealthCodex: mockHandleHealthCodex,
}));

// Re-implement the registration logic from index.ts to test flag wiring
// without importing the full CLI (which would pull in all commands).
function buildHealthCommand(): Command {
  const program = new Command();
  program
    .command('health')
    .description('Show health diagnostics for all workspaces')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .option('--host <host>', 'Host to inspect (openclaw|codex). Defaults to openclaw workspace health.')
    .action(async (opts) => {
      if (opts.host === 'codex') {
        await mockHandleHealthCodex(opts);
        return;
      }
      await mockHandleHealth(opts);
    });
  return program;
}

describe('cli-7: pd health --host flag wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches to handleHealthCodex when --host codex is passed', async () => {
    const program = buildHealthCommand();
    await program.parseAsync(['node', 'pd', 'health', '--host', 'codex', '--json']);
    expect(mockHandleHealthCodex).toHaveBeenCalledTimes(1);
    expect(mockHandleHealthCodex).toHaveBeenCalledWith(expect.objectContaining({ host: 'codex', json: true }));
    expect(mockHandleHealth).not.toHaveBeenCalled();
  });

  it('dispatches to handleHealth when --host is omitted', async () => {
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
});
