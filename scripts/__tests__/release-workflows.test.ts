// Workflow-shape contract tests for the changesets cutover (SPEC v1.2 §31
// T22/T23/T25 wiring). These pin the STRUCTURE of the rewritten release
// workflows: no residual bump authorities, cohort-SHA checkout, exact-version
// gating, idempotent closing steps, and the Version PR automation posture.
// Behavioral evidence (T2-T21, T24, T26) lives in release-contracts.test.ts
// and release-registry.test.ts; T25's live bot E2E runs after the Owner
// merges the adoption PR (documented in the migration report).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsyamlNs from 'js-yaml';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

// js-yaml v5 interop differs between plain node (named `load`) and
// bundler-interopred CJS (`default.load`); select whichever is callable.
const ns = jsyamlNs as unknown as Record<string, unknown>;
const defaultExport = ns.default as Record<string, unknown> | undefined;
const yamlLoad: (text: string) => unknown =
  typeof ns.load === 'function'
    ? (ns.load as (text: string) => unknown)
    : typeof defaultExport?.load === 'function'
      ? (defaultExport.load as (text: string) => unknown)
      : () => {
          throw new Error('js-yaml load export not found');
        };

function loadWorkflow(rel: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  // GitHub workflow YAML treats `on` as a boolean key in YAML 1.1 parsers;
  // js-yaml default (1.2 core) keeps it as the string "on"/true — assert on
  // the raw text for trigger shape and use yaml.load for job structure.
  const doc = yamlLoad(text);
  if (typeof doc !== 'object' || doc === null) throw new Error(`${rel} did not parse to a mapping`);
  return doc as Record<string, unknown>;
}

describe('publish-npm.yml — exact-version publish train (T22/T23)', () => {
  const rel = '.github/workflows/publish-npm.yml';
  const text = () => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('parses as YAML', () => {
    expect(() => loadWorkflow(rel)).not.toThrow();
  });

  it('has no legacy bump authorities (SPEC Phase 4)', () => {
    const t = text();
    expect(t).not.toContain('version_bump');
    expect(t).not.toContain('Analyze commits');
    // Invocation-shaped negatives (prose like "pending npm versions" is fine).
    expect(t).not.toMatch(/npm version ["'\$]/);
    expect(t).not.toContain('Resetting to npm');
    expect(t).not.toContain('bump_version');
    expect(t).not.toContain('Sync version to all files');
    // No push auto-publish: releases only flow from cohorts.
    expect(t).not.toMatch(/\n\s+push:\s*\n\s+branches:/);
  });

  it('triggers only via dispatch (cohort_sha) and the weekly reconciliation window', () => {
    const t = text();
    expect(t).toContain('workflow_dispatch');
    expect(t).toContain('cohort_sha');
    expect(t).toMatch(/cron: '0 4 \* \* 5'/);
  });

  it('checks out the cohort SHA, never main HEAD (T21 wiring)', () => {
    const t = text();
    expect(t).toContain('ref: ${{ needs.resolve-cohort.outputs.cohort_sha }}');
  });

  it('passes the cohort SHA to the reproducibility gate (G5)', () => {
    const t = text();
    expect(t).toContain('ref: ${{ needs.resolve-cohort.outputs.cohort_sha }}');
    const gate = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/release-reproducibility-full.yml'), 'utf8');
    expect(gate).toContain('ref: ${{ inputs.ref || github.sha }}');
  });
});

describe('publish-npm-package action — exact committed version (T17-T23)', () => {
  const rel = '.github/actions/publish-npm-package/action.yml';
  const text = () => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('parses as YAML', () => {
    expect(() => loadWorkflow(rel)).not.toThrow();
  });

  it('has no version-creating authority', () => {
    const t = text();
    expect(t).not.toContain('npm version');
    expect(t).not.toContain('Analyze commits');
    expect(t).not.toContain('version_bump');
    expect(t).not.toContain('set_version');
    expect(t).not.toContain('bump_version');
    expect(t).not.toContain('Sync version to all files');
  });

  it('consults the exact-version registry contract with provenance expectation', () => {
    const t = text();
    expect(t).toContain('registry-exact.mjs');
    expect(t).toContain('--expect-git-head');
  });

  it('gates every version-producing step on ABSENT (idempotent skip, T22)', () => {
    const doc = loadWorkflow(rel) as { runs?: { steps?: Array<{ if?: string; name?: string }> } };
    const steps = doc.runs?.steps ?? [];
    const gatedNames = ['Verify registry dependencies are published', 'Build target package', 'Publish exact committed version', 'Verify the packed installer tarball carries the product identity'];
    for (const name of gatedNames) {
      const step = steps.find((s) => s.name === name);
      expect(step, `step ${name}`).toBeDefined();
      expect(step?.if).toContain("steps.exact.outputs.status == 'ABSENT'");
    }
  });

  it('closing steps are idempotent reconciliation (tag/GitHub Release/ClawHub)', () => {
    const t = text();
    expect(t).toContain('Reconcile Git tag (idempotent)');
    expect(t).toContain('Reconcile GitHub Release (idempotent)');
    expect(t).toContain('Reconcile ClawHub marketplace (idempotent)');
    // Tag conflict is a hard failure, never a silent move.
    expect(t).toContain('Refusing to move an existing tag');
  });
});

describe('version-packages.yml — rolling Version PR automation', () => {
  const rel = '.github/workflows/version-packages.yml';
  const text = () => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('parses as YAML', () => {
    expect(() => loadWorkflow(rel)).not.toThrow();
  });

  it('uses the official action pinned to an exact commit, version-only', () => {
    const t = text();
    expect(t).toMatch(/changesets\/action@[0-9a-f]{40}/);
    expect(t).toContain('version-script: node scripts/release/materialize-version-plan.mjs');
    // PD owns tags/releases in the publish train.
    expect(t).toContain('create-github-releases: false');
    expect(t).toContain('push-git-tags: false');
  });

  it('pins checkout/setup-node to the EXACT SHAs ci.yml uses', () => {
    // The workflow only fires on main pushes, so PR CI never exercises its
    // action resolution — a one-character transcription error in a pin
    // surfaces only AFTER merge (2026-09-21 incident: version-packages
    // failed on unresolvable SHAs at its first run). Pin parity with
    // ci.yml — which every PR run does resolve — is the mechanized guard.
    const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    for (const action of ['actions/checkout', 'actions/setup-node']) {
      const ciPin = ci.match(new RegExp(`${action.replace('/', '\\/')}@([0-9a-f]{40})`));
      const vpPin = text().match(new RegExp(`${action.replace('/', '\\/')}@([0-9a-f]{40})`));
      expect(ciPin, `${action} pin missing in ci.yml`).not.toBeNull();
      expect(vpPin, `${action} pin missing in version-packages.yml`).not.toBeNull();
      expect(vpPin?.[1], `${action} pin in version-packages.yml must equal ci.yml's`).toBe(ciPin?.[1]);
    }
  });

  it('never publishes and never auto-merges', () => {
    const t = text();
    expect(t).not.toContain('changeset publish');
    expect(t).not.toContain('npm publish');
  });

  it('token falls back chain documented for the required-checks problem', () => {
    const t = text();
    expect(t).toContain('PD_VERSION_PR_TOKEN || github.token');
    expect(t).toContain('Verify Merge Gate');
  });

  it('dispatches the publish train only for proven cohort merges (T25 wiring)', () => {
    const t = text();
    expect(t).toContain('resolve-release-cohort.mjs --is-cohort');
    expect(t).toContain('gh workflow run publish-npm.yml --ref main -f cohort_sha=');
  });
});

describe('ci.yml — release intent guard is inside the required gate', () => {
  it('the Verify Merge Gate job runs the guard on pull_request events', () => {
    const t = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(t).toContain('Release intent guard (changesets)');
    expect(t).toContain('check-pr-release-intent.mjs');
    expect(t).toContain('PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}');
  });
});

describe('bundle-plugin — cohort version source (SPEC §21)', () => {
  it('supports the preserve-source mode used by the publish train', () => {
    const t = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/create-principles-disciple/scripts/bundle-plugin.mjs'),
      'utf8',
    );
    expect(t).toContain("process.env.PD_BUNDLE_PRESERVE_SOURCE_VERSIONS === '1'");
  });

  it('the train sets the preserve-source env before building the installer', () => {
    const t = fs.readFileSync(path.join(REPO_ROOT, '.github/actions/publish-npm-package/action.yml'), 'utf8');
    expect(t).toContain('export PD_BUNDLE_PRESERVE_SOURCE_VERSIONS=1');
  });
});
