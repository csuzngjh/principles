import { describe, it, expect, vi, afterEach } from 'vitest';

// PRI-1061 review fix: an unresolvable workspace forces the emitFailure path.
vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: () => {
    throw new Error('simulated: no PD workspace here');
  },
}));

// Module-scope import: the CLI graph is expensive to load and doing it inside
// a test body trips the default 5s timeout on a cold cache.
import { handlePainExplicit } from '../../src/commands/pain-explicit.js';

describe('emitFailure exit path (cli-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not return when process.exit is stubbed — the caller must not continue', async () => {
    // emitFailure is declared `never`; before the fix it only called
    // process.exit(1), so a stubbed exit made it return undefined and the
    // caller continued with unassigned bindings. The explicit throw keeps the
    // `never` contract honest.
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(handlePainExplicit({ json: true, statement: 'x' } as never)).rejects.toThrow(
      /unreachable: emitFailure\(workspace_unresolvable\)/,
    );
  });
});
