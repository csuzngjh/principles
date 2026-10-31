import { describe, it, expect, vi, afterEach } from 'vitest';

// PRI-1061 review fix: force the lazy import to REJECT so the degraded branch
// runs. A throwing module factory makes `await import(...)` reject exactly as
// it does on a workbuddy-host install that ships no codex adapter.
vi.mock('@principles/codex-adapter', () => {
  throw new Error('simulated: @principles/codex-adapter is not installed');
});

// Loaded at module scope: the CLI module graph pulls host-runtime + core, and
// paying that cost inside a test body makes the test look like a hang.
import { handleHealthCodex } from '../../src/commands/health-codex.js';

describe('handleHealthCodex degraded exit path (cli-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cleanly when process.exit is stubbed — never destructures undefined', async () => {
    // A stub that does NOT throw reproduces every in-process caller (and any
    // test) where `process.exit(1)` returns control to the caller. Before the
    // fix the next statement was `const {...} = codexAdapter` on undefined,
    // i.e. a TypeError instead of a clean degraded exit.
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(handleHealthCodex({ json: true, workspace: process.cwd() })).resolves.toBeUndefined();

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({ status: 'failed', reason: 'codex_adapter_unavailable' });
    expect(typeof payload.nextAction).toBe('string');
    expect(payload.nextAction.length).toBeGreaterThan(0);
  });
});
