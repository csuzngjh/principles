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

    // prompt.ts GFI/Observer paths migrated to SignalCollectorHost (spec §3.3)
    // recordObservability invariant now covered by signal-collector-host.ts
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

    // prompt.ts canonicalPainId paths migrated to SignalCollectorHost
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Invariant 3: Hook paths that previously lacked recordPainEvent now have it
  // ═══════════════════════════════════════════════════════════════════════

  describe('hook paths have recordPainEvent for trajectory.db coverage', () => {
    it('llm.ts calls recordPainEvent (added in PRI-453)', () => {
      const source = read(LLM);
      expect(source).toMatch(/wctx\.trajectory\?\.recordPainEvent\??\.\(/);
    });

    // prompt.ts GFI recordPainEvent migrated to SignalCollectorHost
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

  // Observer path migrated to SignalCollectorHost — lineage invariant now
  // covered by signal-collector-host.ts routeStrong (single painId path)


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

  // ═══════════════════════════════════════════════════════════════════════
  // PRI-640: Host attribution source invariants (Host Attribution SPEC §12/§13/§37)
  //
  // OpenClaw hook paths ARE the host boundary: every OpenClaw-owned pain
  // write (legacy recordPainEvent + SDK emit) carries hostKind: 'openclaw',
  // so pain_events.host_kind and diagnostician diagnosticJson.hostKind stay
  // in parity (both derive from the same PainDetectedData object forwarded by
  // emitPainDetectedEvent).
  // ═══════════════════════════════════════════════════════════════════════

  describe('PRI-640 host attribution invariants', () => {
    const HOST_SOURCES: ReadonlyArray<[string, string]> = [
      ['after-tool-call-helpers', AFTER_TOOL_CALL_HELPERS],
      ['pain hook', PAIN],
      ['llm hook', LLM],
      ['gate-block-helper', GATE_BLOCK_HELPER],
      ['lifecycle', LIFECYCLE],
    ];

    it('every OpenClaw hook file still emits pain_detected (attribution now centralized in the funnel)', () => {
      // PRI-642: emit sites no longer stamp hostKind inline — the shared
      // ingress in the pain funnel derives it (decision.legacy.hostKind is
      // asserted below), so per-file stamping is no longer the invariant.
      for (const [name, file] of HOST_SOURCES) {
        const source = read(file);
        const emits = source.match(/type:\s*'pain_detected'/g)?.length ?? 0;
        expect(emits, `${name} should emit pain_detected`).toBeGreaterThan(0);
      }
    });

    it('legacy recordPainEvent calls in host hook paths pass hostKind (trajectory row parity)', () => {
      const helpers = read(AFTER_TOOL_CALL_HELPERS);
      const painHook = read(PAIN);
      const llmHook = read(LLM);
      const legacyCalls = [
        ['after-tool-call-helpers', helpers.match(/recordPainEvent(\?\.)?\(\{/g)?.length ?? 0, helpers.match(/hostKind:\s*'openclaw',?\s*\}\)/g)?.length ?? 0],
        ['pain hook', painHook.match(/recordPainEvent(\?\.)?\(\{/g)?.length ?? 0, painHook.match(/hostKind:\s*'openclaw',?\s*\}\)/g)?.length ?? 0],
        ['llm hook', llmHook.match(/recordPainEvent(\?\.)?\(\{/g)?.length ?? 0, llmHook.match(/hostKind:\s*'openclaw',?\s*\}\)/g)?.length ?? 0],
      ] as const;
      for (const [name, calls, withHost] of legacyCalls) {
        expect(calls, `${name} should have legacy recordPainEvent calls`).toBeGreaterThan(0);
        expect(withHost, `${name}: legacy recordPainEvent calls must pass hostKind: 'openclaw'`).toBeGreaterThanOrEqual(calls);
      }
    });

    it('emitPainDetectedEvent forwards the ingress-derived hostKind to recordPain (diagnosticJson parity, SPEC §37)', () => {
      // PRI-642: attribution derives from the validated ingress decision
      // (openclaw session bound → hostKind openclaw), no longer from
      // per-emitter assembly.
      const source = read(PAIN);
      expect(source).toMatch(/hostKind:\s*decision\.legacy\.hostKind,/);
      expect(source).toMatch(/provenance:\s*decision\.legacy\.provenance,/);
    });

    it('the /pd-pain command forwards its hostKind into recordPain (wiring gap closed)', () => {
      const source = read('packages/openclaw-plugin/src/commands/pain.ts');
      expect(source).toMatch(/hostKind:\s*painData\.hostKind,/);
    });

    it('manual CLI pain record refuses on unverified --session before any LLM/task/candidate mutation (Evidence Over Assumption)', () => {
      // PRI-642 review: the CLI is now per-channel — cli_explicit_session
      // with an UNVERIFIED session (session_not_found / empty_trajectory /
      // trajectory_unavailable / evidence_read_failed) REFUSES before
      // mutation. The shared semantic authority is still in core; the
      // channel-level policy differs by host.
      const source = read('packages/pd-cli/src/commands/pain-record.ts');
      expect(source).toMatch(/evaluatePainIngress\(/);
      // Explicit-session + unverified acquisition routes to unbound
      // (then the shared evaluator refuses it).
      expect(source).toMatch(/acquisition\.status === 'unavailable'[\s\S]{0,400}status: 'unbound'/);
      expect(source).toMatch(/hostKind:\s*binding\.hostKind,/);
      expect(source).not.toMatch(/hostKind:\s*'openclaw',/);
    });

    it('legacy event import stays unattributed (unknown — never guessed)', () => {
      const source = read('packages/openclaw-plugin/src/core/trajectory.ts');
      const importSection = source.slice(source.indexOf('importLegacyEvents'));
      expect(importSection.slice(0, 3000)).not.toMatch(/hostKind/);
    });
  });
});
