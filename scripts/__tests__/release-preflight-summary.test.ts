// PD Release G3-R3 — H1: the preflight rehearsal summary must report what
// actually happened. Before this guard, publish-preflight.yml printed
// "All eight legs ... packed real artifacts" unconditionally, so a cohort
// where PRESENT_MATCH / PRESENT_PRIOR skipped every candidate pack was
// described as a complete packaging run. These tests pin BOTH halves:
//   * the workflow/action wiring reads per-leg evidence and never claims a
//     pack from step success;
//   * scripts/release/preflight-summary.mjs classifies the five scenarios
//     (all skipped, partial, all packed, missing SHA-512, failed/unknown)
//     without ever producing a false packaging claim.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as jsyamlNs from 'js-yaml';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'scripts', 'release');

const yamlNamespace = jsyamlNs as unknown as Record<string, unknown>;
const yamlDefault = yamlNamespace.default as Record<string, unknown> | undefined;
const yamlLoad: (text: string) => unknown =
  typeof yamlNamespace.load === 'function'
    ? (yamlNamespace.load as (text: string) => unknown)
    : typeof yamlDefault?.load === 'function'
      ? (yamlDefault.load as (text: string) => unknown)
      : () => {
          throw new Error('js-yaml load export not found');
        };

function loadYaml(rel: string): Record<string, unknown> {
  const doc = yamlLoad(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  if (typeof doc !== 'object' || doc === null) throw new Error(`${rel} did not parse to a mapping`);
  return doc as Record<string, unknown>;
}

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, unknown> };
type Job = { steps?: Step[] };
type WorkflowDoc = { jobs?: Record<string, Job> };

type LegSummaryResult = {
  id: string;
  packageName: string;
  version: string;
  status: string;
  reason: string;
  sha512: string;
  packAttempted: boolean;
};
type PreflightSummaryResult = {
  controlPlane: string;
  legs: LegSummaryResult[];
  packed: number;
  skipped: number;
  failed: number;
  unknown: number;
  attempted: number;
  exercised: boolean;
  candidatePath: string;
};

async function loadSummaryModule() {
  return (await import(pathToFileURL(path.join(RELEASE_DIR, 'preflight-summary.mjs')).href)) as {
    LEG_STATUS: Record<string, string>;
    classifyLeg: (evidence: Record<string, unknown>) => { status: string; packAttempted: boolean; reason: string };
    summarizeSteps: (steps: Record<string, unknown>, controlPlane: string) => PreflightSummaryResult;
    renderSummary: (summary: PreflightSummaryResult) => string;
  };
}

const PREFLIGHT = '.github/workflows/publish-preflight.yml';
const ACTION = '.github/actions/publish-npm-package/action.yml';
const COHORT = 'c'.repeat(40);

function rehearsalJob(): { jobName: string; steps: Step[] } {
  const doc = loadYaml(PREFLIGHT) as WorkflowDoc;
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    const steps = job.steps ?? [];
    if (steps.some((step) => String(step.uses ?? '').includes('publish-npm-package'))) {
      return { jobName, steps };
    }
  }
  throw new Error('publish-preflight.yml has no rehearsal job using the publish action');
}

describe('publish-preflight.yml — summary is derived from per-leg evidence (H1)', () => {
  it('every rehearsal leg is addressable by id and the set matches TRAIN_ORDER', () => {
    const { steps } = rehearsalJob();
    const legSteps = steps.filter((step) => String(step.uses ?? '').includes('publish-npm-package'));
    const ids = legSteps.map((step) => step.id ?? '');
    // The summary reads `steps.legN`, so a leg without that id is invisible.
    ids.forEach((id) => expect(id).toMatch(/^leg\d+$/));
    expect(ids).toEqual(ids.map((_, index) => `leg${index + 1}`));

    const preflightText = fs.readFileSync(path.join(REPO_ROOT, PREFLIGHT), 'utf8');
    const trainOrder = /^\s*TRAIN_ORDER: ([a-z0-9,_-]+)$/m.exec(preflightText)?.[1].split(',') ?? [];
    expect(trainOrder).toHaveLength(8);
    // A package added to the train without a rehearsal leg would silently
    // shrink the evidence the summary is allowed to describe.
    expect(legSteps).toHaveLength(trainOrder.length);
  });

  it('renders the summary from the steps context, even when a leg failed', () => {
    const { steps } = rehearsalJob();
    const summary = steps.find((step) => step.name === 'Rehearsal summary (explicitly NOT a publish)');
    expect(summary, 'rehearsal summary step').toBeDefined();
    expect(String(summary?.if)).toContain('always()');
    expect(String(summary?.env?.STEPS_CONTEXT)).toContain('toJSON(steps)');
    expect(String(summary?.env?.CONTROL_PLANE)).toContain('needs.preflight-checks.result');
    expect(summary?.run).toContain('preflight-summary.mjs');
    expect(summary?.run).toContain('--steps-json "$STEPS_CONTEXT"');
    expect(summary?.run).toContain('--control-plane "$CONTROL_PLANE"');
  });

  it('no longer contains the unconditional packing claim', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, PREFLIGHT), 'utf8');
    expect(text).not.toContain('All eight legs');
    expect(text).not.toContain('packed real artifacts from the cohort build');
    // The rehearsal is still explicitly not a publish (PRI-886 invariant).
    expect(text).toContain('NOT evidence of a published version');
    // The classifier must be present in the trusted tools checkout.
    expect(text).toContain('scripts/release/preflight-summary.mjs');
  });
});

describe('publish-npm-package action — per-leg status output (H1)', () => {
  it('classifies the leg from evidence and always reports it', () => {
    const doc = yamlLoad(fs.readFileSync(path.join(REPO_ROOT, ACTION), 'utf8')) as {
      outputs?: Record<string, { value?: string }>;
      runs?: { steps?: Step[] };
    };
    const summary = doc.runs?.steps?.find((step) => step.name === 'Summary');
    expect(summary, 'action Summary step').toBeDefined();
    expect(String(summary?.if)).toContain('always()');
    expect(summary?.run).toContain('preflight-summary.mjs');
    expect(summary?.run).toContain('--registry-status "$REGISTRY_STATUS"');
    expect(summary?.run).toContain('--sha512-hex "$CANDIDATE_SHA512_HEX"');
    expect(summary?.run).toContain('--github-output "$GITHUB_OUTPUT"');
    // The caller aggregates these; without the outputs the workflow could
    // only guess from step outcome.
    for (const output of ['leg_status', 'leg_reason', 'leg_pack_attempted']) {
      expect(doc.outputs?.[output]?.value, output).toContain(`steps.summary.outputs.${output}`);
    }
    // The old unconditional "artifact verified" sentence is status-gated now.
    expect(summary?.run).not.toContain('control path exercised and artifact verified');
    // A verified artifact does NOT prove the upload; "Published" is gated on
    // the publish step's own outcome (a failed upload must not be reported as
    // a published version).
    expect(String(summary?.env?.PUBLISH_OUTCOME)).toContain('steps.publish.outcome');
    expect(summary?.run).toContain('"$PUBLISH_OUTCOME" = "success"');
    expect(summary?.run).toContain('did NOT complete');
  });
});

describe('preflight-summary — classification never invents a pack (H1)', () => {
  it('PRESENT_MATCH / PRESENT_PRIOR are SKIPPED_PRESENT, never PACKED', async () => {
    const { LEG_STATUS, classifyLeg } = await loadSummaryModule();
    for (const registryStatus of ['PRESENT_MATCH', 'PRESENT_PRIOR']) {
      const result = classifyLeg({ registryStatus });
      expect(result.status).toBe(LEG_STATUS.SKIPPED_PRESENT);
      expect(result.packAttempted).toBe(false);
    }
  });

  it('ABSENT without a trustworthy candidate is UNKNOWN, not PACKED', async () => {
    const { LEG_STATUS, classifyLeg } = await loadSummaryModule();
    const base = {
      registryStatus: 'ABSENT',
      candidateExists: true,
      declaredSha512Hex: 'a'.repeat(128),
      recomputedSha512Hex: 'a'.repeat(128),
      manifest: { name: 'pkg', version: '1.0.0', gitHead: COHORT },
      expectedName: 'pkg',
      expectedVersion: '1.0.0',
      cohort: COHORT,
    };
    expect(classifyLeg(base).status).toBe(LEG_STATUS.PACKED);

    const scenarios: Array<[string, Record<string, unknown>]> = [
      ['candidate file missing', { ...base, candidateExists: false }],
      ['SHA-512 missing', { ...base, declaredSha512Hex: '' }],
      ['SHA-512 malformed', { ...base, declaredSha512Hex: 'not-a-hex-digest' }],
      ['SHA-512 mismatch', { ...base, recomputedSha512Hex: 'b'.repeat(128) }],
      ['manifest unreadable', { ...base, manifest: null }],
      ['package name mismatch', { ...base, manifest: { ...base.manifest, name: 'other' } }],
      ['package version mismatch', { ...base, manifest: { ...base.manifest, version: '2.0.0' } }],
      ['cohort gitHead mismatch', { ...base, manifest: { ...base.manifest, gitHead: 'd'.repeat(40) } }],
    ];
    for (const [label, evidence] of scenarios) {
      const result = classifyLeg(evidence);
      expect(result.status, label).toBe(LEG_STATUS.UNKNOWN);
      expect(result.packAttempted, label).toBe(true);
      expect(result.reason, label).not.toBe('');
    }
  });

  it('all eight legs skipped: zero packed, packaging NOT exercised', async () => {
    const { LEG_STATUS, summarizeSteps } = await loadSummaryModule();
    const steps = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `leg${index + 1}`,
        {
          outcome: 'success',
          outputs: {
            leg_status: LEG_STATUS.SKIPPED_PRESENT,
            leg_pack_attempted: 'false',
            npm_name: `pkg-${index + 1}`,
            package_version: '1.0.0',
          },
        },
      ]),
    );
    const summary = summarizeSteps(steps, 'success');
    expect(summary.packed).toBe(0);
    expect(summary.skipped).toBe(8);
    expect(summary.exercised).toBe(false);
    expect(summary.candidatePath).toBe('NOT VERIFIED IN THIS RUN');
    expect(summary.legs).toHaveLength(8);
  });

  it('partial packing reports the real counts and a partial verdict', async () => {
    const { LEG_STATUS, summarizeSteps } = await loadSummaryModule();
    const steps = Object.fromEntries(
      ['PACKED', 'PACKED', 'PACKED', 'SKIPPED_PRESENT', 'SKIPPED_PRESENT', 'SKIPPED_PRESENT', 'SKIPPED_PRESENT', 'SKIPPED_PRESENT']
        .map((status, index) => [
          `leg${index + 1}`,
          {
            outcome: 'success',
            outputs: {
              leg_status: status,
              leg_pack_attempted: status === LEG_STATUS.PACKED ? 'true' : 'false',
              npm_name: `pkg-${index + 1}`,
              candidate_sha512_hex: status === LEG_STATUS.PACKED ? 'e'.repeat(128) : '',
            },
          },
        ]),
    );
    const summary = summarizeSteps(steps, 'success');
    expect(summary.packed).toBe(3);
    expect(summary.skipped).toBe(5);
    expect(summary.exercised).toBe(true);
    expect(summary.candidatePath).toBe('PARTIALLY VERIFIED IN THIS RUN');
  });

  it('all eight packed is the only fully VERIFIED verdict', async () => {
    const { LEG_STATUS, summarizeSteps } = await loadSummaryModule();
    const steps = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `leg${index + 1}`,
        {
          outcome: 'success',
          outputs: { leg_status: LEG_STATUS.PACKED, leg_pack_attempted: 'true', npm_name: `pkg-${index + 1}` },
        },
      ]),
    );
    const summary = summarizeSteps(steps, 'success');
    expect(summary.packed).toBe(8);
    expect(summary.skipped).toBe(0);
    expect(summary.exercised).toBe(true);
    expect(summary.candidatePath).toBe('VERIFIED IN THIS RUN');
  });

  it('a candidate file whose SHA-512 was never produced stays unverified', async () => {
    const { LEG_STATUS, summarizeSteps } = await loadSummaryModule();
    const summary = summarizeSteps(
      {
        leg1: { outcome: 'success', outputs: { leg_status: LEG_STATUS.UNKNOWN, leg_pack_attempted: 'true', npm_name: 'pkg' } },
      },
      'success',
    );
    expect(summary.packed).toBe(0);
    expect(summary.unknown).toBe(1);
    expect(summary.exercised).toBe(true);
    expect(summary.candidatePath).toBe('ATTEMPTED BUT NOT VERIFIED IN THIS RUN');
  });

  it('a failed or never-run leg is FAILED / UNKNOWN, never PACKED', async () => {
    const { LEG_STATUS, summarizeSteps } = await loadSummaryModule();
    const summary = summarizeSteps(
      {
        leg1: { outcome: 'failure', outputs: { leg_status: LEG_STATUS.PACKED, leg_pack_attempted: 'true', npm_name: 'a' } },
        leg2: { outcome: 'skipped', outputs: {}, npm_name: 'b' },
        leg3: { outcome: 'success', outputs: { leg_status: LEG_STATUS.SKIPPED_PRESENT, npm_name: 'c' } },
      },
      'success',
    );
    expect(summary.legs?.[0]?.status).toBe(LEG_STATUS.FAILED);
    expect(summary.legs?.[1]?.status).toBe(LEG_STATUS.UNKNOWN);
    expect(summary.packed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.unknown).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('the rendered zero-candidate summary matches the required wording', async () => {
    const { LEG_STATUS, summarizeSteps, renderSummary } = await loadSummaryModule();
    const steps = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `leg${index + 1}`,
        { outcome: 'success', outputs: { leg_status: LEG_STATUS.SKIPPED_PRESENT, npm_name: `pkg-${index + 1}` } },
      ]),
    );
    const text = renderSummary(summarizeSteps(steps, 'success'));
    for (const line of [
      'Preflight control plane: PASS',
      'Release legs: 8',
      'Candidates packed: 0',
      'Skipped existing versions: 8',
      'Candidate packaging exercised: NO',
      'Candidate path: NOT VERIFIED IN THIS RUN',
    ]) {
      expect(text, line).toContain(line);
    }
    // The exact regression this guard exists for.
    expect(text).not.toContain('packed real artifacts');
  });
});
