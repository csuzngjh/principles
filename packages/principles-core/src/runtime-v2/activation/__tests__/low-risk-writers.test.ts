/**
 * Low Risk Writers Tests — PRI-145
 *
 * Unit tests for low-risk channel activation classes:
 * - PromptWriter — handles 'prompt' channel activation
 * - DeferArchiveWriter — handles 'defer_archive' channel activation
 * - extractPrincipleId() — parsing principle ID from PIArtifactSnapshot
 *
 * Tests verify:
 * - Correct extraction of principle IDs from artifact content
 * - canActivate() correctly validates artifact eligibility
 * - activate() produces correct activation records
 * - Boundary conditions and error handling
 *
 * ERR checklist:
 * - ERR-002: Every decision path carries reason + nextAction
 * - ERR-009: Malformed state fails loud
 * - ERR-025: Production-path tests, not just helpers
 */

import { describe, it, expect } from 'vitest';
import {
  extractPrincipleId,
  PromptWriter,
  DeferArchiveWriter,
} from '../low-risk-writers';
import type { PIArtifactSnapshot, CanActivateResult, WriterInput, WriterResult, PIArtifactValidationStatus } from '../activation-types';

// ── extractPrincipleId Tests ──────────────────────────────────────────────────

function createArtifact(
  contentJson: string,
  sourcePrincipleId?: string,
  artifactKind: 'principle' | 'rule' = 'principle',
  validationStatus: PIArtifactValidationStatus = 'validated',
): PIArtifactSnapshot {
  return {
    artifactId: 'art-001',
    artifactKind,
    sourceTaskId: 'task-001',
    sourcePrincipleId,
    lineageArtifactIds: [],
    validationStatus,
    contentJson,
    createdAt: '2026-05-17T00:00:00Z',
    updatedAt: '2026-05-17T00:00:00Z',
  };
}

describe('extractPrincipleId', () => {
  // Source principle ID from artifact property
  it('extracts principle ID from sourcePrincipleId property', () => {
    const artifact = createArtifact('{}', 'PRI-001');
    expect(extractPrincipleId(artifact)).toBe('PRI-001');
  });

  it('extracts principle ID from sourcePrincipleId with whitespace', () => {
    const artifact = createArtifact('{}', '  PRI-002  ');
    expect(extractPrincipleId(artifact)).toBe('PRI-002');
  });

  it('returns null for empty sourcePrincipleId', () => {
    const artifact = createArtifact('{}', '');
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for whitespace-only sourcePrincipleId', () => {
    const artifact = createArtifact('{}', '   ');
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  // Content JSON extraction
  it('extracts principle ID from contentJson principleId field', () => {
    const artifact = createArtifact(JSON.stringify({ principleId: 'PRI-003' }));
    expect(extractPrincipleId(artifact)).toBe('PRI-003');
  });

  it('extracts principle ID from contentJson sourcePrincipleId field', () => {
    const artifact = createArtifact(JSON.stringify({ sourcePrincipleId: 'PRI-004' }));
    expect(extractPrincipleId(artifact)).toBe('PRI-004');
  });

  it('extracts principle ID from contentJson principleDraft.title field', () => {
    const artifact = createArtifact(JSON.stringify({
      principleDraft: { title: 'PRI-005' },
    }));
    expect(extractPrincipleId(artifact)).toBe('PRI-005');
  });

  // Priority: sourcePrincipleId property takes precedence over contentJson
  it('sourcePrincipleId property takes precedence over contentJson', () => {
    const artifact = createArtifact(
      JSON.stringify({ principleId: 'PRI-006' }),
      'PRI-007',
    );
    expect(extractPrincipleId(artifact)).toBe('PRI-007');
  });

  // Whitespace trimming
  it('trims whitespace from principleId in contentJson', () => {
    const artifact = createArtifact(JSON.stringify({ principleId: '  PRI-008  ' }));
    expect(extractPrincipleId(artifact)).toBe('PRI-008');
  });

  it('trims whitespace from sourcePrincipleId in contentJson', () => {
    const artifact = createArtifact(JSON.stringify({ sourcePrincipleId: '  PRI-009  ' }));
    expect(extractPrincipleId(artifact)).toBe('PRI-009');
  });

  it('trims whitespace from principleDraft.title', () => {
    const artifact = createArtifact(JSON.stringify({
      principleDraft: { title: '  PRI-010  ' },
    }));
    expect(extractPrincipleId(artifact)).toBe('PRI-010');
  });

  // Empty/invalid contentJson
  it('returns null for empty contentJson', () => {
    const artifact = createArtifact('');
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for invalid JSON contentJson', () => {
    const artifact = createArtifact('not valid json');
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for JSON array contentJson', () => {
    const artifact = createArtifact('[1, 2, 3]');
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for JSON primitive contentJson', () => {
    const artifact = createArtifact('"just a string"');
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for JSON null contentJson', () => {
    const artifact = createArtifact('null');
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  // Empty principle ID fields
  it('returns null for empty principleId in contentJson', () => {
    const artifact = createArtifact(JSON.stringify({ principleId: '' }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for empty sourcePrincipleId in contentJson', () => {
    const artifact = createArtifact(JSON.stringify({ sourcePrincipleId: '' }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for empty principleDraft.title', () => {
    const artifact = createArtifact(JSON.stringify({
      principleDraft: { title: '' },
    }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for non-string principleId', () => {
    const artifact = createArtifact(JSON.stringify({ principleId: 123 }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for non-string sourcePrincipleId', () => {
    const artifact = createArtifact(JSON.stringify({ sourcePrincipleId: null }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for non-object principleDraft', () => {
    const artifact = createArtifact(JSON.stringify({
      principleDraft: 'not an object',
    }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  it('returns null for non-string principleDraft.title', () => {
    const artifact = createArtifact(JSON.stringify({
      principleDraft: { title: 456 },
    }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  // Complex contentJson structures
  it('extracts from nested JSON structure', () => {
    const artifact = createArtifact(JSON.stringify({
      metadata: { version: '1.0' },
      principleId: 'PRI-011',
      content: 'Some content',
    }));
    expect(extractPrincipleId(artifact)).toBe('PRI-011');
  });

  it('returns null when no principle ID fields present', () => {
    const artifact = createArtifact(JSON.stringify({
      title: 'Some Title',
      description: 'Some description',
    }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  // Boundary: principleDraft without title
  it('returns null for principleDraft without title field', () => {
    const artifact = createArtifact(JSON.stringify({
      principleDraft: { description: 'No title here' },
    }));
    expect(extractPrincipleId(artifact)).toBeNull();
  });

  // Real-world patterns
  it('extracts from typical principle artifact content', () => {
    const artifact = createArtifact(JSON.stringify({
      principleId: 'PRI-012',
      title: 'Test Principle',
      description: 'A test principle for validation',
      ruleIds: ['RULE-001'],
    }));
    expect(extractPrincipleId(artifact)).toBe('PRI-012');
  });

  it('extracts from artifact with sourcePrincipleId reference', () => {
    const artifact = createArtifact(JSON.stringify({
      sourcePrincipleId: 'PRI-013',
      derivedFrom: 'original principle',
    }));
    expect(extractPrincipleId(artifact)).toBe('PRI-013');
  });
});

// ── PromptWriter Tests ────────────────────────────────────────────────────────

describe('PromptWriter', () => {
  const writer = new PromptWriter();

  it('channel is prompt', () => {
    expect(writer.channel).toBe('prompt');
  });

  describe('canActivate', () => {
    it('returns ok:true for validated principle artifact with principle ID', async () => {
      const artifact = createArtifact(JSON.stringify({ principleId: 'PRI-001' }));
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(true);
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:false for non-principle artifact kind', async () => {
      const artifact = createArtifact(
        JSON.stringify({ principleId: 'PRI-002' }),
        undefined,
        'rule',
      );
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('artifact_kind_not_principle');
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:false for pending validation status', async () => {
      const artifact = createArtifact(
        JSON.stringify({ principleId: 'PRI-003' }),
        undefined,
        'principle',
        'pending',
      );
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('artifact_validation_status_pending');
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:false for rejected validation status', async () => {
      const artifact = createArtifact(
        JSON.stringify({ principleId: 'PRI-004' }),
        undefined,
        'principle',
        'rejected',
      );
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('artifact_validation_status_rejected');
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:false for artifact without principle ID', async () => {
      const artifact = createArtifact('{}');
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no_principle_id_in_artifact');
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:false for artifact with empty contentJson', async () => {
      const artifact = createArtifact('');
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no_principle_id_in_artifact');
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:true when sourcePrincipleId property is present', async () => {
      const artifact = createArtifact('{}', 'PRI-005');
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(true);
      expect(result.riskLevel).toBe('low');
    });
  });

  describe('activate', () => {
    it('creates activation record with correct format', async () => {
      const artifact = createArtifact(JSON.stringify({ principleId: 'PRI-001' }));
      const input: WriterInput = {
        artifactId: 'art-001',
        channel: 'prompt',
        principleId: 'PRI-001',
        idempotencyKey: 'art-001::prompt',
        now: '2026-05-17T00:00:00Z',
      };
      const result = await writer.activate(input, artifact);
      expect(result.activationId).toBe('act_prompt_PRI-001');
      expect(result.action).toBe('prompt_activate');
      expect(result.targetRef).toBe('ledger://PRI-001');
    });

    it('ignores artifact in activate (uses input.principleId)', async () => {
      const artifact = createArtifact('{}'); // No principle ID
      const input: WriterInput = {
        artifactId: 'art-002',
        channel: 'prompt',
        principleId: 'PRI-002',
        idempotencyKey: 'art-002::prompt',
        now: '2026-05-17T00:00:00Z',
      };
      const result = await writer.activate(input, artifact);
      expect(result.activationId).toBe('act_prompt_PRI-002');
    });

    it('creates unique activationId per principleId', async () => {
      const artifact = createArtifact('{}');
      const input1: WriterInput = {
        artifactId: 'art-001',
        channel: 'prompt',
        principleId: 'PRI-AAA',
        idempotencyKey: 'art-001::prompt',
        now: '2026-05-17T00:00:00Z',
      };
      const input2: WriterInput = {
        artifactId: 'art-002',
        channel: 'prompt',
        principleId: 'PRI-BBB',
        idempotencyKey: 'art-002::prompt',
        now: '2026-05-17T00:00:00Z',
      };
      const result1 = await writer.activate(input1, artifact);
      const result2 = await writer.activate(input2, artifact);
      expect(result1.activationId).not.toBe(result2.activationId);
    });
  });
});

// ── DeferArchiveWriter Tests ──────────────────────────────────────────────────

describe('DeferArchiveWriter', () => {
  const writer = new DeferArchiveWriter();

  it('channel is defer_archive', () => {
    expect(writer.channel).toBe('defer_archive');
  });

  describe('canActivate', () => {
    it('returns ok:true for validated principle artifact with principle ID', async () => {
      const artifact = createArtifact(JSON.stringify({ principleId: 'PRI-001' }));
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(true);
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:false for non-principle artifact kind', async () => {
      const artifact = createArtifact(
        JSON.stringify({ principleId: 'PRI-002' }),
        undefined,
        'rule',
      );
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('artifact_kind_not_principle');
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:false for pending validation status', async () => {
      const artifact = createArtifact(
        JSON.stringify({ principleId: 'PRI-003' }),
        undefined,
        'principle',
        'pending',
      );
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('artifact_validation_status_pending');
      expect(result.riskLevel).toBe('low');
    });

    it('returns ok:false for artifact without principle ID', async () => {
      const artifact = createArtifact('{}');
      const result = await writer.canActivate(artifact);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no_principle_id_in_artifact');
      expect(result.riskLevel).toBe('low');
    });

    it('shares same validation logic as PromptWriter', async () => {
      const promptWriter = new PromptWriter();
      const artifacts = [
        createArtifact(JSON.stringify({ principleId: 'PRI-001' })),
        createArtifact('{}', undefined, 'rule'),
        createArtifact('{}', undefined, 'principle', 'pending'),
        createArtifact('{}'),
      ];
      for (const artifact of artifacts) {
        const promptResult = await promptWriter.canActivate(artifact);
        const archiveResult = await writer.canActivate(artifact);
        expect(promptResult.ok).toBe(archiveResult.ok);
        if (!promptResult.ok && !archiveResult.ok) {
          expect(promptResult.reason).toBe(archiveResult.reason);
        }
      }
    });
  });

  describe('activate', () => {
    it('creates activation record with defer_archive action', async () => {
      const artifact = createArtifact(JSON.stringify({ principleId: 'PRI-001' }));
      const input: WriterInput = {
        artifactId: 'art-001',
        channel: 'defer_archive',
        principleId: 'PRI-001',
        idempotencyKey: 'art-001::defer_archive',
        now: '2026-05-17T00:00:00Z',
      };
      const result = await writer.activate(input, artifact);
      expect(result.activationId).toBe('act_archive_PRI-001');
      expect(result.action).toBe('defer_archive');
      expect(result.targetRef).toBe('ledger://PRI-001#archived');
    });

    it('targetRef includes #archived suffix', async () => {
      const artifact = createArtifact('{}');
      const input: WriterInput = {
        artifactId: 'art-002',
        channel: 'defer_archive',
        principleId: 'PRI-002',
        idempotencyKey: 'art-002::defer_archive',
        now: '2026-05-17T00:00:00Z',
      };
      const result = await writer.activate(input, artifact);
      expect(result.targetRef).toContain('#archived');
    });

    it('creates different activationId format than PromptWriter', async () => {
      const promptWriter = new PromptWriter();
      const artifact = createArtifact('{}');
      const promptInput: WriterInput = {
        artifactId: 'art-001',
        channel: 'prompt',
        principleId: 'PRI-001',
        idempotencyKey: 'art-001::prompt',
        now: '2026-05-17T00:00:00Z',
      };
      const archiveInput: WriterInput = {
        artifactId: 'art-001',
        channel: 'defer_archive',
        principleId: 'PRI-001',
        idempotencyKey: 'art-001::defer_archive',
        now: '2026-05-17T00:00:00Z',
      };
      const promptResult = await promptWriter.activate(promptInput, artifact);
      const archiveResult = await writer.activate(archiveInput, artifact);
      expect(promptResult.activationId).toBe('act_prompt_PRI-001');
      expect(archiveResult.activationId).toBe('act_archive_PRI-001');
      expect(promptResult.action).toBe('prompt_activate');
      expect(archiveResult.action).toBe('defer_archive');
    });
  });
});

// ── Integration Tests ────────────────────────────────────────────────────────

describe('integration: PromptWriter + DeferArchiveWriter', () => {
  it('both writers reject same invalid artifacts', async () => {
    const promptWriter = new PromptWriter();
    const archiveWriter = new DeferArchiveWriter();

    const invalidArtifacts = [
      createArtifact('{}', undefined, 'rule'), // wrong kind
      createArtifact('{}', undefined, 'principle', 'pending'), // wrong status
      createArtifact('{}'), // no principle ID
    ];

    for (const artifact of invalidArtifacts) {
      const promptResult = await promptWriter.canActivate(artifact);
      const archiveResult = await archiveWriter.canActivate(artifact);
      expect(promptResult.ok).toBe(false);
      expect(archiveResult.ok).toBe(false);
    }
  });

  it('both writers accept same valid artifacts', async () => {
    const promptWriter = new PromptWriter();
    const archiveWriter = new DeferArchiveWriter();

    const validArtifact = createArtifact(JSON.stringify({ principleId: 'PRI-001' }));

    const promptResult = await promptWriter.canActivate(validArtifact);
    const archiveResult = await archiveWriter.canActivate(validArtifact);

    expect(promptResult.ok).toBe(true);
    expect(archiveResult.ok).toBe(true);
    expect(promptResult.riskLevel).toBe('low');
    expect(archiveResult.riskLevel).toBe('low');
  });

  it('both writers produce different activation records for same principle', async () => {
    const promptWriter = new PromptWriter();
    const archiveWriter = new DeferArchiveWriter();
    const artifact = createArtifact(JSON.stringify({ principleId: 'PRI-001' }));

    const promptResult = await promptWriter.activate({
      artifactId: 'art-001',
      channel: 'prompt',
      principleId: 'PRI-001',
      idempotencyKey: 'art-001::prompt',
      now: '2026-05-17T00:00:00Z',
    }, artifact);

    const archiveResult = await archiveWriter.activate({
      artifactId: 'art-001',
      channel: 'defer_archive',
      principleId: 'PRI-001',
      idempotencyKey: 'art-001::defer_archive',
      now: '2026-05-17T00:00:00Z',
    }, artifact);

    // Different activation IDs
    expect(promptResult.activationId).not.toBe(archiveResult.activationId);

    // Different actions
    expect(promptResult.action).toBe('prompt_activate');
    expect(archiveResult.action).toBe('defer_archive');

    // Different target refs
    expect(promptResult.targetRef).toBe('ledger://PRI-001');
    expect(archiveResult.targetRef).toBe('ledger://PRI-001#archived');
  });
});