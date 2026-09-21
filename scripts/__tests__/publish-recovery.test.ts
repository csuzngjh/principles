// Publish-recovery behavior drills (PRI-886). Ten scenarios prove the
// recovered publish control path against a CONTROLLED registry, a fake
// clock and CLI stand-ins — no test touches registry.npmjs.org, burns a
// version, or waits the real 10-minute window.
//
// The OLD behavior these drills replace has production evidence of
// failing: run 35596275911 failed at 4/7 because the legacy inline gate
// (npm view >/dev/null 2>&1, flat 5×15s) misread propagation lag as a
// committed-range error. Drill [1] pins the new pass condition that the
// old gate provably could not meet (>75s visibility), and the YAML
// regression test below pins that the legacy gate shape is gone.

import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'scripts', 'release');

async function loadModule(rel: string) {
  return (await import(pathToFileURL(path.join(RELEASE_DIR, rel)).href)) as Record<string, unknown>;
}

// The train order — mirrors publish-npm.yml's TRAIN_ORDER (the workflow
// is the single source; tests pass it explicitly like the workflow does).
const ORDER = [
  'principles-core',
  'install-layout',
  'host-runtime',
  'codex-adapter',
  'openclaw-plugin',
  'pd-cli',
  'create-principles-disciple',
];

// Mirrors the REAL cohort bdfe2fc8 manifests (2026-09-21 train).
const COHORT_MANIFESTS: Record<string, { name: string; version: string; deps: Record<string, string> }> = {
  'principles-core': { name: '@principles/core', version: '1.287.1', deps: {} },
  'install-layout': { name: '@principles/install-layout', version: '0.2.6', deps: {} },
  'host-runtime': {
    name: '@principles/host-runtime',
    version: '0.7.7',
    deps: { '@principles/core': '^1.74.1', '@principles/install-layout': '^0.2.0' },
  },
  'codex-adapter': {
    name: '@principles/codex-adapter',
    version: '0.4.6',
    deps: { '@principles/core': '^1.287.1', '@principles/host-runtime': '^0.7.7', '@principles/install-layout': '^0.2.0' },
  },
  'openclaw-plugin': { name: 'principles-disciple', version: '2.0.2', deps: { '@principles/core': '^1.287.0' } },
  'pd-cli': {
    name: '@principles/pd-cli',
    version: '1.152.12',
    deps: {
      '@principles/core': '^1.287.1',
      '@principles/codex-adapter': '^0.4.6',
      '@principles/host-runtime': '^0.7.7',
      '@principles/install-layout': '^0.2.0',
      'principles-disciple': '^2.0.2',
    },
  },
  'create-principles-disciple': {
    name: 'create-principles-disciple',
    version: '1.144.0',
    deps: { '@principles/install-layout': '^0.2.0' },
  },
};

function makeCohortFixture(
  overrides: Partial<Record<string, { version?: string; deps?: Record<string, string> }>> = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cohort-'));
  for (const dir of ORDER) {
    const base = COHORT_MANIFESTS[dir]!;
    const o = overrides[dir] ?? {};
    const pkgDir = path.join(root, 'packages', dir);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: base.name, version: o.version ?? base.version, dependencies: o.deps ?? base.deps }, null, 2),
    );
  }
  return root;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (k: string) => (k.toLowerCase() === 'link' ? (headers.link ?? null) : null) },
  };
}

function packument(name: string, versions: string[], latest: string | null = null) {
  const map: Record<string, unknown> = {};
  for (const v of versions) map[v] = { name, version: v };
  return { name, versions: map, 'dist-tags': latest ? { latest } : {} };
}

function fakeClockSleep(record: number[]) {
  return async (ms: number) => {
    record.push(ms);
  };
}

// ---------------------------------------------------------------------------
// Drill 1 + 2: bounded backoff wait — eventual visibility vs window end.
// ---------------------------------------------------------------------------

describe('drills 1-2: propagation wait (fake clock, controlled registry)', () => {
  it('[1] a dependency visible only after >75s eventually CONTINUES (old gate: hard failure)', async () => {
    const { waitForPackageDependencies } = (await loadModule('deps-preflight.mjs')) as {
      waitForPackageDependencies: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const root = makeCohortFixture();
    const plan = ((await loadModule('deps-preflight.mjs')) as { buildTrainPlan: (o: Record<string, unknown>) => unknown[] }).buildTrainPlan({
      workspaceRoot: root,
      order: ORDER,
    });
    let clockMs = 0;
    const sleeps: number[] = [];
    const fetchImpl = async (url: string) => {
      // Route by package: only CORE has delayed visibility (published one
      // leg earlier in this train); host-runtime / install-layout (legs
      // 2-3, published even earlier) are already fully visible.
      if (url.includes('@principles/host-runtime')) {
        return jsonResponse(200, packument('@principles/host-runtime', ['0.7.6', '0.7.7'], '0.7.7'));
      }
      if (url.includes('@principles/install-layout')) {
        return jsonResponse(200, packument('@principles/install-layout', ['0.2.5', '0.2.6'], '0.2.6'));
      }
      const versions = clockMs >= 80000 ? ['1.286.0', '1.287.1'] : ['1.286.0'];
      return jsonResponse(200, packument('@principles/core', versions, '1.286.0'));
    };
    const result = (await waitForPackageDependencies({
      plan,
      packageDir: 'codex-adapter',
      fetchImpl,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
        clockMs += ms;
      },
      backoffSchedule: [5000, 10000, 20000, 40000],
      maxBackoffMs: 60000,
      totalWindowMs: 600000,
      requestTimeoutMs: 5000,
    })) as { ok: boolean; failed?: { kind: string }; checked?: unknown[] };

    expect(result.ok, JSON.stringify(result.failed)).toBe(true);
    // The visibility threshold (80s) exceeds the old gate's entire budget
    // (5×15s) — only the new escalating schedule gets there.
    expect(sleeps.slice(0, 5)).toEqual([5000, 10000, 20000, 40000, 60000]);
    expect(clockMs).toBeGreaterThanOrEqual(80000);
  });

  it('[2] visibility never arriving inside the window FAILS EXPLICITLY, and is NOT read as a range error', async () => {
    const { waitForPackageDependencies } = (await loadModule('deps-preflight.mjs')) as {
      waitForPackageDependencies: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const root = makeCohortFixture();
    const { buildTrainPlan } = (await loadModule('deps-preflight.mjs')) as { buildTrainPlan: (o: Record<string, unknown>) => unknown[] };
    const plan = buildTrainPlan({ workspaceRoot: root, order: ORDER });
    const fetchImpl = async () => jsonResponse(200, packument('@principles/core', ['1.286.0'], '1.286.0'));
    const result = (await waitForPackageDependencies({
      plan,
      packageDir: 'codex-adapter',
      fetchImpl,
      sleepImpl: fakeClockSleep([]),
      backoffSchedule: [5000, 10000, 20000, 40000],
      maxBackoffMs: 60000,
      totalWindowMs: 30000,
      requestTimeoutMs: 5000,
    })) as { ok: boolean; failed?: { kind: string; message: string; lastAnswerKind: string } };

    expect(result.ok).toBe(false);
    expect(result.failed?.kind).toBe('NOT_VISIBLE_WITHIN_WINDOW');
    expect(result.failed?.lastAnswerKind).toBe('NOT_YET_VISIBLE');
    // The exact anti-pattern of the old gate's error is explicitly negated.
    expect(result.failed?.message).toContain('NOT a dependency-range error');
    expect(result.failed?.message).not.toMatch(/range excludes/i);
  });
});

// ---------------------------------------------------------------------------
// Drill 3: error classification — network/timeout vs 429/5xx vs auth.
// ---------------------------------------------------------------------------

describe('drill 3: registry error classification', () => {
  it('distinguishes RATE_LIMITED / SERVER_ERROR / AUTH / NETWORK classes', async () => {
    const { classifyRegistryError } = (await loadModule('deps-preflight.mjs')) as {
      classifyRegistryError: (e: unknown) => { kind: string; retryable: boolean };
    };
    const { RegistryError } = (await loadModule('lib/registry-client.mjs')) as { RegistryError: new (m: string, o: { status?: number }) => Error };
    expect(classifyRegistryError(new RegistryError('HTTP 429', { status: 429 })).kind).toBe('RATE_LIMITED');
    expect(classifyRegistryError(new RegistryError('HTTP 503', { status: 503 })).kind).toBe('SERVER_ERROR');
    expect(classifyRegistryError(new RegistryError('HTTP 401', { status: 401 })).kind).toBe('AUTH');
    expect(classifyRegistryError(new RegistryError('HTTP 403', { status: 403 })).kind).toBe('AUTH');
    expect(classifyRegistryError(new RegistryError('network failure fetching https://x/y: ECONNREFUSED')).kind).toBe('NETWORK_ERROR');
    expect(classifyRegistryError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })).kind).toBe('NETWORK_TIMEOUT');
  });

  it('AUTH is fatal immediately — no waiting, no retries', async () => {
    const { waitForPackageDependencies, buildTrainPlan } = (await loadModule('deps-preflight.mjs')) as Record<string, (o: Record<string, unknown>) => Promise<unknown> & ((o: Record<string, unknown>) => unknown[])>;
    const root = makeCohortFixture();
    const plan = buildTrainPlan({ workspaceRoot: root, order: ORDER }) as unknown[];
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(401, {});
    };
    const result = (await waitForPackageDependencies({
      plan,
      packageDir: 'codex-adapter',
      fetchImpl,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
      backoffSchedule: [5000, 10000],
      maxBackoffMs: 60000,
      totalWindowMs: 600000,
      requestTimeoutMs: 5000,
    })) as { ok: boolean; failed?: { kind: string } };
    expect(result.ok).toBe(false);
    expect(result.failed?.kind).toBe('AUTH');
    expect(sleeps).toEqual([]);
    expect(calls).toBe(1);
  });

  it('5xx answers are retried inside the window and reported as the last answer class', async () => {
    const { waitForPackageDependencies, buildTrainPlan } = (await loadModule('deps-preflight.mjs')) as Record<string, (o: Record<string, unknown>) => Promise<unknown> & ((o: Record<string, unknown>) => unknown[])>;
    const root = makeCohortFixture();
    const plan = buildTrainPlan({ workspaceRoot: root, order: ORDER }) as unknown[];
    const result = (await waitForPackageDependencies({
      plan,
      packageDir: 'codex-adapter',
      fetchImpl: async () => jsonResponse(503, {}),
      sleepImpl: fakeClockSleep([]),
      backoffSchedule: [1000, 1000],
      maxBackoffMs: 1000,
      totalWindowMs: 2500,
      requestTimeoutMs: 5000,
    })) as { ok: boolean; failed?: { kind: string; lastAnswerKind: string } };
    expect(result.ok).toBe(false);
    expect(result.failed?.kind).toBe('NOT_VISIBLE_WITHIN_WINDOW');
    expect(result.failed?.lastAnswerKind).toBe('SERVER_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Drill 4: deterministic range/order errors caught BEFORE any upload.
// ---------------------------------------------------------------------------

describe('drill 4: static plan validation (no registry contact)', () => {
  it('a range that excludes the dependency cohort version fails statically', async () => {
    const { buildTrainPlan, validatePlanStatic } = (await loadModule('deps-preflight.mjs')) as Record<string, (o: Record<string, unknown>) => unknown>;
    const root = makeCohortFixture({ 'codex-adapter': { deps: { '@principles/core': '^9.0.0' } } });
    const plan = buildTrainPlan({ workspaceRoot: root, order: ORDER }) as unknown[];
    const result = validatePlanStatic(plan) as { ok: boolean; errors: { kind: string; message: string }[] };
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.kind)).toContain('RANGE_EXCLUDES_COHORT_VERSION');
    expect(result.errors.find((e) => e.kind === 'RANGE_EXCLUDES_COHORT_VERSION')?.message).toContain('^9.0.0');
  });

  it('a non-topological train order fails statically', async () => {
    const { buildTrainPlan, validatePlanStatic } = (await loadModule('deps-preflight.mjs')) as Record<string, (o: Record<string, unknown>) => unknown>;
    const root = makeCohortFixture();
    const badOrder = [...ORDER];
    // pd-cli (depends on the plugin) publishing before the plugin.
    const pluginIdx = badOrder.indexOf('openclaw-plugin');
    const cliIdx = badOrder.indexOf('pd-cli');
    badOrder[pluginIdx] = 'pd-cli';
    badOrder[cliIdx] = 'openclaw-plugin';
    const plan = buildTrainPlan({ workspaceRoot: root, order: badOrder }) as unknown[];
    const result = validatePlanStatic(plan) as { ok: boolean; errors: { kind: string }[] };
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.kind)).toContain('ORDER_VIOLATION');
  });

  it('the healthy cohort bdfe2fc8 plan passes statically', async () => {
    const { buildTrainPlan, validatePlanStatic } = (await loadModule('deps-preflight.mjs')) as Record<string, (o: Record<string, unknown>) => unknown>;
    const root = makeCohortFixture();
    const plan = buildTrainPlan({ workspaceRoot: root, order: ORDER }) as unknown[];
    expect((validatePlanStatic(plan) as { ok: boolean }).ok).toBe(true);
  });

  it('CLI: static errors exit 10 before any registry call (server sees zero requests)', async () => {
    const root = makeCohortFixture({ 'codex-adapter': { deps: { '@principles/core': '^9.0.0' } } });
    let requests = 0;
    const server = createServer((req, res) => {
      requests += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(packument('@principles/core', ['1.286.0'])));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const outcome = await new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(
          process.execPath,
          [
            path.join(RELEASE_DIR, 'deps-preflight.mjs'),
            '--workspace-root', root,
            '--order', ORDER.join(','),
            '--package', 'codex-adapter',
          ],
          { env: { ...process.env, PD_RELEASE_REGISTRY: `http://127.0.0.1:${port}` } },
          (err, _stdout, stderr) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, stderr: String(stderr) }),
        );
      });
      expect(outcome.code).toBe(10);
      expect(outcome.stderr).toContain('RANGE_EXCLUDES_COHORT_VERSION');
      // The deterministic error surfaces BEFORE any registry contact.
      expect(requests).toBe(0);
    } finally {
      server.close();
    }
  });

  it('CLI: window exhaustion exits 11 with the not-a-range-error wording', async () => {
    const root = makeCohortFixture();
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(packument('@principles/core', ['1.286.0'], '1.286.0')));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const outcome = await new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(
          process.execPath,
          [
            path.join(RELEASE_DIR, 'deps-preflight.mjs'),
            '--workspace-root', root,
            '--order', ORDER.join(','),
            '--package', 'codex-adapter',
          ],
          {
            env: {
              ...process.env,
              PD_RELEASE_REGISTRY: `http://127.0.0.1:${port}`,
              PD_RELEASE_DEPS_BACKOFF_MS: '10,20',
              PD_RELEASE_DEPS_MAX_BACKOFF_MS: '20',
              PD_RELEASE_DEPS_TOTAL_WINDOW_MS: '50',
            },
          },
          (err, _stdout, stderr) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, stderr: String(stderr) }),
        );
      });
      expect(outcome.code).toBe(11);
      expect(outcome.stderr).toContain('NOT a dependency-range error');
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Drills 5-7: publish outcome decisions — recovery skip, lost ack, conflict.
// ---------------------------------------------------------------------------

async function cliWithServer(script: string, args: string[], serve: (url: string, res: import('node:http').ServerResponse) => void) {
  const server = createServer((req, res) => serve(req.url ?? '', res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [path.join(RELEASE_DIR, script), ...args],
        { env: { ...process.env, PD_RELEASE_REGISTRY: `http://127.0.0.1:${port}`, PD_RELEASE_RETRY_DELAY_MS: '1' } },
        (err, stdout, stderr) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  } finally {
    server.close();
  }
}

const COHORT = 'bdfe2fc80afdefec8d00d20754907c967cf6afff';

describe('drills 5-7: exact-state and ambiguous publish outcome', () => {
  it('[5] partial recovery: an already-published PRESENT_MATCH version is a skip (exit 0), never a second upload', async () => {
    const out = await cliWithServer(
      'registry-exact.mjs',
      ['@principles/core', '1.287.1', '--expect-git-head', COHORT],
      (_url, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            name: '@principles/core',
            versions: { '1.287.1': { name: '@principles/core', version: '1.287.1', gitHead: COHORT } },
            'dist-tags': { latest: '1.287.1' },
          }),
        );
      },
    );
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('PRESENT_MATCH');
  });

  it('[6] npm publish "failed" but the registry proves the upload landed → continue (exit 0)', async () => {
    const out = await cliWithServer(
      'verify-publish-outcome.mjs',
      ['@principles/core', '1.287.1', '--expect-git-head', COHORT],
      (_url, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            name: '@principles/core',
            version: '1.287.1',
            gitHead: COHORT,
          }),
        );
      },
    );
    expect(out.code).toBe(0);
    expect(out.stderr).toContain('treating as published and continuing');
  });

  it('[6b] npm publish failed and the registry still shows the version absent → real failure (exit 1)', async () => {
    const out = await cliWithServer(
      'verify-publish-outcome.mjs',
      ['@principles/core', '1.287.1', '--expect-git-head', COHORT],
      (_url, res) => {
        res.statusCode = 404;
        res.end('{}');
      },
    );
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('upload did not land');
  });

  it('[7] a foreign-source version (gitHead mismatch) still BLOCKS (exit 1)', async () => {
    const out = await cliWithServer(
      'verify-publish-outcome.mjs',
      ['@principles/core', '1.287.1', '--expect-git-head', COHORT],
      (_url, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: '@principles/core', version: '1.287.1', gitHead: 'f'.repeat(40) }));
      },
    );
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('integrity conflict');
  });
});

// ---------------------------------------------------------------------------
// Drill 8: product/tools separation — new tools SHA, old cohort content.
// ---------------------------------------------------------------------------

describe('drill 8: product (cohort) vs tools checkout separation', () => {
  const trainText = () => fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'publish-npm.yml'), 'utf8');
  const actionText = () => fs.readFileSync(path.join(REPO_ROOT, '.github', 'actions', 'publish-npm-package', 'action.yml'), 'utf8');

  it('the train checks out PRODUCT at the cohort SHA (workspace root) and TOOLS at a pinned separate path', () => {
    const t = trainText();
    // Product checkout: the cohort ref, at the workspace root (no path).
    expect(t).toMatch(/ref: \$\{\{ needs\.resolve-cohort\.outputs\.cohort_sha \}\}/);
    // Tools checkout: pinned dispatch SHA (never floating main mid-run), separate path.
    expect(t).toContain('ref: ${{ inputs.tools_ref || github.sha }}');
    expect(t).toContain('path: release-tools');
    // The publish action is loaded FROM the tools checkout.
    expect(t.match(/uses: \.\/release-tools\/\.github\/actions\/publish-npm-package/g)?.length).toBe(7);
    expect(t).toContain('uses: ./release-tools/.github/actions/finalize-npm-release');
  });

  it('the action reads manifests from the product workspace but invokes control scripts only via $TOOLS_DIR', () => {
    const a = actionText();
    expect(a).toContain('node "$TOOLS_DIR/scripts/release/registry-exact.mjs"');
    expect(a).toContain('node "$TOOLS_DIR/scripts/release/deps-preflight.mjs"');
    // The publish-failure fallback absolutizes the tools path BEFORE cd —
    // a relative tools_dir must stay valid from inside packages/<dir>
    // (rehearsal run 35666369142 regression).
    expect(a).toContain('TOOLS_ABS="$(cd "$TOOLS_DIR" && pwd)"');
    expect(a).toContain('node "$TOOLS_ABS/scripts/release/verify-publish-outcome.mjs"');
    // No script invocation straight from the workspace (cohort) scripts tree.
    expect(a).not.toMatch(/node scripts\/release\//);
  });

  it('deps-preflight reads manifests from the COHORT workspace root while running from the tools tree', async () => {
    const { buildTrainPlan } = (await loadModule('deps-preflight.mjs')) as { buildTrainPlan: (o: Record<string, unknown>) => { name: string; version: string }[] };
    const root = makeCohortFixture({ 'codex-adapter': { version: '0.4.6' } });
    const plan = buildTrainPlan({ workspaceRoot: root, order: ORDER });
    // The plan mirrors the fixture (cohort) content, not this repo's working
    // tree — product content is never replaced by the tools checkout.
    const codex = plan.find((p) => p.name === '@principles/codex-adapter');
    expect(codex?.version).toBe('0.4.6');
    const plugin = plan.find((p) => p.name === 'principles-disciple');
    expect(plugin?.version).toBe('2.0.2');
  });

  it('the legacy hidden-output gate is gone (regression pin against run 35596275911)', () => {
    const a = actionText();
    expect(a).not.toContain('npm view');
    expect(a).not.toContain('>/dev/null 2>&1');
    // The old misleading diagnosis is not merely reworded away — the
    // replacement script's failure kinds are the documented contract.
    expect(a).toContain('deps-preflight.mjs');
  });

  it('every run records both identities (cohort + tools) in the summary', () => {
    const t = trainText();
    expect(t).toContain('Record release identities (cohort + tools)');
    expect(t).toContain('tools_sha');
  });
});

// ---------------------------------------------------------------------------
// Drill 9: validation-evidence reuse — accept valid, reject every mismatch.
// ---------------------------------------------------------------------------

const RUNNERS = ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15-intel', 'macos-15', 'windows-2025'];
const NODES = ['22.22.2', '24.12.0', '26.7.0'];
const LEGS = RUNNERS.flatMap((runner) => NODES.map((node) => ({ runner, node })));
const HEAD_SHA = 'a'.repeat(40);
const TRUST_SHA = 'e'.repeat(40);

function legJobs(overrides: { skip?: string; fail?: string; attempt?: number } = {}) {
  const skip = overrides.skip ?? '';
  const fail = overrides.fail ?? '';
  const attempt = overrides.attempt ?? 1;
  const jobs = LEGS.map(({ runner, node }, i) => ({
    id: 1000 + i,
    name: `Verify Full Release Matrix (cohort SHA) / native-release-matrix (${runner}, ${node})`,
    conclusion: fail === `${runner}|${node}` ? 'failure' : 'success',
    run_attempt: attempt,
  })).filter((j) => !skip || !j.name.includes(`(${skip.split('|').join(', ')})`));
  jobs.push({
    id: 2000,
    name: 'Verify Full Release Matrix (cohort SHA) / N-1 to N real upgrade gate (windows-2025, 22.22.2)',
    conclusion: 'success',
    run_attempt: attempt,
  });
  jobs.push({ id: 3000, name: 'Publish release cohort (release train)', conclusion: 'failure', run_attempt: attempt });
  return jobs;
}

function legLogText(cohort: string) {
  // Mirrors REAL GitHub job-log shape: every line carries a timestamp
  // prefix (which is why the echo proof matches on line ENDING, and the
  // fetch proof on substring containment).
  return [
    '2026-09-21T11:56:22.1655285Z Uses: csuzngjh/principles/.github/workflows/release-reproducibility-full.yml@refs/heads/main',
    `2026-09-21T11:56:22.1661343Z   ref: ${cohort}`,
    '2026-09-21T11:56:22.1662154Z ##[group]Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    `2026-09-21T11:56:22.2493524Z   ref: ${cohort}`,
    `2026-09-21T11:56:22.5189567Z [command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin ${cohort}`,
    `2026-09-21T11:56:23.5620745Z  * branch            ${cohort} -> FETCH_HEAD`,
  ].join('\n');
}

async function verifyWith(options: {
  runPath?: string;
  jobs?: unknown[];
  logCohort?: string;
  logStatus?: number;
  ancestors?: string[];
  expectedLegs?: { runner: string; node: string }[];
}) {
  const { verifyValidationEvidence } = (await loadModule('verify-validation-evidence.mjs')) as {
    verifyValidationEvidence: (o: Record<string, unknown>) => Promise<{ ok: boolean; reasons: string[]; facts: Record<string, unknown> }>;
  };
  const cohort = COHORT;
  const jobs = options.jobs ?? legJobs();
  const ancestors = options.ancestors ?? [HEAD_SHA, cohort];
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith(`/actions/runs/${options.runPath ?? '123'}`) && url.includes('/actions/runs/')) {
      if (!url.endsWith('/jobs?per_page=100')) {
        return jsonResponse(200, {
          id: 123,
          path: '.github/workflows/publish-npm.yml',
          event: 'workflow_dispatch',
          status: 'completed',
          conclusion: 'failure',
          run_attempt: 1,
          head_sha: HEAD_SHA,
          referenced_workflows: [{ path: 'csuzngjh/principles/.github/workflows/release-reproducibility-full.yml', sha: cohort }],
        });
      }
    }
    if (url.includes('/jobs?per_page=100')) return jsonResponse(200, { jobs });
    if (url.includes('/actions/jobs/')) {
      if (options.logStatus && options.logStatus !== 200) return jsonResponse(options.logStatus, {});
      return { ok: true, status: 200, text: async () => legLogText(options.logCohort ?? cohort), json: async () => { throw new Error('not json'); }, headers: { get: () => null } };
    }
    return jsonResponse(404, {});
  };
  return {
    calls,
    verdict: await verifyValidationEvidence({
      runId: 123,
      repo: 'csuzngjh/principles',
      expectCohort: cohort,
      trustSha: TRUST_SHA,
      expectedLegs: options.expectedLegs ?? LEGS,
      apiBase: 'https://api.example.invalid',
      fetchImpl,
      gitIsAncestor: (sha: string) => ancestors.includes(sha),
      log: () => {},
    }),
  };
}

describe('drill 9: validation evidence reuse (injected GitHub API)', () => {
  it('a valid prior run (15 legs + gate, correct ref, trusted ancestry) is REUSABLE even though the run itself failed', async () => {
    const { verdict } = await verifyWith({});
    expect(verdict.reasons, verdict.reasons.join('; ')).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.facts.validatedRef).toBe(COHORT);
    expect(verdict.facts.attempt).toBe(1);
    expect(verdict.facts.legsChecked.length).toBe(15);
  });

  it('a run whose logs prove a DIFFERENT cohort is rejected', async () => {
    const { verdict } = await verifyWith({ logCohort: 'c'.repeat(40) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('do not prove the validated ref');
  });

  it('a missing matrix leg is rejected (14 legs do not cover the current baseline)', async () => {
    const { verdict } = await verifyWith({ jobs: legJobs().filter((j) => !j.name.includes('macos-15, 26.7.0')) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('required matrix leg missing');
  });

  it('a failed leg is rejected', async () => {
    const { verdict } = await verifyWith({ jobs: legJobs({ fail: 'windows-2025|22.22.2' }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('matrix leg did not succeed');
  });

  it('an untrusted workflow path is rejected', async () => {
    const { verifyValidationEvidence } = (await loadModule('verify-validation-evidence.mjs')) as { verifyValidationEvidence: (o: Record<string, unknown>) => Promise<{ ok: boolean; reasons: string[] }> };
    const jobs = legJobs();
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/actions/runs/123')) {
        return jsonResponse(200, {
          id: 123, path: '.github/workflows/evil-fork.yml', event: 'workflow_dispatch', status: 'completed',
          run_attempt: 1, head_sha: HEAD_SHA, referenced_workflows: [],
        });
      }
      if (url.includes('/jobs?per_page=100')) return jsonResponse(200, { jobs });
      return jsonResponse(404, {});
    };
    const verdict = await verifyValidationEvidence({
      runId: 123, repo: 'csuzngjh/principles', expectCohort: COHORT, trustSha: TRUST_SHA,
      expectedLegs: LEGS, apiBase: 'https://api.example.invalid', fetchImpl,
      gitIsAncestor: () => true, log: () => {},
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('untrusted workflow');
  });

  it('a workflow revision outside the trusted ancestry is rejected', async () => {
    const { verdict } = await verifyWith({ ancestors: [HEAD_SHA] }); // cohort sha not an ancestor
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('not an ancestor of the trusted tools SHA');
  });

  it('unavailable logs (expired) are rejected — never silently reused', async () => {
    const { verdict } = await verifyWith({ logStatus: 410 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('unverifiable, refusing to reuse');
  });

  it('jobs from a different attempt than the recorded run_attempt are not accepted', async () => {
    // Every leg exists, but all recorded at attempt 2 while the run says 1.
    const { verdict } = await verifyWith({ jobs: legJobs({ attempt: 2 }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('required matrix leg missing');
  });

  it('a matrix baseline with EXTRA legs vs the current definition is rejected as incompatible', async () => {
    const { verdict } = await verifyWith({ expectedLegs: LEGS.slice(0, 5) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('the current baseline does not define');
  });
});

// ---------------------------------------------------------------------------
// Drill 10: finalize isolation — npm phase completes first, closing steps
// retriable and visible, recovery never re-uploads.
// ---------------------------------------------------------------------------

describe('drill 10: closing-step isolation (workflow structure)', () => {
  const trainText = () => fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'publish-npm.yml'), 'utf8');
  const finalizeText = () => fs.readFileSync(path.join(REPO_ROOT, '.github', 'actions', 'finalize-npm-release', 'action.yml'), 'utf8');
  const actionText = () => fs.readFileSync(path.join(REPO_ROOT, '.github', 'actions', 'publish-npm-package', 'action.yml'), 'utf8');

  it('the train job has exactly seven npm legs and ZERO closing steps', () => {
    const t = trainText();
    expect(t.match(/uses: \.\/release-tools\/\.github\/actions\/publish-npm-package/g)?.length).toBe(7);
    for (const banned of ['Reconcile Git tag', 'gh release create', 'clawhub package publish', 'git push origin "$TAG"']) {
      expect(t).not.toContain(banned);
    }
  });

  it('the publish action itself has no closing steps either', () => {
    const a = actionText();
    for (const banned of ['Reconcile Git tag', 'gh release create', 'clawhub package publish']) {
      expect(a).not.toContain(banned);
    }
  });

  it('the finalize job runs only after the npm train succeeded, and is independently retriable', () => {
    const t = trainText();
    expect(t).toContain('publish-finalize:');
    expect(t).toContain('needs: [resolve-cohort, publish-full-product]');
    expect(t).toContain('needs.publish-full-product.result == \'success\'');
    // Idempotent reconciliation is preserved (tag semantics + conflict check).
    const f = finalizeText();
    expect(f).toContain('Refusing to move an existing tag');
    expect(f).toContain('continue-on-error: true'); // ClawHub degrades, never blocks
  });

  it('the rehearsal/preflight workflow never uploads (dry_run legs, no write permissions)', () => {
    const p = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'publish-preflight.yml'), 'utf8');
    expect(p.match(/dry_run: true/g)?.length).toBe(7);
    expect(p).not.toContain('id-token: write');
    expect(p).not.toContain('contents: write');
    expect(p).not.toContain('actions: write');
    // A rehearsal is never presented as a publish.
    expect(p).toContain('NOT evidence of a published version');
  });

  it('the publish step stays gated on ABSENT, and the rehearsal skip is decided in bash (exact env comparison)', () => {
    const a = actionText();
    // ABSENT gate keeps recovery re-dispatches skipping published legs.
    const publishStep = a.slice(a.indexOf('name: Publish exact committed version'));
    expect(publishStep).toContain("if: ${{ steps.exact.outputs.status == 'ABSENT' }}");
    // The rehearsal skip must NOT be an `if`-expression boolean comparison:
    // GitHub expression coercion opened this gate for a boolean true in
    // rehearsal run 35666369142. Env + exact bash comparison is the pin.
    expect(publishStep).toContain('DRY_RUN: ${{ inputs.dry_run }}');
    expect(publishStep).toContain('[ "$DRY_RUN" = "true" ]');
    expect(publishStep).not.toMatch(/inputs\.dry_run != true/);
    expect(publishStep).toContain('the real npm upload is SKIPPED');
  });
});
