import { describe, it, expect, vi } from 'vitest';
import { assertLoopbackBindForUnauthenticatedServer } from '../../src/server/bind-guard.js';

/**
 * Regression tests for the audit finding pd-console-noauth-nonloopback-bind:
 * authentication disabled (explicit --no-auth OR the token-less default) must
 * never bind a non-loopback interface. The guard keys on the effective
 * authentication state, not on which flag produced it.
 */
describe('assertLoopbackBindForUnauthenticatedServer', () => {
  it('allows any host when authentication is enabled', () => {
    expect(() => assertLoopbackBindForUnauthenticatedServer(true, '0.0.0.0')).not.toThrow();
    expect(() => assertLoopbackBindForUnauthenticatedServer(true, '192.168.1.10')).not.toThrow();
  });

  it('allows loopback hosts when authentication is disabled', () => {
    expect(() => assertLoopbackBindForUnauthenticatedServer(false, '127.0.0.1')).not.toThrow();
    expect(() => assertLoopbackBindForUnauthenticatedServer(false, 'localhost')).not.toThrow();
    expect(() => assertLoopbackBindForUnauthenticatedServer(false, 'LOCALHOST')).not.toThrow();
    expect(() => assertLoopbackBindForUnauthenticatedServer(false, '::1')).not.toThrow();
    expect(() => assertLoopbackBindForUnauthenticatedServer(false, '[::1]')).not.toThrow();
  });

  it('exits when authentication is disabled and the host is not loopback', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => assertLoopbackBindForUnauthenticatedServer(false, '0.0.0.0'))
        .toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Refusing to bind non-loopback host "0.0.0.0" without authentication'),
      );
      expect(() => assertLoopbackBindForUnauthenticatedServer(false, '192.168.1.10'))
        .toThrow('process.exit(1)');
      expect(() => assertLoopbackBindForUnauthenticatedServer(false, ''))
        .toThrow('process.exit(1)');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
