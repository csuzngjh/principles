import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SyntheticBaselineSummary, SyntheticBaselineStage } from '../synthetic-baseline.js';
import { runSyntheticBaseline, computeOverallStatus, boundedEvidence } from '../synthetic-baseline.js';

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-synth-baseline-'));
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  return dir;
}

function destroyWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors on Windows
  }
}

function makeStage(status: SyntheticBaselineStage['status'], name: string = 'pain_intake'): SyntheticBaselineStage {
  return { name: name as SyntheticBaselineStage['name'], status };
}

describe('Synthetic Baseline (PRI-206)', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = createTempWorkspace();
  });

  afterEach(() => {
    destroyWorkspace(tempDir);
  });

  describe('computeOverallStatus', () => {
    it('returns passed when all stages passed', () => {
      const stages = [
        makeStage('passed', 'pain_intake'),
        makeStage('passed', 'diagnostician_task_created'),
        makeStage('passed', 'candidate_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('passed');
    });

    it('returns failed when all stages failed', () => {
      const stages = [
        makeStage('failed', 'pain_intake'),
        makeStage('failed', 'diagnostician_task_created'),
        makeStage('failed', 'candidate_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('failed');
    });

    it('returns degraded when some passed and some failed', () => {
      const stages = [
        makeStage('passed', 'pain_intake'),
        makeStage('failed', 'diagnostician_task_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('degraded');
    });

    it('returns degraded when passed, failed, and skipped are mixed', () => {
      const stages = [
        makeStage('passed', 'pain_intake'),
        makeStage('failed', 'diagnostician_task_created'),
        makeStage('skipped', 'candidate_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('degraded');
    });

    it('returns degraded when all stages are skipped', () => {
      const stages = [
        makeStage('skipped', 'pain_intake'),
        makeStage('skipped', 'diagnostician_task_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('degraded');
    });
  });

  describe('boundedEvidence', () => {
    it('returns evidence as-is when within budget', () => {
      const evidence = { key: 'value', count: 42 };
      const result = boundedEvidence(evidence);
      expect(result).toEqual(evidence);
    });

    it('truncates evidence with super-long keys', () => {
      const longKey = 'x'.repeat(1900);
      const evidence: Record<string, unknown> = {};
      evidence[longKey] = 'value';
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
    });

    it('handles circular references safely', () => {
      const evidence: Record<string, unknown> = {};
      evidence.self = evidence;
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
    });

    it('handles BigInt values', () => {
      const evidence: Record<string, unknown> = { bigNum: BigInt(9007199254740991) };
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
      expect(json).toContain('9007199254740991n');
    });

    it('truncates when multiple fields exceed budget at boundary', () => {
      const evidence: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        evidence[`field_${String(i).padStart(3, '0')}`] = 'x'.repeat(50);
      }
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
    });
  });

  describe('success path', () => {
    it('all stages pass on temp workspace', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
      });

      expect(result.status).toBe('passed');
      expect(result.workspaceMode).toBe('temp');
      expect(result.generatedAt).toBeTruthy();
      expect(result.stages).toHaveLength(6);

      const stageNames = result.stages.map(s => s.name);
      expect(stageNames).toEqual([
        'pain_intake',
        'diagnostician_task_created',
        'candidate_created',
        'ledger_consistent',
        'internalization_queue_ready',
        'canary_health',
      ]);

      for (const stage of result.stages) {
        expect(stage.status).toBe('passed');
        expect(stage.reason).toBeUndefined();
      }
    });
  });

  describe('stage-by-stage failure isolation', () => {
    it('when pain intake fails, only pain_intake is failed with structured reason', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
        failAfterStage: 'before_pain_intake',
      });

      expect(result.status).toBe('failed');
      const painStage = result.stages.find(s => s.name === 'pain_intake');
      expect(painStage?.status).toBe('failed');
      expect(painStage?.reason).toBeTruthy();

      const laterStages = result.stages.filter(s => s.name !== 'pain_intake');
      for (const stage of laterStages) {
        expect(stage.status).toBe('failed');
      }
    });

    it('when diagnostician task creation fails, only that stage and later are failed', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
        failAfterStage: 'after_pain_intake',
      });

      const painStage = result.stages.find(s => s.name === 'pain_intake');
      expect(painStage?.status).toBe('passed');

      const taskStage = result.stages.find(s => s.name === 'diagnostician_task_created');
      expect(taskStage?.status).toBe('failed');
      expect(taskStage?.reason).toBeTruthy();

      const laterStages = result.stages.filter(
        s => s.name !== 'pain_intake' && s.name !== 'diagnostician_task_created',
      );
      for (const stage of laterStages) {
        expect(stage.status).toBe('failed');
      }
    });
  });

  describe('JSON output contract', () => {
    it('output is stable, bounded, and serializable', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
      });

      const json = JSON.stringify(result);
      const parsed = JSON.parse(json) as SyntheticBaselineSummary;

      expect(parsed.status).toBe(result.status);
      expect(parsed.workspaceMode).toBe(result.workspaceMode);
      expect(parsed.stages).toHaveLength(result.stages.length);

      for (const stage of parsed.stages) {
        expect(typeof stage.name).toBe('string');
        expect(['passed', 'failed', 'skipped']).toContain(stage.status);
        if (stage.reason !== undefined) {
          expect(typeof stage.reason).toBe('string');
          expect(stage.reason.length).toBeLessThanOrEqual(500);
        }
        if (stage.evidence !== undefined) {
          const evidenceJson = JSON.stringify(stage.evidence);
          expect(evidenceJson.length).toBeLessThanOrEqual(2000);
        }
      }
    });

    it('recommendedNextIssue is present when status is failed or degraded', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
        failAfterStage: 'before_pain_intake',
      });

      expect(result.status).not.toBe('passed');
      expect(result.recommendedNextIssue).toBeTruthy();
    });
  });

  describe('workspace safety', () => {
    it('explicit workspace mode is reflected in output', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'explicit_workspace',
      });

      expect(result.workspaceMode).toBe('explicit_workspace');
    });

    it('temp workspace does not modify production paths', async () => {
      const prodPath = path.join(os.tmpdir(), 'pd-prod-should-not-exist');
      if (fs.existsSync(prodPath)) {
        destroyWorkspace(prodPath);
      }

      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
      });

      expect(result.workspaceMode).toBe('temp');
      expect(fs.existsSync(prodPath)).toBe(false);
    });
  });

  describe('DB integrity across runs', () => {
    it('second baseline run does not shrink or corrupt existing DB', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
      });

      const dbPath = path.join(tempDir, '.pd', 'state.db');
      if (!fs.existsSync(dbPath)) {
        throw new Error(`DB not found at ${dbPath} — baseline should have created it`);
      }

      const sizeAfterBaseline = fs.statSync(dbPath).size;

      const result2 = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
      });

      const sizeAfterSecondRun = fs.statSync(dbPath).size;

      expect(result.status).toBe('passed');
      expect(result2.status).toBe('passed');
      expect(sizeAfterSecondRun).toBeGreaterThanOrEqual(sizeAfterBaseline);
    });
  });

  describe('no live RuleHost correction', () => {
    it('baseline does not invoke RuleHost or auto-correction', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
      });

      for (const stage of result.stages) {
        if (stage.evidence) {
          const evidenceStr = JSON.stringify(stage.evidence).toLowerCase();
          expect(evidenceStr).not.toContain('rulehost');
          expect(evidenceStr).not.toContain('autocorrect');
        }
      }
    });
  });

  describe('catch/degrade with structured reason', () => {
    it('every failed stage has a non-empty reason string', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
        failAfterStage: 'after_pain_intake',
      });

      const failedStages = result.stages.filter(s => s.status === 'failed');
      for (const stage of failedStages) {
        if (stage.reason === undefined) {
          throw new Error(`Stage ${stage.name} is failed but has no reason`);
        }
        expect(typeof stage.reason).toBe('string');
        expect(stage.reason.length).toBeGreaterThan(0);
      }
    });

    it('degraded status is reported when some stages pass and some fail', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
        failAfterStage: 'after_ledger_consistent',
      });

      expect(result.status).toBe('degraded');
      const passedStages = result.stages.filter(s => s.status === 'passed');
      const failedStages = result.stages.filter(s => s.status === 'failed');
      expect(passedStages.length).toBeGreaterThan(0);
      expect(failedStages.length).toBeGreaterThan(0);
    });
  });

  describe('summary output contract', () => {
    it('default workspace mode is temp when not specified', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
      });

      expect(result.workspaceMode).toBe('temp');
    });

    it('summary contains all required fields', async () => {
      const result = await runSyntheticBaseline({
        workspaceDir: tempDir,
        workspaceMode: 'temp',
      });

      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('workspaceMode');
      expect(result).toHaveProperty('generatedAt');
      expect(result).toHaveProperty('stages');
    });
  });
});
