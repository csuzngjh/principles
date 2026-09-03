/**
 * PRI-433: PainAdmissionEmitter characterization tests (safety net).
 *
 * These tests capture the CURRENT behavior of the 4 hook sites that emit
 * pain_detected events via emitPainDetectedEvent. They act as a safety net
 * for a future extraction refactor (consolidating into a PainAdmissionEmitter).
 *
 * Scope: static source code analysis only. No runtime mocking needed.
 * This follows the pattern established by runtime-v2-pain-guard.test.ts.
 *
 * Each section captures:
 * - Pain ID format (regex)
 * - Provenance field value
 * - Required fields present/missing (documents inconsistencies)
 * - Gate function used before emit
 * - Emit conditions (what must be true for emit to proceed)
 *
 * Known inconsistencies (to be resolved by future extraction):
 * | Site                     | painId format                    | provenance                | evidence | traceId |
 * |--------------------------|----------------------------------|---------------------------|----------|---------|
 * | after-tool-call-helpers  | pain_${ts}_${hash.slice(0,8)}    | 'automatic_hook'          | yes      | yes     |
 * | prompt.ts (GFI)          | empathy_gfi_${ts}                | 'host_context_bound'  | yes      | no      |
 * | prompt.ts (observer)     | empathy_gfi_${ts}                | 'host_context_bound'  | yes      | no      |
 * | llm.ts                   | llm_${ts}                        | 'host_context_bound'  | yes      | no      |
 * | gate-block-helper        | gate_${ts}_${random}             | MISSING                   | MISSING  | MISSING |
 *
 * ERR refs:
 * - ERR-009 (fail-loud): tests fail if emit pattern changes without update
 * - ERR-006 (lineage consistency): documents traceId presence/absence per site
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Helpers ────────────────────────────────────────────────────────────────

function findRepoRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find repo root from ${cwd} — .git directory not found in any parent`);
}

const repoRoot = findRepoRoot(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * Extract the gate-block pain event object from source code.
 * Uses brace-depth tracking so template-string braces inside the object
 * do not prematurely terminate the match (ERR-009 false-positive guard).
 */
function extractGateBlockObject(source: string): string | null {
  // PRI-453: painId is now a variable reference (gatePainId), not inline template
  const marker = /painId:\s*gatePainId/.exec(source);
  if (!marker) return null;
  const start = source.lastIndexOf('{', marker.index);
  if (start === -1) return null;
  let depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return source.slice(start, i);
}

// ── Source file paths ─────────────────────────────────────────────────────

const AFTER_TOOL_CALL_HELPERS = 'packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts';
const PROMPT = 'packages/openclaw-plugin/src/hooks/prompt.ts';
const SIGNAL_COLLECTOR_HOST = 'packages/openclaw-plugin/src/core/signal-collector-host.ts';
const LLM = 'packages/openclaw-plugin/src/hooks/llm.ts';
const GATE_BLOCK_HELPER = 'packages/openclaw-plugin/src/hooks/gate-block-helper.ts';
const PAIN = 'packages/openclaw-plugin/src/hooks/pain.ts';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('PRI-433: PainAdmissionEmitter characterization (safety net)', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // Section 1: after-tool-call-helpers.ts — tool failure path
  // ═══════════════════════════════════════════════════════════════════════

  describe('after-tool-call-helpers.ts emit site', () => {
    const source = read(AFTER_TOOL_CALL_HELPERS);

    it('uses painId format: pain_${Date.now()}_${errorHash.slice(0,8)}', () => {
      expect(source).toMatch(/painId\s*=\s*`pain_\$\{Date\.now\(\)\}_\$\{observation\.errorHash\.slice\(0,\s*8\)\}`/);
    });

    it('does NOT assemble provenance at the emit site (PRI-642: the funnel ingress derives it)', () => {
      // SPEC §8.3: adapters no longer supply provenance independently.
      expect(source).not.toMatch(/provenance:/);
    });

    it('does NOT assemble evidence at the emit site (PRI-642: typed acquisition in the funnel)', () => {
      expect(source).not.toMatch(/evidence:\s*buildTrajectoryEvidence/);
    });

    it('includes traceId from observation', () => {
      expect(source).toMatch(/traceId:\s*observation\.traceId/);
    });

    it('sets painType to failureSource variable (tool_failure or dispatch_error)', () => {
      expect(source).toMatch(/painType:\s*failureSource/);
    });

    it('sets agentId from context variable', () => {
      expect(source).toMatch(/agentId,/);
    });

    it('uses evaluateTriggerController as gate (PRI-363 single gate)', () => {
      expect(source).toMatch(/evaluateTriggerController/);
    });

    it('calls emitPainDetectedEvent (not legacy writePainFlag)', () => {
      expect(source).toMatch(/emitPainDetectedEvent\(wctx,/);
      expect(source).not.toMatch(/\bwritePainFlag\b/);
    });

    it('early-returns when admission.admitted is false', () => {
      expect(source).toMatch(/if\s*\(!admission\.admitted\)\s*return/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section 2: prompt.ts — empathy GFI path (2 instances)
  // ═══════════════════════════════════════════════════════════════════════

  describe('llm.ts emit site', () => {
    const source = read(LLM);

    it('uses painId format: llm_${Date.now()}', () => {
      // PRI-453: painId is now generated early as `const painId = `llm_${Date.now()}``
      // and referenced as `painId: painId` in the emit data block.
      expect(source).toMatch(/const\s+painId\s*=\s*`llm_\$\{Date\.now\(\)\}`/);
    });

    it('does NOT assemble provenance at the emit site (PRI-642: funnel ingress derives automatic_hook)', () => {
      // PRI-642/SPEC §8.3 + §12.2.3: an LLM-detected signal is an automatic
      // hook — never host-context-bound, and emitters no longer state
      // provenance at all; the shared ingress derives it in the funnel.
      expect(source).not.toMatch(/provenance:/);
    });

    it('sets painType to "user_frustration" (as const)', () => {
      expect(source).toMatch(/painType:\s*'user_frustration'\s+as\s+const/);
    });

    it('does NOT assemble evidence at the emit site (PRI-642: typed acquisition in the funnel)', () => {
      expect(source).not.toMatch(/buildTrajectoryEvidence/);
    });

    it('does NOT include traceId field (known inconsistency)', () => {
      // PRI-453: painId is now a variable reference, so extract the emit block
      // by matching the emitPainDetectedEvent call pattern instead.
      const emitBlock = source.match(/emitPainDetectedEvent\(wctx,\s*\{[\s\S]*?\},\s*\{[^}]*\}\);/);
      expect(emitBlock).not.toBeNull();
      expect(emitBlock![0]).not.toMatch(/traceId/);
    });

    it('sets agentId from ctx.agentId (not hardcoded)', () => {
      expect(source).toMatch(/agentId:\s*ctx\.agentId/);
    });

    it('no longer uses evaluatePainDiagnosticGate (PRI-651-B1: Gate B only)', () => {
      expect(source).not.toMatch(/evaluatePainDiagnosticGate/);
    });

    it('uses evaluateTriggerController as Gate B (PRI-454 dual-gate)', () => {
      expect(source).toMatch(/evaluateTriggerController/);
    });

    it('uses triageResult (not sourceKind) for evaluateTriggerController (PRI-454)', () => {
      expect(source).toMatch(/triageResult:\s*triage/);
    });

    it('no longer loads painEvidenceAdmission flags (PRI-651-B1)', () => {
      expect(source).not.toMatch(/painEvidenceAdmissionDefault/);
      expect(source).not.toMatch(/loadFeatureFlagFromConfig/);
    });

    it('gates emit on triggerDecision.shouldCreateDiagnosticTask', () => {
      expect(source).toMatch(/triggerDecision\.shouldCreateDiagnosticTask/);
    });

    it('calls emitPainDetectedEvent WITHOUT await (fire-and-forget)', () => {
      // llm.ts calls emitPainDetectedEvent without await — known inconsistency
      expect(source).toMatch(/[^a]\s*emitPainDetectedEvent\(wctx,/);
      expect(source).not.toMatch(/await\s+emitPainDetectedEvent/);
    });

    it('uses PEAT-B1 evidence triage (unconditional since PRI-651-B1)', () => {
      expect(source).toMatch(/evaluateEvidenceTriage/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section 4: gate-block-helper.ts — gate block persistence
  // ═══════════════════════════════════════════════════════════════════════

  describe('gate-block-helper.ts emit site', () => {
    const source = read(GATE_BLOCK_HELPER);

    it('uses painId format: gate_${Date.now()}_${random} via gatePainId variable', () => {
      // PRI-453: painId is now generated early as `const gatePainId = `gate_...``
      // and referenced as `painId: gatePainId` in the emit data block.
      expect(source).toMatch(/const\s+gatePainId\s*=\s*`gate_\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)\.slice\(2,\s*10\)\}`/);
      expect(source).toMatch(/painId:\s*gatePainId/);
    });

    it('sets painType to "user_frustration"', () => {
      expect(source).toMatch(/painType:\s*'user_frustration'/);
    });

    it('sets source to "gate_blocked"', () => {
      expect(source).toMatch(/source:\s*'gate_blocked'/);
    });

    it('hardcodes agentId to "main"', () => {
      expect(source).toMatch(/agentId:\s*'main'/);
    });

    it('uses GATE_BLOCK_PAIN_SCORE constant (45)', () => {
      expect(source).toMatch(/GATE_BLOCK_PAIN_SCORE\s*=\s*45/);
      expect(source).toMatch(/score:\s*GATE_BLOCK_PAIN_SCORE/);
    });

    it('does NOT include provenance field (known inconsistency)', () => {
      const gateBlock = extractGateBlockObject(source);
      expect(gateBlock).not.toBeNull();
      expect(gateBlock).not.toMatch(/provenance/);
    });

    it('does NOT include evidence field (known inconsistency)', () => {
      const gateBlock = extractGateBlockObject(source);
      expect(gateBlock).not.toBeNull();
      expect(gateBlock).not.toMatch(/evidence/);
    });

    it('does NOT include traceId field (known inconsistency)', () => {
      const gateBlock = extractGateBlockObject(source);
      expect(gateBlock).not.toBeNull();
      expect(gateBlock).not.toMatch(/traceId/);
    });

    it('no longer uses evaluatePainDiagnosticGate (PRI-651-B1: Gate B only)', () => {
      expect(source).not.toMatch(/evaluatePainDiagnosticGate/);
    });

    it('uses evaluateTriggerController as Gate B (PRI-454 dual-gate)', () => {
      expect(source).toMatch(/evaluateTriggerController/);
    });

    it('uses triageResult for evaluateTriggerController (PRI-454)', () => {
      expect(source).toMatch(/triageResult:\s*triage/);
    });

    it('no longer reads painEvidenceAdmission flags (PRI-651-B1)', () => {
      expect(source).not.toMatch(/painEvidenceAdmissionDefault/);
    });

    it('gates emit on triggerDecision.shouldCreateDiagnosticTask', () => {
      expect(source).toMatch(/triggerDecision\.shouldCreateDiagnosticTask/);
    });

    it('uses PEAT-B1 evidence triage (unconditional since PRI-651-B1)', () => {
      expect(source).toMatch(/evaluateEvidenceTriage/);
    });

    it('passes consecutiveErrors and isRisky to evaluateEvidenceTriage in Gate B path (PRI-454 P2-1)', () => {
      // Regression: Gate B path must pass consecutiveErrors and isRisky so
      // Rule 3 (consecutiveErrors >= 4 → admit) can fire for non-risky
      // repeated gate blocks. Without these, only isUnsafeHighConfidence
      // was passed, dropping the repeated-failure upgrade rule.
      const triageCall = source.match(/evaluateEvidenceTriage\([^)]+\)/s);
      expect(triageCall).not.toBeNull();
      expect(triageCall![0]).toMatch(/consecutiveErrors/);
      expect(triageCall![0]).toMatch(/isRisky/);
    });

    it('calls emitPainDetectedEvent with void + .catch() (fire-and-forget with error handler)', () => {
      expect(source).toMatch(/void\s+emitPainDetectedEvent/);
      expect(source).toMatch(/\.catch\(\(emitErr\)/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section 4b: pain.ts — manual pain path (path 5)
  // ═══════════════════════════════════════════════════════════════════════

  describe('pain.ts manual pain emit site (PRI-454)', () => {
    const source = read(PAIN);

    it('uses painId format: pain_${Date.now()}_${hash.slice(0,8)} via createPainId', () => {
      expect(source).toMatch(/function\s+createPainId\(sessionId:\s*string\)/);
      expect(source).toMatch(/`pain_\$\{Date\.now\(\)\}_\$\{computeHash\(sessionId\)\.slice\(0,\s*8\)\}`/);
    });

    it('sets painType to "user_frustration"', () => {
      expect(source).toMatch(/painType:\s*'user_frustration'/);
    });

    it('sets source to event.toolName (manual pain)', () => {
      expect(source).toMatch(/source:\s*event\.toolName/);
    });

    it('sets score to 100 (manual pain max score)', () => {
      expect(source).toMatch(/score:\s*100/);
    });

    it('includes traceId field', () => {
      expect(source).toMatch(/traceId,/);
    });

    it('includes evidence field via buildTrajectoryEvidence', () => {
      expect(source).toMatch(/evidence:\s*buildTrajectoryEvidence\(wctx,\s*sessionId\)/);
    });

    it('no longer uses evaluatePainDiagnosticGate (PRI-651-B1: Gate B only)', () => {
      expect(source).not.toMatch(/evaluatePainDiagnosticGate/);
    });

    it('uses evaluateTriggerController as Gate B (PRI-454 dual-gate)', () => {
      expect(source).toMatch(/evaluateTriggerController/);
    });

    it('uses triageResult for evaluateTriggerController (PRI-454)', () => {
      expect(source).toMatch(/triageResult:\s*triage/);
    });

    it('uses isOwnerManual: true for manual pain (PRI-454)', () => {
      expect(source).toMatch(/isOwnerManual:\s*true/);
    });

    it('uses buildManualPainObservation (PRI-454)', () => {
      expect(source).toMatch(/buildManualPainObservation/);
    });

    it('no longer loads painEvidenceAdmission flags (PRI-651-B1)', () => {
      expect(source).not.toMatch(/painEvidenceAdmissionDefault/);
      expect(source).not.toMatch(/loadFeatureFlagFromConfig/);
    });

    it('gates emit on triggerDecision.shouldCreateDiagnosticTask (no Gate A gate.shouldDiagnose)', () => {
      expect(source).toMatch(/triggerDecision\.shouldCreateDiagnosticTask/);
      expect(source).not.toMatch(/gate\.shouldDiagnose/);
    });

    it('calls emitPainDetectedEvent (not legacy APIs)', () => {
      expect(source).toMatch(/emitPainDetectedEvent\(wctx,/);
      expect(source).not.toMatch(/\bwritePainFlag\b/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section 5: Cross-site consistency documentation
  // ═══════════════════════════════════════════════════════════════════════

  describe('cross-site consistency (documents known inconsistencies)', () => {
    it('all 5 sites call emitPainDetectedEvent (not legacy APIs)', () => {
      const files = [AFTER_TOOL_CALL_HELPERS, SIGNAL_COLLECTOR_HOST, LLM, GATE_BLOCK_HELPER, PAIN];
      for (const file of files) {
        const src = read(file);
        expect(src).toMatch(/emitPainDetectedEvent/);
        expect(src).not.toMatch(/\bwritePainFlag\b/);
        expect(src).not.toMatch(/\bcreatePainSignalBridge\b/);
      }
    });

    it('all 5 sites emit type: "pain_detected"', () => {
      const files = [AFTER_TOOL_CALL_HELPERS, SIGNAL_COLLECTOR_HOST, LLM, GATE_BLOCK_HELPER, PAIN];
      for (const file of files) {
        const src = read(file);
        expect(src).toMatch(/type:\s*'pain_detected'/);
      }
    });

    it('all 5 sites include ts: new Date().toISOString()', () => {
      const files = [AFTER_TOOL_CALL_HELPERS, SIGNAL_COLLECTOR_HOST, LLM, GATE_BLOCK_HELPER, PAIN];
      for (const file of files) {
        const src = read(file);
        expect(src).toMatch(/ts:\s*new Date\(\)\.toISOString\(\)/);
      }
    });

    it('all 5 sites include sessionId field', () => {
      const files = [AFTER_TOOL_CALL_HELPERS, SIGNAL_COLLECTOR_HOST, LLM, GATE_BLOCK_HELPER, PAIN];
      for (const file of files) {
        const src = read(file);
        expect(src).toMatch(/sessionId,/);
      }
    });

    it('all 5 sites include score field', () => {
      const files = [AFTER_TOOL_CALL_HELPERS, SIGNAL_COLLECTOR_HOST, LLM, GATE_BLOCK_HELPER, PAIN];
      for (const file of files) {
        const src = read(file);
        expect(src).toMatch(/score:/);
      }
    });

    it('all 5 sites include reason field', () => {
      const files = [AFTER_TOOL_CALL_HELPERS, SIGNAL_COLLECTOR_HOST, LLM, GATE_BLOCK_HELPER, PAIN];
      for (const file of files) {
        const src = read(file);
        expect(src).toMatch(/reason:/);
      }
    });

    it('all 5 sites include source field', () => {
      const files = [AFTER_TOOL_CALL_HELPERS, SIGNAL_COLLECTOR_HOST, LLM, GATE_BLOCK_HELPER, PAIN];
      for (const file of files) {
        const src = read(file);
        expect(src).toMatch(/source:/);
      }
    });

    it('all 5 sites include painId field', () => {
      // after-tool-call-helpers uses shorthand `painId,`; others use `painId:`
      const files = [AFTER_TOOL_CALL_HELPERS, SIGNAL_COLLECTOR_HOST, LLM, GATE_BLOCK_HELPER, PAIN];
      for (const file of files) {
        const src = read(file);
        expect(src).toMatch(/painId[,:]/);
      }
    });

  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRI-451 Wave 1: dead-code retirement assertions
//
// These mirror the existing presence-assertions above. Each asserts a dead
// symbol's call/definition is GONE from source (matched via call syntax so the
// retirement comments do not trigger false positives). Written BEFORE deletion
// (TDD) so the deletion commit turns them green.
//
// Evidence each is dead (full map in PRI-451):
// - recordRuleMatch          : only consumer was stats.pain.rulesMatched (dead).
// - processDetectionQueue    : sole caller of searchPainEvents; all its leaf
//                              effects (recordRuleMatch, funnel.updateCache)
//                              have no downstream reader.
// - searchPainEvents / FTS5  : only caller was processDetectionQueue (dead).
//
// LIVE invariants preserved (must NOT regress) — the 4 emit sites still call
// emitPainDetectedEvent (cross-site section above), consumed by PainSignalBridge.
//
// ERR refs: ERR-009 (fail-loud) — these fail if the dead code is reintroduced.
// ═══════════════════════════════════════════════════════════════════════════

describe('PRI-451 Wave 1: dead pain-diagnostic-track symbols removed', () => {
  const EVOLUTION_WORKER = 'packages/openclaw-plugin/src/service/evolution-worker.ts';
  const TRAJECTORY = 'packages/openclaw-plugin/src/core/trajectory.ts';
  const EVENT_LOG = 'packages/openclaw-plugin/src/core/event-log.ts';

  it('processDetectionQueue is removed from evolution-worker', () => {
    const src = read(EVOLUTION_WORKER);
    // Match a call or definition, not the retirement comment.
    expect(src).not.toMatch(/\bprocessDetectionQueue\s*\(/);
  });

  it('searchPainEvents is removed from trajectory', () => {
    const src = read(TRAJECTORY);
    expect(src).not.toMatch(/\bsearchPainEvents\s*\(/);
  });

  it('recordRuleMatch is removed from event-log', () => {
    const src = read(EVENT_LOG);
    expect(src).not.toMatch(/\brecordRuleMatch\s*\(/);
  });

  it('recordRuleMatch call is removed from llm.ts (detection block stays)', () => {
    const src = read(LLM);
    expect(src).not.toMatch(/\brecordRuleMatch\s*\(/);
    // The surrounding detection block that feeds pain emission must remain.
    expect(src).toMatch(/DetectionService\.get/);
  });
});
