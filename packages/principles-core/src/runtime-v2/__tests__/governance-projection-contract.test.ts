import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as runtimeV2 from '../index.js';

const validFacts = {
  schemaVersion: '1',
  principleId: 'principle-1',
  asOf: '2026-08-20T10:00:00.000Z',
  lineage: {
    principleId: 'principle-1',
    artifactIds: ['artifact-1'],
    taskIds: ['task-1'],
    revisionIdentities: [{ kind: 'none' }],
    confidence: 'strong',
    sourceRefs: [{ type: 'artifact', id: 'artifact-1' }],
  },
  principle: {
    schemaVersion: '1',
    family: 'principle',
    sourceRef: { type: 'principle', id: 'principle-1' },
    principleId: 'principle-1',
    lineageConfidence: 'strong',
    recordedAt: '2026-08-20T09:00:00.000Z',
    state: 'candidate',
  },
  tasks: [],
  runnerVerdicts: [],
  derivedRelations: [],
  approvals: [],
  activations: [],
  timelineEvents: [],
  collectionIssues: [],
};

describe('PRI-550 governance projection contracts', () => {
  it('exports the executable GovernanceFacts schema from the Runtime v2 boundary', () => {
    expect(Object.hasOwn(runtimeV2, 'GovernanceFactsSchema')).toBe(true);
  });

  it('accepts a complete aggregate rooted in a durable principle fact', () => {
    expect(Value.Check(runtimeV2.GovernanceFactsSchema, validFacts)).toBe(true);
  });

  it.each(['headlineCode', 'reasonCode', 'nextActionCode'] as const)(
    'rejects an unregistered summary %s',
    codeField => {
      const view = runtimeV2.deriveOwnerGovernanceView(validFacts);
      expect(Value.Check(runtimeV2.OwnerGovernanceViewSchema, {
        ...view,
        summary: { ...view.summary, [codeField]: 'governance.unregistered' },
      })).toBe(false);
    },
  );

  it.each([
    ['missing principle', { ...validFacts, principle: undefined }],
    ['non-object task element', { ...validFacts, tasks: [42] }],
    [
      'empty source identifier',
      {
        ...validFacts,
        principle: {
          ...validFacts.principle,
          sourceRef: { type: 'principle', id: '' },
        },
      },
    ],
    [
      'invalid required timestamp',
      {
        ...validFacts,
        principle: { ...validFacts.principle, recordedAt: 'not-a-timestamp' },
      },
    ],
    [
      'impossible required timestamp',
      {
        ...validFacts,
        principle: { ...validFacts.principle, recordedAt: '2026-99-99T99:99:99.000Z' },
      },
    ],
  ])('rejects %s instead of silently skipping it', (_name, value) => {
    expect(Value.Check(runtimeV2.GovernanceFactsSchema, value)).toBe(false);
  });
});
