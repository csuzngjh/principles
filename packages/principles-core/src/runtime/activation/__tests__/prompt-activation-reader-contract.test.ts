import { describe, it, expect } from 'vitest';
import {
  isRecord,
  filterPromptActivations,
  resolvePrincipleFromArtifact,
  trimToBudget,
  renderPrinciplesToDirectives,
  RUNTIME_PRINCIPLE_BUDGET,
} from '../prompt-activation-reader-contract.js';
import { PROMPT_BUDGET_BASE_CHARS } from '../prompt-budget-policy.js';
import type { ActivationStatusRecord } from '../activation-types.js';

const PRINCIPLE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PRINCIPLE_ID = '22222222-2222-4222-8222-222222222222';

function makeActivation(overrides: Partial<ActivationStatusRecord> = {}): ActivationStatusRecord {
  return {
    activationId: 'act-1',
    idempotencyKey: 'art-1::prompt',
    artifactId: 'art-1',
    channel: 'prompt',
    action: 'prompt_activate',
    targetRef: `ledger://${PRINCIPLE_ID}`,
    activatedAt: '2026-01-01T00:00:00Z',
    deactivatedAt: null,
    ...overrides,
  };
}

function makeArtifactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact_id: 'art-1',
    artifact_kind: 'principle',
    content_json: JSON.stringify({ principleId: PRINCIPLE_ID, text: 'Always use typeof checks' }),
    validation_status: 'validated',
    source_principle_id: PRINCIPLE_ID,
    ...overrides,
  };
}

describe('prompt-activation-reader-contract', () => {
  describe('isRecord', () => {
    it('returns true for plain objects', () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
    });

    it('returns false for null', () => {
      expect(isRecord(null)).toBe(false);
    });

    it('returns false for arrays', () => {
      expect(isRecord([])).toBe(false);
      expect(isRecord([1, 2])).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isRecord('string')).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord(true)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });
  });

  describe('filterPromptActivations', () => {
    it('keeps only prompt/prompt_activate activations', () => {
      const activations = [
        makeActivation({ channel: 'prompt', action: 'prompt_activate' }),
        makeActivation({ channel: 'code_tool_hook', action: 'activate', activationId: 'act-2', artifactId: 'art-2' }),
        makeActivation({ channel: 'prompt', action: 'deactivate', activationId: 'act-3', artifactId: 'art-3' }),
        makeActivation({ channel: 'defer_archive', action: 'prompt_activate', activationId: 'act-4', artifactId: 'art-4' }),
      ];
      const result = filterPromptActivations(activations);
      expect(result).toHaveLength(1);
      expect(result[0]?.activationId).toBe('act-1');
    });

    it('returns empty for no matching activations', () => {
      const activations = [
        makeActivation({ channel: 'code_tool_hook', action: 'activate' }),
      ];
      expect(filterPromptActivations(activations)).toHaveLength(0);
    });

    it('excludes deactivated activations', () => {
      const activations = [
        makeActivation({ activationId: 'act-active', deactivatedAt: null }),
        makeActivation({ activationId: 'act-deactivated', deactivatedAt: '2026-06-01T00:00:00Z' }),
      ];
      const result = filterPromptActivations(activations);
      expect(result).toHaveLength(1);
      expect(result[0]?.activationId).toBe('act-active');
    });

    it('returns empty for empty input', () => {
      expect(filterPromptActivations([])).toHaveLength(0);
    });
  });

  describe('resolvePrincipleFromArtifact', () => {
    it('resolves a valid artifact row with principleId and text', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow();
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe(PRINCIPLE_ID);
        expect(result.principle.text).toBe('Always use typeof checks');
        expect(result.principle.artifactId).toBe('art-1');
        expect(result.principle.activationId).toBe('act-1');
      }
    });

    it('refuses a title-only identity even when principleDraft.statement exists', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        source_principle_id: undefined,
        content_json: JSON.stringify({
          principleDraft: { title: 'D-001', statement: 'Draft statement' },
        }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_missing_principle_id');
      }
    });

    it('uses principleDraft.statement as text but still requires a formal UUID', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        content_json: JSON.stringify({
          principleId: PRINCIPLE_ID,
          principleDraft: { title: 'D-001', statement: 'Draft statement' },
        }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe(PRINCIPLE_ID);
        expect(result.principle.text).toBe('Draft statement');
      }
    });

    it('prefers formal identity and text over principleDraft', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        content_json: JSON.stringify({
          principleId: PRINCIPLE_ID,
          text: 'Primary text',
          principleDraft: { title: 'D-001', statement: 'Draft text' },
        }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe(PRINCIPLE_ID);
        expect(result.principle.text).toBe('Primary text');
      }
    });

    it('refuses a non-UUID title in the identity column', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({ source_principle_id: 'A Fancy Principle Title' });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_principle_id_not_uuid');
      }
    });

    it('refuses a non-UUID title in content when no formal column exists', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        source_principle_id: undefined,
        content_json: JSON.stringify({ principleId: 'P-001', text: 'Some text' }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_principle_id_not_uuid');
      }
    });

    it('refuses an activation/artifact UUID mismatch (never downgrades to title matching)', () => {
      const activation = makeActivation({ targetRef: `ledger://${OTHER_PRINCIPLE_ID}` });
      const result = resolvePrincipleFromArtifact(makeArtifactRow(), activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('activation_artifact_principle_id_mismatch');
      }
    });

    it('refuses conflicting UUID authorities inside one artifact', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        source_principle_id: PRINCIPLE_ID,
        content_json: JSON.stringify({ principleId: OTHER_PRINCIPLE_ID, text: 'Some text' }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_identity_conflict');
      }
    });

    it('keeps a legacy title in content when a formal UUID column exists', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        source_principle_id: PRINCIPLE_ID,
        content_json: JSON.stringify({
          principleId: 'Legacy title',
          text: 'Some text',
          principleDraft: { title: 'Legacy title' },
        }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe(PRINCIPLE_ID);
      }
    });

    it('keeps a legacy title target working but marks it as legacy (no UUID generated)', () => {
      const activation = makeActivation({ targetRef: 'ledger://A Legacy Principle Title' });
      const artifact = makeArtifactRow({
        source_principle_id: undefined,
        content_json: JSON.stringify({ principleDraft: { title: 'A Legacy Principle Title', statement: 'Legacy statement' } }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe('A Legacy Principle Title');
        expect(result.principle.identityKind).toBe('legacy_title');
      }
    });

    it('refuses a legacy title target when the artifact carries a UUID identity', () => {
      const activation = makeActivation({ targetRef: 'ledger://A Legacy Principle Title' });
      const result = resolvePrincipleFromArtifact(makeArtifactRow(), activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('activation_artifact_principle_id_mismatch');
      }
    });

    it('treats principleDraft.title as display only for a legacy target', () => {
      const activation = makeActivation({ targetRef: 'ledger://A Legacy Principle Title' });
      const artifact = makeArtifactRow({
        source_principle_id: undefined,
        content_json: JSON.stringify({ principleDraft: { title: 'A Different Title', statement: 'Legacy statement' } }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe('A Legacy Principle Title');
        expect(result.principle.identityKind).toBe('legacy_title');
      }
    });

    it('refuses a non-ledger activation target even when the artifact has a UUID', () => {
      const activation = makeActivation({ targetRef: 'prependSystemContext' });
      const result = resolvePrincipleFromArtifact(makeArtifactRow(), activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('activation_target_ref_invalid');
      }
    });

    it('accepts the pending:// preview target without an identity comparison', () => {
      const activation = makeActivation({ targetRef: 'pending://art-1' });
      const result = resolvePrincipleFromArtifact(makeArtifactRow(), activation);
      expect(result.ok).toBe(true);
    });

    it('refuses a legacy target carrying a formal UUID artifact (no downgrade)', () => {
      const activation = makeActivation({ targetRef: 'ledger://not-a-uuid' });
      const result = resolvePrincipleFromArtifact(makeArtifactRow(), activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('activation_artifact_principle_id_mismatch');
      }
    });

    it('rejects non-record artifact row', () => {
      const activation = makeActivation();
      const result = resolvePrincipleFromArtifact(null, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_query_unexpected');
      }
    });

    it('rejects array artifact row', () => {
      const activation = makeActivation();
      const result = resolvePrincipleFromArtifact([1, 2], activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_query_unexpected');
      }
    });

    it('rejects artifact with missing artifact_id', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({ artifact_id: '' });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_not_found');
        expect(result.warning).toContain('nextAction=');
      }
    });

    it('stale activation with null artifact row includes nextAction for cleanup (PRI-355)', () => {
      const activation = makeActivation({ artifactId: 'art-mvp-acceptance-001' });
      const result = resolvePrincipleFromArtifact(null, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_query_unexpected');
        expect(result.warning).toContain('nextAction=');
        expect(result.warning).toContain('art-mvp-acceptance-001');
      }
    });

    it('rejects artifact with non-principle kind', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({ artifact_kind: 'trace' });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_not_principle');
      }
    });

    it('rejects artifact that is not validated', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({ validation_status: 'pending' });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_not_validated');
      }
    });

    it('rejects artifact with missing validation_status', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow();
      delete artifact.validation_status;
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_not_validated');
      }
    });

    it('rejects artifact with missing content_json', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow();
      delete artifact.content_json;
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_missing_content_json');
      }
    });

    it('rejects artifact with invalid JSON in content_json', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({ content_json: '{invalid json' });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_content_json_parse_error');
      }
    });

    it('rejects artifact where content_json parses to non-object', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({ content_json: '"a string"' });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_content_malformed');
      }
    });

    it('rejects artifact with missing principleId and no draft fallback', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        source_principle_id: undefined,
        content_json: JSON.stringify({ text: 'Some text' }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_missing_principle_id');
      }
    });

    it('rejects artifact with missing text and no draft fallback', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        content_json: JSON.stringify({ principleId: PRINCIPLE_ID }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_missing_text');
      }
    });

    it('rejects artifact with empty principleId and empty draft title', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        source_principle_id: undefined,
        content_json: JSON.stringify({ principleId: '', text: 'Some text', principleDraft: { title: '', statement: 'Draft' } }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('artifact_missing_principle_id');
      }
    });

    it('handles artifact with prototype-polluted keys safely', () => {
      const activation = makeActivation();
      const artifact = Object.create(null);
      artifact.__proto__ = { malicious: true };
      artifact.artifact_id = 'art-1';
      artifact.artifact_kind = 'principle';
      artifact.content_json = JSON.stringify({ principleId: PRINCIPLE_ID, text: 'Safe' });
      artifact.validation_status = 'validated';
      artifact.source_principle_id = PRINCIPLE_ID;
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
    });

    it('handles content_json with inherited properties safely', () => {
      const activation = makeActivation();
      const contentObj = Object.create({ toString: 'inherited' });
      contentObj.principleId = PRINCIPLE_ID;
      contentObj.text = 'Safe text';
      const artifact = makeArtifactRow({
        content_json: JSON.stringify(contentObj),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe(PRINCIPLE_ID);
        expect(result.principle.text).toBe('Safe text');
      }
    });

    it('includes nextAction in every warning', () => {
      const activation = makeActivation();
      const result = resolvePrincipleFromArtifact(null, activation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('nextAction=');
      }
    });
  });

  describe('trimToBudget', () => {
    it('includes all principles within budget', () => {
      const principles = [
        { principleId: 'P-001', text: 'Short', artifactId: 'a1', activationId: 'act1' },
      ];
      const { lines, injectedIds, truncated } = trimToBudget(principles, 2000);
      expect(lines.length).toBeGreaterThan(1);
      expect(injectedIds.has('P-001')).toBe(true);
      expect(truncated).toBe(false);
    });

    it('truncates when budget is exceeded', () => {
      const principles = Array.from({ length: 100 }, (_, i) => ({
        principleId: `P-${String(i).padStart(3, '0')}`,
        text: 'A'.repeat(100),
        artifactId: `a${i}`,
        activationId: `act${i}`,
      }));
      const { lines: _lines, injectedIds, truncated } = trimToBudget(principles, 500);
      expect(truncated).toBe(true);
      expect(injectedIds.size).toBeLessThan(100);
    });

    it('returns empty injectedIds for zero principles', () => {
      const { lines, injectedIds, truncated } = trimToBudget([], 2000);
      expect(injectedIds.size).toBe(0);
      expect(truncated).toBe(false);
      expect(lines).toHaveLength(1);
    });

    it('uses custom escape function', () => {
      const principles = [
        { principleId: 'P<001>', text: 'A&B', artifactId: 'a1', activationId: 'act1' },
      ];
      const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const { lines } = trimToBudget(principles, 2000, escapeXml);
      expect(lines[1]).toContain('P&lt;001&gt;');
      expect(lines[1]).toContain('A&amp;B');
    });
  });

  describe('renderPrinciplesToDirectives', () => {
    it('renders directive XML for injected principles', () => {
      const principles = [
        { principleId: 'P-001', text: 'Always use typeof', artifactId: 'a1', activationId: 'act1' },
        { principleId: 'P-002', text: 'Never use as', artifactId: 'a2', activationId: 'act2' },
      ];
      const injectedIds = new Set(['P-001', 'P-002']);
      const result = renderPrinciplesToDirectives(principles, injectedIds);
      expect(result).toContain('<directive id="P-001"');
      expect(result).toContain('MANDATORY: Always use typeof');
      expect(result).toContain('<directive id="P-002"');
      expect(result).toContain('MANDATORY: Never use as');
      expect(result).toContain('ACTIVE BEHAVIOR DIRECTIVES');
    });

    it('returns empty string when no principles injected', () => {
      const principles = [
        { principleId: 'P-001', text: 'Always use typeof', artifactId: 'a1', activationId: 'act1' },
      ];
      const result = renderPrinciplesToDirectives(principles, new Set());
      expect(result).toBe('');
    });

    it('PRI-532: appends the self-report instruction footer when selfReportInstruction is true', () => {
      const principles = [
        { principleId: 'P-001', text: 'Always use typeof', artifactId: 'a1', activationId: 'act1' },
      ];
      const injectedIds = new Set(['P-001']);
      const result = renderPrinciplesToDirectives(principles, injectedIds, { selfReportInstruction: true });
      expect(result).toContain('Self-report (OWNER visibility)');
      expect(result).toContain('📌 应用了你的原则「<directive id>」');
      expect(result).toContain('At most one line per directive per session');
    });

    it('PRI-532: selfReportInstruction false/omitted keeps the template byte-identical', () => {
      const principles = [
        { principleId: 'P-001', text: 'Always use typeof', artifactId: 'a1', activationId: 'act1' },
      ];
      const injectedIds = new Set(['P-001']);
      const withFalse = renderPrinciplesToDirectives(principles, injectedIds, { selfReportInstruction: false });
      const omitted = renderPrinciplesToDirectives(principles, injectedIds);
      expect(withFalse).toBe(omitted);
      expect(omitted).not.toContain('Self-report (OWNER visibility)');
      expect(omitted).not.toContain('📌');
    });

    it('skips principles not in injectedIds', () => {
      const principles = [
        { principleId: 'P-001', text: 'Included', artifactId: 'a1', activationId: 'act1' },
        { principleId: 'P-002', text: 'Excluded', artifactId: 'a2', activationId: 'act2' },
      ];
      const injectedIds = new Set(['P-001']);
      const result = renderPrinciplesToDirectives(principles, injectedIds);
      expect(result).toContain('P-001');
      expect(result).not.toContain('P-002');
    });

    it('uses custom escape function', () => {
      const principles = [
        { principleId: 'P<001>', text: 'A&B', artifactId: 'a1', activationId: 'act1' },
      ];
      const injectedIds = new Set(['P<001>']);
      const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const result = renderPrinciplesToDirectives(principles, injectedIds, { escapeFn: escapeXml });
      expect(result).toContain('P&lt;001&gt;');
      expect(result).toContain('A&amp;B');
    });
  });

  describe('P0-G activation authority provenance (Journey-9)', () => {
    it('system_policy 激活不得声称 OWNER-APPROVED,逐项标注 authority', () => {
      const principles = [
        { principleId: 'sys-1', text: 'system policy principle', artifactId: 'a1', activationId: 'act1', authority: 'system_policy' as const },
        { principleId: 'own-1', text: 'owner approved principle', artifactId: 'a2', activationId: 'act2', authority: 'owner' as const, approvedBy: 'console-owner' },
        { principleId: 'unk-1', text: 'unknown authority', artifactId: 'a3', activationId: 'act3' },
      ];
      const injectedIds = new Set(['sys-1', 'own-1', 'unk-1']);
      const result = renderPrinciplesToDirectives(principles, injectedIds);

      expect(result).not.toContain('OWNER-APPROVED');
      expect(result).toContain('ACTIVE BEHAVIOR DIRECTIVES');
      expect(result).toContain('<directive id="sys-1" source="runtime_v2_activation" authority="system_policy">');
      expect(result).toContain('<directive id="own-1" source="runtime_v2_activation" authority="owner">');
      expect(result).toContain('<directive id="unk-1" source="runtime_v2_activation">');
    });

    it('trimToBudget header 不再无条件声称 owner-approved', () => {
      const { lines } = trimToBudget([
        { principleId: 'p1', text: 't', artifactId: 'a', activationId: 'act' },
      ], 2000);
      expect(lines[0]).toBe('Runtime V2 activated principles:');
    });
  });

  describe('RUNTIME_PRINCIPLE_BUDGET', () => {
    it('is the policy base budget (single source of truth)', () => {
      expect(RUNTIME_PRINCIPLE_BUDGET).toBe(PROMPT_BUDGET_BASE_CHARS);
    });
  });
});

describe('exact artifact content revision', () => {
  it('retains distinct digests for metadata-only changes with identical directive text', () => {
    const first = resolvePrincipleFromArtifact(makeArtifactRow({ content_json: JSON.stringify({ principleId: 'same', text: 'same body', revisionNote: 'first' }) }), makeActivation());
    const second = resolvePrincipleFromArtifact(makeArtifactRow({ content_json: JSON.stringify({ principleId: 'same', text: 'same body', revisionNote: 'second' }) }), makeActivation());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.principle.text).toBe(second.principle.text);
      expect(first.principle.artifactContentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(first.principle.artifactContentSha256).not.toBe(second.principle.artifactContentSha256);
    }
  });
});
