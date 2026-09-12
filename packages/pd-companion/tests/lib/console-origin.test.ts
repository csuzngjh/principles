/**
 * Pure-logic tests for the console-token IPC origin guard + status shaping.
 *
 * The read endpoint hands the long-lived Bearer token to the renderer; these
 * tests lock the fail-closed rules: only the EXACT origin of the console the
 * supervisor currently serves may read it (a page from another loopback port
 * still carries the preload bridge but is denied — PR #1635 review), and the
 * status shaper never reports a credential for empty input.
 */
import { describe, it, expect } from 'vitest';
import { consoleOriginOf, isSameConsoleOrigin, buildConsoleTokenStatus } from '../../src/lib/console-origin.js';

describe('consoleOriginOf', () => {
  it('extracts the origin of the console server loopback URLs', () => {
    expect(consoleOriginOf('http://127.0.0.1:41231/')).toBe('http://127.0.0.1:41231');
    expect(consoleOriginOf('http://127.0.0.1:41231/#/login')).toBe('http://127.0.0.1:41231');
    expect(consoleOriginOf('http://localhost:41231/#/login')).toBe('http://localhost:41231');
  });

  it('denies non-loopback or non-http origins', () => {
    expect(consoleOriginOf('https://127.0.0.1:41231/')).toBeNull();
    expect(consoleOriginOf('http://example.com/')).toBeNull();
    expect(consoleOriginOf('http://192.168.1.4:41231/')).toBeNull();
  });

  it('denies degraded data: pages and unparsable URLs (fail closed)', () => {
    expect(consoleOriginOf('data:text/html;charset=utf-8,hello')).toBeNull();
    expect(consoleOriginOf('about:blank')).toBeNull();
    expect(consoleOriginOf('')).toBeNull();
    expect(consoleOriginOf('not a url')).toBeNull();
  });
});

describe('isSameConsoleOrigin (exact-origin guard)', () => {
  it('accepts the sender page of the active console (same port)', () => {
    expect(isSameConsoleOrigin('http://127.0.0.1:41231/#/login', 'http://127.0.0.1:41231/#/focus')).toBe(true);
    expect(isSameConsoleOrigin('http://localhost:41231/', 'http://localhost:41231/#/login')).toBe(true);
  });

  it('rejects a different loopback port — cross-port page cannot read the token', () => {
    expect(isSameConsoleOrigin('http://127.0.0.1:5173/', 'http://127.0.0.1:41231/')).toBe(false);
    expect(isSameConsoleOrigin('http://localhost:3000/#/login', 'http://127.0.0.1:41231/')).toBe(false);
  });

  it('fails closed when the supervisor has no active URL or either side is not a local origin', () => {
    expect(isSameConsoleOrigin('http://127.0.0.1:41231/', undefined)).toBe(false);
    expect(isSameConsoleOrigin('http://127.0.0.1:41231/', '')).toBe(false);
    expect(isSameConsoleOrigin('data:text/html,degraded', 'http://127.0.0.1:41231/')).toBe(false);
    expect(isSameConsoleOrigin('http://127.0.0.1:41231/', 'data:text/html,degraded')).toBe(false);
  });
});

describe('buildConsoleTokenStatus', () => {
  it('reports the token when the runtime env carries one', () => {
    expect(buildConsoleTokenStatus('  abc123  ')).toEqual({ available: true, token: 'abc123' });
  });

  it('reports no credential for empty/whitespace/undefined input', () => {
    expect(buildConsoleTokenStatus(undefined)).toEqual({ available: false });
    expect(buildConsoleTokenStatus('')).toEqual({ available: false });
    expect(buildConsoleTokenStatus('   ')).toEqual({ available: false });
  });
});
