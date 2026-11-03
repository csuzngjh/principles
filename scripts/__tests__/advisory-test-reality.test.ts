// PRI-965: the failure-path test advisory must run, report, and never fail on
// findings. It is a reminder for the EP-09 invariant, not a gate.

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

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-advisory-test-reality-'));
  roots.push(root);
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  return root;
}

function commitAll(root: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', message, '--no-verify'], { cwd: root });
}

function makeAllRepo(): string {
  const root = initRepo();
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tests', 'sample.test.ts'),
    [
      "it('bare throw', () => {",
      "  expect(() => parse('bad')).toThrow();",
      '});',
      '',
      "it('named matcher', () => {",
      "  expect(() => parse('bad')).toThrow('bad-input');",
      '});',
      '',
      "it('multi-line matcher', () => {",
      "  expect(() => parse('bad')).toThrow(",
      "    'bad-input',",
      '  );',
      '});',
      '',
      "it('generic Error instance', () => {",
      "  expect(() => parse('bad')).toThrow(new Error());",
      '});',
      '',
      "it('generic no-call', () => {",
      '  expect(fn).not.toHaveBeenCalled();',
      '});',
      '',
      "it('named spy', () => {",
      '  expect(writeSpy).not.toHaveBeenCalled();',
      '});',
      '',
      "it('with is not bare', () => {",
      "  expect(fn).not.toHaveBeenCalledWith('x');",
      '});',
      '',
      "it('times is not bare', () => {",
      '  expect(fn).not.toHaveBeenCalledTimes(2);',
      '});',
      '',
      "it('positive vi call is not flagged', () => {",
      '  expect(vi.fn()).toHaveBeenCalled();',
      '});',
      '',
      "it('inline vi not called', () => {",
      '  expect(vi.fn()).not.toHaveBeenCalled();',
      '});',
      '',
      "it('fixture strings and comments are not assertions', () => {",
      "  // expect(() => parse('bad')).toThrow();",
      '  const fixture = "expect(() => parse(\'bad\')).toThrow();";',
      '});',
      '',
      "it('closed block comment prefix is still scanned', () => {",
      "  /* closed */ expect(() => parse('bad')).toThrow();",
      '});',
      '',
      "it('assertion before unclosed block comment is still scanned', () => {",
      "  expect(() => parse('bad')).toThrow(); /* opens",
      '  */',
      '});',
      '',
      "it('bare Error identifier and generic regex are not discriminators', () => {",
      "  expect(() => parse('bad')).toThrow(Error);",
      "  expect(() => parse('bad')).toThrow(/error/i);",
      '});',
      '',
    ].join('\n'),
  );
  commitAll(root, 'fixture');
  return root;
}

function makeRepoWithLines(lines: string[]): string {
  const root = initRepo();
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'sample.test.ts'), [...lines, ''].join('\n'));
  commitAll(root, 'fixture');
  return root;
}

function makeDiffRepo(): string {
  const root = initRepo();
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tests', 'diff.test.ts'),
    [
      "it('baseline', () => {",
      "  expect(() => parse('good')).not.toThrow();",
      '});',
      '',
    ].join('\n'),
  );
  commitAll(root, 'base');
  fs.appendFileSync(
    path.join(root, 'tests', 'diff.test.ts'),
    [
      "it('adds failure', () => {",
      "  expect(() => parse('bad')).toThrow();",
      '});',
      '',
    ].join('\n'),
  );
  commitAll(root, 'adds failure');
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
  it('reports only real bare/generic assertions, including multi-line handling', () => {
    const root = makeAllRepo();
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--all', '--json'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      assertions: number;
      files: number;
      items: Array<{ path: string; line: number; kind: string; assertion: string }>;
    };
    expect(report.assertions).toBe(8);
    expect(report.files).toBe(1);
    expect(report.items.filter((item) => item.kind === 'bare-toThrow')).toHaveLength(6);
    expect(report.items.filter((item) => item.kind === 'generic-no-call')).toHaveLength(2);
    expect(report.items.map((item) => item.assertion)).toEqual(
      expect.arrayContaining([
        "expect(() => parse('bad')).toThrow();",
        "expect(() => parse('bad')).toThrow(new Error());",
        'expect(fn).not.toHaveBeenCalled();',
        'expect(vi.fn()).not.toHaveBeenCalled();',
        "/* closed */ expect(() => parse('bad')).toThrow();",
        "expect(() => parse('bad')).toThrow(); /* opens",
        "expect(() => parse('bad')).toThrow(Error);",
        "expect(() => parse('bad')).toThrow(/error/i);",
      ]),
    );
  });

  it('still reports an assertion after a closed block comment prefix', () => {
    const root = makeRepoWithLines([
      "it('closed prefix', () => {",
      "  /* closed */ expect(() => parse('bad')).toThrow();",
      '});',
    ]);
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--all', '--json'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { assertions: number; items: Array<{ assertion: string }> };
    expect(report.assertions).toBe(1);
    expect(report.items[0]?.assertion).toContain('/* closed */');
  });

  it('still reports an assertion before an unclosed block comment opener', () => {
    const root = makeRepoWithLines([
      "it('unclosed opener', () => {",
      "  expect(() => parse('bad')).toThrow(); /* opens",
      '  */',
      '});',
    ]);
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--all', '--json'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { assertions: number; items: Array<{ assertion: string }> };
    expect(report.assertions).toBe(1);
    expect(report.items[0]?.assertion).toContain('/* opens');
  });

  it('treats bare Error and /error/i as non-discriminators', () => {
    const root = makeRepoWithLines([
      "it('generic errors', () => {",
      "  expect(() => parse('bad')).toThrow(Error);",
      "  expect(() => parse('bad')).toThrow(/error/i);",
      '});',
    ]);
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--all', '--json'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { assertions: number; items: Array<{ assertion: string }> };
    expect(report.assertions).toBe(2);
    expect(report.items.map((item) => item.assertion)).toEqual(
      expect.arrayContaining([
        "expect(() => parse('bad')).toThrow(Error);",
        "expect(() => parse('bad')).toThrow(/error/i);",
      ]),
    );
  });

  it('scans a --base diff and only reports added lines', () => {
    const root = makeDiffRepo();
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--base', 'HEAD~1', '--json'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      assertions: number;
      items: Array<{ line: number }>;
    };
    expect(report.assertions).toBe(1);
    expect(report.items[0]?.line).toBe(5);
  });

  it('fails loudly on an unknown argument', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });

  it('fails loudly when the root is not a git checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-advisory-not-git-'));
    roots.push(root);
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--all', '--json'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot scan');
  });

  it('PR template carries the production-input + positive-control obligation', () => {
    const template = fs.readFileSync(path.join(REPO_ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
    expect(template).toContain('positive control');
    expect(template).toContain('生产');
    expect(template).toContain('non-blocking');
  });
});
