import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { guardConsoleApiRequest } from '../../src/server/utils/request-guard.js';

function request(headers: Record<string, string>, method = 'GET'): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

/**
 * Origin/Host guard evidence for the credential-less Console.
 *
 * Browsers always send `Host` and, for mutating requests, `Origin`; local
 * non-browser clients (CLI, installer probes, scripts) send neither
 * `Sec-Fetch-Site` nor necessarily `Origin`, and must keep working.
 */
describe('guardConsoleApiRequest', () => {
  it('lets a non-browser local client through (no Origin / no Sec-Fetch-Site)', () => {
    expect(guardConsoleApiRequest(request({ host: '127.0.0.1:3100' }))).toBeNull();
    expect(guardConsoleApiRequest(request({ host: '127.0.0.1:3100' }, 'POST'))).toBeNull();
  });

  it('accepts the console own origin and rejects another origin', () => {
    expect(guardConsoleApiRequest(request({
      host: '127.0.0.1:3100',
      origin: 'http://127.0.0.1:3100',
      'sec-fetch-site': 'same-origin',
    }))).toBeNull();

    expect(guardConsoleApiRequest(request({
      host: '127.0.0.1:3100',
      origin: 'http://evil.example',
    }))?.error).toBe('forbidden_origin');

    expect(guardConsoleApiRequest(request({
      host: '127.0.0.1:3100',
      origin: 'http://127.0.0.1:9999',
    }))?.error).toBe('forbidden_origin');
  });

  it('rejects cross-site provenance and non-loopback hosts (DNS rebinding)', () => {
    expect(guardConsoleApiRequest(request({
      host: '127.0.0.1:3100',
      'sec-fetch-site': 'cross-site',
    }))?.error).toBe('forbidden_origin');

    expect(guardConsoleApiRequest(request({ host: 'evil.example:3100' }))?.error).toBe('forbidden_host');
    expect(guardConsoleApiRequest(request({ host: '192.168.1.10:3100' }))?.error).toBe('forbidden_host');
  });

  it('requires a JSON body for mutating requests with content', () => {
    const plain = guardConsoleApiRequest(request({
      host: '127.0.0.1:3100',
      'content-type': 'text/plain',
      'content-length': '12',
    }, 'POST'));
    expect(plain?.status).toBe(415);

    expect(guardConsoleApiRequest(request({
      host: '127.0.0.1:3100',
      'content-type': 'application/json',
      'content-length': '12',
    }, 'POST'))).toBeNull();
  });
});
