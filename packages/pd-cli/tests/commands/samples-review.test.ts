/**
 * pd samples review command tests — PRI-753 (Trajectory Reader Reality Fix).
 *
 * A missing workspace trajectory database is an operator-visible failure with
 * a next action (cli-6); failure exits before any mutation (cli-2/cli-5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/pri753-missing-workspace'),
}));

import { handleSamplesReview } from '../../src/commands/samples-review.js';

describe('handleSamplesReview — unavailable database (PRI-753)', () => {
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
    await expect(handleSamplesReview({ sampleId: 'sample-001', decision: 'approve' })).rejects.toThrow(
      'process.exit:1'
    );

    const stderrText = errorSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrText).toContain('Trajectory database unavailable');
    expect(stderrText).toContain('trajectory.db');
    expect(stderrText).toContain('pd runtime init --confirm');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
