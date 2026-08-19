/**
 * Tests for console-launcher openBrowser command-injection hardening (PRI-547).
 *
 * The win32 opener must never route the URL through a shell
 * (`cmd.exe /c start "" <url>`). It must use a parameterized spawn of
 * `explorer.exe` with an argument array, and the URL must be validated as
 * http(s) before any spawn.
 *
 * Covers:
 * - http(s) URLs accepted
 * - non-http(s) schemes rejected before spawn (no child process created)
 * - shell metacharacters cannot reach a shell (spawn called with arg array)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'services',
  'console-launcher.js',
);

describe('openBrowser URL validation and no-shell spawn', () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let platformSpy: ReturnType<typeof vi.spyOn>;

  const fakeChild = () => {
    const child: any = { on: vi.fn(), unref: vi.fn() };
    return child;
  };

  beforeEach(() => {
    spawnMock = vi.fn(() => fakeChild());
    vi.doMock('child_process', () => ({ spawn: spawnMock, execFile: vi.fn(), execFileSync: vi.fn() }));
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as any);
  });

  afterEach(() => {
    vi.doUnmock('child_process');
    platformSpy.mockRestore();
    vi.resetModules();
  });

  async function loadOpenBrowser() {
    const mod = await import(launcherPath);
    return mod.openBrowser as (url: string) => Promise<{ opened: boolean; reason?: string; nextAction?: string }>;
  }

  it('opens an https URL via parameterized explorer.exe spawn (no shell)', async () => {
    const openBrowser = await loadOpenBrowser();
    const result = await openBrowser('https://localhost:8123');

    expect(result.opened).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('explorer.exe');
    // Argument array — never a shell command string
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['https://localhost:8123/']);
    // No shell option
    expect(opts.shell).not.toBeDefined();
  });

  it('accepts http URL on localhost (legitimate local console)', async () => {
    const openBrowser = await loadOpenBrowser();
    const result = await openBrowser('http://127.0.0.1:8123');

    expect(result.opened).toBe(true);
    expect(spawnMock.mock.calls[0][1]).toEqual(['http://127.0.0.1:8123/']);
  });

  it('rejects javascript: scheme without spawning', async () => {
    const openBrowser = await loadOpenBrowser();
    const result = await openBrowser('javascript:alert(1)');

    expect(result.opened).toBe(false);
    expect(result.reason).toContain('protocol');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects file: scheme without spawning', async () => {
    const openBrowser = await loadOpenBrowser();
    const result = await openBrowser('file:///etc/passwd');

    expect(result.opened).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects empty URL without spawning', async () => {
    const openBrowser = await loadOpenBrowser();
    const result = await openBrowser('');

    expect(result.opened).toBe(false);
    expect(result.reason).toContain('empty');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('shell metacharacters in a valid http URL stay as data (arg array, not shell)', async () => {
    const openBrowser = await loadOpenBrowser();
    const sneaky = 'http://localhost:8123/path?a=1&b=2;calc.exe';
    const result = await openBrowser(sneaky);

    expect(result.opened).toBe(true);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.length).toBe(1);
    // The whole URL is a single argument — the spawn call has no shell so
    // metacharacters cannot be interpreted as commands.
    expect(args[0]).toContain(';calc.exe');
  });
});
