/**
 * The installer payload carries a SUBSET of the principle-learning-lab under
 * `console/lab`. This test owns the two failure modes that would otherwise
 * surface only as an installed console answering 503:
 *
 *   1. the console mentions a lab module by name that the closure forgot, and
 *   2. the closure is too wide — research/transport modules that read secrets
 *      from the user's home directory must never reach a user machine.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB_ENTRY_MODULES, collectLabModuleClosure } from '../build/lab-payload.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const labRoot = path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab');
const consoleRoutes = [
  path.join(repoRoot, 'packages', 'pd-console', 'src', 'server', 'routes', 'examiner.ts'),
  path.join(repoRoot, 'packages', 'pd-console', 'src', 'server', 'routes', 'examiner-executor.ts'),
];

describe('installer lab payload closure', () => {
  const closure: string[] = collectLabModuleClosure(labRoot);

  it('resolves every module inside the lab lib', () => {
    expect(closure.length).toBeGreaterThan(0);
    for (const rel of closure) {
      expect(rel.startsWith('lib/')).toBe(true);
      expect(fs.existsSync(path.join(labRoot, rel))).toBe(true);
    }
    expect(new Set(closure).size).toBe(closure.length);
  });

  it('contains every lab module the console route layer names', () => {
    const named = new Set<string>();
    for (const file of consoleRoutes) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/([A-Za-z0-9._-]+\.mjs)/g)) {
        if (match[1]) named.add(match[1]);
      }
    }
    expect(named.size).toBeGreaterThan(0);
    for (const moduleName of named) {
      expect(closure).toContain(`lib/${moduleName}`);
    }
    for (const entry of LAB_ENTRY_MODULES) {
      expect(closure).toContain(entry);
    }
  });

  it('ships no test material and no secret-reading research transports', () => {
    for (const rel of closure) {
      expect(rel).not.toContain('__tests__');
      expect(rel).not.toMatch(/\.test\.[a-z]+$/);
    }
    // challenge-amd-transport reads API keys from the operator's home dir.
    expect(closure).not.toContain('lib/challenge-amd-transport.mjs');
  });

  it('fails loud on a missing module or an import escaping lib/', () => {
    const emptyLab = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lab-empty-'));
    expect(() => collectLabModuleClosure(emptyLab)).toThrow(/lab module not found/);

    const escapingLab = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lab-escape-'));
    fs.mkdirSync(path.join(escapingLab, 'lib'));
    fs.writeFileSync(path.join(escapingLab, 'lib', 'examiner-study.mjs'), "import x from '../outside.mjs';\n");
    fs.writeFileSync(path.join(escapingLab, 'outside.mjs'), 'export const x = 1;\n');
    expect(() => collectLabModuleClosure(escapingLab)).toThrow(/imports outside lib\//);

    fs.rmSync(emptyLab, { recursive: true, force: true });
    fs.rmSync(escapingLab, { recursive: true, force: true });
  });
});
