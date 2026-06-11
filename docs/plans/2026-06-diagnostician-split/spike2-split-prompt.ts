/**
 * spike2-split-prompt.ts — Stage A (RootCause) + Stage B (Distiller) prompts
 *
 * THROWAWAY script for Spike-2 (PRI-366).
 * Builds the two-stage split pipeline prompts per §3 of 06-split-distiller-spike-plan.md.
 *
 * Stage A: Root-cause analysis ONLY (no recommendations, no taxonomy)
 * Stage B: Isolated distiller (core axioms + root cause → ONE abstract principle)
 */

import { CORE_PRINCIPLES, CORE_PRINCIPLE_IDS } from '../../../packages/principles-core/src/runtime-v2/core-principles/core-principle-registry.js';
import type { DiagnosticianContextPayload } from '../../../packages/principles-core/src/runtime-v2/context-payload.js';

// ── Stage A: Root-Cause ONLY ─────────────────────────────────────────────

export interface RootCauseOutput {
  summary: string;
  causalChain: string[];
  rootCause: string;
  rootCauseCategory: 'People' | 'Design' | 'Assumption' | 'Tooling';
  confidence: number;
}

const STAGE_A_SYSTEM_PROMPT = `You are a root-cause analyst. Given a pain signal (owner reason + evidence + conversation),
produce ONLY a root-cause analysis. Do NOT propose fixes, rules, prompts, or code.

Output strict JSON:
{
  "summary": "<one sentence: what happened>",
  "causalChain": ["Why-1 ...", "Why-2 ...", "... up to Why-5"],
  "rootCause": "People|Design|Assumption|Tooling: <the systemic root cause>",
  "rootCauseCategory": "People" | "Design" | "Assumption" | "Tooling",
  "confidence": 0.0-1.0
}
Output ONLY the JSON object. No prose, no markdown fences.`;

export function buildRootCausePrompt(payload: DiagnosticianContextPayload): {
  systemPrompt: string;
  userMessage: string;
} {
  const userMessage = JSON.stringify({
    painId: payload.diagnosisTarget.painId,
    reason: payload.diagnosisTarget.reasonSummary,
    severity: payload.diagnosisTarget.severity,
    source: payload.diagnosisTarget.source,
    evidence: payload.diagnosisTarget.evidence,
    conversationWindow: payload.conversationWindow,
  });

  return {
    systemPrompt: STAGE_A_SYSTEM_PROMPT,
    userMessage,
  };
}

// ── Stage B: Isolated Distiller ──────────────────────────────────────────

export interface DistillerOutput {
  abstractedPrinciple: string;
  groundedOnCorePrincipleId: string;
  rationale: string;
  confidence: number;
}

function buildAxiomList(): string {
  return CORE_PRINCIPLES.map(p => `${p.id}: ${p.name} — ${p.statement}`).join('\n');
}

const STAGE_B_SYSTEM_PROMPT_TEMPLATE = `You are a principle distiller. You are given a confirmed root-cause analysis and the 10
core axioms below. Produce exactly ONE principle that:
- generalizes BEYOND this specific incident (cross-scenario, reusable),
- is anchored to the single most relevant core axiom,
- is NOT a rule: do NOT mention specific files, tools, commands, regexes, or step-by-step actions.

CORE AXIOMS:
{AXIOM_LIST}

Output strict JSON:
{
  "abstractedPrinciple": "<= 200 chars, abstract, reusable, no concrete artifacts>",
  "groundedOnCorePrincipleId": "T-0X",
  "rationale": "<why this principle addresses the root cause, 1-2 sentences>",
  "confidence": 0.0-1.0
}
Output ONLY the JSON object.`;

export function buildDistillerPrompt(rootCauseJson: RootCauseOutput): {
  systemPrompt: string;
  userMessage: string;
} {
  const axiomList = buildAxiomList();
  const systemPrompt = STAGE_B_SYSTEM_PROMPT_TEMPLATE.replace('{AXIOM_LIST}', axiomList);

  const userMessage = JSON.stringify(rootCauseJson);

  return {
    systemPrompt,
    userMessage,
  };
}

// ── Validation helpers ───────────────────────────────────────────────────

export function isValidAxiomRef(axiomId: string): boolean {
  return CORE_PRINCIPLE_IDS.includes(axiomId);
}

export function findFabricatedAxiomRefs(output: DistillerOutput): string[] {
  const fabricated: string[] = [];
  const id = output.groundedOnCorePrincipleId;
  if (id && !isValidAxiomRef(id)) {
    fabricated.push(id);
  }
  // Also check abstractedPrinciple for T-XX references
  const matches = output.abstractedPrinciple?.match(/T-\d{2}/g) || [];
  for (const m of matches) {
    if (!isValidAxiomRef(m)) fabricated.push(m);
  }
  return [...new Set(fabricated)];
}

// ── Rule-like leakage detector (§4.2) ────────────────────────────────────

const CONCRETE_PATTERNS = [
  /\.\w{1,4}\b/g,                    // file extensions (.ts, .js, .json)
  /\b(auth|payment|middleware|config|session|utils|router|db|api|server|client|handler|service|model|controller)\b/gi, // common file names
  /\b(edit_file|read_file|run_command|git push|grep|glob)\b/gi,  // tool names
  /\b(triggerPattern|action|regex|WHERE|DELETE|INSERT|UPDATE)\b/gi, // taxonomy/SQL keywords
  /\b(block|intercept|halt|prevent|enforce|require|mandate|must)\b/gi, // step verbs (rule-like)
];

export function countRuleLikeLeakage(text: string): { count: number; matches: string[] } {
  const allMatches: string[] = [];
  for (const pattern of CONCRETE_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      allMatches.push(...matches);
    }
  }
  return { count: allMatches.length, matches: [...new Set(allMatches)] };
}
