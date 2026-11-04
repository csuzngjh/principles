import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoDowngrade,
  checkMetadata,
  nextPins,
  PUBLISH_RECHECK_TIMEOUT_MS,
  PUBLISH_WAIT_TIMEOUT_MS,
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
      })).toThrow(/not the current release cohort/);
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

  it('production CI probes the PR-built runtime bytes and publication reconciles a separate maintenance PR', () => {
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const train = fs.readFileSync(path.join(root, '.github/workflows/publish-npm.yml'), 'utf8');
    // PRI-1071 P1-4E: pd-mcp-server@0.1.0 is unpublished while the PR is in
    // review, so PR CI must NOT pull the pin cohort from the registry. It
    // installs the tarballs this PR builds into an isolated runtime and
    // probes those bytes; the published-cohort probe stays in the
    // post-publication maintenance job.
    expect(ci).not.toContain('run: npm run check:runtime-pin');
    expect(ci).toContain('npm pack --ignore-scripts --pack-destination');
    expect(ci).toContain('verify-pinned-runtime-capability.cjs --runtime-dir');
    expect(ci).toContain('scripts/ci/verify-installed-mcp-server.mjs');
    expect(ci).toContain('sync-codex-runtime-pins.mjs --check-base');
    expect(train).toContain('run: npm run check:runtime-pin');
    expect(train).toContain('sync-codex-runtime-pins.mjs --cohort');
    expect(train).toContain('needs.publish-full-product.result == \'success\'');
    expect(train).toContain('BRANCH=codex/runtime-pins-maintenance');
    expect(train).toContain('gh pr edit "$PR"');
    expect(train).toContain('gh pr create --base main');
    expect(train).not.toContain('gh pr merge');
  });
});
