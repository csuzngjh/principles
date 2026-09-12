/**
 * pd evolution tasks list command tests — PRI-753 (Trajectory Reader Reality Fix).
 *
 * Before PRI-753 this handler wrapped every error as "No evolution tasks
 * found." — including a missing database and real database failures. A
 * missing trajectory database must now fail loud with reason and next action
 * (cli-6), never masquerade as an empty task list (rc-9).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/pri753-missing-workspace'),
}));

import { handleEvolutionTasksList } from '../../src/commands/evolution-tasks-list.js';

describe('handleEvolutionTasksList — unavailable database (PRI-753)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails loud with reason and next action when trajectory.db is missing', async () => {
    await expect(handleEvolutionTasksList({ status: 'all' })).rejects.toThrow('process.exit:1');

    const stderrText = errorSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrText).toContain('Trajectory database unavailable');
    expect(stderrText).toContain('trajectory.db');
    expect(stderrText).toContain('pd runtime init --confirm');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
