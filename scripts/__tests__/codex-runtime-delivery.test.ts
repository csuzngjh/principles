import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoDowngrade,
  checkMetadata,
  nextPins,
  waitForPublishedCohort,
} from '../release/sync-codex-runtime-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
describe('Codex runtime delivery authority and discoverability', () => {
  it('requires all three exact cohort identities, including core, without floating latest', () => {
    const versions = { '@principles/codex-adapter': '0.5.14', '@principles/host-runtime': '0.14.0', '@principles/core': '1.297.0' };
    expect(nextPins(versions)).toEqual({ codexAdapter: '0.5.14', hostRuntime: '0.14.0', core: '1.297.0' });
    expect(() => nextPins({ ...versions, '@principles/core': 'latest' })).toThrow();
    expect(() => nextPins({ '@principles/codex-adapter': '0.5.14' })).toThrow();
  });
  it('payload edits must increase the host cache version; unrelated docs do not', () => {
    expect(() => checkMetadata('0.2.0', '0.2.0', true)).toThrow(/cache/);
    expect(() => checkMetadata('0.2.0', '0.1.9', true)).toThrow();
    expect(() => checkMetadata('0.2.0', '0.2.1', true)).not.toThrow();
    expect(() => checkMetadata('0.2.0', '0.2.0', false)).not.toThrow();
  });
  it('a delayed older release run cannot roll back a newer plugin cohort', () => {
    const current = { codexAdapter: '0.5.14', hostRuntime: '0.14.0', core: '1.297.0' };
    expect(() => assertNoDowngrade(current, { ...current, core: '1.296.0' })).toThrow(/stale cohort/);
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
      expect(message).toContain('15000ms');
      expect(message).toContain('nextAction');
      // It really consumed the whole budget: 4 reads at t=0/5/10/15s.
      expect(calls).toBe(4);
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

  it('production CI probes package bytes and publication reconciles a separate maintenance PR', () => {
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const train = fs.readFileSync(path.join(root, '.github/workflows/publish-npm.yml'), 'utf8');
    expect(ci).toContain('run: npm run check:runtime-pin');
    expect(ci).toContain('sync-codex-runtime-pins.mjs --check-base');
    expect(train).toContain('sync-codex-runtime-pins.mjs --cohort');
    expect(train).toContain('needs.publish-full-product.result == \'success\'');
    expect(train).toContain('BRANCH=codex/runtime-pins-maintenance');
    expect(train).toContain('gh pr edit "$PR"');
    expect(train).toContain('gh pr create --base main');
    expect(train).not.toContain('gh pr merge');
  });
});
