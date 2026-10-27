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

interface JobDef {
  name?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, unknown>;
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

  it('every job gated on impact keeps the fail-open condition shape', () => {
    const gated = Object.entries(jobs).filter(([, j]) => [].concat(j.needs ?? []).includes('impact'));
    // The design currently gates 13 jobs; a shrinking gate set is a design
    // change that should show up in this test's diff.
    expect(gated.length).toBe(13);
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
