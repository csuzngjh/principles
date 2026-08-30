import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

/**
 * Static metadata validation for composite GitHub actions.
 *
 * Why this exists (#1454): PR CI never EXECUTES composite actions, so
 * invalid action metadata ships invisibly — the first full-product train
 * died loading an action whose step contained `timeout-minutes`, a
 * workflow-only key, before a single package published. This test makes
 * the metadata itself the test subject: any composite action step key that
 * GitHub's runner would reject fails the PR here, before merge.
 *
 * Scope: every `action.yml` under the repository `.github/actions`
 * directory whose `runs.using` is `composite`. Workflow files intentionally
 * excluded (they support the full step schema, including `timeout-minutes`).
 */

const COMPOSITE_STEP_ALLOWED_KEYS = new Set([
  'name',
  'id',
  'if',
  'env',
  'uses',
  'with',
  'run',
  'shell',
  'working-directory',
  'continue-on-error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function listActionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listActionFiles(p));
    else if (entry.name === 'action.yml' || entry.name === 'action.yaml') out.push(p);
  }
  return out;
}

type Violation = { file: string; problem: string };

function validateCompositeAction(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  let doc: unknown;
  try {
    doc = load(text);
  } catch (error) {
    return [{ file, problem: `YAML parse error: ${error instanceof Error ? error.message : String(error)}` }];
  }
  if (!isRecord(doc) || !isRecord(doc.runs)) {
    return [{ file, problem: 'missing runs section' }];
  }
  if (doc.runs.using !== 'composite') return violations; // different schema, not covered here
  if (!Array.isArray(doc.runs.steps)) {
    return [{ file, problem: 'runs.steps is not an array' }];
  }
  doc.runs.steps.forEach((step: unknown, index: number) => {
    if (!isRecord(step)) {
      violations.push({ file, problem: `step ${index + 1} is not a mapping` });
      return;
    }
    const label = `step ${index + 1} (${String(step.name ?? 'unnamed')})`;
    for (const key of Object.keys(step)) {
      if (!COMPOSITE_STEP_ALLOWED_KEYS.has(key)) {
        violations.push({ file, problem: `${label}: unsupported key "${key}"` });
      }
    }
  });
  return violations;
}

describe('composite action metadata', () => {
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testsDir, '..', '..', '..');
  const actionsDir = path.join(repoRoot, '.github', 'actions');
  const actionFiles = listActionFiles(actionsDir);

  it('discovers at least one composite action (guard against silent skip)', () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('composite action steps use only runner-supported keys', () => {
    const violations: Violation[] = [];
    for (const file of actionFiles) {
      violations.push(...validateCompositeAction(file, fs.readFileSync(file, 'utf8')));
    }
    expect(
      violations,
      `invalid composite action metadata:\n${violations.map((v) => `${v.file}: ${v.problem}`).join('\n')}`,
    ).toEqual([]);
  });

  it('rejects the #1454 failure shape (timeout-minutes inside a composite step)', () => {
    // Negative control: the exact metadata that killed the first full-product
    // train must be reported as a violation by the same validator.
    const bad = `
runs:
  using: composite
  steps:
    - name: bounded
      continue-on-error: true
      timeout-minutes: 25
      shell: bash
      run: echo hi
`;
    const violations = validateCompositeAction('in-memory/action.yml', bad);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain('timeout-minutes');
  });
});
