/**
 * PRI-711 — post-apply CLI smoke (runPostUpdateCliSmoke).
 *
 * Real subprocess tests: the smoke's whole purpose is to detect a pd CLI
 * whose eager import graph cannot resolve (the failure mode of the 1.231.2
 * update, where `pd console open` died with ERR_MODULE_NOT_FOUND from inside
 * codex-adapter). The broken case below reproduces that exact signature
 * against a real Node subprocess — no mocks — and the ok case proves a clean
 * exit surfaces the CLI's version line.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPostUpdateCliSmoke } from '../../src/server/utils/cli-smoke.js';

function makeCli(distEntrySource: string): string {
  const pdCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-smoke-'));
  fs.mkdirSync(path.join(pdCliDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pdCliDir, 'dist', 'index.js'), distEntrySource);
  return pdCliDir;
}

describe('runPostUpdateCliSmoke', () => {
  it('returns ok with the CLI version line when the updated CLI starts cleanly', () => {
    const pdCliDir = makeCli("console.log('9.9.9-test');\n");
    try {
      const result = runPostUpdateCliSmoke(pdCliDir);
      expect(result).toEqual({ ok: true, version: '9.9.9-test' });
    } finally {
      fs.rmSync(pdCliDir, { recursive: true, force: true });
    }
  });

  it('fails with a bounded stderr tail when the import graph cannot resolve (1.231.2 signature)', () => {
    const pdCliDir = makeCli(
      "import '@principles/host-runtime';\n" +
      "throw new Error(\"Cannot find package '@principles/host-runtime' imported from \" + import.meta.url);\n",
    );
    try {
      const result = runPostUpdateCliSmoke(pdCliDir);
      if (result.ok) throw new Error('expected the smoke to fail for a broken CLI');
      // The bounded extract carries the error MESSAGE (stderr head), not the
      // stack-tail noise that follows it.
      expect(result.error).toContain('host-runtime');
      expect(result.error.length).toBeLessThanOrEqual(400);
    } finally {
      fs.rmSync(pdCliDir, { recursive: true, force: true });
    }
  });

  it('fails with a structured reason when the CLI entry does not exist', () => {
    const pdCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-smoke-empty-'));
    try {
      const result = runPostUpdateCliSmoke(pdCliDir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('entry not found');
    } finally {
      fs.rmSync(pdCliDir, { recursive: true, force: true });
    }
  });
});
