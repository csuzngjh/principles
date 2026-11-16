/**
 * PD-SPEC-001 — redaction canary tests (Owner remediation Phase 1 §4.3).
 *
 * Proves the public-repo projection is fail-closed: a synthetic pain carrying
 * canary Owner text, nested string-encoded JSON evidence, session ids, local
 * paths and pipeline free-text must NEVER survive into the projection, and the
 * leak assertion must FAIL LOUD when any canary is planted into a projection.
 */
import { describe, it, expect } from 'vitest';
import {
  redactForPublication,
  assertNoVerbatimLeak,
  anonId,
  safeError,
  placeholder,
} from '../../experiment/prompt-v2/scripts/redact-for-publication.mjs';

const CANARY_TEXT = 'CANARY-OWNER-WORDS-这是Owner原话金丝雀-7f3a91不得公开';
const CANARY_NOTE = 'CANARY-EVIDENCE-NOTE-嵌套证据金丝雀-9bb27c';
const CANARY_SESSION = 'b2c88df8ca8b-1111-2222-3333-444455556666';
const CANARY_PATH = 'D:\\some-private\\workspace';
const CANARY_SCOPE = 'CANARY-SCOPE-FREE-TEXT-适用范围金丝雀';

function canaryFull() {
  return {
    samples: [
      {
        experimentPainId: 'S-CANARY',
        painEvent: { text: CANARY_TEXT, reason: CANARY_TEXT, session_id: CANARY_SESSION, severity: 'severe' },
        diagnosisTarget: {
          reasonSummary: CANARY_TEXT,
          workspaceDir: CANARY_PATH,
          sessionIdHint: CANARY_SESSION,
          provenanceReason: CANARY_TEXT,
          evidence: [{ sourceRef: 'agent_turn:2026-01-01T00:00:00.000Z', note: CANARY_NOTE }],
          correctionEvidence: { text: CANARY_TEXT, sessionId: CANARY_SESSION },
        },
        painDiagnosis: {
          root_cause: CANARY_TEXT,
          // String-encoded JSON evidence (the v1 leak class) — must be parsed,
          // recursively redacted and re-serialized.
          evidence_json: JSON.stringify([
            { sourceRef: 'owner_correction', note: CANARY_TEXT },
            { sourceRef: 'conversationWindow', note: CANARY_NOTE, nested: { deep: CANARY_TEXT } },
          ]),
        },
        stageArtifacts: {
          rootcause: {
            artifacts: [{ artifact_id: 'pi-art-canary', content_json: JSON.stringify({ ambiguityNotes: [CANARY_TEXT], intentTension: { evidence: [CANARY_TEXT], explanation: CANARY_NOTE } }) }],
            succeededRunOutputPayload: JSON.stringify({ antiPatterns: [CANARY_TEXT], principleCandidate: { scope: CANARY_SCOPE } }),
            runs: [{ run_id: 'run_canary_1', reason: '[timeout] LLM request timed out: CANARY-in-message' }],
          },
        },
        candidates: [{ candidate_id: 'c-1', title: CANARY_TEXT, description: CANARY_NOTE, abstracted_principle: CANARY_TEXT }],
        textPreview: CANARY_TEXT,
      },
    ],
  };
}

function collectStrings(v, sink) {
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, sink); return; }
  if (v && typeof v === 'object') { for (const x of Object.values(v)) collectStrings(x, sink); return; }
  if (typeof v === 'string') sink.push(v);
}

const CANARIES = [CANARY_TEXT, CANARY_NOTE, CANARY_SESSION, CANARY_PATH, CANARY_SCOPE];

describe('PD-SPEC-001 redaction canaries', () => {
  it('no canary original survives the public projection (structure + text)', () => {
    const full = canaryFull();
    const projected = redactForPublication(full);
    const retained = [];
    collectStrings(projected, retained);
    for (const canary of CANARIES) {
      for (const s of retained) {
        expect(s.includes(canary), `canary leaked into retained string: ${JSON.stringify(s.slice(0, 60))}`).toBe(false);
      }
    }
  });

  it('nested string-encoded evidence_json is parsed, redacted and re-serialized (structure kept)', () => {
    const projected = redactForPublication(canaryFull());
    const evidenceJson = projected.samples[0].painDiagnosis.evidence_json;
    expect(typeof evidenceJson).toBe('string');
    const parsed = JSON.parse(evidenceJson);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].sourceRef).toBe('owner_correction'); // structural ref survives
    expect(parsed[0].note).not.toContain(CANARY_TEXT); // text redacted
    expect(parsed[0].note.startsWith('«redacted')).toBe(true);
    expect(parsed[1].nested.deep.startsWith('«redacted')).toBe(true); // recursion reaches nested objects
  });

  it('session ids become stable irreversible anon ids (correlatable, not relatable)', () => {
    expect(anonId(CANARY_SESSION)).toBe(anonId(CANARY_SESSION));
    expect(anonId(CANARY_SESSION)).not.toBe(anonId('other-session'));
    expect(anonId(CANARY_SESSION).startsWith('anon-')).toBe(true);
    const projected = redactForPublication(canaryFull());
    expect(projected.samples[0].painEvent.session_id).toBe(anonId(CANARY_SESSION));
    expect(projected.samples[0].diagnosisTarget.sessionIdHint).toBe(anonId(CANARY_SESSION));
  });

  it('scope keeps the Distiller enum but redacts free text', () => {
    const projected = redactForPublication(canaryFull());
    const payload = JSON.parse(projected.samples[0].stageArtifacts.rootcause.succeededRunOutputPayload);
    expect(payload.principleCandidate.scope.startsWith('«redacted')).toBe(true);
    const enumKept = redactForPublication({ scope: 'general' });
    expect(enumKept.scope).toBe('general');
  });

  it('last_error maps to a safe failure CLASS, never the verbatim message', () => {
    const projected = redactForPublication(canaryFull());
    const run = projected.samples[0].stageArtifacts.rootcause.runs[0];
    expect(run.reason).toBe('timeout');
    expect(run.reason.includes('CANARY')).toBe(false);
    expect(safeError('[rate_limit] 00（UTC+8）恢复')).toBe('rate_limit');
    expect(safeError('Some totally unknown failure CANARY-xyz').startsWith('«redacted')).toBe(true);
  });

  it('assertNoVerbatimLeak FAILS LOUD when a canary is planted into a projection (positive control)', () => {
    const full = canaryFull();
    const projected = redactForPublication(full);
    // Positive control: plant one canary back into the projection — the
    // assertion MUST throw, proving it can actually catch leaks.
    const poisoned = JSON.parse(JSON.stringify(projected));
    poisoned.samples[0].painEvent.text = 'harmless-looking sentence containing ' + CANARY_TEXT;
    expect(() => assertNoVerbatimLeak(full, poisoned)).toThrow(/REDACTION LEAK/);
    // And the clean projection passes.
    expect(() => assertNoVerbatimLeak(full, projected)).not.toThrow();
  });

  it('placeholder is deterministic and length-annotated', () => {
    expect(placeholder('abc')).toBe(placeholder('abc'));
    expect(placeholder('abc')).toMatch(/^«redacted sha256:[0-9a-f]{16} len:3»$/);
  });
});
