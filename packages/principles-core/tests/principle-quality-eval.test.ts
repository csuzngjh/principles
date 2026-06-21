import { describe, it, expect } from 'vitest';
import type { PIArtifactSnapshot } from '../src/runtime-v2/activation/activation-types.js';

/**
 * Principle quality evaluation — pure-code dimensions.
 *
 * MVP Quality Task 19: schema validation alone misses empty principle text
 * and lineage mismatch. This grader scores LLM-produced principles on three
 * pure-code dimensions. LLM-as-judge dimensions (specificity, actionability)
 * are deferred to post-release.
 *
 * Runtime Contract compliance:
 * - Rule #1: `principle` is typed `unknown` (parsed JSON / DB row / artifact
 *   metadata is untrusted).
 * - Rule #2: no `as` casts; shape is validated with type guards.
 * - Rule #4: `lineageArtifactIds` element types are validated.
 * - Rule #5: direct property access with typeof checks (no `in` operator).
 */

interface PrincipleGradeResult {
  formatAdherence: number; // 1.0 if shape valid + contentJson is a JSON object, 0.0 otherwise
  taskSuccess: number; // 1.0 if required text field is non-empty, 0.0 otherwise
  lineageConsistency: number; // 1.0 if sourceTaskId matches expected pain id, 0.0 otherwise
  overall: number; // weighted average (equal weights)
  feedback: string;
}

const PRINCIPLE_ARTIFACT_KINDS = new Set<string>([
  'principle',
]);

const VALIDATION_STATUSES = new Set<string>(['pending', 'validated', 'rejected']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Type guard for PIArtifactSnapshot. Validates every required field by
 * runtime shape, including array element types (Runtime Contract Rule #4).
 * No `as` casts — field types are narrowed via typeof checks.
 */
function isPIArtifactSnapshot(value: unknown): value is PIArtifactSnapshot {
  if (!isObject(value)) return false;
  if (!Object.hasOwn(value, 'artifactId') || typeof value.artifactId !== 'string') return false;
  if (!Object.hasOwn(value, 'artifactKind') || typeof value.artifactKind !== 'string' || !PRINCIPLE_ARTIFACT_KINDS.has(value.artifactKind)) return false;
  if (!Object.hasOwn(value, 'sourceTaskId') || typeof value.sourceTaskId !== 'string') return false;
  if (!Object.hasOwn(value, 'lineageArtifactIds') || !isStringArray(value.lineageArtifactIds)) return false;
  if (!Object.hasOwn(value, 'validationStatus') || typeof value.validationStatus !== 'string' || !VALIDATION_STATUSES.has(value.validationStatus)) return false;
  if (!Object.hasOwn(value, 'contentJson') || typeof value.contentJson !== 'string') return false;
  if (!Object.hasOwn(value, 'createdAt') || typeof value.createdAt !== 'string') return false;
  if (!Object.hasOwn(value, 'updatedAt') || typeof value.updatedAt !== 'string') return false;
  return true;
}

/**
 * Check whether a sourceTaskId is consistent with an expected pain id.
 *
 * Real artifacts use either the raw pain/task id directly or the
 * `diagnosis_<painId>` convention (see evidence-chain-contract.ts, ERR-008).
 * Both forms are accepted so the grader works against real seed-customer
 * fixtures.
 */
function sourceTaskIdMatchesPainId(sourceTaskId: string, expectedPainId: string): boolean {
  if (sourceTaskId === expectedPainId) return true;
  if (sourceTaskId === `diagnosis_${expectedPainId}`) return true;
  return false;
}

/**
 * Grade a principle artifact on three pure-code dimensions.
 *
 * @param principle - untrusted artifact (typed `unknown` per Runtime Contract Rule #1)
 * @param expectedPainId - the pain id the caller expects this principle to be derived from
 */
function gradePrinciplePureCode(principle: unknown, expectedPainId: string): PrincipleGradeResult {
  const feedback: string[] = [];

  // Early return: reject non-principle artifacts
  if (isObject(principle) && Object.hasOwn(principle, 'artifactKind') && principle.artifactKind !== 'principle') {
    return {
      formatAdherence: 0,
      taskSuccess: 0,
      lineageConsistency: 0,
      overall: 0,
      feedback: `artifactKind is '${String(principle.artifactKind)}', expected 'principle'`,
    };
  }

  // ── Dimension 1: formatAdherence ──────────────────────────────────────
  // Shape must match PIArtifactSnapshot AND contentJson must parse to a JSON object.
  let formatAdherence = 0;
  let parsedContent: unknown = undefined;

  if (!isPIArtifactSnapshot(principle)) {
    feedback.push('artifact shape validation failed');
  } else {
    try {
      parsedContent = JSON.parse(principle.contentJson);
    } catch {
      feedback.push('contentJson is not valid JSON');
    }
    if (parsedContent !== undefined && !isObject(parsedContent)) {
      feedback.push('contentJson is not a JSON object');
      parsedContent = undefined;
    }
    if (parsedContent !== undefined) {
      formatAdherence = 1;
    }
  }

  // ── Dimension 2: taskSuccess ──────────────────────────────────────────
  // Required field: the principle's text must be a non-empty string.
  // Only evaluated when formatAdherence passed (contentJson is a parseable object).
  let taskSuccess = 0;
  if (formatAdherence === 1 && isObject(parsedContent)) {
    const text = parsedContent.text;
    if (typeof text === 'string' && text.length > 0) {
      taskSuccess = 1;
    } else {
      feedback.push('principleText is empty');
    }
  }

  // ── Dimension 3: lineageConsistency ───────────────────────────────────
  // sourceTaskId must be present and match the expected pain id (directly or
  // via the diagnosis_<painId> convention). Evaluated independently of
  // formatAdherence so a malformed contentJson still surfaces lineage drift.
  let lineageConsistency = 0;
  if (isPIArtifactSnapshot(principle)) {
    const sourceTaskId = principle.sourceTaskId;
    if (sourceTaskId.length === 0) {
      feedback.push('sourceTaskId is missing');
    } else if (sourceTaskIdMatchesPainId(sourceTaskId, expectedPainId)) {
      lineageConsistency = 1;
    } else {
      feedback.push('sourcePainId mismatch');
    }
  }

  const overall = (formatAdherence + taskSuccess + lineageConsistency) / 3;

  return {
    formatAdherence,
    taskSuccess,
    lineageConsistency,
    overall,
    feedback: feedback.join('; '),
  };
}

// ── Test fixtures: golden set from real activation-channel scenarios ────────
// These mirror the principle artifacts used in activation-prompt-e2e,
// story-a-full-chain, and activation-defer-archive-e2e — the three MVP
// activation paths (prompt, code_tool_hook lineage, defer_archive).

function createPromptChannelPrinciple(): unknown {
  return {
    artifactId: 'art-principle-prompt-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-pain-prompt-001',
    sourcePrincipleId: 'principle-prompt-001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: 'principle-prompt-001',
      text: 'Always read existing implementation before adding a parallel module',
      language: 'en',
    }),
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  };
}

function createFullChainPrinciple(): unknown {
  // Uses the diagnosis_<painId> lineage convention (ERR-008).
  return {
    artifactId: 'art-principle-fullchain-001',
    artifactKind: 'principle',
    sourceTaskId: 'diagnosis_pain_fullchain_001',
    sourcePrincipleId: 'principle-fullchain-001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: 'principle-fullchain-001',
      text: 'Always read existing implementation before adding a parallel module',
      language: 'en',
      derivedFrom: 'Agent added a parallel module without reading the existing implementation, causing duplication.',
    }),
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  };
}

function createDeferArchivePrinciple(): unknown {
  return {
    artifactId: 'art-principle-defer-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-pain-defer-001',
    sourcePrincipleId: 'principle-defer-001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: 'principle-defer-001',
      text: 'Prefer archiving completed work items over deleting them',
      language: 'en',
    }),
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  };
}

describe('gradePrinciplePureCode — golden set (real seed-customer scenarios)', () => {
  it('scores prompt-channel principle at full marks', () => {
    const result = gradePrinciplePureCode(createPromptChannelPrinciple(), 'task-pain-prompt-001');
    expect(result.formatAdherence).toBe(1);
    expect(result.taskSuccess).toBe(1);
    expect(result.lineageConsistency).toBe(1);
    expect(result.overall).toBeGreaterThanOrEqual(0.9);
    expect(result.feedback).toBe('');
  });

  it('scores full-chain principle (diagnosis_<painId> lineage) at full marks', () => {
    const result = gradePrinciplePureCode(createFullChainPrinciple(), 'pain_fullchain_001');
    expect(result.formatAdherence).toBe(1);
    expect(result.taskSuccess).toBe(1);
    expect(result.lineageConsistency).toBe(1);
    expect(result.overall).toBeGreaterThanOrEqual(0.9);
    expect(result.feedback).toBe('');
  });

  it('scores defer-archive principle at full marks', () => {
    const result = gradePrinciplePureCode(createDeferArchivePrinciple(), 'task-pain-defer-001');
    expect(result.formatAdherence).toBe(1);
    expect(result.taskSuccess).toBe(1);
    expect(result.lineageConsistency).toBe(1);
    expect(result.overall).toBeGreaterThanOrEqual(0.9);
    expect(result.feedback).toBe('');
  });
});

describe('gradePrinciplePureCode — failure dimensions', () => {
  it('fails taskSuccess when principleText is empty', () => {
    const principle = createPromptChannelPrinciple();
    if (isObject(principle)) {
      principle.contentJson = JSON.stringify({
        principleId: 'principle-prompt-001',
        text: '',
        language: 'en',
      });
    }
    const result = gradePrinciplePureCode(principle, 'task-pain-prompt-001');

    expect(result.formatAdherence).toBe(1);
    expect(result.taskSuccess).toBe(0);
    expect(result.lineageConsistency).toBe(1);
    expect(result.feedback).toContain('principleText is empty');
  });

  it('fails lineageConsistency when sourcePainId does not match expected', () => {
    const principle = createPromptChannelPrinciple();
    if (isObject(principle)) {
      principle.sourceTaskId = 'task-pain-different-001';
    }
    const result = gradePrinciplePureCode(principle, 'task-pain-prompt-001');

    expect(result.formatAdherence).toBe(1);
    expect(result.taskSuccess).toBe(1);
    expect(result.lineageConsistency).toBe(0);
    expect(result.feedback).toContain('sourcePainId mismatch');
  });

  it('fails formatAdherence when contentJson is not valid JSON', () => {
    const principle = createPromptChannelPrinciple();
    if (isObject(principle)) {
      principle.contentJson = 'not valid json {';
    }
    const result = gradePrinciplePureCode(principle, 'task-pain-prompt-001');

    expect(result.formatAdherence).toBe(0);
    expect(result.feedback).toContain('contentJson is not valid JSON');
  });

  it('fails formatAdherence when artifact shape is wrong (non-object input)', () => {
    const result = gradePrinciplePureCode('not-an-artifact', 'task-pain-prompt-001');

    expect(result.formatAdherence).toBe(0);
    expect(result.taskSuccess).toBe(0);
    expect(result.lineageConsistency).toBe(0);
    expect(result.feedback).toContain('artifact shape validation failed');
  });
});
