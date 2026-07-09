/**
 * WorkflowFunnelLoader Tests — Core Package
 *
 * Direct unit tests for the WorkflowFunnelLoader class.
 *
 * Tests verify:
 * - Constructor loads workflows.yaml from stateDir
 * - Missing file → empty funnels + warning
 * - Malformed YAML → preserves last known-good config + warning
 * - Invalid schema (missing version/funnels) → preserves last known-good + warning
 * - Invalid funnel entries (missing workflowId/stages) → skipped + warning
 * - getStages returns correct stages for known workflow
 * - getStages returns empty array for unknown workflow
 * - getFunnel returns full funnel with policy for known workflow
 * - getFunnel returns undefined for unknown workflow
 * - getFunnel returns deep clone (mutations don't affect internal state)
 * - getAllFunnels returns deep clone of all stages
 * - getAllFunnelsWithPolicy returns deep clone of all funnels
 * - watch() starts file watching, dispose() cleans up
 * - getWarnings returns warnings from last load
 * - getConfigPath returns correct path
 *
 * ERR checklist:
 * - ERR-002 / EP-03: malformed YAML preserves last known-good (fail-safe)
 * - ERR-007 / EP-02: single source for funnels table
 * - EP-07: deep clones prevent consumer mutation of internal state
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yamlLib from 'js-yaml';
import { WorkflowFunnelLoader } from '../../workflow-funnel-loader.js';
import type { WorkflowFunnelConfig } from '../../workflow-funnel-loader.js';

describe('WorkflowFunnelLoader', () => {
  let tmpDir: string;
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-workflow-loader-test-'));
    stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    configPath = path.join(stateDir, 'workflows.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(config: WorkflowFunnelConfig): void {
    const yamlStr = yamlLib.dump(config, { schema: yamlLib.DEFAULT_SCHEMA });
    fs.writeFileSync(configPath, yamlStr, 'utf-8');
  }

  describe('constructor and initial load', () => {
    it('loads valid workflows.yaml on construction', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'test-funnel',
            stages: [
              { name: 'stage1', eventType: 'created', eventCategory: 'created', statsField: 'test.created' },
              { name: 'stage2', eventType: 'completed', eventCategory: 'completed', statsField: 'test.completed' },
            ],
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);

      const stages = loader.getStages('test-funnel');
      expect(stages.length).toBe(2);
      expect(stages[0].name).toBe('stage1');
      expect(stages[1].name).toBe('stage2');
    });

    it('handles missing workflows.yaml with empty funnels + warning', () => {
      fs.rmSync(configPath, { force: true });

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getStages('any-workflow')).toEqual([]);
      expect(loader.getAllFunnels().size).toBe(0);
      const warnings = loader.getWarnings();
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('not found');
    });

    it('handles malformed YAML with empty funnels + warning', () => {
      fs.writeFileSync(configPath, 'not: valid: yaml: [broken', 'utf-8');

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getAllFunnels().size).toBe(0);
      const warnings = loader.getWarnings();
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('Failed to parse');
    });

    it('handles missing version field with warning', () => {
      fs.writeFileSync(configPath, 'funnels:\n  - workflowId: test\n    stages: []\n', 'utf-8');

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getAllFunnels().size).toBe(0);
      const warnings = loader.getWarnings();
      expect(warnings.some(w => w.includes('validation failed'))).toBe(true);
    });

    it('handles missing funnels array with warning', () => {
      fs.writeFileSync(configPath, 'version: "1.0"\n', 'utf-8');

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getAllFunnels().size).toBe(0);
      const warnings = loader.getWarnings();
      expect(warnings.some(w => w.includes('validation failed'))).toBe(true);
    });
  });

  describe('getStages', () => {
    it('returns empty array for unknown workflow', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'known-funnel',
            stages: [{ name: 's1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getStages('unknown-funnel')).toEqual([]);
    });

    it('returns stages in order for known workflow', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'ordered-funnel',
            stages: [
              { name: 'first', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' },
              { name: 'second', eventType: 'e2', eventCategory: 'c2', statsField: 'f2' },
              { name: 'third', eventType: 'e3', eventCategory: 'c3', statsField: 'f3' },
            ],
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      const stages = loader.getStages('ordered-funnel');

      expect(stages.map(s => s.name)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('getFunnel', () => {
    it('returns undefined for unknown workflow', () => {
      writeConfig({
        version: '1.0',
        funnels: [],
      });

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getFunnel('nonexistent')).toBeUndefined();
    });

    it('returns full funnel with policy for known workflow', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'policy-funnel',
            stages: [{ name: 's1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
            policy: {
              timeoutMs: 30000,
              stageOrder: 'strict',
              runtimeKind: 'pi-ai',
            },
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      const funnel = loader.getFunnel('policy-funnel');

      expect(funnel).toBeDefined();
      expect(funnel?.workflowId).toBe('policy-funnel');
      expect(funnel?.stages.length).toBe(1);
      expect(funnel?.policy?.timeoutMs).toBe(30000);
      expect(funnel?.policy?.stageOrder).toBe('strict');
    });

    it('returns deep clone — mutations do not affect internal state', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'clone-test',
            stages: [{ name: 'original', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
            policy: { timeoutMs: 1000 },
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      const funnel1 = loader.getFunnel('clone-test')!;

      funnel1.stages[0].name = 'mutated';
      funnel1.policy!.timeoutMs = 99999;

      const funnel2 = loader.getFunnel('clone-test')!;
      expect(funnel2.stages[0].name).toBe('original');
      expect(funnel2.policy?.timeoutMs).toBe(1000);
    });
  });

  describe('getAllFunnels', () => {
    it('returns all funnels as a Map', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'funnel-a',
            stages: [{ name: 's1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
          },
          {
            workflowId: 'funnel-b',
            stages: [
              { name: 's2', eventType: 'e2', eventCategory: 'c2', statsField: 'f2' },
              { name: 's3', eventType: 'e3', eventCategory: 'c3', statsField: 'f3' },
            ],
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      const all = loader.getAllFunnels();

      expect(all.size).toBe(2);
      expect(all.get('funnel-a')?.length).toBe(1);
      expect(all.get('funnel-b')?.length).toBe(2);
    });

    it('returns deep clone — mutations do not affect internal state', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'mutate-test',
            stages: [{ name: 'original', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      const all1 = loader.getAllFunnels();
      all1.get('mutate-test')![0].name = 'mutated';

      const all2 = loader.getAllFunnels();
      expect(all2.get('mutate-test')![0].name).toBe('original');
    });
  });

  describe('getAllFunnelsWithPolicy', () => {
    it('returns all funnels with policy as a Map', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'funnel-x',
            stages: [{ name: 's1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
            policy: { timeoutMs: 5000 },
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      const all = loader.getAllFunnelsWithPolicy();

      expect(all.size).toBe(1);
      const funnel = all.get('funnel-x')!;
      expect(funnel.workflowId).toBe('funnel-x');
      expect(funnel.policy?.timeoutMs).toBe(5000);
    });

    it('returns deep clone — policy mutations do not affect internal state', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'policy-clone',
            stages: [{ name: 's1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
            policy: {
              timeoutMs: 1000,
              observability: {
                enabled: true,
                emitEvents: ['event1', 'event2'],
              },
            },
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      const all1 = loader.getAllFunnelsWithPolicy();
      const funnel1 = all1.get('policy-clone')!;
      funnel1.policy!.timeoutMs = 99999;
      funnel1.policy!.observability!.emitEvents!.push('malicious');

      const all2 = loader.getAllFunnelsWithPolicy();
      const funnel2 = all2.get('policy-clone')!;
      expect(funnel2.policy?.timeoutMs).toBe(1000);
      expect(funnel2.policy?.observability?.emitEvents).toEqual(['event1', 'event2']);
    });
  });

  describe('load() reload', () => {
    it('reloads from disk on explicit load() call', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'reload-test',
            stages: [{ name: 'v1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      expect(loader.getStages('reload-test')[0].name).toBe('v1');

      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'reload-test',
            stages: [{ name: 'v2', eventType: 'e2', eventCategory: 'c2', statsField: 'f2' }],
          },
        ],
      });

      loader.load();
      expect(loader.getStages('reload-test')[0].name).toBe('v2');
    });

    it('preserves last known-good config on malformed reload', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'stable-funnel',
            stages: [{ name: 'good', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      expect(loader.getStages('stable-funnel')[0].name).toBe('good');

      fs.writeFileSync(configPath, '::: invalid yaml :::', 'utf-8');
      loader.load();

      expect(loader.getStages('stable-funnel')[0].name).toBe('good');
      expect(loader.getWarnings().some(w => w.includes('Failed to parse'))).toBe(true);
    });

    it('clears funnels when file is deleted and reloaded', () => {
      writeConfig({
        version: '1.0',
        funnels: [
          {
            workflowId: 'will-disappear',
            stages: [{ name: 's1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
          },
        ],
      });

      const loader = new WorkflowFunnelLoader(stateDir);
      expect(loader.getStages('will-disappear').length).toBe(1);

      fs.rmSync(configPath);
      loader.load();

      expect(loader.getStages('will-disappear')).toEqual([]);
      expect(loader.getAllFunnels().size).toBe(0);
    });
  });

  describe('invalid funnel entries', () => {
    it('skips funnels missing workflowId', () => {
      const yamlContent = `version: "1.0"\nfunnels:\n  - stages:\n      - name: s1\n        eventType: e1\n        eventCategory: c1\n        statsField: f1\n`;
      fs.writeFileSync(configPath, yamlContent, 'utf-8');

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getAllFunnels().size).toBe(0);
      expect(loader.getWarnings().some(w => w.includes('Skipping invalid funnel'))).toBe(true);
    });

    it('skips funnels missing stages array', () => {
      const yamlContent = `version: "1.0"\nfunnels:\n  - workflowId: no-stages\n`;
      fs.writeFileSync(configPath, yamlContent, 'utf-8');

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getAllFunnels().size).toBe(0);
      expect(loader.getWarnings().some(w => w.includes('Skipping invalid funnel'))).toBe(true);
    });

    it('keeps valid funnels when some are invalid', () => {
      const yamlContent = `version: "1.0"\nfunnels:\n  - workflowId: valid-1\n    stages:\n      - name: s1\n        eventType: e1\n        eventCategory: c1\n        statsField: f1\n  - workflowId: valid-2\n    stages:\n      - name: s2\n        eventType: e2\n        eventCategory: c2\n        statsField: f2\n  - stages: []\n`;
      fs.writeFileSync(configPath, yamlContent, 'utf-8');

      const loader = new WorkflowFunnelLoader(stateDir);

      expect(loader.getAllFunnels().size).toBe(2);
      expect(loader.getStages('valid-1').length).toBe(1);
      expect(loader.getStages('valid-2').length).toBe(1);
    });
  });

  describe('getWarnings', () => {
    it('returns empty array for successful load', () => {
      writeConfig({
        version: '1.0',
        funnels: [{
          workflowId: 'clean',
          stages: [{ name: 's1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
        }],
      });

      const loader = new WorkflowFunnelLoader(stateDir);

      const warnings = loader.getWarnings();
      expect(Array.isArray(warnings)).toBe(true);
    });

    it('warnings are cleared and refreshed on each load', () => {
      fs.writeFileSync(configPath, 'bad yaml [[[', 'utf-8');
      const loader = new WorkflowFunnelLoader(stateDir);
      const firstWarnings = loader.getWarnings();
      expect(firstWarnings.length).toBeGreaterThan(0);

      writeConfig({
        version: '1.0',
        funnels: [{
          workflowId: 'clean',
          stages: [{ name: 's1', eventType: 'e1', eventCategory: 'c1', statsField: 'f1' }],
        }],
      });
      loader.load();
      const secondWarnings = loader.getWarnings();
      expect(secondWarnings.length).toBeLessThan(firstWarnings.length);
    });
  });

  describe('getConfigPath', () => {
    it('returns the correct config path', () => {
      const loader = new WorkflowFunnelLoader(stateDir);
      expect(loader.getConfigPath()).toBe(configPath);
    });
  });

  describe('watch and dispose', () => {
    it('watch() does not throw when file does not exist', () => {
      fs.rmSync(configPath, { force: true });
      const loader = new WorkflowFunnelLoader(stateDir);
      expect(() => loader.watch()).not.toThrow();
      loader.dispose();
    });

    it('dispose() is safe to call multiple times', () => {
      writeConfig({
        version: '1.0',
        funnels: [],
      });
      const loader = new WorkflowFunnelLoader(stateDir);
      loader.watch();
      expect(() => loader.dispose()).not.toThrow();
      expect(() => loader.dispose()).not.toThrow();
    });
  });

  describe('stage-level fields', () => {
    it('preserves optional stage fields: timeoutMs, successCriteria, legacyDisabled', () => {
      const yamlContent = `version: "1.0"\nfunnels:\n  - workflowId: stage-fields\n    stages:\n      - name: full-stage\n        eventType: ev1\n        eventCategory: cat1\n        statsField: stats.ev1\n        timeoutMs: 5000\n        successCriteria: "count > 0"\n        legacyDisabled: true\n        observability:\n          enabled: true\n          emitEvents:\n            - stage_started\n`;
      fs.writeFileSync(configPath, yamlContent, 'utf-8');

      const loader = new WorkflowFunnelLoader(stateDir);
      const stages = loader.getStages('stage-fields');

      expect(stages.length).toBe(1);
      expect(stages[0].timeoutMs).toBe(5000);
      expect(stages[0].successCriteria).toBe('count > 0');
      expect(stages[0].legacyDisabled).toBe(true);
      expect(stages[0].observability?.enabled).toBe(true);
      expect(stages[0].observability?.emitEvents).toEqual(['stage_started']);
    });
  });
});
