import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertNoDowngrade,
  checkMetadata,
  classifyCohort,
  composePinsFromWorkspace,
  deferredReport,
  gitIsAncestor,
  nextPins,
  pinsFromWorkspace,
  PUBLISH_RECHECK_TIMEOUT_MS,
  PUBLISH_WAIT_TIMEOUT_MS,
  verifyPinnedManifests,
  waitForPinnedManifests,
  waitForPublishedCohort,
} from '../release/sync-codex-runtime-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
describe('Codex runtime delivery authority and discoverability', () => {
  it('requires all four exact cohort identities, including core and the MCP server, without floating latest', () => {
    const versions = { '@principles/codex-adapter': '0.5.14', '@principles/host-runtime': '0.14.0', '@principles/core': '1.297.0', '@principles/pd-mcp-server': '0.1.0' };
    expect(nextPins(versions)).toEqual({ codexAdapter: '0.5.14', hostRuntime: '0.14.0', core: '1.297.0', mcpServer: '0.1.0' });
    expect(() => nextPins({ ...versions, '@principles/core': 'latest' })).toThrow();
    expect(() => nextPins({ ...versions, '@principles/pd-mcp-server': '^0.1.0' })).toThrow();
    expect(() => nextPins({ '@principles/codex-adapter': '0.5.14' })).toThrow();
  });
  it('payload edits must increase the host cache version; unrelated docs do not', () => {
    expect(() => checkMetadata('0.2.0', '0.2.0', true)).toThrow(/cache/);
    expect(() => checkMetadata('0.2.0', '0.1.9', true)).toThrow();
    expect(() => checkMetadata('0.2.0', '0.2.1', true)).not.toThrow();
    expect(() => checkMetadata('0.2.0', '0.2.0', false)).not.toThrow();
  });
  it('a delayed older release run cannot roll back a newer plugin cohort', () => {
    const current = { codexAdapter: '0.5.14', hostRuntime: '0.14.0', core: '1.297.0', mcpServer: '0.1.0' };
    expect(() => assertNoDowngrade(current, { ...current, core: '1.296.0' })).toThrow(/stale cohort/);
    expect(() => assertNoDowngrade(current, { ...current, mcpServer: '0.0.9' })).toThrow(/stale cohort/);
    expect(() => assertNoDowngrade(current, current)).not.toThrow();
    expect(() => assertNoDowngrade(current, { ...current, core: '1.298.0' })).not.toThrow();
  });
  // PRI-1067: the maintenance leg can start seconds after npm publish returns.
  // A single packument read treats propagation as "not published", so the
  // cohort check needs a bounded wait — and a real absence must still fail.
  describe('PRI-1067 bounded propagation wait', () => {
    const sha = 'a'.repeat(40);
    const incomplete = {
      cohort: true,
      sha,
      publishComplete: false,
      packages: [
        { name: '@principles/core', version: '1.297.0', published: false },
        { name: '@principles/host-runtime', version: '0.14.0', published: true },
      ],
    };
    const complete = { ...incomplete, publishComplete: true, packages: [
      { name: '@principles/core', version: '1.297.0', published: true },
      { name: '@principles/host-runtime', version: '0.14.0', published: true },
    ] };

    it('waits through a propagation window and succeeds once every package is visible', () => {
      let clock = 0;
      let calls = 0;
      const sleeps: number[] = [];
      const responses = [incomplete, complete];
      const result = waitForPublishedCohort({
        sha,
        timeoutMs: 60_000,
        intervalMs: 5_000,
        now: () => clock,
        sleep: (ms: number) => {
          clock += ms;
          sleeps.push(ms);
        },
        resolve: () => {
          calls += 1;
          return responses[Math.min(calls - 1, responses.length - 1)];
        },
      });
      expect(result.publishComplete).toBe(true);
      expect(calls).toBe(2);
      expect(sleeps).toEqual([5_000]);
    });

    it('negative control: a genuinely absent package still fails after the budget and names it', () => {
      let clock = 0;
      let calls = 0;
      let caught: unknown;
      try {
        waitForPublishedCohort({
          sha,
          timeoutMs: 15_000,
          intervalMs: 5_000,
          now: () => clock,
          sleep: (ms: number) => {
            clock += ms;
          },
          resolve: () => {
            calls += 1;
            return incomplete;
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain('@principles/core@1.297.0');
      expect(message).toContain('after 115000ms');
      expect(message).toContain('main budget 15000ms');
      expect(message).toContain('nextAction');
      // It really consumed the main budget and the default recheck round:
      // 24 reads at t=0/5/.../115s.
      expect(calls).toBe(24);
      expect(clock).toBe(115_000);
    });

    // Measured 2026-11-04: the installer became registry-visible
    // ~4 minutes after its upload finished, so a 300s main budget plus one
    // independent recheck round is required — and the budget must stay a
    // single source, not drift into the workflow.
    it('PRI-1067 long-tail: the default budget covers the measured 4-minute tail with a derived recheck round', () => {
      expect(PUBLISH_WAIT_TIMEOUT_MS).toBe(300_000);
      expect(PUBLISH_RECHECK_TIMEOUT_MS).toBe(PUBLISH_WAIT_TIMEOUT_MS / 3);
      expect(PUBLISH_RECHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
      expect(PUBLISH_RECHECK_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
      const train = fs.readFileSync(path.join(root, '.github/workflows/publish-npm.yml'), 'utf8');
      expect(train).not.toContain('--timeout');
      const source = fs.readFileSync(path.join(root, 'scripts/release/sync-codex-runtime-pins.mjs'), 'utf8');
      // Only the exported constants carry the numbers; no inline default literal.
      expect(source).not.toMatch(/timeoutMs\s*=\s*\d/);
      expect(source).not.toMatch(/recheckMs\s*=\s*\d/);
    });

    it('PRI-1067 long-tail: the default budget drives the real wait loop and its failure text', () => {
      let clock = 0;
      let calls = 0;
      let caught: unknown;
      try {
        waitForPublishedCohort({
          sha,
          now: () => clock,
          sleep: (ms: number) => {
            clock += ms;
          },
          resolve: () => {
            calls += 1;
            return incomplete;
          },
        });
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain('after 400000ms');
      expect(message).toContain('main budget 300000ms');
      expect(message).toContain('@principles/core@1.297.0');
      // 81 reads at t=0/5/.../400s; the whole default budget (300s + 100s) was
      // consumed before failing, so the default really is the last line of defence.
      expect(calls).toBe(81);
      expect(clock).toBe(400_000);
    });

    it('PRI-1067 long-tail: a package visible only after the main budget is accepted by the recheck round', () => {
      let clock = 0;
      let calls = 0;
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const result = waitForPublishedCohort({
          sha,
          now: () => clock,
          sleep: (ms: number) => {
            clock += ms;
          },
          resolve: () => {
            calls += 1;
            return clock >= 350_000 ? complete : incomplete;
          },
        });
        expect(result.publishComplete).toBe(true);
        expect(log).toHaveBeenCalledTimes(1);
        expect(String(log.mock.calls[0]?.[0])).toContain('became visible after 350000ms');
      } finally {
        log.mockRestore();
      }
      // t=0/5/.../350s: the main budget (300s) really expired first.
      expect(calls).toBe(71);
      expect(clock).toBe(350_000);
    });

    it('PRI-1067 long-tail negative control: visibility beyond the recheck round still fails and reports the measured delay', () => {
      let clock = 0;
      let caught: unknown;
      try {
        waitForPublishedCohort({
          sha,
          now: () => clock,
          sleep: (ms: number) => {
            clock += ms;
          },
          resolve: () => (clock >= 450_000 ? complete : incomplete),
        });
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain('after 400000ms');
      expect(message).toContain('@principles/core@1.297.0');
      expect(message).toContain('100000ms recheck');
      expect(clock).toBe(400_000);
    });

    it('PRI-1094: an explicit timeoutMs wins over the default budget', () => {
      let clock = 0;
      let caught: unknown;
      try {
        waitForPublishedCohort({
          sha,
          timeoutMs: 15_000,
          recheckMs: 0,
          intervalMs: 5_000,
          now: () => clock,
          sleep: (ms: number) => {
            clock += ms;
          },
          resolve: () => incomplete,
        });
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain('after 15000ms');
      expect(message).not.toContain('300000ms');
      expect(clock).toBe(15_000);
    });

    it('a different current cohort fails immediately instead of waiting for the wrong target', () => {
      expect(() => waitForPublishedCohort({
        sha,
        timeoutMs: 60_000,
        intervalMs: 5_000,
        now: () => 0,
        sleep: () => undefined,
        resolve: () => ({ ...incomplete, sha: 'b'.repeat(40) }),
        isAncestor: () => false,
      })).toThrow(/not the current release cohort/);
    });

    it('refuses to decide anything when the ancestry authority was never wired', () => {
      expect(() => waitForPublishedCohort({
        sha,
        timeoutMs: 60_000,
        intervalMs: 5_000,
        now: () => 0,
        sleep: () => undefined,
        resolve: () => ({ ...incomplete, sha: 'b'.repeat(40) }),
      })).toThrow(/ancestry authority is not wired/);
    });

    it('does not retry a registry query failure', () => {
      let calls = 0;
      expect(() => waitForPublishedCohort({
        sha,
        timeoutMs: 60_000,
        intervalMs: 5_000,
        now: () => 0,
        sleep: () => undefined,
        resolve: () => {
          calls += 1;
          throw new Error('registry query failed: 503');
        },
      })).toThrow(/registry query failed/);
      expect(calls).toBe(1);
    });
  });

  // The maintenance leg runs AFTER npm publication, but the 16-leg matrix takes
  // 64-105 minutes; a newer Version Packages PR routinely lands in that window.
  // That case must hand off (the newer cohort's run owns delivery) instead of
  // failing the release train — while every other mismatch stays a hard
  // failure. Measured 2026-11-10: runs 42750562739 / 42753009939 / 42771071290
  // all died here with `target is not the current release cohort`.
  describe('superseded cohort defers; every other mismatch still fails', () => {
    const target = 'a'.repeat(40);
    const newer = 'c'.repeat(40);
    const controls = { timeoutMs: 60_000, intervalMs: 5_000, now: () => 0, sleep: () => undefined };
    const cohort = (sha: string, publishComplete = true) => ({
      cohort: true,
      sha,
      publishComplete,
      packages: [
        { name: '@principles/codex-adapter', version: '0.8.7', published: publishComplete },
        { name: '@principles/host-runtime', version: '3.2.1', published: publishComplete },
        { name: '@principles/core', version: '7.0.0', published: publishComplete },
        { name: '@principles/pd-mcp-server', version: '0.3.3', published: publishComplete },
      ],
    });

    it('case 1: the target IS the current cohort — publishes normally, ancestry is never consulted', () => {
      const result = waitForPublishedCohort({
        ...controls,
        sha: target,
        resolve: () => cohort(target),
        isAncestor: () => {
          throw new Error('ancestry must not be consulted when the cohort matches');
        },
      });
      expect(result.outcome).toBe('published');
      expect(result.publishComplete).toBe(true);
    });

    it('case 2: a proven newer cohort supersedes the target — deferred, names it, does not wait', () => {
      let calls = 0;
      const result = waitForPublishedCohort({
        ...controls,
        sha: target,
        resolve: () => {
          calls += 1;
          return cohort(newer);
        },
        isAncestor: (ancestor: string, descendant: string) => ancestor === target && descendant === newer,
      });
      expect(result.outcome).toBe('deferred');
      expect(result.supersededBy).toBe(newer);
      expect(result.target).toBe(target);
      expect(calls).toBe(1); // a hand-off is not a retry loop
    });

    it('case 2 boundary: the newer cohort need not be published yet — its own run owns delivery', () => {
      const result = waitForPublishedCohort({
        ...controls,
        sha: target,
        resolve: () => cohort(newer, false),
        isAncestor: () => true,
      });
      expect(result.outcome).toBe('deferred');
      expect(result.supersededBy).toBe(newer);
    });

    it('case 3a: a different SHA that is NOT a descendant is a real failure', () => {
      expect(() => waitForPublishedCohort({
        ...controls,
        sha: target,
        resolve: () => cohort(newer),
        isAncestor: () => false,
      })).toThrow(/not the current release cohort/);
    });

    it('case 3b: ancestry is not proof — the newer commit must be a reproduced Version Packages landing commit', () => {
      expect(() => waitForPublishedCohort({
        ...controls,
        sha: target,
        resolve: () => ({ ...cohort(newer), cohort: false }),
        isAncestor: () => true,
      })).toThrow(/not a proven Version Packages landing commit/);
    });

    it('case 3c: a target newer than the resolved main spine still fails', () => {
      const older = 'd'.repeat(40);
      expect(() => waitForPublishedCohort({
        ...controls,
        sha: target,
        resolve: () => cohort(older),
        isAncestor: (ancestor: string, descendant: string) => ancestor === older && descendant === target,
      })).toThrow(/supersession is not proven/);
    });

    it('case 3d: an incomplete CURRENT cohort still exhausts the budget and fails', () => {
      let clock = 0;
      let caught: unknown;
      try {
        waitForPublishedCohort({
          sha: target,
          timeoutMs: 15_000,
          recheckMs: 0,
          intervalMs: 5_000,
          now: () => clock,
          sleep: (ms: number) => {
            clock += ms;
          },
          resolve: () => cohort(target, false),
          isAncestor: () => true,
        });
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain('@principles/core@7.0.0');
      expect(message).toContain('after 15000ms');
      expect(clock).toBe(15_000);
    });
  });

  describe('classifyCohort: only a proven ancestor may defer', () => {
    const target = 'a'.repeat(40);
    const newer = 'c'.repeat(40);

    it('keeps the four verdicts distinct', () => {
      expect(classifyCohort({ sha: target, latest: { cohort: true, sha: target } })).toEqual({ outcome: 'current' });
      expect(classifyCohort({ sha: target, latest: { cohort: true, sha: newer }, isAncestor: () => true }))
        .toEqual({ outcome: 'superseded', supersededBy: newer });
      expect(classifyCohort({ sha: target, latest: { cohort: true, sha: newer }, isAncestor: () => false }).outcome)
        .toBe('unrelated');
      expect(classifyCohort({ sha: target, latest: { cohort: false, sha: newer }, isAncestor: () => true }).outcome)
        .toBe('unproven');
      expect(classifyCohort({ sha: target, latest: null, isAncestor: () => true }).outcome).toBe('unproven');
    });

    it('refuses to answer without a wired authority, instead of guessing either way', () => {
      expect(() => classifyCohort({ sha: target, latest: { cohort: true, sha: newer } }))
        .toThrow(/ancestry authority is not wired/);
    });

    it('the production authority answers real git ancestry, and an unanswerable question is an error', () => {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      expect(gitIsAncestor(head, head)).toBe(true);
      // A SHA git cannot resolve is an unanswered question, never "no".
      expect(() => gitIsAncestor('f'.repeat(40), head)).toThrow(/ancestry check failed/);
    });
  });

  describe('deferral is visible on all three surfaces', () => {
    const target = 'a'.repeat(40);
    const newer = 'c'.repeat(40);
    const report = deferredReport({ target, supersededBy: newer });

    it('payload is an explicit deferral, never an empty success', () => {
      expect(report.payload).toEqual({ ok: true, changed: false, deferred: true, cohort: target, supersededBy: newer });
    });

    it('the stdout line names both cohorts', () => {
      expect(report.line).toContain('deferred');
      expect(report.line).toContain(target);
      expect(report.line).toContain(newer);
    });

    it('the job summary says no pins changed and who owns the update', () => {
      expect(report.summary).toContain('deferred');
      expect(report.summary).toContain(`\`${target}\``);
      expect(report.summary).toContain(`\`${newer}\``);
      expect(report.summary).toContain('Pins changed:** none');
      expect(report.summary).toContain("newer cohort's own release run");
    });

    it('the CLI wires the git ancestry authority and the step summary', () => {
      const source = fs.readFileSync(path.join(root, 'scripts/release/sync-codex-runtime-pins.mjs'), 'utf8');
      expect(source).toMatch(/isAncestor:\s*gitIsAncestor/);
      expect(source).toContain("'merge-base', '--is-ancestor'");
      expect(source).toContain('GITHUB_STEP_SUMMARY');
      expect(source).toContain('appendStepSummary(');
    });
  });

  it('shipped payload accepts both core runtime subpath generations', () => {
    // PRI-1136 renamed `@principles/core/runtime-v2` -> .../runtime. The plugin
    // pin still points at Core 4.1.0 (runtime-v2), while PR CI probes the
    // PR-built Core 5.x bytes (runtime). Both must resolve, and the probe must
    // report which generation the installed bytes provided.
    const probe = fs.readFileSync(
      path.join(root, 'plugins/principles-disciple/scripts/verify-pinned-runtime-capability.cjs'),
      'utf8',
    );
    expect(probe).toContain("'@principles/core/runtime'");
    expect(probe).toContain("'@principles/core/runtime-v2'");
    expect(probe).toContain('coreRuntimeSubpath,');
    const setup = fs.readFileSync(
      path.join(root, 'plugins/principles-disciple/scripts/pd-setup.cjs'),
      'utf8',
    );
    expect(setup).toContain("['runtime', 'runtime-v2']");
  });

  it('production CI probes the PR-built runtime bytes and publication only VERIFIES the shipped pin', () => {
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const train = fs.readFileSync(path.join(root, '.github/workflows/publish-npm.yml'), 'utf8');
    // PRI-1071 P1-4E: pd-mcp-server@0.1.0 is unpublished while the PR is in
    // review, so PR CI must NOT pull the pin cohort from the registry. It
    // installs the tarballs this PR builds into an isolated runtime and
    // probes those bytes; the published-cohort probe stays in the
    // post-publication verification job.
    expect(ci).not.toContain('run: npm run check:runtime-pin');
    expect(ci).toContain('npm pack --ignore-scripts --pack-destination');
    expect(ci).toContain('verify-pinned-runtime-capability.cjs --runtime-dir');
    expect(ci).toContain('scripts/ci/verify-installed-mcp-server.mjs');
    expect(ci).toContain('sync-codex-runtime-pins.mjs --check-base');
    expect(train).toContain('run: npm run check:runtime-pin');
    // Owner decision 2026-11-11: the pin is materialized by the Version PR,
    // so publication verifies it read-only instead of opening a second PR.
    expect(train).toContain('sync-codex-runtime-pins.mjs --verify --root .');
    expect(train).toContain("needs.publish-full-product.result == 'success'");
    expect(train).not.toContain('sync-codex-runtime-pins.mjs --cohort');
    expect(train).not.toContain('BRANCH=codex/runtime-pins-maintenance');
    expect(train).not.toContain('gh pr edit "$PR"');
    expect(train).not.toContain('gh pr create');
    expect(train).not.toContain('PD_VERSION_PR_TOKEN');
    expect(train).not.toContain('gh pr merge');
  });
});

describe('Codex pin materialization (Version PR) and post-publication verification', () => {
  const workspace = [
    ['codex-adapter', '@principles/codex-adapter'],
    ['host-runtime', '@principles/host-runtime'],
    ['principles-core', '@principles/core'],
    ['pd-mcp-server', '@principles/pd-mcp-server'],
  ] as const;

  function seed(
    dir: string,
    versions: Record<string, string>,
    pins: Record<string, string>,
    pluginVersion = '0.3.20',
  ) {
    for (const [dirName, name] of workspace) {
      fs.mkdirSync(path.join(dir, 'packages', dirName), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'packages', dirName, 'package.json'),
        JSON.stringify({ name, version: versions[name] }, null, 2) + '\n',
      );
    }
    fs.mkdirSync(path.join(dir, 'plugins/principles-disciple/.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugins/principles-disciple/runtime-version.json'),
      JSON.stringify({ ...pins, note: 'Exact versions only.' }, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'plugins/principles-disciple/.codex-plugin/plugin.json'),
      JSON.stringify({ name: 'principles-disciple', version: pluginVersion }, null, 2) + '\n',
    );
  }

  function withFixture(fn: (dir: string) => void | Promise<void>) {
    return async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-pins-'));
      try {
        await fn(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  const target = {
    '@principles/codex-adapter': '0.9.0',
    '@principles/host-runtime': '3.3.0',
    '@principles/core': '7.3.0',
    '@principles/pd-mcp-server': '0.4.0',
  };
  const previous = { codexAdapter: '0.8.8', hostRuntime: '3.2.2', core: '7.2.0', mcpServer: '0.3.3' };
  const expectedPins = { codexAdapter: '0.9.0', hostRuntime: '3.3.0', core: '7.3.0', mcpServer: '0.4.0' };

  it(
    'reads the pin from the workspace and bumps the Codex cache version with it',
    withFixture((dir) => {
      seed(dir, target, previous);
      expect(pinsFromWorkspace(dir)).toEqual(expectedPins);

      const result = composePinsFromWorkspace(dir);
      expect(result).toEqual({ changed: true, pins: expectedPins, pluginVersion: '0.3.21' });
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'plugins/principles-disciple/runtime-version.json'), 'utf8'))).toMatchObject(expectedPins);
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, 'plugins/principles-disciple/.codex-plugin/plugin.json'), 'utf8')).version,
      ).toBe('0.3.21');

      // Deterministic: a re-run over its own output changes nothing.
      expect(composePinsFromWorkspace(dir)).toEqual({ changed: false, pins: expectedPins });
    }),
  );

  it(
    'refuses a workspace version that would downgrade an existing pin',
    withFixture((dir) => {
      seed(dir, { ...target, '@principles/core': '7.1.0' }, previous);
      expect(() => composePinsFromWorkspace(dir)).toThrow(/stale cohort/);
    }),
  );

  it(
    'refuses an incomplete or non-exact workspace version instead of writing a partial pin',
    withFixture((dir) => {
      seed(dir, target, previous);
      fs.writeFileSync(
        path.join(dir, 'packages/principles-core/package.json'),
        JSON.stringify({ name: '@principles/core', version: '7.3.0-beta.1' }, null, 2) + '\n',
      );
      expect(() => pinsFromWorkspace(dir)).toThrow(/invalid cohort version/);

      fs.rmSync(path.join(dir, 'packages/host-runtime'), { recursive: true, force: true });
      expect(() => pinsFromWorkspace(dir)).toThrow(/not a workspace member/);
    }),
  );

  it('verifies the shipped pin against the registry identity, not just existence', async () => {
    const pins = expectedPins;
    const pinKeys = ['codexAdapter', 'hostRuntime', 'core', 'mcpServer'] as const;
    const ok = await verifyPinnedManifests({ pins, fetchManifest: async (name, version) => ({ name, version }) });
    expect(ok.problems).toEqual([]);
    expect(ok.checked).toEqual(workspace.map(([, name], i) => `${name}@${pins[pinKeys[i]]}`));

    const problems = await verifyPinnedManifests({
      pins,
      fetchManifest: async (name, version) =>
        name === '@principles/core' ? undefined : { name, version: version === '3.3.0' ? '3.3.1' : version },
    });
    expect(problems.problems).toEqual([
      '@principles/host-runtime@3.3.0: registry returned @principles/host-runtime@3.3.1',
      '@principles/core@7.3.0: not published',
    ]);
  });

  it('waits through registry propagation, then fails loudly after the budget', async () => {
    const pins = expectedPins;
    const checked = await waitForPinnedManifests({
      pins,
      fetchManifest: (() => {
        let core = 0;
        return async (name: string, version: string) => {
          if (name === '@principles/core' && core++ === 0) return undefined;
          return { name, version };
        };
      })(),
      timeoutMs: 100,
      recheckMs: 0,
      intervalMs: 1,
      now: (() => {
        let clock = 0;
        return () => clock++;
      })(),
      sleep: async () => {},
    });
    expect(checked.checked).toHaveLength(4);

    await expect(
      waitForPinnedManifests({
        pins,
        fetchManifest: async () => undefined,
        timeoutMs: 5,
        recheckMs: 5,
        intervalMs: 1,
        now: (() => {
          let clock = 0;
          return () => clock++;
        })(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/not published[\s\S]*nextAction/);
  });
});
