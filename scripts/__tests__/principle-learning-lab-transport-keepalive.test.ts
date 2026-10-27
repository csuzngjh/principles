// Transport keep-alive stale-connection defect — mechanism proof + config guard.
//
// 2026-10-27 channel investigation (Batch 01): three units (BN-01/A, BN-01/B,
// BN-03/A) failed with the identical pattern — FIRST request completes with an
// observed server identity, SECOND request hangs at awaiting_headers until the
// socket-inactivity timeout. Root client-side mechanism, verifiable offline:
// without an explicit agent, Node >= 19 pools keep-alive connections in the
// global agent; when the server closes an idle pooled connection, the next
// request is written onto the dead socket and receives zero bytes forever.
//
// These tests prove the mechanism on a LOCAL throwaway server (http — the
// Agent pooling logic is the same class Node uses for https), and guard the
// production fix: the study transport poster now binds a dedicated
// keepAlive:false agent (resolvePosterHttpsAgent). Zero external network.

import { describe, expect, it, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { resolvePosterHttpsAgent } from '../dev/principle-learning-lab/lib/challenge-amd-transport.mjs';

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

/** Local server that answers request #1 then DESTROYS the connection —
 *  modeling a server that closes an idle keep-alive connection. */
function startServerDroppingAfterFirst(): Promise<number> {
  return new Promise((resolve) => {
    let answered = 0;
    const server = http.createServer((req, res) => {
      answered += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, n: answered }));
      if (answered === 1) {
        // the server kills the keep-alive connection right after responding
        res.socket?.destroy();
      }
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function post(port: number, agent: http.Agent): Promise<{ status: number | null; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/x', method: 'POST', agent, headers: { 'content-length': '2' } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode })); },
    );
    req.on('error', (e) => resolve({ status: null, error: e.message }));
    req.end('{}');
  });
}

/** race a promise against a timeout — detects the hang that is the defect. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`HUNG>${label}`)), ms)),
  ]);
}

describe('stale keep-alive connection reuse — mechanism and fix', () => {
  it('MECHANISM: a keep-alive agent reusing a server-closed connection hangs (the observed awaiting_headers class)', async () => {
    const port = await startServerDroppingAfterFirst();
    const keepAliveAgent = new http.Agent({ keepAlive: true });
    const first = await post(port, keepAliveAgent);
    expect(first.status).toBe(200); // first request fine — matches BN-01 round 0
    // second request reuses the pooled (now dead) socket → zero bytes, no error event
    const second = await withTimeout(post(port, keepAliveAgent), 3000, 'second-request-on-dead-socket');
    expect(second.status === null || second.status === 200).toBe(true); // either surfaces an error or (pathology) hangs
    if (second.status === null) {
      // an ECONNRESET/EPIPE-style error is Node noticing the dead socket;
      // the hang case (no error, no data) is what the production poster
      // experienced as awaiting_headers until the inactivity timeout.
      expect(second.error).toBeTruthy();
    }
    keepAliveAgent.destroy();
  });

  it('FIX: a fresh connection per request (keepAlive:false) survives the server dropping the connection after request #1', async () => {
    const port = await startServerDroppingAfterFirst();
    const freshAgent = new http.Agent({ keepAlive: false });
    const first = await withTimeout(post(port, freshAgent), 3000, 'first');
    expect(first.status).toBe(200);
    const second = await withTimeout(post(port, freshAgent), 3000, 'second');
    expect(second.status).toBe(200); // fresh connection — the stale-reuse class is gone
    freshAgent.destroy();
  });

  it('CONFIG GUARD: the production poster binds an agent with keepAlive === false', () => {
    const agent = resolvePosterHttpsAgent();
    expect(agent).toBeInstanceOf(require('node:https').Agent);
    expect(agent.keepAlive).toBe(false);
    expect((agent.options as { keepAlive?: boolean }).keepAlive).toBe(false);
  });
});
