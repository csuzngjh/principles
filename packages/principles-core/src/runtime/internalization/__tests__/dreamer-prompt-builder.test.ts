/**
 * DreamerPromptBuilder unit tests (PRI-107).
 *
 * Dreamer-specific prompt contracts. The mechanical template shared by all
 * six peer prompt builders (result shape, taskId/contextHash passthrough,
 * JSON-only directives, PRI-633 payload split, purity) lives in
 * peer-prompt-builder-contract.test.ts (PRI-888).
 *
 * PD-SPEC-001 round 2: the V2.1 prompt (Owner-provided text, see
 * dreamer-v21-verbatim.test.ts for the byte-exact snapshot check) adds the
 * EXPLORATION BEFORE SELECTION flow, pairwise distinctness, and the 2-4
 * normal selection band. The tests below assert those markers plus the
 * unchanged dynamic assembly contracts.
 */
import { describe, it, expect } from 'vitest';
import { DreamerPromptBuilder } from '../dreamer-prompt-builder.js';

const MINIMAL_INPUT = {
  taskId: 'task-dreamer-001',
  contextHash: 'ctx-abc123',
  contextRefs: ['ref-diag-001', 'ref-artifact-001'],
  predecessorOutput: {
    valid: true,
    diagnosisId: 'diag-001',
    taskId: 'task-diag-001',
    summary: 'Agent failed to validate input',
    rootCause: 'Design: missing input validation gate',
    violatedPrinciples: [{ rationale: 'No pre-condition check' }],
    evidence: [{ sourceRef: 'ref-1', note: 'Missing validation' }],
    recommendations: [
      { kind: 'rule', description: 'Add input validation', triggerPattern: 'user_input', action: 'validate before processing' },
    ],
    confidence: 0.85,
    ambiguityNotes: [],
  },
};

/**
 * Extract the COMPLETE EXAMPLE OUTPUT JSON object from the instruction with a
 * balanced-brace scan. The example contains nested candidate objects, so a
 * `[^}]+`-style flat regex cannot span it (the previous regex failed to match
 * and `expect(match).toBeDefined()` passed vacuously on `null` — fixed here to
 * actually parse the example).
 */
function extractExampleJson(instruction: string): string | null {
  const marker = instruction.indexOf('COMPLETE EXAMPLE OUTPUT');
  if (marker < 0) return null;
  const start = instruction.indexOf('{"valid":true', marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < instruction.length; i++) {
    const ch = instruction[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return instruction.slice(start, i + 1);
    }
  }
  return null;
}

describe('DreamerPromptBuilder', () => {
  describe('buildPrompt()', () => {
    it('maps contextRefs from input to top-level promptInput.contextRefs', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.contextRefs).toEqual(['ref-diag-001', 'ref-artifact-001']);
    });

    // Shared-contract note (PRI-888): result shape, taskId/contextHash and
    // predecessorOutput passthrough, valid-JSON/parsed-taskId, confidence-range,
    // JSON-only directives and purity for this builder now run in
    // peer-prompt-builder-contract.test.ts.

    it('systemPrompt (PRI-633: ex-dreamerInstruction) is present and contains key protocol keywords', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.systemPrompt).toBeDefined();
      expect(result.systemPrompt.length).toBeGreaterThan(100);
      expect(result.systemPrompt).toContain('Dreamer');
      expect(result.systemPrompt).toContain('candidate');
      expect(result.systemPrompt).toContain('badDecision');
      expect(result.systemPrompt).toContain('betterDecision');
      expect(result.systemPrompt).toContain('confidence');
    });

    // PRI-862 (CIL-006): the prompt must stop teaching fabricated lineage.
    it('systemPrompt forbids inventing sourcePainId and contains no invented pain-id example', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.systemPrompt).toMatch(/Do NOT invent sourcePainId/i);
      expect(result.systemPrompt).not.toContain('pain-null-crash');
      expect(result.systemPrompt).not.toContain('"sourcePainId"');
    });

    it('dreamerInstruction contains the output JSON schema format', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
      expect(instruction).toContain('"valid"');
      expect(instruction).toContain('"taskId"');
      expect(instruction).toContain('"candidates"');
      expect(instruction).toContain('"candidateIndex"');
      expect(instruction).toContain('"riskLevel"');
      expect(instruction).toContain('"generatedAt"');
    });

    it('dreamerInstruction specifies riskLevel must be low|medium|high', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
      expect(instruction).toMatch(/low.*medium.*high|riskLevel.*low.*medium.*high/s);
    });

    it('dreamerInstruction contains COMPLETE EXAMPLE OUTPUT with concrete values', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
      expect(instruction).toContain('COMPLETE EXAMPLE OUTPUT');
      expect(instruction).toContain('"valid":true');
      expect(instruction).toContain('"taskId":"task-dreamer-001"');
      expect(instruction).toContain('"badDecision"');
      expect(instruction).toContain('"betterDecision"');
      expect(instruction).toContain('"rationale"');
      expect(instruction).toContain('"strategicPerspective"');
    });

    it('dreamerInstruction example output is parseable JSON (balanced-brace extraction, non-vacuous)', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
      const example = extractExampleJson(instruction);
      // Fail loud when the example is missing — a null match must not skip the
      // parse assertion (the previous flat regex did exactly that).
      expect(example).not.toBeNull();
      if (example) {
        const parsed: unknown = JSON.parse(example);
        expect(parsed).toHaveProperty('valid', true);
        expect(parsed).toHaveProperty('taskId', 'task-dreamer-001');
        expect(Array.isArray((parsed as { candidates?: unknown[] }).candidates)).toBe(true);
      }
    });

    it('dreamerInstruction explicitly prohibits code fences', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
      expect(instruction).toMatch(/Do NOT wrap.*code fence/);
    });

    it('SIA v1.2: teaches the dual anchor and forbids re-deriving relevance', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.systemPrompt).toContain('DUAL ANCHOR');
      expect(result.systemPrompt).toContain('intentTension');
      expect(result.systemPrompt).toContain('intentSnapshot.sections');
      expect(result.systemPrompt).toMatch(/Stage A owns strategic relevance/i);
      expect(result.systemPrompt).toMatch(/never fabricate one/i);
      expect(result.systemPrompt).toContain('no strategic intent was configured for this run');
    });

    it('SIA v1.2: passes the Stage A snapshot through in predecessorOutput unchanged', () => {
      const input = {
        ...MINIMAL_INPUT,
        predecessorOutput: {
          ...MINIMAL_INPUT.predecessorOutput,
          intentTension: { source: 'action_drift', relatedIntentFields: ['why'], explanation: 'drift' },
          intentSnapshot: { contentHash: 'sha256:stage-a-hash', capturedAt: '2026-11-14T00:00:00.000Z', sections: [{ key: 'why', text: 'protect owner intent' }] },
        },
      };
      const result = new DreamerPromptBuilder().buildPrompt(input);
      const parsed = JSON.parse(result.message) as { predecessorOutput: Record<string, unknown> };
      expect(parsed.predecessorOutput.intentSnapshot).toEqual(input.predecessorOutput.intentSnapshot);
      expect(parsed.predecessorOutput.intentTension).toEqual(input.predecessorOutput.intentTension);
    });

    it('handles null predecessorOutput gracefully', () => {
      const input = { ...MINIMAL_INPUT, predecessorOutput: null };
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(input);

      expect(result.promptInput.predecessorOutput).toBeNull();
      expect(() => JSON.parse(result.message)).not.toThrow();
    });

    it('handles empty contextRefs array', () => {
      const input = { ...MINIMAL_INPUT, contextRefs: [] };
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(input);

      expect(result.promptInput.contextRefs).toEqual([]);
      const parsed = JSON.parse(result.message);
      expect(parsed.contextRefs).toEqual([]);
    });

    it('message JSON contains all required DreamerPromptInput fields at top level and no role instruction (PRI-633)', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const parsed = JSON.parse(result.message);
      expect(parsed).toHaveProperty('taskId');
      expect(parsed).toHaveProperty('contextHash');
      expect(parsed).toHaveProperty('contextRefs');
      expect(parsed).toHaveProperty('predecessorOutput');
      // PRI-633: the role/protocol instruction left the payload.
      expect(parsed).not.toHaveProperty('dreamerInstruction');
      expect(result.message).not.toContain('You are a Dreamer agent');
      expect(result.systemPrompt).toContain('You are a Dreamer agent');
    });
  });

  describe('Dreamer V2.1 markers (PD-SPEC-001 round 2)', () => {
    const instruction = new DreamerPromptBuilder().buildPrompt(MINIMAL_INPUT).systemPrompt;

    it('global candidate cap is explicit (1-5 IN TOTAL, GLOBAL limit, not per-root-cause)', () => {
      expect(instruction).toContain('The output must contain 1-5 candidates IN TOTAL for the entire predecessorOutput.');
      expect(instruction).toContain('This is a GLOBAL limit, not a per-root-cause limit.');
      expect(instruction).toContain('Return 5 only when five genuinely distinct, useful, evidence-supported candidates exist.');
    });

    it('exploration-before-selection flow is present', () => {
      expect(instruction).toContain('EXPLORATION BEFORE SELECTION');
      expect(instruction).toContain('perform an internal exploration of the independently useful decision opportunities');
      expect(instruction).toContain('First identify the genuinely distinct, evidence-supported alternatives. Then remove redundant alternatives and select the strongest candidates.');
    });

    it('pairwise distinctness check is present', () => {
      expect(instruction).toContain('Apply a pairwise distinctness check');
      expect(instruction).toContain('"If one candidate were removed, would the remaining candidate already cover the same decision mechanism and corrective behavior?"');
      expect(instruction).toContain('- If YES, merge them and retain the clearer, more complete version.');
      expect(instruction).toContain('- If NO, and each addresses an independently useful failure path, retain both.');
    });

    it('exploration lenses are optional, not mandatory categories', () => {
      expect(instruction).toContain('These are optional exploration lenses, NOT mandatory categories.');
      expect(instruction).toContain('Do not generate one candidate for every category.');
    });

    it('candidate count is not forced (no padding, no suppression)', () => {
      expect(instruction).toContain('Never invent candidates to reach a target count.');
      expect(instruction).toContain('Never suppress an independently valuable candidate merely to produce a shorter answer.');
      expect(instruction).toContain('normally surface 2-4 distinct candidates instead of prematurely stopping at the first acceptable solution');
    });

    it('evidence fidelity: no invented facts, capabilities, or unsupported attribution', () => {
      expect(instruction).toContain('Do not invent failures, agent actions, Owner requirements, or system capabilities absent from the supplied evidence.');
      expect(instruction).toContain('Do not assume tools, permissions, external services, approval mechanisms, or runtime capabilities that the input does not establish.');
      expect(instruction).toContain('Do not convert an environmental, tooling, or architectural failure into agent misconduct unless the evidence supports that attribution.');
    });

    it('riskLevel evaluates the risk of APPLYING the candidate', () => {
      expect(instruction).toContain('Evaluate the risk of APPLYING the proposed betterDecision, not simply the severity of the original Pain.');
      expect(instruction).toContain('over-restriction, unnecessary escalation, false positives, operational overhead, loss of useful autonomy, and unintended side effects');
    });

    it('output contract forbids new fields and lists exactly the DreamerOutputV1 fields', () => {
      expect(instruction).toContain('OUTPUT CONTRACT — MUST REMAIN UNCHANGED');
      expect(instruction).toContain('- Do NOT add any new fields, metadata, ranking fields, diversity scores, evidenceRefs, or candidate categories.');
      expect(instruction).toContain('- candidateIndex MUST be a number, zero-based, and sequential.');
      expect(instruction).toContain('- contextRefs MUST be copied exactly from the input contextRefs array, preserving its contents and order.');
      expect(instruction).toContain('- riskLevel MUST be exactly "low", "medium", or "high".');
    });

    it('no old V1 per-root-cause rule and no V2-era uppercase protocol wording remains', () => {
      expect(instruction).not.toContain('For each identified root cause, generate 1-5');
      expect(instruction).not.toContain('MATERIALLY DIFFERENT');
      expect(instruction).not.toContain('do NOT pad to reach five');
      expect(instruction).not.toContain('a GLOBAL cap on the entire output');
    });

    it('dynamic axiom injection: absent by default, present with coreGrounding', () => {
      const plain = new DreamerPromptBuilder().buildPrompt(MINIMAL_INPUT).systemPrompt;
      // The OUTPUT CONTRACT text mentions the "supplied CORE AXIOMS section";
      // the injected section itself is titled "CORE AXIOMS:" (with colon).
      expect(plain).not.toContain('CORE AXIOMS:');

      const groundedInput = { ...MINIMAL_INPUT, coreGrounding: true } as typeof MINIMAL_INPUT & { coreGrounding: boolean };
      const grounded = new DreamerPromptBuilder({ coreGrounding: true }).buildPrompt(groundedInput).systemPrompt;
      expect(grounded).toContain('CORE AXIOMS:');
      // The axiom block sits at the same position (immediately before CRITICAL).
      expect(grounded).toMatch(/CORE AXIOMS:[\s\S]*CRITICAL: Your ENTIRE response/);
    });

    it('language directives: en and zh-CN both append the directive and preserve the contract', () => {
      const en = new DreamerPromptBuilder({ outputLanguage: 'en' }).buildPrompt(MINIMAL_INPUT).systemPrompt;
      expect(en).toContain('LANGUAGE DIRECTIVE (PRI-336)');
      expect(en).toContain('English');
      expect(en).toContain('OUTPUT CONTRACT — MUST REMAIN UNCHANGED');

      const zh = new DreamerPromptBuilder({ outputLanguage: 'zh-CN' }).buildPrompt(MINIMAL_INPUT).systemPrompt;
      expect(zh).toContain('LANGUAGE DIRECTIVE (PRI-336)');
      expect(zh).toContain('Simplified Chinese (简体中文)');
      expect(zh).toContain('OUTPUT CONTRACT — MUST REMAIN UNCHANGED');
      // The directive is appended at the very end, after the output contract.
      expect(zh.trimEnd().endsWith('preserving the original meaning and technical accuracy.')).toBe(true);
    });

    it('example warns against copying the scenario and matches candidateIndex ordering rules', () => {
      expect(instruction).toContain('IMPORTANT: The example is illustrative only. Do not copy its scenario or candidate content.');
      expect(instruction).toContain('candidateIndex":0');
      expect(instruction).toContain('candidateIndex":1');
    });
  });
});
