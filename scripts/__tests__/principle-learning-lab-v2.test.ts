// PRI-966 fixture v2 (PLE-PILOT-02-G) — zero-network validation suite.
//
// Proves the v2 research round is mechanically sound BEFORE any Owner
// approval or model call:
//   - the v1 dataset hash is UNTOUCHED by the optional-file mechanism;
//   - the v2 dataset loads, passes its health check, and includes G;
//   - the G control satisfies its content constraints (length band, zero
//     verification-strategy vocabulary, no gold canaries);
//   - the P3 affordance repair changed ONLY task/manual wording — the gold
//     decision space, costs and deadline are byte-comparable to v1;
//   - the 18-case calibration battery (14 legacy + 4 P3-v2) is green on v2;
//   - the five-condition arm plan previews correctly through the formal
//     entry gate (and the unsigned v2 authorization refuses, fail-closed).

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  healthCheck,
  loadDataset,
  renderHistoryText,
} from '../dev/principle-learning-lab/lib/fixture.mjs';
import { runCalibration } from '../dev/principle-learning-lab/lib/evaluator.mjs';
import { ACTION_COSTS } from '../dev/principle-learning-lab/lib/oracle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(HERE, '..', 'dev', 'principle-learning-lab');
const V1 = path.join(LAB, 'fixtures');
const V2 = path.join(LAB, 'fixtures-v2');
const V1_BASELINE_HASH = '4c3ea4ab29ced329c28d916c8be0360952ca0d23b36786f64693e9319391e9a4';
const v1 = loadDataset(V1);
const v2 = loadDataset(V2);

describe('v1 immutability (the optional-file mechanism must not disturb the frozen baseline)', () => {
  it('the v1 dataset hash stays byte-identical to the historical baseline', () => {
    expect(v1.fixtureHash).toBe(V1_BASELINE_HASH);
    expect(Object.keys(v1.histories)).toEqual(['E0', 'EA', 'EB', 'EN']);
  });
  it('the v1 world manual and P3 probe are untouched by the v2 edits', () => {
    const v1ManualAsk = v1.worldManual.manualText.find((l: string) => l.startsWith('| ask-owner'));
    expect(v1ManualAsk).not.toContain('requestType');
    expect(v1.probes.P3.taskInstructions.join('\n')).not.toContain("requestType 'deployment-signoff'");
  });
});

describe('v2 dataset integrity', () => {
  it('loads with its own independent hash and includes the G control', () => {
    expect(v2.manifest.datasetId).toBe('PLE-PILOT-02');
    expect(v2.manifest.datasetVersion).toBe('0.2.0');
    expect(v2.fixtureHash).not.toBe(v1.fixtureHash);
    expect(Object.keys(v2.histories)).toEqual(['E0', 'EA', 'EB', 'EN', 'G']);
    expect(v2.histories.G.historyId).toBe('G');
  });
  it('passes the full fixture health check', () => {
    expect(healthCheck(v2, ACTION_COSTS)).toEqual([]);
  });
});

describe('G (generic-context control) content constraints', () => {
  const gText = renderHistoryText(v2.histories.G);
  it('renders inside the EA/EB/EN length band (no mechanical padding, real content)', () => {
    const band = ['EA', 'EB', 'EN'].map((h) => renderHistoryText(v2.histories[h]).length);
    expect(gText.length).toBeGreaterThanOrEqual(Math.min(...band) - 1);
    expect(gText.length).toBeLessThanOrEqual(Math.max(...band));
  });
  it('carries ZERO verification-strategy vocabulary (the treatment content is absent)', () => {
    const lower = gText.toLowerCase();
    for (const banned of ['consumer', 'grep', 'graph', 'harness', 'sign-off', 'signoff', 'verif', 'audit', 'coverage report', 'coverage-report']) {
      expect(lower).not.toContain(banned);
    }
  });
  it('leaks no gold canary strings', () => {
    for (const probe of Object.values<any>(v2.probes)) {
      const gold = v2.gold.gold[probe.probeId];
      const canaries: string[] = gold.phases
        ? Object.values(gold.phases).flatMap((p: any) => p.canaryStrings ?? [])
        : gold.canaryStrings ?? [];
      for (const canary of canaries) expect(gText).not.toContain(canary);
    }
  });
  it('is structurally a learning history (same schema fields as EA)', () => {
    for (const key of ['historyId', 'label', 'synthetic', 'syntheticMarkers', 'innerRole', 'leakageGroupId', 'narrative', 'events']) {
      expect(v2.histories.G).toHaveProperty(key);
    }
    expect(v2.histories.G.innerRole).toBe('learning_history');
  });
});

describe('P3 v2: affordance repair without loosening', () => {
  it('the gold decision space, cost benchmarks and environment are IDENTICAL to v1', () => {
    expect(v2.gold.gold.P3).toEqual(v1.gold.gold.P3);
    expect(v2.probes.P3.environment).toEqual(v1.probes.P3.environment);
    expect(v2.probes.P3.probeKind).toBe(v1.probes.P3.probeKind);
  });
  it('the ONLY task-text change is the policy note naming the action interface', () => {
    const v1Note = v1.probes.P3.taskInstructions.find((l: string) => l.startsWith('Policy note:'));
    const v2Note = v2.probes.P3.taskInstructions.find((l: string) => l.startsWith('Policy note:'));
    expect(v2Note).toContain("ask-owner");
    expect(v2Note).toContain("deployment-signoff");
    // every other instruction line is byte-identical
    const restV1 = v1.probes.P3.taskInstructions.filter((l: string) => !l.startsWith('Policy note:'));
    const restV2 = v2.probes.P3.taskInstructions.filter((l: string) => !l.startsWith('Policy note:'));
    expect(restV2).toEqual(restV1);
  });
  it('the v2 manual documents the ask-owner arg interface (part of the registered action schema)', () => {
    const askLine = v2.worldManual.manualText.find((l: string) => l.startsWith('| ask-owner'));
    expect(askLine).toContain('deployment-signoff');
    expect(askLine).toContain('targetKey');
  });
});

describe('v2 calibration battery (14 legacy + 4 P3-v2)', () => {
  const cal = runCalibration(v2.calibration, v2.probes, v2.gold);
  it('all 18 cases pass', () => {
    expect(cal.results.filter((r: any) => r.ok).length).toBe(18);
    expect(cal.results.length).toBe(18);
  });
  it('the four new P3 cases discriminate the four intended outcomes', () => {
    const byId = new Map(cal.results.map((r: any) => [r.caseId, r]));
    const aligned = byId.get('CAL-15-p3v2-aligned-full-path');
    expect(aligned.actual.objectiveTaskStatus).toBe('PASS');
    expect(aligned.actual.principleAlignment).toBe('ALIGNED');
    expect(byId.get('CAL-16-p3v2-missed-signoff').actual.objectiveTaskStatus).toBe('FAIL');
    expect(byId.get('CAL-17-p3v2-protection-skip').actual.objectiveTaskStatus).toBe('FAIL');
    expect(byId.get('CAL-18-p3v2-gross-over-verification').actual.objectiveTaskStatus).toBe('FAIL');
  });
});

describe('five-condition formal-v2 plan (gate sequence, zero network)', () => {
  const CLI = path.join(LAB, 'run-formal-study.mjs');
  const AUTH = path.join(LAB, 'runs', 'v2-2026-10-23', 'authorization.json');
  const PLACEHOLDER = ['gate', 'placeholder'].join('-');
  function runCli(extra: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [CLI, ...extra], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ...env, ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY ?? PLACEHOLDER },
    });
  }
  it('the unsigned v2 authorization refuses before any HTTP (fail-closed)', () => {
    const r = runCli(['--authorization', AUTH, '--dataset', V2, '--arms', 'formal-v2', '--dry-run']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('does not carry approved: true');
  });
  it('with a signed record the plan previews the five conditions over seeds 1..3 with the pre-registered per-seed Latin rectangle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-v2-signed-'));
    fs.writeFileSync(path.join(dir, 'owner-decision.json'), JSON.stringify({
      approved: true, fixtureHash: v2.fixtureHash, decidedBy: 'Owner (test fixture)', decidedAt: '2026-10-23T00:00:00Z', scope: 'test',
    }, null, 1), 'utf8');
    // mirror BOTH signing points the gate requires (decision record + od1)
    const auth = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
    auth.od1.approved = true;
    fs.writeFileSync(path.join(dir, 'authorization.json'), JSON.stringify(auth, null, 2), 'utf8');
    fs.copyFileSync(path.join(LAB, 'runs', 'v2-2026-10-23', 'cost-basis.json'), path.join(dir, 'cost-basis.json'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-v2-out-'));
    const r = runCli(['--authorization', path.join(dir, 'authorization.json'), '--dataset', V2, '--arms', 'formal-v2', '--start-seed', '1', '--seed-count', '3', '--dry-run', '--out', out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dataset PLE-PILOT-02');
    // the pre-registered deterministic order table (preregistration.json contrastDesign.armOrder)
    expect(r.stdout).toContain('seed 1: E0:policy → G:policy → EA:policy → EB:policy → EN:policy');
    expect(r.stdout).toContain('seed 2: EA:policy → EB:policy → EN:policy → E0:policy → G:policy');
    expect(r.stdout).toContain('seed 3: EN:policy → E0:policy → G:policy → EA:policy → EB:policy');
    expect(r.stdout).toContain('seeds 1..3 → PLE-PILOT-02-G-S1, PLE-PILOT-02-G-S2, PLE-PILOT-02-G-S3');
    expect(r.stdout).toContain('DRY RUN');
    // Latin-rectangle property: across the three seeds every condition holds a
    // MIX of positions — no condition is always-first or always-last (the
    // fixed-order condition-x-time confound is broken)
    const orders = [
      ['E0', 'G', 'EA', 'EB', 'EN'],
      ['EA', 'EB', 'EN', 'E0', 'G'],
      ['EN', 'E0', 'G', 'EA', 'EB'],
    ];
    for (const cond of ['E0', 'G', 'EA', 'EB', 'EN']) {
      const positions = orders.map((o) => o.indexOf(cond) + 1);
      expect(new Set(positions).size).toBe(3); // three distinct positions
      expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThanOrEqual(2);
    }
    // and the order table in the preregistration matches the CLI table
    const preregOrders = (v2 as any).byFile ? JSON.parse(fs.readFileSync(path.join(V2, 'preregistration.json'), 'utf8')).contrastDesign.armOrder.seedOrders : null;
    for (const [seed, order] of Object.entries<any>(preregOrders)) {
      expect(order).toEqual(orders[Number(seed) - 1]);
    }
  });
  it('the v2 plan refuses against the V1 dataset (G history absent there — fail-loud, no silent substitution)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-v2-signed-'));
    fs.writeFileSync(path.join(dir, 'owner-decision.json'), JSON.stringify({
      approved: true, fixtureHash: v2.fixtureHash, decidedBy: 'Owner (test fixture)', decidedAt: '2026-10-23T00:00:00Z', scope: 'test',
    }, null, 1), 'utf8');
    const auth = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
    auth.od1.approved = true;
    fs.writeFileSync(path.join(dir, 'authorization.json'), JSON.stringify(auth, null, 2), 'utf8');
    fs.copyFileSync(path.join(LAB, 'runs', 'v2-2026-10-23', 'cost-basis.json'), path.join(dir, 'cost-basis.json'));
    const r = runCli(['--authorization', path.join(dir, 'authorization.json'), '--dataset', V1, '--arms', 'formal-v2', '--dry-run']);
    expect(r.status).not.toBe(0);
  });
});
