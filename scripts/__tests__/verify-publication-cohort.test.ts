// PRI-1103 final-round regression: the publication COHORT RE-VERIFICATION gate.
//
// `release-metadata.yml` resolves the npm cohort once, then builds nine
// platform assets for a long time. If npm `latest` moves from commit A to
// commit B during that build, every asset can still carry a valid embedded
// identity stamp and still be the WRONG bytes for a fresh install. These
// tests drive the real gate script (which spawns the real resolver) against a
// fixture checkout and a mutable stub registry, covering the business
// scenarios A–H from the task brief — not just "the script runs".
//
// Workflow placement/ordering is pinned in release-workflows.test.ts.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.resolve(HERE, '..', 'release', 'verify-publication-cohort.mjs');
const RESOLVER = path.resolve(HERE, '..', 'release', 'resolve-installer-cohort.mjs');
const INSTALLER = 'create-principles-disciple';
const GIT_ID = ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid'];

interface Stub {
  status: number;
  body: string;
  delayMs: number;
  /**
   * Simulated intermediary cache: requests WITHOUT npm's `?write=true`
   * freshness marker receive `body` (the stale packument); requests WITH it
   * receive `freshBody` (what the registry actually serves now).
   */
  freshBody?: string;
}

interface RecordedRequest {
  url: string;
  pathname: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
}

const tempDirs: string[] = [];
const requests: RecordedRequest[] = [];
let stubServer: http.Server | null = null;
let stubPort = 0;
let stub: Stub = { status: 200, body: '{}', delayMs: 0 };

async function sh(cmd: string, args: string[], cwd: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function removeTree(dir: string) {
  try {
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      try {
        fs.chmodSync(path.join(dir, entry as string), 0o666);
      } catch {
        /* raced or already gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // The temp-lifecycle guardian reclaims these; cleanup must not fail the suite.
  }
}

/**
 * Three cohorts on one branch:
 *   A — product version 2.8.3 at one commit
 *   B — product version 2.8.3 at a DIFFERENT commit (same version, different bytes)
 *   C — product version 2.8.4 (the version moved too)
 * B is the scenario that a version-only comparison would wave through.
 */
async function makeCheckout() {
  const base = process.env.TMPDIR ?? os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, 'pri1103-gate-'));
  tempDirs.push(root);
  await sh('git', ['init', '-b', 'main', '-q'], root);
  const shas: Record<string, string> = {};
  const commits = [
    { key: 'A', version: '2.8.3', file: 'a.txt' },
    { key: 'B', version: '2.8.3', file: 'b.txt' },
    { key: 'C', version: '2.8.4', file: 'c.txt' },
  ];
  for (const commit of commits) {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'pri1103-gate-fixture', version: commit.version }, null, 2) + '\n',
    );
    fs.writeFileSync(path.join(root, commit.file), `${commit.key}\n`);
    await sh('git', [...GIT_ID, 'add', '.'], root);
    await sh('git', [...GIT_ID, 'commit', '-q', '-m', `cohort ${commit.key}`], root);
    shas[commit.key] = (await sh('git', ['rev-parse', 'HEAD'], root)).stdout.trim();
  }
  return { root, shas };
}

function packument(latest: string | null, entries: Array<{ version: string; gitHead?: string; publishedAt: string }>) {
  const versions: Record<string, Record<string, unknown>> = {};
  const time: Record<string, string> = { created: entries[0]?.publishedAt ?? '2026-01-01T00:00:00.000Z' };
  for (const entry of entries) {
    const manifest: Record<string, unknown> = { name: INSTALLER, version: entry.version };
    if (entry.gitHead !== undefined) manifest.gitHead = entry.gitHead;
    versions[entry.version] = manifest;
    time[entry.version] = entry.publishedAt;
  }
  return { 'dist-tags': latest === null ? {} : { latest }, versions, time };
}

function serve(json: unknown, status = 200) {
  stub = { status, body: JSON.stringify(json), delayMs: 0 };
}

/** Simulate an intermediary that keeps serving `stale` unless the request
 *  carries npm's `?write=true` freshness marker, in which case `fresh` is
 *  returned. This is how a CDN-backed stale packument would behave. */
function serveStale(stale: unknown, fresh: unknown, status = 200) {
  stub = { status, body: JSON.stringify(stale), freshBody: JSON.stringify(fresh), delayMs: 0 };
}

async function runScript(script: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd,
        env: {
          ...process.env,
          PD_RELEASE_REGISTRY: `http://127.0.0.1:${stubPort}`,
          PD_RELEASE_RETRY_DELAY_MS: '1',
          ...env,
        },
      },
      (err, out, errOut) => {
        const e = err as (Error & { code?: number }) | null;
        resolve({ code: typeof e?.code === 'number' ? e.code : 0, stdout: String(out), stderr: String(errOut) });
      },
    );
  });
}

async function runGate(args: string[], cwd: string, env: Record<string, string> = {}) {
  const { code, stdout, stderr } = await runScript(GATE, args, cwd, env);
  let json: Record<string, any> | null = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
  }
  return { code, stdout, stderr, json };
}

/** The initial cohort resolution performed by `resolve-inputs` — a separate
 *  process, therefore a separate registry query, exactly like production. */
async function runResolver(args: string[], cwd: string, env: Record<string, string> = {}) {
  const { code, stdout, stderr } = await runScript(RESOLVER, args, cwd, env);
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code, stdout, stderr, json };
}

function gateArgs(options: {
  version: string;
  commit: string;
  mode?: 'publish' | 'dry-run';
  explicit?: string;
  sideEffects?: 'none' | 'asset-bytes-uploaded';
}) {
  const args = [
    '--mode',
    options.mode ?? 'publish',
    '--product-version',
    options.version,
    '--expected-commit',
    options.commit,
    '--external-side-effects',
    options.sideEffects ?? 'none',
    '--json',
  ];
  if (options.explicit !== undefined) args.push('--explicit-cohort', options.explicit);
  return args;
}

let checkout: { root: string; shas: Record<string, string> };

beforeAll(async () => {
  checkout = await makeCheckout();
  stubServer = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${stubPort}`);
    const query: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    requests.push({ url: req.url ?? '', pathname: parsed.pathname, query, headers: req.headers });
    // A request carrying npm's freshness marker sees the CURRENT packument;
    // one without it sees whatever an intermediary had cached.
    const body = stub.freshBody !== undefined && parsed.searchParams.get('write') === 'true' ? stub.freshBody : stub.body;
    const respond = () => {
      res.writeHead(stub.status, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (stub.delayMs > 0) setTimeout(respond, stub.delayMs);
    else respond();
  });
  await new Promise<void>((r) => stubServer!.listen(0, '127.0.0.1', r));
  stubPort = (stubServer!.address() as { port: number }).port;
});

afterAll(async () => {
  stubServer?.closeAllConnections?.();
  if (stubServer) await new Promise<void>((r) => stubServer!.close(() => r()));
  for (const dir of tempDirs) removeTree(dir);
});

beforeEach(() => {
  requests.length = 0;
  serve({});
});

describe('verify-publication-cohort gate — the business scenarios', () => {
  // Scenario A — normal publication: the channel still serves A at gate time.
  it('passes when npm latest is still the exact version+commit this run built', async () => {
    serve(packument('1.147.12', [{ version: '1.147.12', gitHead: checkout.shas.A, publishedAt: '2026-11-03T00:00:00.000Z' }]));
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root);

    expect(run.code).toBe(0);
    expect(run.json).toMatchObject({
      status: 'MATCH',
      mode: 'auto-latest',
      expected: { version: '2.8.3', commit: checkout.shas.A },
      actual: { version: '2.8.3', commit: checkout.shas.A },
      externalSideEffects: 'none',
    });
    // cli-1-strict-json: stdout is exactly the machine-readable result.
    expect(JSON.parse(run.stdout)).toEqual(run.json);
  });

  // Scenario B — SAME product version, DIFFERENT commit. The exact TOCTOU
  // shape: a version-only check would pass here and ship the wrong bytes.
  it('BLOCKS when the same product version is published from a different commit', async () => {
    serve(packument('1.147.13', [{ version: '1.147.13', gitHead: checkout.shas.B, publishedAt: '2026-11-03T00:00:00.000Z' }]));
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root);

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({
      status: 'BLOCKED',
      mode: 'auto-latest',
      expected: { version: '2.8.3', commit: checkout.shas.A },
      actual: { version: '2.8.3', commit: checkout.shas.B },
      externalSideEffects: 'none',
    });
    expect(run.json?.reason).toContain('does not match');
    expect(run.stderr).toContain(checkout.shas.A);
    expect(run.stderr).toContain(checkout.shas.B);
  });

  // Scenario C — the version moved too.
  it('BLOCKS when the product version changed during the build', async () => {
    serve(packument('1.147.13', [{ version: '1.147.13', gitHead: checkout.shas.C, publishedAt: '2026-11-03T00:00:00.000Z' }]));
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root);

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({
      status: 'BLOCKED',
      expected: { version: '2.8.3', commit: checkout.shas.A },
      actual: { version: '2.8.4', commit: checkout.shas.C },
    });
  });

  // Scenario E — an explicit HISTORICAL cohort republish stays legal even
  // though npm latest is a newer cohort. The final guard must not demand that
  // a historical cohort equals latest.
  it('passes for a published historical cohort even when latest is newer', async () => {
    serve(
      packument('1.147.13', [
        { version: '1.147.13', gitHead: checkout.shas.B, publishedAt: '2026-11-04T00:00:00.000Z' },
        { version: '1.147.12', gitHead: checkout.shas.A, publishedAt: '2026-11-03T00:00:00.000Z' },
      ]),
    );
    const run = await runGate(
      gateArgs({ version: '2.8.3', commit: checkout.shas.A, explicit: checkout.shas.A }),
      checkout.root,
    );

    expect(run.code).toBe(0);
    expect(run.json).toMatchObject({
      status: 'MATCH',
      mode: 'explicit-cohort',
      actual: { version: '2.8.3', commit: checkout.shas.A },
    });
  });

  // Scenario F — a SHA with no published record is never an acceptable cohort.
  it('BLOCKS an explicit historical cohort that was never published', async () => {
    serve(packument('1.147.13', [{ version: '1.147.13', gitHead: checkout.shas.B, publishedAt: '2026-11-03T00:00:00.000Z' }]));
    const run = await runGate(
      gateArgs({ version: '2.8.3', commit: 'f'.repeat(40), explicit: 'f'.repeat(40) }),
      checkout.root,
    );

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ status: 'BLOCKED', mode: 'explicit-cohort', resolverStatus: 'EXPLICIT_UNPUBLISHED' });
  });

  // Dry-run fallback stays available, but can never be publication evidence;
  // publish mode can never take that advisory path.
  it('dry-run labels even a matching result as advisory, not publication evidence', async () => {
    serve(packument('1.147.12', [{ version: '1.147.12', gitHead: checkout.shas.A, publishedAt: '2026-11-03T00:00:00.000Z' }]));
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A, mode: 'dry-run' }), checkout.root);

    expect(run.code).toBe(0);
    expect(run.json).toMatchObject({ status: 'MATCH', mode: 'dry-run-advisory' });
    expect(run.stderr).toContain('advisory only');
    expect(run.stderr).toContain('NOT publication evidence');
  });

  it('dry-run downgrades a mismatch to an advisory, labelled NOT publication evidence', async () => {
    stub = { status: 404, body: '{}', delayMs: 0 };
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A, mode: 'dry-run' }), checkout.root);

    expect(run.code).toBe(0);
    expect(run.json?.status).toBe('ADVISORY_MISMATCH');
    expect(run.json?.mode).toBe('dry-run-advisory');
    expect(run.stderr).toContain('NOT publication evidence');
  }, 30_000);

  it('rejects malformed gate arguments before touching the registry', async () => {
    serve(packument('1.147.12', [{ version: '1.147.12', gitHead: checkout.shas.A, publishedAt: '2026-11-03T00:00:00.000Z' }]));
    const missing = await runGate(['--mode', 'publish', '--product-version', '2.8.3'], checkout.root);
    expect(missing.code).toBe(2);

    const shortSha = await runGate(
      ['--mode', 'publish', '--product-version', '2.8.3', '--expected-commit', 'abc'],
      checkout.root,
    );
    expect(shortSha.code).toBe(2);

    const badMode = await runGate(
      ['--mode', 'release', '--product-version', '2.8.3', '--expected-commit', checkout.shas.A],
      checkout.root,
    );
    expect(badMode.code).toBe(2);
  });
});

// PRI-1103 second-round hardening: a repeated query is not a fresh query. npm's
// documented `?write=true` marker makes the registry serve the CURRENT
// packument; without it an intermediary can hand every gate the same stale
// document, which turns both gates into no-ops.
describe('verify-publication-cohort gate — registry freshness', () => {
  // Functions, not constants: describe callbacks run during collection,
  // before `beforeAll` builds the fixture repository.
  const latestA = () =>
    packument('1.147.12', [{ version: '1.147.12', gitHead: checkout.shas.A, publishedAt: '2026-11-03T00:00:00.000Z' }]);
  const latestB = () =>
    packument('1.147.13', [{ version: '1.147.13', gitHead: checkout.shas.B, publishedAt: '2026-11-04T00:00:00.000Z' }]);

  function expectFresh(request: RecordedRequest) {
    expect(request.query).toEqual({ write: 'true' });
    expect(request.pathname).toBe(`/${INSTALLER}`);
    // Complement, never the sole freshness argument (see registry-client).
    expect(String(request.headers['cache-control'])).toContain('no-cache');
  }

  // A — every cohort query point force-revalidates, and each one performs a
  // real new request instead of reusing the initial resolution or gate 1.
  it('A: initial resolution, gate 1 and gate 2 each issue a fresh, independent query', async () => {
    serve(latestA());
    const initial = await runResolver(['--product-version', '2.8.3', '--json'], checkout.root);
    expect(initial.code).toBe(0);

    const gate1 = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root);
    expect(gate1.code).toBe(0);
    const gate2 = await runGate(
      gateArgs({ version: '2.8.3', commit: checkout.shas.A, sideEffects: 'asset-bytes-uploaded' }),
      checkout.root,
    );
    expect(gate2.code).toBe(0);

    expect(requests).toHaveLength(3);
    for (const request of requests) expectFresh(request);
  });

  // B — a stale intermediary cache: without the freshness marker this exact
  // code path would read A forever and declare "no drift".
  it('B: reads the current packument through a stale cache layer (A cached, B current)', async () => {
    serveStale(latestA(), latestB());
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root);

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({
      status: 'BLOCKED',
      actual: { version: '2.8.3', commit: checkout.shas.B },
    });
    expect(requests).toHaveLength(1);
    expectFresh(requests[0]);
  });

  // C — the channel moved while the platform assets were being built: gate 1
  // refuses before any external side effect can happen.
  it('C: blocks gate 1 when the channel moved during the build (initial A, gate 1 B)', async () => {
    serve(latestA());
    const initial = await runResolver(['--product-version', '2.8.3', '--json'], checkout.root);
    expect(initial.code).toBe(0);
    expect(initial.json).toMatchObject({ status: 'MATCH', cohort: checkout.shas.A });

    serve(latestB());
    const gate1 = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root);
    expect(gate1.code).toBe(1);
    expect(gate1.json).toMatchObject({
      status: 'BLOCKED',
      externalSideEffects: 'none',
      actual: { version: '2.8.3', commit: checkout.shas.B },
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) expectFresh(request);
  });

  // D — gate 1 passed, then the registry moved before the push: gate 2 must
  // refuse, must NOT report success, must disclose the uploaded asset bytes,
  // and must not tamper with the asset identity.
  it('D: gate 2 blocks when the registry moves between gate 1 and the push, reporting the side effect', async () => {
    serve(latestA());
    const gate1 = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root);
    expect(gate1.code).toBe(0);

    serve(latestB());
    const gate2 = await runGate(
      gateArgs({ version: '2.8.3', commit: checkout.shas.A, sideEffects: 'asset-bytes-uploaded' }),
      checkout.root,
    );

    expect(gate2.code).toBe(1);
    expect(gate2.json).toMatchObject({
      status: 'BLOCKED',
      externalSideEffects: 'asset-bytes-uploaded',
      expected: { version: '2.8.3', commit: checkout.shas.A },
      actual: { version: '2.8.3', commit: checkout.shas.B },
    });
    expect(gate2.stderr).toContain('ALREADY uploaded');
    expect(gate2.stderr).toContain('NO signed metadata pointer');
    expect(gate2.stderr).not.toContain('VERIFIED');
    // Both gates queried the registry independently, each with the marker.
    expect(requests).toHaveLength(2);
    for (const request of requests) expectFresh(request);
  });

  // E — an undecidable registry is never "no drift".
  const registryFailures: Array<[string, Stub]> = [
    ['404', { status: 404, body: JSON.stringify({ error: 'not found' }), delayMs: 0 }],
    ['503', { status: 503, body: JSON.stringify({ error: 'unavailable' }), delayMs: 0 }],
    ['invalid JSON', { status: 200, body: '<html>not json</html>', delayMs: 0 }],
    [
      'missing gitHead',
      {
        status: 200,
        body: JSON.stringify(packument('1.147.12', [{ version: '1.147.12', publishedAt: '2026-11-03T00:00:00.000Z' }])),
        delayMs: 0,
      },
    ],
  ];

  it.each(registryFailures)('E: fails closed on %s', async (_label, response) => {
    stub = response;
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root);

    expect(run.code).toBe(1);
    expect(run.json?.status).toBe('BLOCKED');
    expect(['REGISTRY_ERROR', 'ABSENT_COHORT']).toContain(run.json?.resolverStatus);
    expect(run.json?.actual).toEqual({ version: null, commit: null });
    expect(run.stderr).toContain('REFUSED');
  }, 30_000);

  it('E: fails closed on a request timeout', async () => {
    stub = { status: 200, body: '{}', delayMs: 5_000 };
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root, {
      PD_RELEASE_TIMEOUT_MS: '40',
    });

    expect(run.code).toBe(1);
    expect(run.json?.status).toBe('BLOCKED');
    expect(run.json?.resolverStatus).toBe('REGISTRY_ERROR');
  }, 30_000);

  it('E: fails closed on a network failure (connection refused)', async () => {
    const run = await runGate(gateArgs({ version: '2.8.3', commit: checkout.shas.A }), checkout.root, {
      PD_RELEASE_REGISTRY: 'http://127.0.0.1:1',
    });

    expect(run.code).toBe(1);
    expect(run.json?.status).toBe('BLOCKED');
    expect(run.json?.resolverStatus).toBe('REGISTRY_ERROR');
    expect(run.stderr).toContain('REFUSED');
  }, 30_000);
});
