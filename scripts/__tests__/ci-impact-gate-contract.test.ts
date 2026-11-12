// Contract test for the ci.yml impact scope gates (live since 2026-10-27).
//
// Pins the fail-open shape of every gated job's condition. Root cause this
// guards against (review catch 2026-10-27): GitHub Actions implicitly
// prepends `success()` to any job `if` that contains no status-check
// function — so a bare `needs.impact.result != 'success' || …` still SKIPS
// the job when the impact job fails, silently dropping its tests. Every
// gated condition must therefore start with an explicit status function
// (`!cancelled() &&`) and keep the fail-open disjunction inside it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CI_YML = path.resolve(HERE, '..', '..', '.github', 'workflows', 'ci.yml');

interface StepDef {
  name?: string;
  run?: string;
  'continue-on-error'?: boolean;
}

interface JobDef {
  name?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, unknown>;
  'continue-on-error'?: boolean;
  steps?: StepDef[];
}

function loadJobs(): Record<string, JobDef> {
  const doc = load(fs.readFileSync(CI_YML, 'utf8')) as { jobs: Record<string, JobDef> };
  return doc.jobs;
}

describe('ci.yml impact scope-gate contract', () => {
  const jobs = loadJobs();

  it('the impact job exposes the prediction as an output', () => {
    expect(jobs.impact).toBeDefined();
    expect(jobs.impact!.outputs).toHaveProperty('impact');
  });

  it('verify-merge never depends on the impact job (required check must always run)', () => {
    const needs = [].concat(jobs['verify-merge']?.needs ?? []);
    expect(needs).not.toContain('impact');
    expect(jobs['verify-merge']?.if).toBeUndefined();
  });

  it('the export-surface gate job is unconditional', () => {
    // `test-principles-core` carries the export-surface admission gate and is a
    // required check. Gating it on `scopes.core` (or on the impact job at all)
    // would let a PR skip the gate by editing scripts/ci/impact.mjs — and a
    // skipped required check is reported as success.
    const job = jobs['test-principles-core'];
    expect(job, 'test-principles-core job missing').toBeDefined();
    expect([].concat(job!.needs ?? [])).not.toContain('impact');
    expect(job!.if, 'test-principles-core must not be conditionally skipped').toBeUndefined();
    // Tolerating a failure keeps the check green without running the gate.
    expect(job!['continue-on-error'], 'job-level continue-on-error tolerates a red gate').toBeUndefined();
    const steps = job!.steps ?? [];
    expect(
      steps.filter((s) => s['continue-on-error'] === true).map((s) => s.name ?? s.run),
      'a step-level continue-on-error can hide a red gate',
    ).toEqual([]);
    // The job must actually execute a test runner somewhere in its steps.
    expect(
      steps.some((s) => typeof s.run === 'string' && (/npm run test\b/.test(s.run) || /\bvitest\b/.test(s.run))),
      'no step in test-principles-core runs the tests',
    ).toBe(true);
  });

  it('every job gated on impact keeps the fail-open condition shape', () => {
    const gated = Object.entries(jobs).filter(([, j]) => [].concat(j.needs ?? []).includes('impact'));
    // The design currently gates 15 jobs (test-principles-core was removed from
    // the gate set: it is a required check that must always run); a shrinking
    // gate set is a design change that should show up in this test's diff.
    // (PRI-1071 added test-pd-mcp-server; PRI-1066 added test-workbuddy-adapter
    // after its impact scope had no consumer; the pd-skills single-source
    // renderer added skill-render-contract, whose installer-scope gate is the
    // same fail-open shape verified below.)
    expect(gated.length).toBe(15);
    for (const [id, job] of gated) {
      const expr = job.if ?? '';
      // The ${{ }} wrapper matters as much as the status function: a bare
      // `!cancelled()` starts with YAML's tag indicator and a bare
      // `needs.… || …` (no status function) gets an implicit success()
      // prepended by GitHub — both shapes silently break fail-open.
      const PREFIX = '${{ !cancelled() && (';
      expect(expr.startsWith(PREFIX), id + ': missing ' + PREFIX + ' prefix').toBe(true);
      expect(expr.endsWith(') }}'), id + ': unbalanced expression wrapper').toBe(true);
      expect(expr, id + ': missing fail-open disjunction').toContain("needs.impact.result != 'success' ||");
      expect(expr, id + ': missing scope consumption').toContain('fromJSON(needs.impact.outputs.impact).scopes.');
    }
  });
});
