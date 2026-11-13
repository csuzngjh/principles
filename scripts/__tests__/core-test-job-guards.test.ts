// Contracts of the REQUIRED `Test principles-core` job (PRI-1198, PRI-1167).
//
// Both tickets describe guarantees that live OUTSIDE the core source tree:
// which directories ESLint is allowed to see, and how the job invokes vitest.
// A guarantee outside the tested code needs a mechanized assertion here, or
// the next config edit silently restores the gap.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { ESLint } from 'eslint';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface StepDef {
  name?: string;
  run?: string;
}

function coreJobSteps(): StepDef[] {
  const doc = load(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: StepDef[] }>;
  };
  const job = doc.jobs['test-principles-core'];
  if (!job) throw new Error('test-principles-core job missing from ci.yml');
  return job.steps ?? [];
}

describe('PRI-1198 — packages/principles-core/tests is linted', () => {
  const eslint = new ESLint({ cwd: ROOT });

  it('is not ignored by eslint.config.js', async () => {
    // Reverting the `!packages/principles-core/tests/**` un-ignore makes this
    // true, which is exactly the original defect (27 files never linted).
    await expect(
      eslint.isPathIgnored('packages/principles-core/tests/candidate-intake.test.ts'),
    ).resolves.toBe(false);
  });

  it('keeps the generated gate-a replay fixtures ignored', async () => {
    // These are `git archive` mirror assets (excluded from test discovery too);
    // un-ignoring them would lint generated files.
    await expect(
      eslint.isPathIgnored('packages/principles-core/tests/fixtures/gate-a-reproducibility/fixture-sqlite.ts'),
    ).resolves.toBe(true);
  });

  it('the required core job runs the tests lint step', () => {
    const step = coreJobSteps().find((s) => (s.run ?? '').includes('lint:core-tests'));
    // Removing the CI step would leave the directory lintable but ungated:
    // `scripts/lint-by-package.mjs` still ignores `**/*.test.ts` for every
    // package, so the canonical `npm run lint` cannot cover it.
    expect(step, 'ci.yml core job has no step running `npm run lint:core-tests`').toBeDefined();
  });
});

describe('PRI-1167 — core job caps test workers instead of raising the timeout', () => {
  function coverageStep(): StepDef {
    const step = coreJobSteps().find((s) => s.name === 'Test with coverage');
    if (!step) throw new Error('ci.yml core job has no "Test with coverage" step');
    return step;
  }

  it('pins a bounded --maxWorkers on the vitest command', () => {
    // Reverting the fix (dropping the flag) makes this fail: an unbounded run
    // is what let isolate startup starve the first test past 5000ms.
    const match = (coverageStep().run ?? '').match(/--maxWorkers=(\d+)/);
    expect(match, 'core test command must pin --maxWorkers=<n>').not.toBeNull();
    const workers = Number(match![1]);
    expect(workers).toBeGreaterThan(0);
    // 4-vCPU runner; keep headroom under the 15-min job budget.
    expect(workers).toBeLessThanOrEqual(2);
  });

  it('does not paper over the flake with a vitest testTimeout override', () => {
    // The original failure is real startup cost; hiding it in the config would
    // move that cost to the user's real startup path.
    const config = fs.readFileSync(path.join(ROOT, 'packages/principles-core/vitest.config.ts'), 'utf8');
    expect(config).not.toMatch(/testTimeout/);
  });
});
