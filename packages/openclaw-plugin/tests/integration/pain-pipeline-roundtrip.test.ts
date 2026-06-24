/**
 * PRI-453: Pain pipeline round-trip invariant tests.
 *
 * Verifies that the rewired dual-track pain writes maintain pipeline
 * completeness and interface contract consistency. Uses static source
 * code analysis (same pattern as runtime-v2-pain-guard.test.ts).
 *
 * Invariants verified:
 * 1. Hook paths with legacy writers pass `recordObservability: false`
 *    to avoid triple-write (events_*.jsonl + trajectory.db + evolution.jsonl).
 * 2. Hook paths pass `canonicalPainId` to `recordPainEvent` for dedup.
 * 3. Hook paths that previously lacked `recordPainEvent` now have it
 *    (llm.ts and prompt.ts GFI path) to maintain trajectory.db coverage.
 * 4. Paths without legacy writers (gate-block-helper, lifecycle) do NOT
 *    pass `recordObservability: false` — they keep the SDK default true.
 * 5. `emitPainDetectedEvent` signature accepts optional options parameter.
 * 6. painId is generated before recordPainEvent (lineage consistency).
 * 7. Observer path uses same painId for recordPainEvent and emit (ERR-004/ERR-008).
 * 8. gate-block-helper does NOT have a legacy recordPainEvent call
 *    (SDK observability path handles all writes, avoiding double-write).
 *
 * ERR refs:
 * - ERR-004/ERR-008 (lineage consistency): same painId for trajectory + emit
 * - ERR-009 (fail-loud): tests fail if write pattern changes without update
 * - ERR-015/ERR-019 (stale loop state): canonicalPainId must be generated
 *   before recordPainEvent to ensure consistency
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function findRepoRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return cwd;
}

const repoRoot = findRepoRoot(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const AFTER_TOOL_CALL_HELPERS = 'packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts';
const LLM = 'packages/openclaw-plugin/src/hooks/llm.ts';
const PAIN = 'packages/openclaw-plugin/src/hooks/pain.ts';
const PROMPT = 'packages/openclaw-plugin/src/hooks/prompt.ts';
const GATE_BLOCK_HELPER = 'packages/openclaw-plugin/src/hooks/gate-block-helper.ts';
const LIFECYCLE = 'packages/openclaw-plugin/src/hooks/lifecycle.ts';

describe('PRI-453: Pain pipeline round-trip invariants', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 1: Hook paths with legacy writers pass recordObservability: false
  // ═══════════════════════════════════════════════════════════════════════

  describe('hook paths with legacy writers pass recordObservability: false', () => {
    it('after-tool-call-helpers.ts passes recordObservability: false', () => {
      const source = read(AFTER_TOOL_CALL_HELPERS);
      expect(source).toMatch(/\{ recordObservability: false \}/);
    });

    it('llm.ts passes recordObservability: false', () => {
      const source = read(LLM);
      expect(source).toMatch(/\{ recordObservability: false \}/);
    });

    it('pain.ts (handleManualPain) passes recordObservability: false', () => {
      const source = read(PAIN);
      expect(source).toMatch(/\{ recordObservability: false \}/);
    });

    it('prompt.ts passes recordObservability: false (both GFI and Observer paths)', () => {
      const source = read(PROMPT);
      const matches = source.match(/\{ recordObservability: false \}/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 2: Hook paths pass canonicalPainId to recordPainEvent
  // ═══════════════════════════════════════════════════════════════════════

  describe('hook paths pass canonicalPainId to recordPainEvent', () => {
    it('after-tool-call-helpers.ts passes canonicalPainId', () => {
      const source = read(AFTER_TOOL_CALL_HELPERS);
      expect(source).toMatch(/canonicalPainId:\s*painId/);
    });

    it('llm.ts passes canonicalPainId', () => {
      const source = read(LLM);
      expect(source).toMatch(/canonicalPainId:\s*painId/);
    });

    it('pain.ts (handleManualPain) passes canonicalPainId', () => {
      const source = read(PAIN);
      expect(source).toMatch(/canonicalPainId:\s*painId/);
    });

    it('prompt.ts passes canonicalPainId (both GFI and Observer paths)', () => {
      const source = read(PROMPT);
      const matches = source.match(/canonicalPainId:/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 3: Hook paths that previously lacked recordPainEvent now have it
  // ═══════════════════════════════════════════════════════════════════════

  describe('hook paths have recordPainEvent for trajectory.db coverage', () => {
    it('llm.ts calls recordPainEvent (added in PRI-453)', () => {
      const source = read(LLM);
      expect(source).toMatch(/wctx\.trajectory\?\.recordPainEvent\??\.\(/);
    });

    it('prompt.ts GFI path calls recordPainEvent (added in PRI-453)', () => {
      const source = read(PROMPT);
      // The GFI path's recordPainEvent uses gfiPainId as canonicalPainId
      expect(source).toMatch(/canonicalPainId:\s*gfiPainId/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 4: Paths without legacy writers keep SDK default (no recordObservability: false)
  // ═══════════════════════════════════════════════════════════════════════

  describe('paths without legacy writers keep SDK default true', () => {
    it('gate-block-helper.ts does NOT pass recordObservability: false', () => {
      const source = read(GATE_BLOCK_HELPER);
      expect(source).not.toMatch(/recordObservability:\s*false/);
    });

    it('lifecycle.ts does NOT pass recordObservability: false', () => {
      const source = read(LIFECYCLE);
      expect(source).not.toMatch(/recordObservability:\s*false/);
    });

    it('gate-block-helper.ts generates painId before emitPainDetectedEvent', () => {
      const source = read(GATE_BLOCK_HELPER);
      const painIdLine = source.indexOf('const gatePainId = `gate_');
      const emitLine = source.indexOf('void emitPainDetectedEvent(wctx, {');
      expect(painIdLine).toBeGreaterThan(-1);
      expect(emitLine).toBeGreaterThan(-1);
      expect(painIdLine).toBeLessThan(emitLine);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 5: emitPainDetectedEvent accepts options parameter
  // ═══════════════════════════════════════════════════════════════════════

  describe('emitPainDetectedEvent signature accepts options parameter', () => {
    it('pain.ts emitPainDetectedEvent has options parameter with recordObservability', () => {
      const source = read(PAIN);
      expect(source).toMatch(/options\?:\s*\{\s*recordObservability\?:\s*boolean\s*\}/);
      expect(source).toMatch(/options\?\.recordObservability\s*\?\?\s*true/);
    });

    it('after-tool-call-helpers.ts emitPainIfAdmitted passes options to emitPainDetectedEvent type', () => {
      const source = read(AFTER_TOOL_CALL_HELPERS);
      // The type signature should include options?: { recordObservability?: boolean }
      expect(source).toMatch(/emitPainDetectedEvent:\s*\(wctx:.*?options\?:\s*\{\s*recordObservability\?:\s*boolean\s*\}\)\s*=>\s*Promise<void>/s);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 6: painId is generated before recordPainEvent (lineage consistency)
  // ═══════════════════════════════════════════════════════════════════════

  describe('painId is generated before recordPainEvent (lineage consistency)', () => {
    it('after-tool-call-helpers.ts generates painId before recordPainEvent', () => {
      const source = read(AFTER_TOOL_CALL_HELPERS);
      const painIdLine = source.indexOf('const painId = `pain_');
      const recordPainEventLine = source.indexOf('wctx.trajectory?.recordPainEvent({');
      expect(painIdLine).toBeGreaterThan(-1);
      expect(recordPainEventLine).toBeGreaterThan(-1);
      expect(painIdLine).toBeLessThan(recordPainEventLine);
    });

    it('llm.ts generates painId before recordPainEvent', () => {
      const source = read(LLM);
      const painIdLine = source.indexOf('const painId = `llm_');
      const recordPainEventLine = source.indexOf('wctx.trajectory?.recordPainEvent?.({');
      expect(painIdLine).toBeGreaterThan(-1);
      expect(recordPainEventLine).toBeGreaterThan(-1);
      expect(painIdLine).toBeLessThan(recordPainEventLine);
    });

    it('pain.ts (handleManualPain) generates painId before recordPainEvent', () => {
      const source = read(PAIN);
      const painIdLine = source.indexOf('const painId = createPainId(sessionId)');
      const recordPainEventLine = source.indexOf('wctx.trajectory?.recordPainEvent?.({');
      expect(painIdLine).toBeGreaterThan(-1);
      expect(recordPainEventLine).toBeGreaterThan(-1);
      expect(painIdLine).toBeLessThan(recordPainEventLine);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 7: Observer path uses same painId for recordPainEvent and emit
  // (lineage consistency — ERR-004/ERR-008)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Observer path uses same painId for trajectory and emit (lineage consistency)', () => {
    it('prompt.ts Observer path uses observerPainId for both canonicalPainId and emitted painId', () => {
      const source = read(PROMPT);
      // The Observer path should use observerPainId as canonicalPainId in recordPainEvent
      expect(source).toMatch(/canonicalPainId:\s*observerPainId/);
      // The Observer path should use observerPainId as painId in the emitted event
      expect(source).toMatch(/painId:\s*observerPainId/);
      // There should be NO separate observerEmitPainId variable (lineage gap fixed)
      expect(source).not.toMatch(/observerEmitPainId/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 8: gate-block-helper does NOT have legacy recordPainEvent
  // (SDK observability path handles all writes, avoiding double-write)
  // ═══════════════════════════════════════════════════════════════════════

  describe('gate-block-helper has no legacy recordPainEvent (no double-write)', () => {
    it('gate-block-helper.ts does NOT call recordPainEvent directly', () => {
      const source = read(GATE_BLOCK_HELPER);
      expect(source).not.toMatch(/wctx\.trajectory\?\.recordPainEvent/);
    });

    it('gate-block-helper.ts uses gatePainId for emitted painId (SDK path writes canonicalPainId)', () => {
      const source = read(GATE_BLOCK_HELPER);
      expect(source).toMatch(/painId:\s*gatePainId/);
    });
  });
});
