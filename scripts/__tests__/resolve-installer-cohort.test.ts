// PRI-1103 — the release asset leg must be able to name the cohort the npm
// installer channel ACTUALLY shipped for a product version, and must refuse
// whenever that binding is unprovable. These tests spawn the real CLI against
// a fixture git repo and a stub registry, so every status below is produced by
// the same code path the workflow step runs.
//
// The workflow wiring (that release-metadata.yml calls this resolver and
// re-anchors commit/source_epoch to its answer) is pinned in
// release-workflows.test.ts.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'release', 'resolve-installer-cohort.mjs');
const INSTALLER = 'create-principles-disciple';
const GIT_ID = ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid'];

const tempDirs: string[] = [];
let stubServer: http.Server | null = null;
let stubPort = 0;
// One packument per test, swapped by the caller before invoking the CLI.
let servedPackument: unknown = null;
let servedStatus = 200;

async function sh(cmd: string, args: string[], cwd: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function removeTree(dir: string) {
  // Windows: git writes read-only objects; clear the bit before removing.
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
 * Fixture checkout: two commits whose ROOT manifests declare 1.0.0 and 1.1.0.
 * The resolver reads the product version with `git show <sha>:package.json`,
 * so these are the two cohorts a registry packument can point at.
 */
async function makeCheckout() {
  const base = process.env.TMPDIR ?? os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, 'pri1103-cohort-'));
  tempDirs.push(root);
  await sh('git', ['init', '-b', 'main', '-q'], root);
  const shas: Record<string, string> = {};
  for (const version of ['1.0.0', '1.1.0']) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pri1103-fixture', version }, null, 2) + '\n');
    await sh('git', [...GIT_ID, 'add', 'package.json'], root);
    await sh('git', [...GIT_ID, 'commit', '-q', '-m', `v${version}`], root);
    shas[version] = (await sh('git', ['rev-parse', 'HEAD'], root)).stdout.trim();
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

async function runCli(args: string[], cwd: string) {
  const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        env: { ...process.env, PD_RELEASE_REGISTRY: `http://127.0.0.1:${stubPort}`, PD_RELEASE_RETRY_DELAY_MS: '1' },
      },
      (err, out, errOut) => {
        const e = err as (Error & { code?: number }) | null;
        resolve({ code: typeof e?.code === 'number' ? e.code : 0, stdout: String(out), stderr: String(errOut) });
      },
    );
  });
  return { code, stdout, stderr, json: args.includes('--json') ? JSON.parse(stdout) : null };
}

let checkout: { root: string; shas: Record<string, string> };

beforeAll(async () => {
  checkout = await makeCheckout();
  stubServer = http.createServer((_req, res) => {
    res.writeHead(servedStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(servedPackument));
  });
  await new Promise<void>((r) => stubServer!.listen(0, '127.0.0.1', r));
  stubPort = (stubServer!.address() as { port: number }).port;
});

afterAll(async () => {
  if (stubServer) await new Promise<void>((r) => stubServer!.close(() => r()));
  for (const dir of tempDirs) removeTree(dir);
});

describe('resolve-installer-cohort.mjs', () => {
  it('resolves the cohort recorded as gitHead on dist-tags.latest', async () => {
    servedStatus = 200;
    servedPackument = packument('1.147.12', [{ version: '1.147.12', gitHead: checkout.shas['1.1.0'], publishedAt: '2026-11-03T00:00:00.000Z' }]);

    const run = await runCli(['--product-version', '1.1.0', '--json'], checkout.root);

    expect(run.code).toBe(0);
    expect(run.json).toMatchObject({ status: 'MATCH', via: 'latest', cohort: checkout.shas['1.1.0'], installerVersion: '1.147.12' });
    // Exactly one JSON object on stdout — the workflow parses it with JSON.parse.
    expect(JSON.parse(run.stdout)).toEqual(run.json);
  });

  /**
   * Acceptance criterion 3 (the negative control): the registry naming a
   * DIFFERENT cohort must produce a refusal that names both sides, not a
   * silent agreement and not a bare "drift detected".
   */
  it('refuses when the channel serves another product version, naming both cohorts and both versions', async () => {
    servedStatus = 200;
    servedPackument = packument('1.147.12', [
      { version: '1.147.12', gitHead: checkout.shas['1.1.0'], publishedAt: '2026-11-03T00:00:00.000Z' },
      { version: '1.147.11', gitHead: checkout.shas['1.0.0'], publishedAt: '2026-11-02T00:00:00.000Z' },
    ]);

    const run = await runCli(['--product-version', '1.0.0', '--json'], checkout.root);

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({
      status: 'VERSION_LAGS',
      channelProductVersion: '1.1.0',
      cohort: checkout.shas['1.1.0'],
    });
    // No "pass an older cohort to republish" hint: that path is now refused.
    expect(run.json).not.toHaveProperty('suggestedCohort');
    expect(run.stderr).toContain('1.1.0');
    expect(run.stderr).not.toContain('cohort_sha');
  });

  it('still refuses when no published installer release carries the requested version', async () => {
    servedStatus = 200;
    servedPackument = packument('1.147.12', [{ version: '1.147.12', gitHead: checkout.shas['1.1.0'], publishedAt: '2026-11-03T00:00:00.000Z' }]);

    const run = await runCli(['--product-version', '9.9.9', '--json'], checkout.root);

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ status: 'VERSION_LAGS' });
    expect(run.json).not.toHaveProperty('suggestedCohort');
    // No invented cohort: the operator gets a refusal, not a guess to paste.
    expect(run.stderr).not.toContain('cohort_sha = ');
  });

  it('accepts an explicit cohort only when it is the current npm latest commit', async () => {
    servedStatus = 200;
    servedPackument = packument('1.147.12', [{ version: '1.147.12', gitHead: checkout.shas['1.1.0'], publishedAt: '2026-11-03T00:00:00.000Z' }]);

    const ok = await runCli(['--product-version', '1.1.0', '--expect-cohort', checkout.shas['1.1.0'], '--json'], checkout.root);
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({ status: 'MATCH', via: 'explicit', cohort: checkout.shas['1.1.0'] });

    // Never published at all: unprovable, therefore refused.
    const unknown = await runCli(['--product-version', '1.1.0', '--expect-cohort', 'f'.repeat(40), '--json'], checkout.root);
    expect(unknown.code).toBe(1);
    expect(unknown.json?.status).toBe('EXPLICIT_UNPUBLISHED');

    // Unreadable live channel: an explicit SHA cannot substitute for it.
    servedPackument = packument('1.147.12', [{ version: '1.147.12', publishedAt: '2026-11-03T00:00:00.000Z' }]);
    const noHead = await runCli(['--product-version', '1.1.0', '--expect-cohort', checkout.shas['1.1.0'], '--json'], checkout.root);
    expect(noHead.code).toBe(1);
    expect(noHead.json?.status).toBe('ABSENT_COHORT');
  });

  /**
   * The Owner-identified P1: a published historical cohort with the SAME
   * product version must not be usable once `latest` moved to another commit.
   * Both sides carry product version 1.1.0, so only a full-SHA comparison
   * against the live channel can refuse this.
   */
  it('refuses a published historical cohort once latest points at another commit', async () => {
    servedStatus = 200;
    servedPackument = packument('1.147.12', [
      { version: '1.147.12', gitHead: checkout.shas['1.1.0'], publishedAt: '2026-11-03T00:00:00.000Z' },
      { version: '1.147.11', gitHead: checkout.shas['1.0.0'], publishedAt: '2026-11-02T00:00:00.000Z' },
    ]);

    const run = await runCli(['--product-version', '1.1.0', '--expect-cohort', checkout.shas['1.0.0'], '--json'], checkout.root);

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({
      status: 'EXPLICIT_NOT_LATEST',
      expectedCommit: checkout.shas['1.0.0'],
      actualLatestCommit: checkout.shas['1.1.0'],
      installerVersion: '1.147.12',
      productVersion: '1.1.0',
      actualProductVersion: '1.1.0',
    });
    expect(run.stderr).toContain('EXPLICIT_NOT_LATEST');
    expect(run.stderr).toContain(checkout.shas['1.0.0']);
    expect(run.stderr).toContain(checkout.shas['1.1.0']);
  });

  it('refuses an explicit cohort whose root manifest carries a different product version', async () => {
    servedStatus = 200;
    // `latest` itself points at the commit whose root manifest says 1.0.0,
    // while this run expects product version 1.1.0.
    servedPackument = packument('1.147.12', [
      { version: '1.147.12', gitHead: checkout.shas['1.0.0'], publishedAt: '2026-11-03T00:00:00.000Z' },
    ]);

    const run = await runCli(['--product-version', '1.1.0', '--expect-cohort', checkout.shas['1.0.0'], '--json'], checkout.root);

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ status: 'VERSION_MISMATCH', cohortProductVersion: '1.0.0', installerVersion: '1.147.12' });
  });

  it('refuses rather than assuming when the release records no gitHead', async () => {
    servedStatus = 200;
    servedPackument = packument('1.147.12', [{ version: '1.147.12', publishedAt: '2026-11-03T00:00:00.000Z' }]);

    const run = await runCli(['--product-version', '1.1.0', '--json'], checkout.root);

    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ status: 'ABSENT_COHORT', installerVersion: '1.147.12' });
  });

  it('refuses when the channel cohort is not readable in this checkout', async () => {
    servedStatus = 200;
    // A sha the registry recorded but this checkout has never seen (shallow
    // or wrong-ref dispatch): unverifiable, never "equal".
    servedPackument = packument('1.147.12', [{ version: '1.147.12', gitHead: 'd'.repeat(40), publishedAt: '2026-11-03T00:00:00.000Z' }]);

    const run = await runCli(['--product-version', '1.1.0', '--json'], checkout.root);

    expect(run.code).toBe(1);
    expect(run.json?.status).toBe('COMMIT_UNAVAILABLE');
  });

  it('treats a failed or empty registry read as unprovable, never as no drift', async () => {
    servedStatus = 503;
    servedPackument = {};
    // fetchPackument's own retry posture is part of what is being proven here,
    // so this case is bounded by that contract (3 attempts) rather than the
    // default 5s test timeout.
    const down = await runCli(['--product-version', '1.1.0', '--json'], checkout.root);
    expect(down.code).toBe(1);
    expect(down.json?.status).toBe('REGISTRY_ERROR');

    servedStatus = 404;
    servedPackument = {};
    const missing = await runCli(['--product-version', '1.1.0', '--json'], checkout.root);
    expect(missing.code).toBe(1);
    expect(missing.json?.status).toBe('REGISTRY_ERROR');
  }, 30_000);

  it('rejects a malformed version or cohort before touching the registry', async () => {
    servedStatus = 200;
    servedPackument = packument('1.147.12', [{ version: '1.147.12', gitHead: checkout.shas['1.1.0'], publishedAt: '2026-11-03T00:00:00.000Z' }]);

    expect((await runCli([], checkout.root)).code).toBe(2);
    expect((await runCli(['--product-version', 'v1.1'], checkout.root)).code).toBe(2);
    expect((await runCli(['--product-version', '1.1.0', '--expect-cohort', 'abc'], checkout.root)).code).toBe(2);
  });
});
