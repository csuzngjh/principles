import { describe, it, expect, vi } from 'vitest';
import { assertLoopbackBind } from '../../src/server/bind-guard.js';

/**
 * The Console has no application-level credential, so the OS session is the
 * trust boundary. That only holds while the listener is local: a non-loopback
 * `--host` must be refused unconditionally (it used to depend on the
 * authentication mode).
 */
describe('assertLoopbackBind', () => {
  it('allows loopback hosts', () => {
    expect(() => assertLoopbackBind('127.0.0.1')).not.toThrow();
    expect(() => assertLoopbackBind('localhost')).not.toThrow();
    expect(() => assertLoopbackBind('LOCALHOST')).not.toThrow();
    expect(() => assertLoopbackBind('::1')).not.toThrow();
    expect(() => assertLoopbackBind('[::1]')).not.toThrow();
  });

  it('exits for any non-loopback host', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => assertLoopbackBind('0.0.0.0')).toThrow('process.exit(1)');
      expect(() => assertLoopbackBind('192.168.1.10')).toThrow('process.exit(1)');
      expect(() => assertLoopbackBind('')).toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Refusing to bind non-loopback host "0.0.0.0"'),
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
