import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApplyFullTimeoutMs } from '../../../src/server/update-timeout.js';

const ENV_KEY = 'PD_UPDATE_APPLY_FULL_TIMEOUT_MS';

describe('apply-full request timeout configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, '', '   '])('defaults silently for %j', (raw) => {
    vi.stubEnv(ENV_KEY, raw);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveApplyFullTimeoutMs()).toBe(180000);
    expect(error).not.toHaveBeenCalled();
  });

  it.each(['abc', 'NaN', 'Infinity', '0', '-1', '1.5', '2147483648', '3000000000'])(
    'rejects %s with an observable fallback', (raw) => {
      vi.stubEnv(ENV_KEY, raw);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(resolveApplyFullTimeoutMs()).toBe(180000);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(ENV_KEY));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(raw));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('180000'));
    },
  );

  it.each([
    ['1', 1],
    ['600000', 600000],
    ['2147483647', 2147483647],
    ['1e3', 1000],
  ])('accepts %s unchanged', (raw, expected) => {
    vi.stubEnv(ENV_KEY, raw);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveApplyFullTimeoutMs()).toBe(expected);
    expect(error).not.toHaveBeenCalled();
  });
});
