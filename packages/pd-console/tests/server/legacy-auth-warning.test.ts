import { describe, it, expect, vi, afterEach } from 'vitest';
import { warnAboutLegacyAuthArgs } from '../../src/server/index.js';

/**
 * The Console has no application-level credential. Old launchers and shell
 * profiles may still pass `--token` / `--no-auth` or export
 * `PD_CONSOLE_TOKEN`; those values are ignored, but the operator gets one
 * line saying so instead of silently believing a secret still guards the UI.
 */
describe('warnAboutLegacyAuthArgs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('stays quiet for a normal launch', () => {
    vi.stubEnv('PD_CONSOLE_TOKEN', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnAboutLegacyAuthArgs(['node', 'server.js', '--port', '3210', '--host', '127.0.0.1']);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('explains that --token is ignored', () => {
    vi.stubEnv('PD_CONSOLE_TOKEN', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnAboutLegacyAuthArgs(['node', 'server.js', '--token', 'secret']);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('--token is no longer used'));
  });

  it('explains that --no-auth is no longer needed', () => {
    vi.stubEnv('PD_CONSOLE_TOKEN', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnAboutLegacyAuthArgs(['node', 'server.js', '--no-auth']);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('--no-auth is no longer needed'));
  });

  it('explains that PD_CONSOLE_TOKEN is ignored', () => {
    vi.stubEnv('PD_CONSOLE_TOKEN', 'secret');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnAboutLegacyAuthArgs(['node', 'server.js']);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PD_CONSOLE_TOKEN is no longer used'));
  });
});
