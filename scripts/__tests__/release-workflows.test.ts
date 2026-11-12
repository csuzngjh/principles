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

function scheduleEntries(rel: string): Record<string, unknown>[] {
  // Derive the cadence from the parsed document instead of pinning a cron
  // literal: a literal turns every deliberate schedule change into a test
  // edit (PRI-979 seam 6 — publication constants hand-copied into guards).
  const doc = loadWorkflow(rel);
  const onBlock = (doc.on ?? doc[String(true)]) as Record<string, unknown> | undefined;
  if (!onBlock) throw new Error(`${rel} has no parsed "on:" block`);
  // GitHub accepts both shapes — `schedule: [{cron}, …]` (what these files
  // use) and the single-entry `schedule: {cron}` — so normalise the entries
  // rather than assuming one.
  const schedule = onBlock.schedule as unknown;
  if (schedule === undefined) return [];
  const entries: unknown[] = Array.isArray(schedule) ? schedule : [schedule];
  return entries as Record<string, unknown>[];
}

function scheduleCrons(rel: string): string[] {
  return scheduleEntries(rel).flatMap((entry) => {
    const value = entry.cron as string | string[] | undefined;
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map(String);
  });
}

function isDailyCron(cron: string): boolean {
  // Standard 5-field cron: minute hour day-of-month month day-of-week.
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 && fields[4] === '*';
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

  it('triggers via dispatch (cohort_sha) plus a DAILY reconciliation window', () => {
    const t = text();
    expect(t).toContain('workflow_dispatch');
    expect(t).toContain('cohort_sha');
    const crons = scheduleCrons(rel);
    // PRI-986: the window reconciles every day. The cadence is asserted from
    // the parsed cron (day-of-week = '*'), never from a literal string.
    expect(crons.length).toBe(1);
    expect(crons.every(isDailyCron), `not a daily schedule: ${crons.join(', ')}`).toBe(true);
    // Reconciliation only: the schedule must never gain a version-creating input.
    // Checked on the parsed entries (a raw-text regex over the whole file would
    // also fire on the dispatch inputs that legitimately precede `schedule:`).
    expect(scheduleEntries(rel).flatMap((e) => Object.keys(e))).toEqual(['cron']);
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
    const gatedNames = [
      'Verify registry dependencies are published',
      'Build target package',
      'Pack and verify immutable candidate',
      'Publish exact committed version',
    ];
    for (const name of gatedNames) {
      const step = steps.find((s) => s.name === name);
      expect(step, `step ${name}`).toBeDefined();
      expect(step?.if).toContain("steps.exact.outputs.status == 'ABSENT'");
    }
  });

  it('publish legs carry no closing steps — they live in finalize-npm-release (PRI-886)', () => {
    const t = text();
    // Closing steps moved to the separate finalize action that runs AFTER
    // every npm leg: a tag/release/marketplace failure must never block an
    // unuploaded npm package.
    expect(t).not.toContain('Reconcile Git tag');
    expect(t).not.toContain('gh release create');
    expect(t).not.toContain('clawhub package publish');
    // The publish leg never pushes (no persisted credentials needed).
    expect(t).not.toContain('git push origin "$TAG"');
  });

  it('pd-cli build branch is self-sufficient: it builds codex-adapter itself', () => {
    // Run 35834470066: leg 4/7 (codex-adapter) resolved PRESENT_PRIOR for an
    // unchanged version, so its ABSENT-gated build step was skipped and the
    // pd-cli leg's tsc failed with TS2307 on @principles/codex-adapter. A
    // leg must never rely on an upstream leg's build side effect — every
    // workspace import has to be built within the leg that needs it.
    const doc = loadWorkflow(rel) as { runs?: { steps?: Array<{ name?: string; run?: string }> } };
    const build = doc.runs?.steps?.find((s) => s.name === 'Build target package');
    expect(build?.run).toBeDefined();
    // Located by its own marker, never by branch position: the mapping is an
    // if/elif chain that grows whenever a package joins the train (PRI-979).
    const branch = (dir: string) => {
      const run = build!.run!;
      const start = run.indexOf(`[ "$PKG_DIR" = "${dir}" ]`);
      expect(start, `no build branch for ${dir}`).toBeGreaterThan(-1);
      const next = run.indexOf('elif [ "$PKG_DIR" = ', start);
      return next === -1 ? run.slice(start) : run.slice(start, next);
    };
    // G3.2: the leg still guarantees the build itself — build_once builds
    // whenever no identity-verified entry from an EARLIER leg of this job
    // exists (an upstream PRESENT_PRIOR leg records nothing), and only reuses
    // a dist whose cohort, version and SHA-256 still match
    // (release-build-once.test.ts proves the rebuild-on-miss behavior).
    expect(branch('pd-cli')).toContain('build_once @principles/codex-adapter build packages/codex-adapter');
    // @principles/workbuddy-adapter is a pd-cli runtime import too
    // (commands/workbuddy-worker) — same rule, same failure class.
    expect(branch('pd-cli')).toContain('build_once @principles/workbuddy-adapter build packages/workbuddy-adapter');
    expect(branch('create-principles-disciple')).toContain('build_once @principles/workbuddy-adapter build packages/workbuddy-adapter');
  });

  it('routes EVERY train package through the verified candidate and publishes that tarball (G3.1-A)', () => {
    const doc = loadWorkflow(rel) as {
      runs?: { steps?: Array<{ id?: string; if?: string; name?: string; run?: string; env?: Record<string, unknown> }> };
    };
    const steps = doc.runs?.steps ?? [];

    // The old non-installer path (a dry-run pack whose output was discarded)
    // is gone: one pack produces the published artifact.
    expect(steps.find((s) => s.name === 'Verify non-installer package dry-run')).toBeUndefined();
    expect(steps.some((s) => /^\s*npm pack/m.test(s.run ?? ''))).toBe(false);

    const candidate = steps.find((s) => s.name === 'Pack and verify immutable candidate');
    expect(candidate?.id).toBe('candidate');
    // Candidate is no longer installer-only; it runs for every ABSENT leg.
    expect(candidate?.if).toBe("${{ steps.exact.outputs.status == 'ABSENT' }}");
    expect(String(candidate?.env?.TOOLS_DIR)).toContain('inputs.tools_dir');
    expect(String(candidate?.env?.PACKAGE_NAME)).toContain('inputs.npm_name');
    expect(candidate?.run).toContain('prepare-npm-candidate.mjs');
    expect(candidate?.run).toContain('--package-name "$PACKAGE_NAME"');
    expect(candidate?.run).toContain('--cohort "$COHORT"');
    expect(candidate?.run).toContain('--github-output "$GITHUB_OUTPUT"');
    // Legacy lifecycle owners are materialized by the build step instead.
    expect(candidate?.run).toContain('SKIP_PACK_SCRIPTS');
    expect(candidate?.run).toContain('openclaw-plugin');
    expect(candidate?.run).toContain('pd-cli');
    expect(candidate?.run).toContain('--skip-pack-scripts');
    // The stamp contract stays installer-only.
    expect(candidate?.run).toContain('--product-version "$PRODUCT_VERSION"');

    const publish = steps.find((s) => s.name === 'Publish exact committed version');
    expect(String(publish?.env?.CANDIDATE_TARBALL)).toContain('steps.candidate.outputs.tarball');
    expect(String(publish?.env?.CANDIDATE_SHA512_HEX)).toContain('steps.candidate.outputs.sha512_hex');
    expect(publish?.run).toContain('ACTUAL_SHA512_HEX');
    expect(publish?.run).toContain('npm publish "$CANDIDATE_TARBALL" --provenance --access public');
    // No directory-publish fallback survives, for any package.
    expect(publish?.run).not.toMatch(/npm publish --provenance --access public/);
    expect(publish?.run).not.toContain('cd "packages/');
  });
});

describe('finalize-npm-release action — isolated closing steps (PRI-886)', () => {
  const rel = '.github/actions/finalize-npm-release/action.yml';
  const text = () => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('parses as YAML', () => {
    expect(() => loadWorkflow(rel)).not.toThrow();
  });

  it('closing steps are idempotent reconciliation (tag/GitHub Release/ClawHub)', () => {
    const t = text();
    expect(t).toContain('Reconcile Git tag (idempotent)');
    expect(t).toContain('Reconcile GitHub Release (idempotent)');
    expect(t).toContain('Reconcile ClawHub marketplace (idempotent)');
    // Tag conflict is a hard failure, never a silent move — the verdict
    // (including the refusal wording) lives in the TOOLS decision script.
    const cli = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'release', 'finalize-tag-reconcile.mjs'),
      'utf8',
    );
    expect(cli).toContain('Refusing to move an existing tag');
    // The marketplace sync degrades to a warning, never blocks npm.
    expect(t).toContain('continue-on-error: true');
  });

  it('a plugin-unchanged cohort skips the closing steps instead of failing (PRI-923)', () => {
    // Run 36104100294 (cohort 6199897a): the tag is the PLUGIN version
    // (SPEC §25), so a cohort that bumps only other packages can never own
    // it — the old unconditional fail left a red finalize leg on every such
    // cohort. The decision lives in the TOOLS script (pure judgment +
    // unit tests); the action only wires the runner to it, and every
    // closing step is gated on the same verdict.
    const t = text();
    expect(t).toContain('finalize-tag-reconcile.mjs');
    expect(t).toContain('skipped-prior-tag');
    const gate = "steps.tag-reconcile.outputs.closing_steps != 'skipped-prior-tag'";
    const gated = t.split(gate).length - 1;
    expect(gated).toBeGreaterThanOrEqual(3);
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

  it('skips Version PR creation with instructions when the token secret is absent', () => {
    // First post-cutover run (2026-09-21): without the secret the action
    // falls back to GITHUB_TOKEN, which the repository does not permit to
    // create pull requests — the job failed red on every main push. The
    // token-check step turns that into a green skip with setup guidance.
    const doc = loadWorkflow(rel) as { jobs?: Record<string, { steps?: Array<{ name?: string; if?: string }> }> };
    const steps = doc.jobs?.version?.steps ?? [];
    const check = steps.find((s) => s.name === 'Check Version PR token');
    expect(check).toBeDefined();
    const gate = steps.find((s) => s.name === 'Materialize version plan (changeset version + mirrors + pins + lockfile)');
    expect(gate?.if).toContain("steps.token-check.outputs.armed == 'true'");
    const t = text();
    expect(t).toContain('PD_VERSION_PR_TOKEN is not configured');
    expect(t).toContain('contents:write + pull-requests:write');
  });

  it('dispatches the publish train only for proven cohort merges (T25 wiring)', () => {
    const t = text();
    expect(t).toContain('resolve-release-cohort.mjs --is-cohort');
    expect(t).toContain('gh workflow run publish-npm.yml --ref main -f cohort_sha=');
  });

  // PRI-1014: the bot must be able to re-materialize an EXISTING Version PR
  // branch. A checkout without that ref leaves `changeset-release/main`
  // unknown to git; the action then rebuilds from main and its API ref update
  // is rejected, permanently wedging the release train. These assertions pin
  // the two halves of the fix without widening the workflow's trigger surface.
  it('offers workflow_dispatch for human recovery but never widens PR triggers', () => {
    const doc = loadWorkflow(rel) as Record<string, unknown>;
    const onBlock = (doc.on ?? doc[String(true)]) as Record<string, unknown> | undefined;
    expect(onBlock).toBeDefined();
    expect(Object.keys(onBlock ?? {}).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(onBlock).not.toHaveProperty('pull_request');
  });

  it('never pre-creates changeset-release/main as a LOCAL branch before the action (P0)', () => {
    const t = text();
    // changesets/action v2.1.2 `prepareBranch` runs:
    //   git checkout <branch>
    //   if stderr lacks "Switched to a new branch <branch>": git checkout -b
    //   git reset --hard context.sha
    // A pre-existing LOCAL branch makes the first checkout print
    // "Switched to branch", so the action runs `checkout -b` and dies with
    // "a branch named ... already exists" (exit 128). Fetching the branch into
    // refs/heads is therefore worse than not fetching it at all; the action
    // recreates the branch and the CLI force push below replaces its content.
    // Adding a local-branch fetch step back MUST turn this test red.
    expect(t).not.toContain('git fetch');
    expect(t).not.toContain('fetch-version-pr-branch.mjs');
    expect(t).not.toContain('refs/heads/changeset-release/main');
    const doc = loadWorkflow(rel) as {
      jobs?: Record<string, { steps?: Array<{ name?: string }> }>;
    };
    const steps = doc.jobs?.version?.steps ?? [];
    expect(steps.some((step) => step.name === 'Fetch existing Version PR branch')).toBe(false);
  });

  it('requires workflow_dispatch to run on refs/heads/main', () => {
    const t = text();
    // A feature-branch dispatch would materialize unpublished code as a
    // Version PR. The hard gate fails before checkout.
    expect(t).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(t).toContain('dispatch must run on refs/heads/main');
  });

  it('uses the action Git CLI push path and an explicit main PR base (PRI-1014)', () => {
    const t = text();
    // The GitHub API force-update path is what returned
    // "Reference cannot be updated" on a branch whose tip had diverged from
    // main. `push-with-git-cli` is the action's supported force-push path;
    // `pr-base-branch: main` keeps a manual dispatch from targeting the
    // operator's current branch by accident.
    expect(t).toContain('push-with-git-cli: true');
    expect(t).toContain('pr-base-branch: main');
  });
});

describe('publish-npm.yml — Codex pin is verified, never re-issued', () => {
  const rel = '.github/workflows/publish-npm.yml';

  it('verifies the shipped pin after publication from a read-only job', () => {
    // Owner decision 2026-11-11: the pin ships inside the Version Packages PR.
    // The publish train therefore has NO write path for it — only a
    // post-publication verification that must fail red on a mismatch.
    const doc = loadWorkflow(rel) as {
      jobs?: Record<
        string,
        {
          needs?: string[];
          permissions?: Record<string, string>;
          steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    const jobs = doc.jobs ?? {};
    const verify = jobs['codex-plugin-delivery-verify'];
    expect(verify).toBeDefined();
    expect(verify?.needs).toEqual(expect.arrayContaining(['publish-full-product']));
    expect(verify?.permissions).toEqual({ contents: 'read' });

    const steps = verify?.steps ?? [];
    expect(steps.some((s) => (s.run ?? '').includes('sync-codex-runtime-pins.mjs --verify --root .'))).toBe(true);
    expect(steps.some((s) => s.run === 'npm run check:runtime-pin')).toBe(true);
    // Product comes from the cohort SHA; tooling from the trusted SHA.
    const checkouts = steps.filter((s) => String(s.uses ?? '').startsWith('actions/checkout'));
    expect(checkouts.some((s) => s.with?.ref === '${{ needs.resolve-cohort.outputs.cohort_sha }}')).toBe(true);
    expect(checkouts.every((s) => s.with?.['persist-credentials'] === false)).toBe(true);

    const serialized = JSON.stringify(steps);
    for (const forbidden of ['git push', 'git commit', 'gh pr create', 'gh pr edit', 'git checkout -B']) {
      expect(serialized).not.toContain(forbidden);
    }

    // The old maintenance job (write token + branch + PR) is gone entirely.
    expect(jobs).not.toHaveProperty('codex-plugin-maintenance');
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    expect(text).not.toContain('codex/runtime-pins-maintenance');
    expect(text).not.toContain('PD_VERSION_PR_TOKEN');
  });

  it('publish-finalize is hard-gated on the pin verification result', () => {
    // `!cancelled()` defeats Actions' default "needs succeeded" check, so the
    // closing job must assert the verify result explicitly. Any terminal
    // outcome other than success must never reach tag / GitHub Release /
    // ClawHub — that is the difference between a visible red job and a
    // release shipped over a pin that does not match published bytes.
    type Job = { needs?: string[]; if?: string; permissions?: Record<string, string>; steps?: Array<{ uses?: string }> };
    const doc = loadWorkflow(rel) as { jobs?: Record<string, Job> };
    const jobs = doc.jobs ?? {};
    const verify = jobs['codex-plugin-delivery-verify'];
    const finalize = jobs['publish-finalize'];

    expect(verify).toBeDefined();
    expect(verify?.needs).toEqual(expect.arrayContaining(['publish-full-product']));
    expect(verify?.permissions).toEqual({ contents: 'read' });

    expect(finalize).toBeDefined();
    expect(finalize?.needs).toEqual(
      expect.arrayContaining(['resolve-cohort', 'publish-full-product', 'codex-plugin-delivery-verify']),
    );

    const gate = String(finalize?.if ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(gate).toContain('!cancelled()');
    expect(gate).toContain("needs.resolve-cohort.outputs.has_cohort == 'true'");
    expect(gate).toContain("needs.publish-full-product.result == 'success'");
    expect(gate).toContain("needs.codex-plugin-delivery-verify.result == 'success'");
    // No escape hatches: the gate is a pure conjunction of explicit results.
    expect(gate).not.toContain('always()');
    expect(gate).not.toContain('||');

    // Evaluate the ACTUAL parsed gate for each terminal verify outcome.
    const verifyOutcomes = ['success', 'failure', 'skipped', 'cancelled'] as const;
    const evaluate = (verifyResult: (typeof verifyOutcomes)[number]): boolean => {
      if (!gate.includes('!cancelled()')) return false;
      if (!gate.includes("needs.resolve-cohort.outputs.has_cohort == 'true'")) return false;
      const required = [...gate.matchAll(/needs\.([a-z0-9-]+)\.result == 'success'/g)].map((m) => m[1]);
      if (!required.includes('publish-full-product')) return false;
      if (!required.includes('codex-plugin-delivery-verify')) return false;
      const results: Record<string, string> = {
        'publish-full-product': 'success',
        'codex-plugin-delivery-verify': verifyResult,
      };
      return required.every((job) => results[job] === 'success');
    };
    expect(evaluate('success')).toBe(true);
    for (const outcome of verifyOutcomes.filter((outcome) => outcome !== 'success')) {
      expect(evaluate(outcome), `verify=${outcome} must not reach finalize`).toBe(false);
    }

    // The closing steps remain the idempotent release finalizer.
    expect((finalize?.steps ?? []).some((s) => String(s.uses ?? '').includes('finalize-npm-release'))).toBe(true);
  });
});

describe('ci.yml — release intent guard is inside the required gate', () => {
  it('the Verify Merge Gate job runs the guard on pull_request events', () => {
    const t = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(t).toContain('Release intent guard (changesets)');
    expect(t).toContain('check-pr-release-intent.mjs');
    // PRI-964: CI must not hand the GUARD the stale recorded base.sha; the
    // guard derives the live base from the merge ref / origin/main. Scope the
    // assertion to this step: the codex-pins `--check-base` probe legitimately
    // still uses base.sha for its own diff.
    const guardStep = t.slice(t.indexOf('Release intent guard (changesets)'));
    const stepBody = guardStep.slice(0, guardStep.indexOf('Run canonical merge gate'));
    expect(stepBody).toContain('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
    expect(stepBody).not.toContain('PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}');
  });
});

describe('release-metadata.yml — install completeness before tsc (PRI-928)', () => {
  const rel = '.github/workflows/release-metadata.yml';
  const text = () => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('every job that execs the compiler probes the installed tree after npm ci', () => {
    // Both `build-asset` and `assemble-publish` run `npm run build`, so a
    // silently dropped optional package must be caught in both. Deleting the
    // probe from either leg fails here, not on a release train.
    const doc = loadWorkflow(rel) as {
      jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const installing = Object.entries(doc.jobs ?? {}).filter(([, job]) =>
      (job.steps ?? []).some((step) => (step.run ?? '').includes('npm ci --ignore-scripts')),
    );
    expect(installing.map(([name]) => name).sort()).toEqual(['assemble-publish', 'build-asset']);
    for (const [, job] of installing) {
      const step = (job.steps ?? []).find((s) => (s.run ?? '').includes('npm ci --ignore-scripts'));
      expect(step?.run).toContain('check-compiler-runnable.mjs --root .');
    }
  });

  it('retries the install exactly once, then fails (bounded, not a retry loop)', () => {
    const installs = text().match(/npm ci --ignore-scripts/g) ?? [];
    expect(installs).toHaveLength(4);
    expect(text()).toContain('reinstalling once');
  });

  it('never special-cases a platform (the probe is content-based)', () => {
    const t = text();
    expect(t).not.toMatch(/if.*darwin.*npm install/i);
    expect(t).not.toContain('npm install @typescript/');
  });
});

describe('release-metadata.yml — daily preflight must stay structurally non-publishing (PRI-986)', () => {
  const rel = '.github/workflows/release-metadata.yml';
  const text = () => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('is scheduled daily for the preflight', () => {
    const crons = scheduleCrons(rel);
    expect(crons.length).toBe(1);
    expect(crons.every(isDailyCron), `not a daily schedule: ${crons.join(', ')}`).toBe(true);
    // The scheduled entry carries nothing but its cadence — a `schedule:` with
    // inputs would be the door through which automation picks a version.
    expect(scheduleEntries(rel).flatMap((e) => Object.keys(e))).toEqual(['cron']);
  });

  it('gates every publishing step on an explicit publish mode', () => {
    // The bytes-carrying steps are the only ones that may touch gh-pages or
    // the release host. They must stay `env.MODE == 'publish'` gated, and the
    // schedule event never supplies that input.
    const publishing = (text().match(/if: env\.MODE == 'publish'/g) ?? []).length;
    expect(publishing).toBeGreaterThanOrEqual(2);
    expect(text()).toMatch(/github\.event\.inputs\.mode \|\| 'dry-run'/);
  });

  it('refuses a scheduled run that somehow resolves to publish', () => {
    const t = text();
    expect(t).toContain('github.event_name');
    expect(t).toMatch(/schedule" \] && \[ "\$MODE" = "publish"/);
  });

  it('derives readable-from only for a schedule and still requires it from an operator', () => {
    const t = text();
    expect(t).toContain('needs.resolve-inputs.outputs.readable_from');
    expect(t).toContain('data_schema_forward_readable_from is required (PRI-853)');
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

  it('the train sets the preserve-source env on the step that actually runs pack/prepack', () => {
    type Step = { name?: string; run?: string; env?: Record<string, unknown> };
    const doc = loadWorkflow('.github/actions/publish-npm-package/action.yml') as { runs?: { steps?: Step[] } };
    const packStep = doc.runs?.steps?.find((step) => step.run?.includes('prepare-npm-candidate.mjs'));
    expect(packStep?.name).toBe('Pack and verify immutable candidate');
    // The bundle runs from pack's prepack lifecycle — a separate `run:` shell.
    // Step env is the only channel that reaches it (release 1.150.1 defect:
    // the export lived on the build step and the bundle silently stamped
    // pd-cli 2.1.0 over the cohort's 2.2.0).
    expect(packStep?.env?.PD_BUNDLE_PRESERVE_SOURCE_VERSIONS).toBe('1');

    const buildStep = doc.runs?.steps?.find((step) => step.name === 'Build target package');
    expect(buildStep?.run ?? '').not.toMatch(/^\s*export PD_BUNDLE_PRESERVE_SOURCE_VERSIONS=1/m);
  });

  it('verifies the packed installer payload against the cohort commit before publish', () => {
    const t = fs.readFileSync(path.join(REPO_ROOT, 'scripts/release/prepare-npm-candidate.mjs'), 'utf8');
    expect(t).toContain('readCommittedComponentVersions');
    expect(t).toContain('verifyInstallerPayloadVersions');
  });
});

// G3.2 build deduplication: structural pins. Behavioral evidence lives in
// release-build-once.test.ts (ledger identity contract) and
// packages/create-principles-disciple/tests/console-dist-freshness.test.ts
// (skip-flag freshness gate).
describe('G3.2 build-once — train legs reuse only identity-verified builds', () => {
  const actionRel = '.github/actions/publish-npm-package/action.yml';
  type Step = { name?: string; run?: string; env?: Record<string, unknown>; uses?: string };
  const buildStep = (): Step => {
    const doc = loadWorkflow(actionRel) as { runs?: { steps?: Step[] } };
    const step = doc.runs?.steps?.find((s) => s.name === 'Build target package');
    expect(step?.run).toBeDefined();
    return step!;
  };
  const branch = (dir: string) => {
    const run = buildStep().run!;
    const start = run.indexOf(`[ "$PKG_DIR" = "${dir}" ]`);
    expect(start, `no build branch for ${dir}`).toBeGreaterThan(-1);
    const next = run.indexOf('elif [ "$PKG_DIR" = ', start + 1);
    return next === -1 ? run.slice(start) : run.slice(start, next);
  };

  it('wires build_once through the TOOLS checkout with the cohort identity', () => {
    const step = buildStep();
    expect(String(step.env?.TOOLS_DIR)).toContain('inputs.tools_dir');
    expect(String(step.env?.COHORT)).toContain('inputs.cohort_sha');
    expect(step.run).toContain('node "$TOOLS_ABS/scripts/release/build-once.mjs"');
    expect(step.run).toContain('--cohort "$COHORT"');
  });

  it('every adapter/pd-cli build site goes through build_once (no plain duplicate left)', () => {
    const run = buildStep().run!;
    for (const ws of ['@principles/codex-adapter', '@principles/workbuddy-adapter', '@principles/pd-cli']) {
      expect(run, `plain rebuild of ${ws} survived`).not.toContain(`npm run build --workspace=${ws}`);
    }
    expect(branch('codex-adapter')).toContain('build_once @principles/codex-adapter build packages/codex-adapter');
    expect(branch('workbuddy-adapter')).toContain('build_once @principles/workbuddy-adapter build packages/workbuddy-adapter');
    for (const dir of ['pd-cli', 'create-principles-disciple']) {
      expect(branch(dir)).toContain('build_once @principles/pd-cli build packages/pd-cli');
      expect(branch(dir)).toContain('build_once @principles/codex-adapter build packages/codex-adapter');
    }
  });

  it('never build-onces the plugin: its leg executes the production prepack variant explicitly', () => {
    const run = buildStep().run!;
    expect(run).not.toMatch(/build_once\s+principles-disciple/);
    // G3.1-A: the plugin's prepack IS its build, so the leg runs those exact
    // scripts once and the candidate pack uses --ignore-scripts.
    expect(branch('openclaw-plugin')).toContain('npm run build:production --workspace=principles-disciple');
    expect(branch('openclaw-plugin')).toContain('npm run build:types --workspace=principles-disciple');
    expect(branch('openclaw-plugin')).not.toContain('npm run build --workspace=principles-disciple');
    expect(branch('pd-cli')).toContain('npm run build --workspace=principles-disciple');
    // The installer branch keeps every single-site build unconditional.
    const installer = branch('create-principles-disciple');
    expect(installer).toContain('npm run build:production --workspace=principles-disciple');
    expect(installer).toContain('npm run build:types --workspace=principles-disciple');
    expect(installer).toContain('cd packages/create-principles-disciple && npm run build');
    expect(installer).toContain('npm run build --workspace=@principles/pd-console');
  });

  it('preamble-built packages are verified fail-closed in their legs, never rebuilt', () => {
    const run = buildStep().run!;
    expect(run).toContain('assert_preamble_dist()');
    expect(run).toMatch(/packages\/\$1\/dist\/index\.js/);
    expect(run).toContain('exit 1');
    for (const [dir, ws] of [
      ['principles-core', '@principles/core'],
      ['install-layout', '@principles/install-layout'],
      ['host-runtime', '@principles/host-runtime'],
    ] as const) {
      expect(branch(dir)).toContain(`assert_preamble_dist ${dir}`);
      expect(branch(dir), `${dir} leg must not rebuild`).not.toContain(`npm run build --workspace=${ws}`);
    }
  });

  it('every caller of the action builds core/install-layout/host-runtime in its preamble BEFORE the first leg', () => {
    for (const rel of ['.github/workflows/publish-npm.yml', '.github/workflows/publish-preflight.yml']) {
      const doc = loadWorkflow(rel) as { jobs?: Record<string, { steps?: Step[] }> };
      const legJobs = Object.values(doc.jobs ?? {}).filter((job) =>
        (job.steps ?? []).some((s) => String(s.uses ?? '').includes('publish-npm-package')),
      );
      expect(legJobs.length, `${rel} has a job using the publish action`).toBeGreaterThan(0);
      for (const job of legJobs) {
        const steps = job.steps ?? [];
        const firstLeg = steps.findIndex((s) => String(s.uses ?? '').includes('publish-npm-package'));
        for (const ws of ['@principles/core', '@principles/install-layout', '@principles/host-runtime']) {
          const at = steps.findIndex((s) => String(s.run ?? '').includes(`npm run build --workspace=${ws}`));
          expect(at, `${rel}: preamble build of ${ws}`).toBeGreaterThan(-1);
          expect(at, `${rel}: ${ws} must be built before the first leg`).toBeLessThan(firstLeg);
        }
      }
    }
  });
});

describe('G3.2 console skip flag — set only where the console was just built', () => {
  type Step = { name?: string; run?: string; env?: Record<string, unknown> };
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('bundle-plugin gates the skip on the exact flag and the freshness check, and builds otherwise', () => {
    const t = read('packages/create-principles-disciple/scripts/bundle-plugin.mjs');
    expect(t).toContain("process.env.PD_BUNDLE_SKIP_CONSOLE_BUILD === '1'");
    expect(t).toContain('assertConsoleDistFresh(CONSOLE_SRC)');
    // The unflagged path still runs the official console build chain.
    expect(t).toMatch(/} else \{[\s\S]*?'run', 'build', '--workspace=@principles\/pd-console'/);
  });

  it('release-metadata sets the flag ONLY on the asset step, right after the step that builds console', () => {
    const doc = loadWorkflow('.github/workflows/release-metadata.yml') as { jobs?: Record<string, { steps?: Step[] }> };
    const flagged: Array<{ job: string; index: number; steps: Step[] }> = [];
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      (job.steps ?? []).forEach((step, index) => {
        if (step.env && Object.hasOwn(step.env, 'PD_BUNDLE_SKIP_CONSOLE_BUILD')) {
          flagged.push({ job: jobName, index, steps: job.steps ?? [] });
        }
      });
    }
    expect(flagged).toHaveLength(1);
    const { index, steps } = flagged[0];
    expect(steps[index].name).toBe('Build release asset');
    expect(String(steps[index].env?.PD_BUNDLE_SKIP_CONSOLE_BUILD)).toBe('1');
    expect(steps[index].run).toContain('build:release-asset');
    const previous = steps[index - 1];
    expect(previous?.name).toBe('Build release payload components');
    expect(previous?.run).toContain('npm run build --workspace=@principles/pd-console');
  });

  it('no job-level or workflow-level env leaks the flag into other steps', () => {
    // The per-step parse above cannot see `env:` at workflow/job level; a
    // single textual occurrence (the asset step's env line) rules that out.
    const t = read('.github/workflows/release-metadata.yml');
    expect(t.match(/PD_BUNDLE_SKIP_CONSOLE_BUILD/g)).toHaveLength(1);
  });

  it('reproducibility workflows never set the flag and keep two independent builds', () => {
    for (const rel of ['.github/workflows/release-reproducibility.yml', '.github/workflows/release-reproducibility-full.yml']) {
      expect(read(rel), rel).not.toContain('PD_BUNDLE_SKIP_CONSOLE_BUILD');
    }
    const full = read('.github/workflows/release-reproducibility-full.yml');
    // Two double-build JOBS (`native-release-matrix` and `windows-asset`), two
    // independent builds each — 2026-11-12 split the Windows leg out so the
    // upgrade gate stops waiting for the whole matrix. The invariant is "each
    // job builds twice and compares bytes"; a single build anywhere would
    // drop this to an odd count.
    expect(full.match(/build-self-contained-release\.mjs --output/g)?.length).toBe(4);
    expect(full.match(/compare-release-archives\.mjs/g)?.length).toBe(2);
    // No other workflow or action sets it either.
    for (const rel of ['.github/workflows/publish-npm.yml', '.github/workflows/publish-preflight.yml', '.github/actions/publish-npm-package/action.yml']) {
      expect(read(rel), rel).not.toContain('PD_BUNDLE_SKIP_CONSOLE_BUILD');
    }
  });
});

/**
 * PRI-1103 — the asset leg used to build from whatever ref an operator
 * dispatched while npm built from the cohort it published. Both legs preserve
 * source component versions, so identical version numbers could hide
 * different bytes, and no install-side observer could tell them apart. These
 * pins keep the commit bound to the npm channel by construction: the identity
 * step asks the registry which cohort shipped the product version, and every
 * downstream consumer keeps reading that one output.
 */
describe('release-metadata.yml — asset commit bound to the npm cohort (PRI-1103)', () => {
  const rel = '.github/workflows/release-metadata.yml';
  const text = () => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  type Step = { name?: string; run?: string; env?: Record<string, unknown>; with?: Record<string, string> };

  function identityStep(): Step {
    const doc = loadWorkflow(rel) as { jobs?: Record<string, { steps?: Step[] }> };
    const step = (doc.jobs?.['resolve-inputs']?.steps ?? []).find((s) => s.name === 'Resolve release identity');
    if (!step?.run) throw new Error('Resolve release identity step missing');
    return step;
  }

  it('exposes cohort_sha as a current-npm-latest assertion, defaulted so no event can invent one', () => {
    const doc = loadWorkflow(rel) as {
      on?: Record<string, { inputs?: Record<string, { default?: unknown; type?: string; description?: string }> }>;
    };
    const inputs = doc.on?.workflow_dispatch?.inputs;
    expect(Object.keys(inputs ?? [])).toContain('cohort_sha');
    expect(inputs?.cohort_sha?.default).toBe('');
    expect(inputs?.cohort_sha?.type).toBe('string');
    // The operator-facing contract must not advertise historical republishing:
    // the value asserts the commit npm `latest` currently points at.
    expect(inputs?.cohort_sha?.description ?? '').toMatch(/npm `latest`/);
    expect(inputs?.cohort_sha?.description ?? '').toContain('NOT a historical selector');
    expect(inputs?.allow_version_drift?.description ?? '').toContain('never changes the npm latest commit identity');
    // A schedule event carries no inputs, so the daily preflight can never
    // pin an arbitrary cohort — same posture as mode.
    expect(text()).toContain('github.event.inputs.cohort_sha');
  });

  it('derives the commit from the resolver instead of the dispatched ref', () => {
    const run = identityStep().run ?? '';
    expect(run).toContain('node scripts/release/resolve-installer-cohort.mjs --product-version "$VERSION"');
    expect(run).toMatch(/JSON\.parse\(process\.argv\[1\]\)\.cohort/);
    // The only remaining HEAD read is the dry-run fallback, inside the else
    // branch after the publish refusal — a second one anywhere else would
    // re-open the door this ticket closed.
    expect((run.match(/COMMIT=\$\(git rev-parse HEAD\)/g) ?? [])).toHaveLength(1);
    expect((text().match(/resolve-installer-cohort\.mjs/g) ?? [])).toHaveLength(1);
    // No refusal message may send the operator to an older cohort: that is the
    // bypass this rule exists to close.
    expect(run).not.toContain('cohort_sha that shipped it');
    expect(run).not.toContain('re-publish it from its own cohort');
  });

  it('fails closed on mode=publish and only rehearses the ref in a dry-run', () => {
    const run = identityStep().run ?? '';
    expect(run).toMatch(/if \[ "\$MODE" = "publish" \]; then[\s\S]{0,600}?exit 1[\s\S]{0,20}fi[\s\S]*?DRY-RUN[\s\S]*?COMMIT=\$\(git rev-parse HEAD\)/);
  });

  it('skips the ref-manifest check only for a cohort_sha the resolver binds to current npm latest', () => {
    // The resolver refuses any cohort_sha that is not latest's gitHead and
    // checks latest's ROOT manifest against the expected version, so that
    // branch already proves the version binding; the ref manifest may differ
    // because main keeps advancing.
    expect(identityStep().run ?? '').toMatch(/\[ -z "\$COHORT_SHA_INPUT" \] && \[ "\$PRODUCT_VERSION_INPUT" != "auto" \]/);
  });

  it('anchors the deterministic archive epoch to the resolved commit', () => {
    // SOURCE_DATE_EPOCH must describe the bytes being built, which since this
    // change is the cohort rather than the checkout tip.
    expect(identityStep().run ?? '').toMatch(/git log -1 --format=%ct "\$COMMIT"/);
    expect(text()).toContain('export SOURCE_DATE_EPOCH="${{ needs.resolve-inputs.outputs.source_epoch }}"');
  });

  it('threads the resolved commit through build, stamp and publish expectations', () => {
    const doc = loadWorkflow(rel) as { jobs?: Record<string, { steps?: Step[]; needs?: unknown }> };
    for (const job of ['build-asset', 'assemble-publish']) {
      const checkout = (doc.jobs?.[job]?.steps ?? []).find((s) => s.uses?.startsWith('actions/checkout'));
      expect(checkout?.with?.ref, job).toBe('${{ needs.resolve-inputs.outputs.commit }}');
    }
    const t = text();
    expect(t).toContain('--source-commit "${{ needs.resolve-inputs.outputs.commit }}"');
    expect(t).toContain('EXPECTED_COMMIT="${{ needs.resolve-inputs.outputs.commit }}"');
  });
});

/**
 * PRI-1103 final round — two publication facts are GLOBAL, not per-channel:
 * npm `latest`, and the installer cohort it points at. A long cross-platform
 * build can outlive that fact, so the workflows need (1) one mutex around all
 * production writes to the npm channel and (2) two cohort re-checks around the
 * bytes they publish.
 *
 * These pins are deliberately structural: GitHub Actions concurrency cannot be
 * unit-executed here, so the contract is "which group expression is committed"
 * plus the documented limitation in the workflow comments.
 */
describe('release workflows — global publication mutex (PRI-1103 race)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('gives the npm publish train the same global group as release-metadata publish', () => {
    const doc = loadWorkflow('.github/workflows/publish-npm.yml') as {
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
    };
    // No channel token: stable and candidate publish the SAME npm latest.
    expect(doc.concurrency?.group).toBe('pd-release-publication-global');
    expect(doc.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('locks only mode=publish in release-metadata, and keeps dry-run off the production lock', () => {
    const doc = loadWorkflow('.github/workflows/release-metadata.yml') as {
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
    };
    const group = doc.concurrency?.group ?? '';
    expect(group).toContain("github.event.inputs.mode == 'publish'");
    // Outer `||` arms: the publish arm is channel-agnostic; the dry-run arm is
    // per-channel and must not contain the production group.
    const arms = group.split('||');
    expect(arms[0]).toContain("'pd-release-publication-global'");
    expect(arms[0]).not.toContain('channel');
    expect(arms.slice(1).join('||')).toContain("format('release-metadata-{0}'");
    expect(arms.slice(1).join('||')).toContain('github.event.inputs.channel');
    expect(doc.concurrency?.['cancel-in-progress']).toBe(false);
    // Exactly one production-lock literal: no second group can be smuggled in.
    expect((read('.github/workflows/release-metadata.yml').match(/pd-release-publication-global/g) ?? [])).toHaveLength(1);
  });

  it('keeps the npm preflight rehearsal off the production lock (it never publishes)', () => {
    const doc = loadWorkflow('.github/workflows/publish-preflight.yml') as { concurrency?: { group?: string } };
    expect(doc.concurrency?.group ?? '').not.toContain('pd-release-publication-global');
    // It can only invoke the publish action with dry_run: true.
    const calls = (doc as unknown as { jobs?: Record<string, { steps?: Array<{ with?: Record<string, unknown> }> }> }).jobs ?? {};
    const publishCalls = Object.values(calls)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => (step.with?.dry_run as unknown) !== undefined);
    expect(publishCalls.length).toBeGreaterThan(0);
    for (const call of publishCalls) expect(call.with?.dry_run).toBe(true);
  });
});

describe('release-metadata.yml — cohort re-check gates around the publication (PRI-1103 race)', () => {
  const rel = '.github/workflows/release-metadata.yml';
  type Step = { name?: string; if?: string; run?: string; env?: Record<string, unknown>; 'continue-on-error'?: boolean };

  function steps(): Step[] {
    const doc = loadWorkflow(rel) as { jobs?: Record<string, { steps?: Step[] }> };
    return doc.jobs?.['assemble-publish']?.steps ?? [];
  }

  function stepNamed(prefix: string): Step {
    const step = steps().find((s) => (s.name ?? '').startsWith(prefix));
    if (!step) throw new Error(`step ${prefix} missing`);
    return step;
  }

  /**
   * Executable lines of a `run:` block. Comments and blank lines carry no
   * execution order, so "nothing between gate 2 and push" is judged on real
   * commands, never on YAML step names or comments.
   */
  function commandLines(run: string): string[] {
    return run
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  const GATE_SCRIPT = '"$RUNNER_TEMP/release-tools/scripts/release/verify-publication-cohort.mjs"';

  function publishRun(): string {
    const run = stepNamed('Publish to metadata source').run ?? '';
    expect(run.length).toBeGreaterThan(0);
    return run;
  }

  it('keeps gate 1 after asset identity verification and before every external side effect', () => {
    const order = steps().map((s) => s.name ?? '');
    const identity = order.findIndex((n) => n.startsWith('Verify embedded product identity'));
    const gate1 = order.findIndex((n) => n.startsWith('Publication gate 1'));
    const sign = order.findIndex((n) => n.startsWith('Sign and emit release metadata'));
    const uploadBytes = order.findIndex((n) => n.startsWith('Upload asset bytes'));
    const push = order.findIndex((n) => n.startsWith('Publish to metadata source'));

    expect(identity).toBeGreaterThanOrEqual(0);
    expect(gate1).toBeGreaterThan(identity);
    expect(sign).toBeGreaterThan(gate1);
    expect(uploadBytes).toBeGreaterThan(gate1);
    expect(push).toBeGreaterThan(uploadBytes);
    // Gate 2 is no longer a sibling step: a step boundary cannot protect the
    // push, because the push happens INSIDE the publish step.
    expect(order.some((n) => n.startsWith('Publication gate 2'))).toBe(false);
  });

  it('runs gate 2 inside the real publish shell, after git commit and immediately before git push', () => {
    const lines = commandLines(publishRun());
    const add = lines.indexOf('git add -A');
    const commit = lines.findIndex((line) => line.startsWith('git commit'));
    const gate = lines.findIndex((line) => line.includes(GATE_SCRIPT));
    const push = lines.indexOf('git push origin gh-pages');

    // Fixed order inside one shell: prepare/copy -> stage -> checks -> commit
    // -> gate 2 -> push.
    expect(add).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(add);
    expect(lines.some((line) => line.includes('find targets/releases'))).toBe(true);
    expect(gate).toBeGreaterThan(commit);
    expect(push).toBeGreaterThan(gate);
    // NOTHING executes between the gate and the push: push is the next command.
    expect(push).toBe(gate + 1);
    // The gate is invoked as one clear command, so its position is testable.
    expect(lines[gate]).toContain(`node ${GATE_SCRIPT}`);
  });

  it('calls gate 2 with the same verifier and cohort arguments as gate 1', () => {
    const gate1 = stepNamed('Publication gate 1').run ?? '';
    const publish = publishRun();
    for (const arg of [
      '--mode "$MODE"',
      '--product-version "$EXPECTED_VERSION"',
      '--expected-commit "$EXPECTED_COMMIT"',
      '--explicit-cohort "$COHORT_SHA_INPUT"',
    ]) {
      expect(gate1, `gate1 ${arg}`).toContain(arg);
      expect(publish, `gate2 ${arg}`).toContain(arg);
    }
    // One shared control-plane script, same path in both gates.
    expect(gate1).toContain(`node ${GATE_SCRIPT}`);
    expect(publish).toContain(`node ${GATE_SCRIPT}`);
    // Only gate 2 may claim that external bytes already exist; gate 1 runs
    // before any upload.
    expect(gate1).toContain('--external-side-effects none');
    expect(publish).toContain('--external-side-effects asset-bytes-uploaded');
  });

  it('makes the push unreachable when gate 2 refuses, and rewrites no asset identity', () => {
    const run = publishRun();
    expect(run).toContain('set -euo pipefail');
    const lines = commandLines(run);
    const gate = lines.findIndex((line) => line.includes(GATE_SCRIPT));
    expect(gate).toBeGreaterThanOrEqual(0);
    // `set -e` + a plain sequential command means a non-zero gate exits the
    // shell before the next line, which is the push.
    expect(lines[gate]).not.toContain('||');
    expect(lines[gate]).not.toContain('set +e');
    expect(lines.slice(gate).join('\n')).not.toContain('|| true');

    const step = stepNamed('Publish to metadata source');
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.if ?? '').toContain("env.MODE == 'publish'");
    expect(step.if ?? '').toContain('success()');
    // A refusal must never be "fixed" by rewriting what the bytes claim.
    expect(run).not.toContain('sourceCommit');
    expect(run).not.toContain('sed -i');
    // The only gh-pages push in the whole workflow is this guarded shell.
    const pushes = steps().filter((s) => (s.run ?? '').includes('git push origin gh-pages'));
    expect(pushes).toHaveLength(1);
  });

  it('never lets a gate refusal be skipped, retried or downgraded', () => {
    const gate1 = stepNamed('Publication gate 1');
    expect(gate1['continue-on-error']).toBeUndefined();
    expect(gate1.run ?? '').not.toContain('|| true');
    expect(gate1.run ?? '').not.toContain('continue');
    expect(gate1.run ?? '').not.toContain('sourceCommit');
    expect(gate1.run ?? '').not.toContain('sed -i');
    // Publishing steps keep default success() semantics, so a gate failure
    // skips the upload/push instead of racing ahead.
    expect(stepNamed('Upload asset bytes').if ?? '').toContain('success()');
  });

  it('keeps dry-run off the production gate-2 write path', () => {
    // Gate 1 runs in dry-run but is advisory by mode; the production write
    // (push) is unreachable unless mode=publish.
    const step = stepNamed('Publish to metadata source');
    expect(step.if ?? '').toMatch(/env\.MODE == 'publish'/);
    expect(publishRun()).toContain('git push origin gh-pages');
    // Nothing outside this mode-guarded shell pushes metadata.
    for (const candidate of steps().filter((s) => (s.run ?? '').includes('git push'))) {
      expect(candidate.name ?? '').toContain('Publish to metadata source');
    }
  });

  it('receives gate tooling from resolve-inputs, never from the product cohort', () => {
    const doc = loadWorkflow(rel) as { jobs?: Record<string, { steps?: Array<Step & { uses?: string; with?: Record<string, unknown> }> }> };
    const resolveSteps = doc.jobs?.['resolve-inputs']?.steps ?? [];
    const bundle = resolveSteps.find((s) => (s.name ?? '').startsWith('Bundle publication-gate tooling'));
    expect(bundle?.run ?? '').toContain('git archive HEAD scripts/release scripts/lib');
    const upload = resolveSteps.find(
      (s) => (s.uses ?? '').startsWith('actions/upload-artifact') && s.with?.name === 'release-publication-gate-tooling',
    );
    expect(upload?.with?.['if-no-files-found']).toBe('error');

    // assemble-publish downloads the bundle; it never re-reads the mutable ref.
    const assemble = doc.jobs?.['assemble-publish']?.steps ?? [];
    const download = assemble.find(
      (s) => (s.uses ?? '').startsWith('actions/download-artifact') && s.with?.name === 'release-publication-gate-tooling',
    );
    expect(download?.with?.path).toBe('${{ runner.temp }}/release-tools-archive');
    const extract = assemble.find((s) => (s.name ?? '').startsWith('Extract trusted publication-gate tooling'));
    expect(extract?.run ?? '').toContain('$RUNNER_TEMP/release-tools');
    expect(extract?.run ?? '').toContain('verify-publication-cohort.mjs');
    // Extraction target is RUNNER_TEMP: the cohort workspace (and therefore the
    // gh-pages publication payload) stays untouched.
    expect(assemble.some((s) => (s.run ?? '').includes('git archive HEAD'))).toBe(false);
  });
});

