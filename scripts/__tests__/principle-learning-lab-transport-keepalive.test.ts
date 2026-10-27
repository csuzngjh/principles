// Transport keep-alive stale-connection defect — connection-reuse behavior
// verification + deterministic hang reproduction + fix behavior verification.
//
// 2026-10-27 channel investigation (Batch 01): three units (BN-01/A, BN-01/B,
// BN-03/A) failed identically — FIRST request completes with an observed
// server identity, SECOND request hangs at awaiting_headers until the
// socket-inactivity timeout. The client-side mechanism under test: Node's
// http(s) Agent pools keep-alive connections, so the second request to the
// same host REUSES the first request's connection; if the server has stopped
// responding on that connection (silently, without an orderly close reaching
// the client), the reused request receives zero bytes and hangs.
//
// What these tests PROVE (all offline, local throwaway servers, zero external
// network; the Agent pooling logic is the same class Node uses for https):
//   1. REUSE  — with a keep-alive agent, two consecutive requests ride the
//      SAME server-side TCP connection (observable connection identity).
//   2. FIX    — with the production fix agent (keepAlive:false), two
//      consecutive requests both succeed on DIFFERENT TCP connections.
//   3. HANG   — with a keep-alive agent against a connection the server has
//      turned into a black hole (responds once, then silently never again),
//      the second request DETERMINISTICALLY hangs with no bytes and no error
//      — the awaiting_headers class — while the fix agent succeeds on its
//      fresh connection.
// What they do NOT claim: reproducing the historical provider-side condition
// (why the real server stopped responding) — that remains unobserved.

import { describe, expect, it, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { resolvePosterHttpsAgent } from '../dev/principle-learning-lab/lib/challenge-amd-transport.mjs';

interface ServerHandle {
  port: number;
  /** server-side per-connection sequence, echoed in every response body */
  connOf: (n: number) => number;
}

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

/** A normal server that keeps connections alive. Every response body carries
 *  the server-side connection identity: { ok, n, conn } — conn is the same
 *  for two requests that rode one TCP connection, different otherwise. */
function startKeepAliveServer(): Promise<ServerHandle> {
  return new Promise((resolve) => {
    let nextConnId = 0;
    let requestN = 0;
    const connById = new Map<number, number>(); // requestId -> connection id
    const server = http.createServer((req, res) => {
      requestN += 1;
      const connId = (req.socket as unknown as { __connId?: number }).__connId ?? -1;
      connById.set(requestN, connId);
      res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' });
      res.end(JSON.stringify({ ok: true, n: requestN, conn: connId }));
    });
    server.on('connection', (socket) => {
      nextConnId += 1;
      (socket as unknown as { __connId?: number }).__connId = nextConnId;
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, connOf: (n) => connById.get(n) ?? -1 }));
  });
}

/** A server whose FIRST connection answers exactly one request and then goes
 *  silent: the socket stays open (no close, no RST, no response) — modeling
 *  a server that silently stops responding on a keep-alive connection. Any
 *  LATER connection behaves normally. */
function startBlackholeAfterFirstServer(): Promise<ServerHandle> {
  return new Promise((resolve) => {
    let nextConnId = 0;
    let requestN = 0;
    const connById = new Map<number, number>();
    const server = http.createServer((req, res) => {
      requestN += 1;
      const connId = (req.socket as unknown as { __connId?: number }).__connId ?? -1;
      connById.set(requestN, connId);
      if (connId === 1 && requestN > 1) {
        // first connection, second request: receive it and NEVER respond —
        // the socket is open, bytes flow in, nothing flows back
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, n: requestN, conn: connId }));
    });
    server.on('connection', (socket) => {
      nextConnId += 1;
      (socket as unknown as { __connId?: number }).__connId = nextConnId;
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, connOf: (n) => connById.get(n) ?? -1 }));
  });
}

function post(port: number, agent: http.Agent): Promise<{ status: number | null; conn: number; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/x', method: 'POST', agent, headers: { 'content-length': '2' } },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, conn: JSON.parse(d).conn }); } catch { resolve({ status: res.statusCode, conn: -1 }); }
        });
      },
    );
    req.on('error', (e) => resolve({ status: null, conn: -1, error: e.message }));
    req.end('{}');
  });
}

/** classify-and-timeout: turns a silent hang into an explicit HANG verdict. */
function withHangDetection(p: Promise<{ status: number | null; conn: number; error?: string }>, ms: number) {
  return Promise.race([
    p,
    new Promise<{ status: string; conn: number; error: string }>((resolve) => setTimeout(() => resolve({ status: 'HANG', conn: -1, error: `no response within ${ms}ms` }), ms)),
  ]);
}

describe('connection reuse — observable TCP connection identity', () => {
  it('REUSE: with a keep-alive agent the second request rides the SAME server-side connection', async () => {
    const { port } = await startKeepAliveServer();
    const agent = new http.Agent({ keepAlive: true });
    const r1 = await post(port, agent);
    const r2 = await post(port, agent);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.conn).toBeGreaterThan(0);
    expect(r2.conn).toBe(r1.conn); // SAME connection — reuse is real and observable
    agent.destroy();
  });

  it('FIX: with the production keepAlive:false agent both requests succeed on DIFFERENT connections', async () => {
    const { port } = await startKeepAliveServer();
    const agent = new http.Agent({ keepAlive: false });
    const r1 = await post(port, agent);
    const r2 = await post(port, agent);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.conn).not.toBe(r1.conn); // fresh TCP connection per request
    agent.destroy();
  });

  it('CONFIG GUARD: the production poster binds an https.Agent with keepAlive === false', () => {
    const agent = resolvePosterHttpsAgent();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const https = require('node:https');
    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent.keepAlive).toBe(false);
    expect((agent.options as { keepAlive?: boolean }).keepAlive).toBe(false);
  });
});

describe('deterministic awaiting_headers reproduction — server goes silent on the first connection after one response', () => {
  it('HANG: a keep-alive agent reusing the silenced connection gets NO bytes and NO error (the awaiting_headers class)', async () => {
    const { port } = await startBlackholeAfterFirstServer();
    const agent = new http.Agent({ keepAlive: true });
    const r1 = await post(port, agent);
    expect(r1.status).toBe(200); // first request fine — matches BN-01 round 0
    // second request reuses connection #1, which the server now ignores:
    // no response bytes, no socket error — a silent hang, exactly the class
    // the production poster experienced as awaiting_headers until timeout
    const r2 = await withHangDetection(post(port, agent), 2500);
    expect(r2.status).toBe('HANG'); // not 200, not an ECONNRESET — silence
    agent.destroy();
  });

  it('FIX under the same fault: the keepAlive:false agent succeeds on its fresh connection', async () => {
    const { port } = await startBlackholeAfterFirstServer();
    const agent = new http.Agent({ keepAlive: false });
    const r1 = await withHangDetection(post(port, agent), 2500);
    expect(r1.status).toBe(200);
    expect(r1.conn).toBe(1); // first request is on connection #1 by arrival order
    const r2 = await withHangDetection(post(port, agent), 2500);
    expect(r2.status).toBe(200); // fresh connection #2 — the server answers normally there
    expect(typeof r2.conn).toBe('number');
    expect(r2.conn).not.toBe(1);
    agent.destroy();
  });
});
