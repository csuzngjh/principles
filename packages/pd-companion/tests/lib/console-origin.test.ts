/**
 * Pure-logic tests for the console-token IPC origin guard + status shaping.
 *
 * The read endpoint hands the long-lived Bearer token to the renderer; these
 * tests lock the fail-closed rules: only plain-http loopback origins are
 * served, everything else (data: pages, https, remote hosts, garbage) is
 * denied, and the status shaper never reports a credential for empty input.
 */
import { describe, it, expect } from 'vitest';
import { isLocalConsoleOrigin, buildConsoleTokenStatus } from '../../src/lib/console-origin.js';

describe('isLocalConsoleOrigin', () => {
  it('accepts the console server loopback origins', () => {
    expect(isLocalConsoleOrigin('http://127.0.0.1:41231/')).toBe(true);
    expect(isLocalConsoleOrigin('http://127.0.0.1:41231/#/login')).toBe(true);
    expect(isLocalConsoleOrigin('http://localhost:41231/#/login')).toBe(true);
  });

  it('denies non-loopback or non-http origins', () => {
    expect(isLocalConsoleOrigin('https://127.0.0.1:41231/')).toBe(false);
    expect(isLocalConsoleOrigin('http://example.com/')).toBe(false);
    expect(isLocalConsoleOrigin('http://192.168.1.4:41231/')).toBe(false);
  });

  it('denies degraded data: pages and unparsable URLs (fail closed)', () => {
    expect(isLocalConsoleOrigin('data:text/html;charset=utf-8,hello')).toBe(false);
    expect(isLocalConsoleOrigin('about:blank')).toBe(false);
    expect(isLocalConsoleOrigin('')).toBe(false);
    expect(isLocalConsoleOrigin('not a url')).toBe(false);
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
