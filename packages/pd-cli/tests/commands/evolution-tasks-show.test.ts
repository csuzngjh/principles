/**
 * pd evolution tasks show command tests — PRI-753 (Trajectory Reader Reality Fix).
 *
 * "Task not found" (database present, row absent) and "database unavailable"
 * (file missing) are different failures and must stay distinguishable (cli-6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/pri753-missing-workspace'),
}));

import { handleEvolutionTasksShow } from '../../src/commands/evolution-tasks-show.js';

describe('handleEvolutionTasksShow — unavailable database (PRI-753)', () => {
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
    await expect(handleEvolutionTasksShow({ id: 'task-001' })).rejects.toThrow('process.exit:1');

    const stderrText = errorSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrText).toContain('Trajectory database unavailable');
    expect(stderrText).toContain('trajectory.db');
    expect(stderrText).toContain('pd runtime init --confirm');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports unavailable instead of "Task not found" when the database is missing', async () => {
    await expect(handleEvolutionTasksShow({ id: 'task-001' })).rejects.toThrow('process.exit:1');

    const stderrText = errorSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrText).not.toContain('Task not found');
  });
});
