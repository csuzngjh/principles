// PRI-965: the failure-path test advisory must run, report, and never fail
// the build. It is a reminder for the EP-09 invariant, not a gate.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'dev', 'advisory-test-reality.mjs');

const roots: string[] = [];

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-advisory-test-reality-'));
  roots.push(root);
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tests', 'sample.test.ts'),
    [
      "it('bare throw has no branch marker', () => {",
      "  expect(() => parse('bad')).toThrow();",
      '});',
      '',
      "it('named matcher is a branch marker', () => {",
      "  expect(() => parse('bad')).toThrow('bad-input');",
      '});',
      '',
      "it('generic no-call has no spy marker', () => {",
      '  expect(fn).not.toHaveBeenCalled();',
      '});',
      '',
      "it('named spy is a marker', () => {",
      '  expect(writeSpy).not.toHaveBeenCalled();',
      '});',
      '',
      "it('negative control is not a failure assertion', () => {",
      "  expect(() => parse('good')).not.toThrow();",
      '});',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture', '--no-verify'], { cwd: root });
  return root;
}

afterAll(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows transient handle; OS temp cleaner owns the rest.
    }
  }
});

describe('advisory-test-reality.mjs (PRI-965)', () => {
  it('reports failure-path assertions without failing, and skips .not.toThrow', () => {
    const root = makeRepo();
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--all', '--json'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      assertions: number;
      files: number;
      items: Array<{ path: string; line: number; assertion: string }>;
    };
    expect(report.assertions).toBe(2);
    expect(report.files).toBe(1);
    expect(report.items.map((item) => item.line).sort((a, b) => a - b)).toEqual([2, 10]);
    expect(report.items.map((item) => item.assertion)).toEqual(
      expect.arrayContaining([
        "expect(() => parse('bad')).toThrow();",
        'expect(fn).not.toHaveBeenCalled();',
      ]),
    );
  });

  it('PR template carries the production-input + positive-control obligation', () => {
    const template = fs.readFileSync(path.join(REPO_ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
    expect(template).toContain('positive control');
    expect(template).toContain('生产');
  });
});
