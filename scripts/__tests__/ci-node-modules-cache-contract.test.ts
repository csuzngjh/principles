// Contract test for the shared `restore-node-modules` cache key.
//
// Root cause this guards against (2026-11-18): `codex-plugin-delivery` ran
// `actions/setup-node` with Node 24 but called the composite cache action with
// `node-version: '22'`, so the job restored a node_modules tree materialized
// for a different Node major. The action's `default: '22'` made the omission
// silent: any job that forgot the input silently shared the Node 22 tree.
//
// The key is `<os>-node<major>-<lockfile hash>-node-modules`, so the major is
// the ONLY thing separating ABI-incompatible trees. Two invariants keep that
// true:
//   1. every call site passes an explicit major, and it equals the same job's
//      `setup-node` major;
//   2. the action's cache key interpolates the input (a constant key would
//      silently collapse every major back into one entry).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = path.resolve(HERE, '..', '..', '.github', 'workflows');
const ACTION_FILE = path.resolve(
  HERE,
  '..',
  '..',
  '.github',
  'actions',
  'restore-node-modules',
  'action.yml',
);

const ACTION_REF = './.github/actions/restore-node-modules';
const SETUP_NODE_PREFIX = 'actions/setup-node';

interface StepDef {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface JobDef {
  name?: string;
  steps?: StepDef[];
}

function workflowFiles(): string[] {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

/** Normalise '24', 24, 'v24', '24.11.0' to the major version string. */
function majorOf(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^v/, '')
    .split('.')[0]!;
}

describe('restore-node-modules cache-key contract', () => {
  describe('the composite action itself', () => {
    const doc = load(fs.readFileSync(ACTION_FILE, 'utf8')) as {
      inputs?: Record<string, { required?: boolean; default?: unknown }>;
      runs?: { steps?: Array<{ with?: Record<string, unknown> }> };
    };

    it('requires an explicit node-version and ships no default', () => {
      const input = doc.inputs?.['node-version'];
      expect(input, 'node-version input is missing from action.yml').toBeDefined();
      expect(
        input!.required,
        'node-version must be required: a default silently shares one materialized tree across Node majors',
      ).toBe(true);
      expect(input!.default, 'node-version must not declare a default').toBeUndefined();
    });

    it('interpolates the node-version input into the cache key', () => {
      const keys = (doc.runs?.steps ?? [])
        .map((s) => s.with?.key)
        .filter((k): k is string => typeof k === 'string');
      expect(keys.length, 'no cache key found in action.yml').toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toContain('inputs.node-version');
        expect(key).toContain('runner.os');
        expect(key).toContain('hashFiles(\'package-lock.json\')');
      }
    });
  });

  describe('every workflow call site', () => {
    const violations: string[] = [];
    const callSites: string[] = [];

    for (const file of workflowFiles()) {
      const full = path.join(WORKFLOWS_DIR, file);
      const doc = load(fs.readFileSync(full, 'utf8')) as { jobs?: Record<string, JobDef> } | null;
      for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
        const steps = job.steps ?? [];
        const calls = steps.filter((s) => s.uses === ACTION_REF);
        if (calls.length === 0) continue;

        const setup = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith(SETUP_NODE_PREFIX));
        const setupMajor = setup ? majorOf(setup.with?.['node-version']) : '';

        for (const call of calls) {
          callSites.push(`${file}:${jobId}`);
          const passed = majorOf(call.with?.['node-version']);
          if (!passed) {
            violations.push(`${file}:${jobId} calls ${ACTION_REF} without an explicit node-version`);
            continue;
          }
          if (!setupMajor) {
            violations.push(`${file}:${jobId} has no ${SETUP_NODE_PREFIX} node-version to compare against`);
            continue;
          }
          if (passed !== setupMajor) {
            violations.push(
              `${file}:${jobId} caches as node ${passed} but runs setup-node ${setupMajor}`,
            );
          }
        }
      }
    }

    it('scans at least one call site (guards against a silently empty scan)', () => {
      expect(callSites.length).toBeGreaterThan(0);
    });

    it('each call passes a major identical to its job setup-node major', () => {
      expect(violations, violations.join('\n')).toEqual([]);
    });
  });
});
