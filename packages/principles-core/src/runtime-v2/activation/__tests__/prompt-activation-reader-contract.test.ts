import { describe, it, expect } from 'vitest';
import {
  isRecord,
  filterPromptActivations,
  resolvePrincipleFromArtifact,
  trimToBudget,
  renderPrinciplesToDirectives,
  RUNTIME_V2_PRINCIPLE_BUDGET,
} from '../prompt-activation-reader-contract.js';
import type { ActivationStatusRecord } from '../activation-types.js';

function makeActivation(overrides: Partial<ActivationStatusRecord> = {}): ActivationStatusRecord {
  return {
    activationId: 'act-1',
    idempotencyKey: 'art-1::prompt',
    artifactId: 'art-1',
    channel: 'prompt',
    action: 'prompt_activate',
    targetRef: 'prependSystemContext',
    activatedAt: '2026-01-01T00:00:00Z',
    deactivatedAt: null,
    ...overrides,
  };
}

function makeArtifactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact_id: 'art-1',
    artifact_kind: 'principle',
    content_json: JSON.stringify({ principleId: 'P-001', text: 'Always use typeof checks' }),
    validation_status: 'validated',
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
        expect(result.principle.principleId).toBe('P-001');
        expect(result.principle.text).toBe('Always use typeof checks');
        expect(result.principle.artifactId).toBe('art-1');
        expect(result.principle.activationId).toBe('act-1');
      }
    });

    it('falls back to principleDraft.title and principleDraft.statement', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        content_json: JSON.stringify({
          principleDraft: { title: 'D-001', statement: 'Draft statement' },
        }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe('D-001');
        expect(result.principle.text).toBe('Draft statement');
      }
    });

    it('prefers principleId/text over principleDraft', () => {
      const activation = makeActivation();
      const artifact = makeArtifactRow({
        content_json: JSON.stringify({
          principleId: 'P-001',
          text: 'Primary text',
          principleDraft: { title: 'D-001', statement: 'Draft text' },
        }),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe('P-001');
        expect(result.principle.text).toBe('Primary text');
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
        content_json: JSON.stringify({ principleId: 'P-001' }),
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
      artifact.content_json = JSON.stringify({ principleId: 'P-001', text: 'Safe' });
      artifact.validation_status = 'validated';
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
    });

    it('handles content_json with inherited properties safely', () => {
      const activation = makeActivation();
      const contentObj = Object.create({ toString: 'inherited' });
      contentObj.principleId = 'P-001';
      contentObj.text = 'Safe text';
      const artifact = makeArtifactRow({
        content_json: JSON.stringify(contentObj),
      });
      const result = resolvePrincipleFromArtifact(artifact, activation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principle.principleId).toBe('P-001');
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
      expect(result).toContain('OWNER-APPROVED BEHAVIOR DIRECTIVES');
    });

    it('returns empty string when no principles injected', () => {
      const principles = [
        { principleId: 'P-001', text: 'Always use typeof', artifactId: 'a1', activationId: 'act1' },
      ];
      const result = renderPrinciplesToDirectives(principles, new Set());
      expect(result).toBe('');
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
      const result = renderPrinciplesToDirectives(principles, injectedIds, escapeXml);
      expect(result).toContain('P&lt;001&gt;');
      expect(result).toContain('A&amp;B');
    });
  });

  describe('RUNTIME_V2_PRINCIPLE_BUDGET', () => {
    it('is 2000', () => {
      expect(RUNTIME_V2_PRINCIPLE_BUDGET).toBe(2000);
    });
  });
});
