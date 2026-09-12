/**
 * pd samples list command tests — PRI-753 (Trajectory Reader Reality Fix).
 *
 * A missing workspace trajectory database is an operator-visible failure with
 * a next action (cli-6), never a silent "no samples" answer (rc-9).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/pri753-missing-workspace'),
}));

import { handleSamplesList } from '../../src/commands/samples-list.js';

describe('handleSamplesList — unavailable database (PRI-753)', () => {
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
    await expect(handleSamplesList({})).rejects.toThrow('process.exit:1');

    const stderrText = errorSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrText).toContain('Trajectory database unavailable');
    expect(stderrText).toContain(joinPath('.state', 'trajectory.db'));
    expect(stderrText).toContain('pd runtime init --confirm');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

function joinPath(a: string, b: string): string {
  return `${a}${process.platform === 'win32' ? '\\' : '/'}${b}`;
}
