/**
 * Spike: Distiller Grounding — Baseline vs Grounded prompt comparison
 *
 * THROWAWAY script for PRI-366 (T-B) P-spike.
 * NOT production code. Does not need to follow project coding conventions.
 *
 * This file provides two prompt builders:
 * - buildBaselinePrompt(): Uses the current monolith buildDiagnosticProtocolInstruction()
 * - buildGroundedPrompt(): Adds Phase 3.5 (Core Principle Grounding) before Phase 4
 *
 * Both functions import CORE_PRINCIPLES from the registry to ensure
 * axiom data is always in sync with the single authoritative source.
 */

import { buildDiagnosticProtocolInstruction } from '../../packages/principles-core/src/runtime-v2/diagnostician-prompt-builder.js';
import { DefaultSchemaPromptAdapter } from '../../packages/principles-core/src/runtime-v2/adapter/schema-prompt-adapter.js';
import { DiagnosticianOutputV1Schema } from '../../packages/principles-core/src/runtime-v2/diagnostician-output.js';
import { CORE_PRINCIPLES, CORE_PRINCIPLE_IDS } from '../../packages/principles-core/src/runtime-v2/core-principles/core-principle-registry.js';
import type { DiagnosticianContextPayload } from '../../packages/principles-core/src/runtime-v2/context-payload.js';
import type { PromptInput } from '../../packages/principles-core/src/runtime-v2/diagnostician-prompt-builder.js';

const adapter = new DefaultSchemaPromptAdapter();
const schema = DiagnosticianOutputV1Schema;

/**
 * Baseline prompt — the current 4-phase monolith diagnostician instruction.
 * This is the control group.
 */
export function buildBaselinePrompt(payload: DiagnosticianContextPayload): PromptInput {
  const diagnosticInstruction = buildDiagnosticProtocolInstruction(adapter, schema);

  return {
    taskId: payload.taskId,
    contextHash: payload.contextHash,
    diagnosisTarget: payload.diagnosisTarget,
    conversationWindow: payload.conversationWindow,
    sourceRefs: payload.sourceRefs,
    context: payload,
    diagnosticInstruction,
  };
}

/**
 * Build the axiom grounding block for Phase 3.5.
 * Uses CORE_PRINCIPLES from the registry — no hardcoded data.
 */
function buildAxiomGroundingBlock(): string {
  const axiomList = CORE_PRINCIPLES.map(p => `${p.id}: ${p.name} — ${p.statement}`).join('\n');

  return `
PHASE 3.5 — Core Principle Grounding:
Before distilling recommendations, evaluate whether the root cause violates any of the
10 core axioms below. If a violation exists, the resulting principle MUST explicitly
reference the violated axiom id (e.g., "violates T-03: Evidence Over Assumption").

CORE AXIOMS:
${axiomList}

If no axiom is violated, state "No core axiom violation detected" in ambiguityNotes.
If an axiom IS violated, the principle's abstractedPrinciple MUST generalize beyond the
specific incident while remaining anchored to the violated axiom's intent.`;
}

/**
 * Build the Phase 4 modification for grounded version.
 * Adds the axiom-grounding constraint to the recommendation taxonomy phase.
 */
function buildGroundedPhase4Addition(): string {
  return `
- If a core axiom violation was identified in Phase 3.5, the principle's kind MUST be
  "principle" (not "rule" or "implementation"), and the violated axiom id MUST appear
  in ambiguityNotes as "groundedOn: T-XX".`;
}

/**
 * Grounded prompt — adds Phase 3.5 (Core Principle Grounding) between
 * Phase 3 and Phase 4, plus modifies Phase 4 instruction.
 * This is the experimental group.
 */
export function buildGroundedPrompt(payload: DiagnosticianContextPayload): PromptInput {
  // Start with the baseline instruction
  const baselineInstruction = buildDiagnosticProtocolInstruction(adapter, schema);

  // Insert Phase 3.5 after Phase 3 and before Phase 4
  const phase3EndMarker = 'PHASE 4 — Recommendation Taxonomy & Distillation:';
  const phase3EndIndex = baselineInstruction.indexOf(phase3EndMarker);

  if (phase3EndIndex === -1) {
    // Fallback: append grounding block at the end if Phase 4 marker not found
    const groundedInstruction = baselineInstruction + '\n\n' + buildAxiomGroundingBlock() + '\n\n' + buildGroundedPhase4Addition();
    return {
      taskId: payload.taskId,
      contextHash: payload.contextHash,
      diagnosisTarget: payload.diagnosisTarget,
      conversationWindow: payload.conversationWindow,
      sourceRefs: payload.sourceRefs,
      context: payload,
      diagnosticInstruction: groundedInstruction,
    };
  }

  // Split at Phase 4 marker
  const beforePhase4 = baselineInstruction.slice(0, phase3EndIndex);
  const phase4AndAfter = baselineInstruction.slice(phase3EndIndex);

  // Add grounding addition to Phase 4 section
  // Find the end of the TAXONOMY DEFINITIONS block to insert the grounding constraint
  const taxonomyDefEnd = phase4AndAfter.indexOf('EVIDENCE SCOPE GUARD:');
  let modifiedPhase4: string;
  if (taxonomyDefEnd !== -1) {
    modifiedPhase4 = phase4AndAfter.slice(0, taxonomyDefEnd) +
      buildGroundedPhase4Addition() + '\n\n' +
      phase4AndAfter.slice(taxonomyDefEnd);
  } else {
    // Fallback: append at end of Phase 4 section
    modifiedPhase4 = phase4AndAfter + '\n' + buildGroundedPhase4Addition();
  }

  const groundedInstruction = beforePhase4 + buildAxiomGroundingBlock() + '\n\n' + modifiedPhase4;

  return {
    taskId: payload.taskId,
    contextHash: payload.contextHash,
    diagnosisTarget: payload.diagnosisTarget,
    conversationWindow: payload.conversationWindow,
    sourceRefs: payload.sourceRefs,
    context: payload,
    diagnosticInstruction: groundedInstruction,
  };
}

/**
 * Validate that an axiom reference is real (not fabricated).
 * Returns true if the id exists in CORE_PRINCIPLE_IDS.
 */
export function isValidAxiomRef(axiomId: string): boolean {
  return CORE_PRINCIPLE_IDS.includes(axiomId);
}

/**
 * Extract axiom references from ambiguityNotes.
 * Looks for patterns like "groundedOn: T-XX" or "violates T-XX".
 */
export function extractAxiomRefs(ambiguityNotes: string[] | undefined): string[] {
  if (!ambiguityNotes || !Array.isArray(ambiguityNotes)) return [];

  const refs: string[] = [];
  for (const note of ambiguityNotes) {
    // Match "groundedOn: T-XX" or "violates T-XX" patterns
    const matches = note.match(/(?:groundedOn|violates)[:\s]+(T-\d{2})/gi);
    if (matches) {
      for (const m of matches) {
        const idMatch = m.match(/T-\d{2}/);
        if (idMatch) refs.push(idMatch[0]);
      }
    }
  }
  return refs;
}

/**
 * Check for fabricated axiom IDs in the output.
 * Returns list of fabricated IDs (not in CORE_PRINCIPLE_IDS).
 */
export function findFabricatedAxiomRefs(output: Record<string, unknown>): string[] {
  const fabricated: string[] = [];

  // Check ambiguityNotes
  const notes = output.ambiguityNotes;
  if (Array.isArray(notes)) {
    for (const note of notes) {
      if (typeof note !== 'string') continue;
      const matches = note.match(/T-\d{2}/g);
      if (matches) {
        for (const m of matches) {
          if (!isValidAxiomRef(m)) fabricated.push(m);
        }
      }
    }
  }

  // Check recommendations for groundedOn references
  const recs = output.recommendations;
  if (Array.isArray(recs)) {
    for (const rec of recs) {
      if (typeof rec !== 'object' || rec === null) continue;
      const desc = rec.description;
      if (typeof desc === 'string') {
        const matches = desc.match(/T-\d{2}/g);
        if (matches) {
          for (const m of matches) {
            if (!isValidAxiomRef(m)) fabricated.push(m);
          }
        }
      }
      const absPrinciple = rec.abstractedPrinciple;
      if (typeof absPrinciple === 'string') {
        const matches = absPrinciple.match(/T-\d{2}/g);
        if (matches) {
          for (const m of matches) {
            if (!isValidAxiomRef(m)) fabricated.push(m);
          }
        }
      }
    }
  }

  // Check violatedPrinciples for T-XX references
  const violated = output.violatedPrinciples;
  if (Array.isArray(violated)) {
    for (const vp of violated) {
      if (typeof vp !== 'object' || vp === null) continue;
      const rationale = vp.rationale;
      if (typeof rationale === 'string') {
        const matches = rationale.match(/T-\d{2}/g);
        if (matches) {
          for (const m of matches) {
            if (!isValidAxiomRef(m)) fabricated.push(m);
          }
        }
      }
    }
  }

  return [...new Set(fabricated)];
}

// ── CLI quick-test ──────────────────────────────────────────────────────

if (typeof require !== 'undefined' && require.main === module) {
  const testPayload: DiagnosticianContextPayload = {
    contextId: 'spike-test-1',
    contextHash: 'hash-spike',
    taskId: 'task-spike-001',
    workspaceDir: 'D:/spike',
    sourceRefs: ['pain://spike-001'],
    diagnosisTarget: {
      painId: 'pain-spike-001',
      reasonSummary: 'Agent skipped verification and directly modified code',
    },
    conversationWindow: [
      { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Fix the bug in auth.ts' },
      { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will modify auth.ts directly' },
      { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'edit_file', toolResultSummary: 'Modified auth.ts without reading first' },
    ],
  };

  const baseline = buildBaselinePrompt(testPayload);
  const grounded = buildGroundedPrompt(testPayload);

  console.log('=== BASELINE instruction length:', baseline.diagnosticInstruction.length);
  console.log('=== GROUNDED instruction length:', grounded.diagnosticInstruction.length);
  console.log('=== GROUNDED contains Phase 3.5:', grounded.diagnosticInstruction.includes('PHASE 3.5'));
  console.log('=== GROUNDED contains CORE AXIOMS:', grounded.diagnosticInstruction.includes('CORE AXIOMS'));
  console.log('=== GROUNDED contains groundedOn:', grounded.diagnosticInstruction.includes('groundedOn'));
  console.log('=== Valid axiom IDs:', CORE_PRINCIPLE_IDS.join(', '));
}
