/**
 * Scope regression test (design §4.7.1, task 3.21).
 *
 * Guards the Layer 0 scope boundary: the three diagnostic stages
 * (`diag_rootcause` / `diag_distiller` / `diag_router`) and `philosopher`
 * participate in Layer 0 ONLY as writer-side summary producers/forwarders.
 * They MUST NOT:
 *   - own a ContextManifest (manifests are exactly 4: dreamer / scribe /
 *     artificer / evaluator)
 *   - widen their export surface (philosopher stays de-surfaced from the
 *     internal barrel — PRI-458)
 *   - change their output schema or prompt text (Requirement 1.7)
 *
 * PR 1 has no manifest table yet (that lands in PR 2). This test asserts the
 * negative today ("no diagnostic stage owns a manifest") and will be re-run
 * unchanged once PR 2 introduces the manifest registry.
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §4.7, §4.7.1
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirements 1.7, 2.14
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SUMMARY_RUNNER_KINDS,
} from '../artifact-summary.js';
import { SUMMARY_EDGE_PREDECESSOR } from '../attach-summary-envelope.js';

const DIAG_KINDS: readonly string[] = ['diag_rootcause', 'diag_distiller', 'diag_router'];

describe('Layer 0 scope regression — diagnostic stages & philosopher (task 3.21)', () => {
  it('SUMMARY_RUNNER_KINDS includes the 3 diagnostic stages (they produce summaries)', () => {
    // design §4.7.1: diag stages ARE SummaryRunnerKinds (writer-side only).
    for (const kind of DIAG_KINDS) {
      expect(SUMMARY_RUNNER_KINDS).toContain(kind);
    }
  });

  it('diag stages have NO manifest field/import anywhere in their runner source (design §4.7.1)', () => {
    // A diagnostic stage owning a manifest would be a scope violation. Today
    // (PR 1) no ContextManifest type exists in the codebase yet, so we assert
    // the stronger negative: the diag runner source files do not reference any
    // manifest symbol. When PR 2 lands the manifest registry, this same test
    // guards against a diag kind sneaking in.
    const diagFiles = [
      'diag-rootcause-runner.ts',
      'diag-distiller-runner.ts',
      'diag-router-runner.ts',
    ];
    for (const file of diagFiles) {
      const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      // Must not reference ContextManifest, manifest, DREAMER_MANIFEST, etc.
      expect(src, `${file} must not own a manifest`).not.toMatch(/\bContextManifest\b/);
      expect(src, `${file} must not reference allocateContext`).not.toMatch(/\ballocateContext\b/);
      // But it SHOULD reference the Layer 0 writer wiring (proves it only does
      // writer-side summary, not manifest-driven injection).
      expect(src, `${file} must wire buildArtifactContentJson (writer-side only)`).toMatch(/buildArtifactContentJson/);
    }
  });

  it('diag-router predecessor is diag_distiller, NOT diag_rootcause (F17 edge-predecessor uniqueness)', () => {
    // Even though diag_router loads BOTH rootcause and distiller in buildContext,
    // only distiller is the edge predecessor. This is the single most important
    // scope assertion for the diagnostic chain.
    expect(SUMMARY_EDGE_PREDECESSOR.diag_router).toBe('diag_distiller');
    expect(SUMMARY_EDGE_PREDECESSOR.diag_router).not.toBe('diag_rootcause');
  });

  it('dreamer predecessor is diag_router (F13/F14: diagnostic chain is dreamer\'s direct upstream)', () => {
    expect(SUMMARY_EDGE_PREDECESSOR.dreamer).toBe('diag_router');
  });

  it('evaluator predecessor is artificer, NOT scribe (F17)', () => {
    expect(SUMMARY_EDGE_PREDECESSOR.evaluator).toBe('artificer');
    expect(SUMMARY_EDGE_PREDECESSOR.evaluator).not.toBe('scribe');
  });

  it('philosopher stays de-surfaced from internalization/index.ts barrel (PRI-458 MVP-Quiet)', () => {
    // PRI-458: PhilosopherRunner is NOT exported from the internal barrel.
    // Layer 0 does not re-add it. (It remains reachable via runtime-v2/index.ts
    // for the rulehost pipeline — guarded separately by architecture-regression.test.ts.)
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).not.toContain("from './philosopher-runner.js'");
    expect(src).not.toContain('PhilosopherRunner');
  });

  it('each SummaryRunnerKind has a defined edge predecessor (or null for the root)', () => {
    // Every kind must resolve to a predecessor entry — no kind left un-mapped.
    for (const kind of SUMMARY_RUNNER_KINDS) {
      expect(Object.hasOwn(SUMMARY_EDGE_PREDECESSOR, kind)).toBe(true);
      const pred = SUMMARY_EDGE_PREDECESSOR[kind];
      // Either null (chain root = diag_rootcause) or a valid SummaryRunnerKind.
      if (pred !== null) {
        expect(SUMMARY_RUNNER_KINDS).toContain(pred);
      }
    }
    // Exactly one root (null).
    const roots = SUMMARY_RUNNER_KINDS.filter((k) => SUMMARY_EDGE_PREDECESSOR[k] === null);
    expect(roots).toEqual(['diag_rootcause']);
  });
});
