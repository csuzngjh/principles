/**
 * SEC-BASE-2: Sandbox Escape Regression
 *
 * Documents known vm escape payloads (Node official docs + public PoC summaries)
 * and asserts they are blocked by either:
 *   (a) checkForbiddenPatterns (static layer), OR
 *   (b) sandbox execution boundary (runtime layer — subprocess spawnSync)
 *
 * These tests are NON-EXHAUSTIVE — they cover canonical escape patterns,
 * not all possible exploits. The defense is layered; this file is the
 * regression net for documented patterns.
 *
 * Reference: https://nodejs.org/api/vm.html — "The node:vm module is not a
 * security mechanism. Do not use it to run untrusted code."
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkForbiddenPatterns } from '../../../principles-core/src/runtime-v2/internalization/rule-code-validator.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUNTIME_SOURCE_PATH = join(
  REPO_ROOT,
  'packages',
  'openclaw-plugin',
  'src',
  'core',
  'rule-implementation-runtime.ts',
);

describe('SEC-BASE-2: sandbox escape regression', () => {
  describe('static layer — checkForbiddenPatterns blocks escape primitives', () => {
    const ESCAPE_PAYLOADS = [
      // Node official docs example: this.constructor.constructor('return process')()
      { name: 'constructor chain to process', code: 'const p = this.constructor.constructor("return process")(); p.exit(0);' },
      // globalThis access
      { name: 'globalThis access', code: 'const g = globalThis; g.process.exit(0);' },
      // import.meta (post-SEC-BASE-2 upgrade)
      { name: 'import.meta', code: 'const u = import.meta.url;' },
      // WeakRef / FinalizationRegistry (post-SEC-BASE-2 upgrade)
      { name: 'WeakRef', code: 'const r = new WeakRef({});' },
      { name: 'FinalizationRegistry', code: 'new FinalizationRegistry(() => {});' },
      // SharedArrayBuffer / Atomics (post-SEC-BASE-2 upgrade)
      { name: 'SharedArrayBuffer', code: 'new SharedArrayBuffer(8);' },
      { name: 'Atomics', code: 'Atomics.load(new Int32Array(1), 0);' },
      // Reflect / Proxy (existing — PRI-439 Phase 2)
      { name: 'Reflect.construct', code: 'Reflect.construct(Function, ["return process"])();' },
      { name: 'Proxy', code: 'const p = new Proxy({}, { get: () => process });' },
      // require / import (existing)
      { name: 'require', code: 'require("child_process").execSync("id");' },
      { name: 'import', code: 'import fs from "fs";' },
      // eval / Function (existing)
      { name: 'eval', code: 'eval("process.exit(0)");' },
      { name: 'Function constructor', code: 'Function("return process")().exit(0);' },
      // Bracket access evasion
      { name: 'bracket access to process', code: 'const p = globalThis["process"]; p.exit(0);' },
      { name: 'bracket access to WeakRef', code: 'const W = globalThis["WeakRef"]; new W({});' },
    ];

    for (const { name, code } of ESCAPE_PAYLOADS) {
      test(`static layer blocks: ${name}`, () => {
        const labels = checkForbiddenPatterns(code);
        expect(labels.length, `expected at least one forbidden pattern to match for: ${name}`).toBeGreaterThan(0);
      });
    }
  });

  describe('subprocess boundary — rule-implementation-runtime.ts source guards', () => {
    // These tests guard against accidental refactor that removes the
    // subprocess boundary. They read the source file and assert the
    // canonical boundary markers exist. Runtime behavior tests live
    // in rule-implementation-runtime.test.ts (not this file).

    test('uses spawnSync (not direct eval in host process)', () => {
      const source = readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
      expect(source).toContain('spawnSync');
    });

    test('uses --max-old-space-size=32 (bounded child memory)', () => {
      const source = readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
      expect(source).toContain('--max-old-space-size=32');
    });

    test('uses windowsHide: true (no window flash on Windows)', () => {
      const source = readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
      expect(source).toContain('windowsHide: true');
    });

    test('uses maxBuffer (bounded child output)', () => {
      const source = readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
      expect(source).toContain('maxBuffer');
    });

    test('uses timeout (bounded child wall-clock)', () => {
      const source = readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
      expect(source).toMatch(/timeout:\s*\w+/);
    });

    test('uses vm.createContext with Object.create(null) (no prototype chain)', () => {
      const source = readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
      expect(source).toContain('Object.create(null)');
    });

    test('uses runInContext with timeout (bounded vm execution)', () => {
      const source = readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
      expect(source).toMatch(/runInContext\([^)]*timeout/);
    });
  });

  describe('residual risk declaration', () => {
    // This test exists to make the residual risk explicit in test output.
    // It is always-pass — its purpose is documentation, not assertion.

    test('documents accepted residual risk: node:vm 0day V8 escape', () => {
      const residualRisk = `
        RESIDUAL RISK (SEC-BASE-2):
        node:vm is NOT a security sandbox (Node.js official statement).
        PD uses three-layer defense:
          1. Static: checkForbiddenPatterns blocks known escape primitives
          2. VM: createContext(Object.create(null)) + runInContext(timeout)
          3. Subprocess: spawnSync with bounded memory/time/output
        Residual risk = 0day V8 escape using an unknown primitive.
        MVP accepts this residual risk. Post-MVP mitigation: isolated-vm migration.
        See docs/architecture/SECURITY_BASELINE.md §2.1.
      `;
      expect(residualRisk.length).toBeGreaterThan(0);
    });
  });
});
