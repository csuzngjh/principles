/**
 * PRI-874 review (P1) — the channel guard must judge the version that is about
 * to be published, not the one the ref's root manifest happens to declare.
 *
 * The POLICY (`decideProductVersionPublish`) is pinned in
 * `product-version-order.test.ts`. This file pins the other half of the fix:
 * the guard's `--resolved-version` input, and the workflow wiring that must
 * supply it. Either half alone leaves the defect open — a correct policy that
 * receives the manifest value would still have passed an explicit 2.0.0
 * publish against a 2.1.0 channel.
 *
 * Deliberately hermetic: no fetch, no DNS. Every assertion here is decided
 * before the guard reaches its channel read, so this file never depends on the
 * live channel, GitHub Pages, or the network.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'check-product-version-channel.mjs');
const RELEASE_METADATA_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release-metadata.yml');

interface GuardRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runGuard(args: string[]): GuardRun {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('check-product-version-channel: selected release version input', () => {
  // Every case spawns node, so the shape matrix is kept short here and the
  // exhaustive `x.y.z` grammar coverage stays in product-version-order.test.ts
  // (STRICT_SEMVER). The timeouts are explicit because a loaded CI worker can
  // take seconds to start a node process per case.
  it('refuses a --resolved-version that is not a strict x.y.z, before reading any channel', () => {
    for (const notAVersion of ['2.0', '2.0.0-rc.1']) {
      const run = runGuard(['--resolved-version', notAVersion]);

      expect(run.status, `--resolved-version ${notAVersion}`).toBe(1);
      expect(run.stderr).toMatch(/--resolved-version is not a strict x\.y\.z version/);
      // Fail-closed on a bad input must not come from a channel read.
      expect(run.stderr).not.toMatch(/Channel read failed/);
    }
  }, 30_000);

  it('still refuses a non-semver --channel-product-version floor', () => {
    const run = runGuard(['--channel-product-version', 'bogus']);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/--channel-product-version is not a strict x\.y\.z version: "bogus"/);
  }, 30_000);
});

describe('release-metadata.yml wiring of the channel guard', () => {
  const workflow = fs.readFileSync(RELEASE_METADATA_WORKFLOW, 'utf8');

  it('invokes the single shared guard implementation', () => {
    expect(workflow).toContain('scripts/check-product-version-channel.mjs');
  });

  /**
   * The load-bearing wire. `Resolve publication inputs` already receives the
   * release identity as the step env `RESOLVED_VERSION` — which is
   * `steps.release.outputs.version`, i.e. the explicit `product_version` input
   * when one was supplied. Passing it is what makes the guard judge the version
   * that will actually be published.
   */
  it('passes the resolved release version to the guard', () => {
    expect(workflow).toMatch(/--resolved-version\s+"\$RESOLVED_VERSION"/);
  });

  it('keeps the locally observed pointer as an additional floor', () => {
    expect(workflow).toMatch(/--channel-product-version\s+"\$CHANNEL_PRODUCT_VERSION"/);
  });
});
