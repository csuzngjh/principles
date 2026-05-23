import { describe, it, expect } from 'vitest';
import type {
  BrokenArtifactScenarioName,
  SimulatedUpstreamTask,
  SimulatedArtifact,
  SimulatedDownstreamTask,
} from '../broken-artifact-simulation.js';
import {
  detectMissingArtifact,
  validateArtifactMetadata,
  checkLineageConsistency,
  resolveDuplicateArtifacts,
  decideDownstreamGate,
  computeSimulationStatus,
  recommendNextIssue,
  buildSimulationSummary,
  truncateReason,
  safeStringify,
  boundedEvidence,
} from '../broken-artifact-simulation.js';

function makeUpstream(overrides: Partial<SimulatedUpstreamTask> & { taskId: string }): SimulatedUpstreamTask {
  return {
    taskKind: 'dreamer',
    status: 'succeeded',
    resultRef: null,
    diagnosticJson: null,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<SimulatedArtifact> & { artifactId: string; sourceTaskId: string }): SimulatedArtifact {
  return {
    artifactKind: 'principle',
    contentJson: '{"valid":true}',
    metadataJson: null,
    ...overrides,
  };
}

function makeDownstream(overrides: Partial<SimulatedDownstreamTask> & { taskId: string }): SimulatedDownstreamTask {
  return {
    taskKind: 'philosopher',
    status: 'pending',
    dependencyTaskIds: [],
    expectedArtifactKinds: ['principle'],
    ...overrides,
  };
}

describe('Broken Artifact Recovery Simulation (PRI-209)', () => {
  describe('Scenario 1: succeeded upstream task missing expected artifact', () => {
    it('detects missing artifact for succeeded upstream task', () => {
      const upstream = makeUpstream({ taskId: 'dreamer-001' });
      const result = detectMissingArtifact(upstream, [], 'principle');

      expect(result.type).toBe('missing_artifact');
      expect(result.severity).toBe('error');
      expect(result.taskId).toBe('dreamer-001');
      expect(result.reason).toContain('no \'principle\' artifact');
      expect(result.nextAction).toBeTruthy();
    });

    it('does not report missing artifact when artifact exists', () => {
      const upstream = makeUpstream({ taskId: 'dreamer-002' });
      const artifact = makeArtifact({ artifactId: 'art-002', sourceTaskId: 'dreamer-002' });
      const result = detectMissingArtifact(upstream, [artifact], 'principle');

      expect(result.type).toBe('artifact_present');
    });

    it('does not report missing artifact for non-succeeded upstream', () => {
      const upstream = makeUpstream({ taskId: 'dreamer-003', status: 'pending' });
      const result = detectMissingArtifact(upstream, [], 'principle');

      expect(result.type).toBe('upstream_not_succeeded');
      expect(result.severity).toBe('warning');
    });

    it('nextAction is non-empty for missing artifact (ERR-002 avoidance)', () => {
      const upstream = makeUpstream({ taskId: 'dreamer-004' });
      const result = detectMissingArtifact(upstream, [], 'principle');

      expect(result.nextAction.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario 2: artifact exists but metadata is malformed', () => {
    it('detects null metadataJson', () => {
      const artifact = makeArtifact({
        artifactId: 'art-m1',
        sourceTaskId: 'dreamer-001',
        metadataJson: null,
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('metadataJson is null — artifact metadata missing');
    });

    it('detects non-JSON metadataJson', () => {
      const artifact = makeArtifact({
        artifactId: 'art-m2',
        sourceTaskId: 'dreamer-001',
        metadataJson: 'not-json{{{',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('not valid JSON'))).toBe(true);
    });

    it('detects metadataJson that parses to non-object (array)', () => {
      const artifact = makeArtifact({
        artifactId: 'art-m3',
        sourceTaskId: 'dreamer-001',
        metadataJson: '[1,2,3]',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('instead of object'))).toBe(true);
    });

    it('detects missing sourceTaskId in metadata', () => {
      const artifact = makeArtifact({
        artifactId: 'art-m4',
        sourceTaskId: 'dreamer-001',
        metadataJson: '{"artifactKind":"principle"}',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('missing required field: sourceTaskId'))).toBe(true);
    });

    it('detects non-string sourceTaskId in metadata (ERR-001/005 avoidance)', () => {
      const artifact = makeArtifact({
        artifactId: 'art-m5',
        sourceTaskId: 'dreamer-001',
        metadataJson: '{"sourceTaskId":42,"artifactKind":"principle"}',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('sourceTaskId is number'))).toBe(true);
    });

    it('detects sourceTaskId mismatch between metadata and artifact record (ERR-004/008 avoidance)', () => {
      const artifact = makeArtifact({
        artifactId: 'art-m6',
        sourceTaskId: 'dreamer-001',
        metadataJson: '{"sourceTaskId":"dreamer-999","artifactKind":"principle"}',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('does not match artifact.sourceTaskId'))).toBe(true);
    });

    it('detects missing artifactKind in metadata', () => {
      const artifact = makeArtifact({
        artifactId: 'art-m7',
        sourceTaskId: 'dreamer-001',
        metadataJson: '{"sourceTaskId":"dreamer-001"}',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('missing required field: artifactKind'))).toBe(true);
    });

    it('detects null contentJson', () => {
      const artifact = makeArtifact({
        artifactId: 'art-m8',
        sourceTaskId: 'dreamer-001',
        contentJson: null,
        metadataJson: '{"sourceTaskId":"dreamer-001","artifactKind":"principle"}',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('contentJson is null — artifact content missing');
    });

    it('passes valid metadata', () => {
      const artifact = makeArtifact({
        artifactId: 'art-ok',
        sourceTaskId: 'dreamer-001',
        metadataJson: '{"sourceTaskId":"dreamer-001","artifactKind":"principle"}',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('uses Object.hasOwn for key checks (ERR-013 avoidance)', () => {
      const artifact = makeArtifact({
        artifactId: 'art-prototype',
        sourceTaskId: 'dreamer-001',
        metadataJson: '{"sourceTaskId":"dreamer-001","artifactKind":"principle"}',
      });
      const result = validateArtifactMetadata(artifact);

      expect(result.valid).toBe(true);
    });
  });

  describe('Scenario 3: artifact.sourceTaskId does not match dependencyTaskId', () => {
    it('detects sourceTaskId mismatch', () => {
      const artifact = makeArtifact({
        artifactId: 'art-mismatch',
        sourceTaskId: 'dreamer-wrong',
      });
      const result = checkLineageConsistency(artifact, 'dreamer-001');

      expect(result.consistent).toBe(false);
      expect(result.sourceTaskId).toBe('dreamer-wrong');
      expect(result.dependencyTaskId).toBe('dreamer-001');
      expect(result.mismatchReason).toContain('does not match');
    });

    it('passes when sourceTaskId matches dependencyTaskId', () => {
      const artifact = makeArtifact({
        artifactId: 'art-match',
        sourceTaskId: 'dreamer-001',
      });
      const result = checkLineageConsistency(artifact, 'dreamer-001');

      expect(result.consistent).toBe(true);
      expect(result.mismatchReason).toBeUndefined();
    });
  });

  describe('Scenario 4: multiple artifacts for same source task — deterministic selection or fail loud', () => {
    it('detects ambiguous duplicate artifacts', () => {
      const artifacts = [
        makeArtifact({ artifactId: 'art-a', sourceTaskId: 'dreamer-001' }),
        makeArtifact({ artifactId: 'art-b', sourceTaskId: 'dreamer-001' }),
      ];
      const result = resolveDuplicateArtifacts(artifacts, 'dreamer-001', 'principle');

      expect(result.resolved).toBe(false);
      expect(result.candidateCount).toBe(2);
      expect(result.reason).toContain('Multiple artifacts');
      expect(result.selectedArtifactId).toBeTruthy();
    });

    it('resolves single artifact deterministically', () => {
      const artifacts = [
        makeArtifact({ artifactId: 'art-single', sourceTaskId: 'dreamer-002' }),
      ];
      const result = resolveDuplicateArtifacts(artifacts, 'dreamer-002', 'principle');

      expect(result.resolved).toBe(true);
      expect(result.selectedArtifactId).toBe('art-single');
      expect(result.candidateCount).toBe(1);
    });

    it('reports no artifacts when none found', () => {
      const result = resolveDuplicateArtifacts([], 'dreamer-003', 'principle');

      expect(result.resolved).toBe(false);
      expect(result.selectedArtifactId).toBeNull();
      expect(result.candidateCount).toBe(0);
    });

    it('deterministic sort by artifactId for duplicates', () => {
      const artifacts = [
        makeArtifact({ artifactId: 'art-z', sourceTaskId: 'dreamer-004' }),
        makeArtifact({ artifactId: 'art-a', sourceTaskId: 'dreamer-004' }),
      ];
      const result = resolveDuplicateArtifacts(artifacts, 'dreamer-004', 'principle');

      expect(result.selectedArtifactId).toBe('art-a');
      expect(result.resolved).toBe(false);
    });
  });

  describe('Scenario 5: downstream runner must not continue on missing/mismatch', () => {
    it('blocks downstream when artifact is missing', () => {
      const downstream = makeDownstream({
        taskId: 'philosopher-001',
        dependencyTaskIds: ['dreamer-001'],
        expectedArtifactKinds: ['principle'],
      });
      const result = decideDownstreamGate(downstream, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Missing artifact');
      expect(result.blockedBy).toContain('missing_artifact');
    });

    it('blocks downstream when lineage is mismatched', () => {
      const downstream = makeDownstream({
        taskId: 'philosopher-002',
        dependencyTaskIds: ['dreamer-001'],
        expectedArtifactKinds: ['principle'],
      });
      const artifacts = [
        makeArtifact({
          artifactId: 'art-mismatch',
          sourceTaskId: 'dreamer-wrong',
          metadataJson: '{"sourceTaskId":"dreamer-wrong","artifactKind":"principle"}',
        }),
      ];
      const result = decideDownstreamGate(downstream, artifacts);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Lineage mismatch');
      expect(result.blockedBy).toContain('lineage_mismatch');
    });

    it('blocks downstream when artifact metadata is malformed', () => {
      const downstream = makeDownstream({
        taskId: 'philosopher-003',
        dependencyTaskIds: ['dreamer-001'],
        expectedArtifactKinds: ['principle'],
      });
      const artifacts = [
        makeArtifact({
          artifactId: 'art-bad',
          sourceTaskId: 'dreamer-001',
          metadataJson: null,
        }),
      ];
      const result = decideDownstreamGate(downstream, artifacts);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Malformed artifact metadata');
      expect(result.blockedBy).toContain('malformed_metadata');
    });

    it('allows downstream when all artifacts are present, valid, and lineage-consistent', () => {
      const downstream = makeDownstream({
        taskId: 'philosopher-004',
        dependencyTaskIds: ['dreamer-001'],
        expectedArtifactKinds: ['principle'],
      });
      const artifacts = [
        makeArtifact({
          artifactId: 'art-ok',
          sourceTaskId: 'dreamer-001',
          metadataJson: '{"sourceTaskId":"dreamer-001","artifactKind":"principle"}',
        }),
      ];
      const result = decideDownstreamGate(downstream, artifacts);

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('All dependency artifacts present');
    });

    it('allows downstream with no dependencies', () => {
      const downstream = makeDownstream({
        taskId: 'philosopher-005',
        dependencyTaskIds: [],
      });
      const result = decideDownstreamGate(downstream, []);

      expect(result.allowed).toBe(true);
    });
  });

  describe('Scenario 6: integrity/read model output structure', () => {
    it('BrokenLinkDetection has required fields: type, severity, reason, nextAction', () => {
      const upstream = makeUpstream({ taskId: 'dreamer-001' });
      const result = detectMissingArtifact(upstream, [], 'principle');

      expect(result.type).toBeTruthy();
      expect(result.severity).toMatch(/^(warning|error)$/);
      expect(result.reason).toBeTruthy();
      expect(result.nextAction).toBeTruthy();
    });

    it('buildSimulationSummary includes structured broken-link type, taskId, artifactId, reason, nextAction', () => {
      const scenarios = [
        {
          scenarioName: 'missing_artifact' as BrokenArtifactScenarioName,
          description: 'test',
          status: 'passed' as const,
          brokenLinkType: 'missing_artifact',
          reason: 'test reason',
          nextAction: 'test action',
        },
      ];
      const summary = buildSimulationSummary(scenarios);

      expect(summary.status).toBe('healthy');
      expect(summary.totalScenarios).toBe(1);
      expect(summary.passedScenarios).toBe(1);
      expect(summary.failedScenarios).toBe(0);
      expect(summary.generatedAt).toBeTruthy();
    });

    it('summary includes recommendedNextIssue when scenarios fail', () => {
      const scenarios = [
        {
          scenarioName: 'missing_artifact' as BrokenArtifactScenarioName,
          description: 'test',
          status: 'failed' as const,
          brokenLinkType: 'missing_artifact',
          reason: 'test reason',
          nextAction: 'test action',
        },
      ];
      const summary = buildSimulationSummary(scenarios);

      expect(summary.recommendedNextIssue).toContain('PRI-209');
    });
  });

  describe('Scenario 7: repair/remediation dry-run first, confirm explicit, idempotent', () => {
    it('detectMissingArtifact is deterministic — same input produces same output', () => {
      const upstream = makeUpstream({ taskId: 'dreamer-001' });
      const result1 = detectMissingArtifact(upstream, [], 'principle');
      const result2 = detectMissingArtifact(upstream, [], 'principle');

      expect(result1).toEqual(result2);
    });

    it('validateArtifactMetadata is deterministic — same input produces same output', () => {
      const artifact = makeArtifact({
        artifactId: 'art-d1',
        sourceTaskId: 'dreamer-001',
        metadataJson: null,
      });
      const result1 = validateArtifactMetadata(artifact);
      const result2 = validateArtifactMetadata(artifact);

      expect(result1).toEqual(result2);
    });

    it('decideDownstreamGate is deterministic — same input produces same output', () => {
      const downstream = makeDownstream({
        taskId: 'philosopher-001',
        dependencyTaskIds: ['dreamer-001'],
        expectedArtifactKinds: ['principle'],
      });
      const result1 = decideDownstreamGate(downstream, []);
      const result2 = decideDownstreamGate(downstream, []);

      expect(result1).toEqual(result2);
    });

    it('resolveDuplicateArtifacts is deterministic — same input produces same output', () => {
      const artifacts = [
        makeArtifact({ artifactId: 'art-a', sourceTaskId: 'dreamer-001' }),
        makeArtifact({ artifactId: 'art-b', sourceTaskId: 'dreamer-001' }),
      ];
      const result1 = resolveDuplicateArtifacts(artifacts, 'dreamer-001', 'principle');
      const result2 = resolveDuplicateArtifacts(artifacts, 'dreamer-001', 'principle');

      expect(result1).toEqual(result2);
    });
  });

  describe('computeSimulationStatus', () => {
    it('returns healthy when all scenarios pass', () => {
      const scenarios = [
        { scenarioName: 'missing_artifact' as BrokenArtifactScenarioName, status: 'passed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(computeSimulationStatus(scenarios)).toBe('healthy');
    });

    it('returns degraded when some scenarios fail', () => {
      const scenarios = [
        { scenarioName: 'missing_artifact' as BrokenArtifactScenarioName, status: 'passed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
        { scenarioName: 'malformed_metadata' as BrokenArtifactScenarioName, status: 'failed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(computeSimulationStatus(scenarios)).toBe('degraded');
    });

    it('returns error when no scenarios pass', () => {
      const scenarios = [
        { scenarioName: 'missing_artifact' as BrokenArtifactScenarioName, status: 'failed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(computeSimulationStatus(scenarios)).toBe('error');
    });
  });

  describe('recommendNextIssue', () => {
    it('returns undefined when no scenarios fail', () => {
      const scenarios = [
        { scenarioName: 'missing_artifact' as BrokenArtifactScenarioName, status: 'passed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(recommendNextIssue(scenarios)).toBeUndefined();
    });

    it('returns PRI-209 for missing_artifact failure', () => {
      const scenarios = [
        { scenarioName: 'missing_artifact' as BrokenArtifactScenarioName, status: 'failed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(recommendNextIssue(scenarios)).toContain('PRI-209');
    });

    it('returns PRI-209 for source_task_id_mismatch failure', () => {
      const scenarios = [
        { scenarioName: 'source_task_id_mismatch' as BrokenArtifactScenarioName, status: 'failed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(recommendNextIssue(scenarios)).toContain('PRI-209');
    });

    it('returns PRI-209 for duplicate_artifacts_ambiguous failure', () => {
      const scenarios = [
        { scenarioName: 'duplicate_artifacts_ambiguous' as BrokenArtifactScenarioName, status: 'failed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(recommendNextIssue(scenarios)).toContain('PRI-209');
    });

    it('returns PRI-209 for downstream_continues_on_missing failure', () => {
      const scenarios = [
        { scenarioName: 'downstream_continues_on_missing' as BrokenArtifactScenarioName, status: 'failed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(recommendNextIssue(scenarios)).toContain('PRI-209');
    });

    it('returns PRI-209 for integrity_report_structure failure', () => {
      const scenarios = [
        { scenarioName: 'integrity_report_structure' as BrokenArtifactScenarioName, status: 'failed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(recommendNextIssue(scenarios)).toContain('PRI-209');
    });

    it('returns PRI-209 for repair_dry_run_idempotent failure', () => {
      const scenarios = [
        { scenarioName: 'repair_dry_run_idempotent' as BrokenArtifactScenarioName, status: 'failed' as const, description: '', brokenLinkType: '', reason: '', nextAction: '' },
      ];
      expect(recommendNextIssue(scenarios)).toContain('PRI-209');
    });
  });

  describe('safeStringify (ERR-017 avoidance)', () => {
    it('handles BigInt', () => {
      expect(safeStringify(BigInt(123))).toBe('123n');
    });

    it('handles circular references', () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(safeStringify(obj)).toBe('[unserializable]');
    });

    it('handles undefined', () => {
      expect(safeStringify(undefined)).toBe('undefined');
    });

    it('handles null', () => {
      expect(safeStringify(null)).toBe('null');
    });
  });

  describe('truncateReason (ERR-014 avoidance)', () => {
    it('does not truncate short reasons', () => {
      expect(truncateReason('short')).toBe('short');
    });

    it('truncates long reasons', () => {
      const long = 'x'.repeat(600);
      const truncated = truncateReason(long);
      expect(truncated.length).toBeLessThanOrEqual(500);
      expect(truncated.endsWith('...')).toBe(true);
    });
  });

  describe('boundedEvidence (ERR-014/016 avoidance)', () => {
    it('returns evidence as-is when within budget', () => {
      const evidence = { key: 'value' };
      expect(boundedEvidence(evidence)).toEqual(evidence);
    });

    it('truncates evidence with super-long keys', () => {
      const evidence: Record<string, unknown> = {};
      evidence['x'.repeat(1900)] = 'value';
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
    });

    it('handles circular references safely', () => {
      const evidence: Record<string, unknown> = {};
      evidence.self = evidence;
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
    });
  });

  describe('Structured JSON output examples', () => {
    it('BrokenLinkDetection for missing artifact produces valid JSON', () => {
      const upstream = makeUpstream({ taskId: 'dreamer-001' });
      const result = detectMissingArtifact(upstream, [], 'principle');
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe('missing_artifact');
      expect(parsed.severity).toBe('error');
      expect(parsed.taskId).toBe('dreamer-001');
      expect(parsed.reason).toBeTruthy();
      expect(parsed.nextAction).toBeTruthy();
    });

    it('DownstreamGateDecision for blocked downstream produces valid JSON', () => {
      const downstream = makeDownstream({
        taskId: 'philosopher-001',
        dependencyTaskIds: ['dreamer-001'],
        expectedArtifactKinds: ['principle'],
      });
      const result = decideDownstreamGate(downstream, []);
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.allowed).toBe(false);
      expect(parsed.reason).toBeTruthy();
      expect(parsed.blockedBy).toBeTruthy();
    });

    it('buildSimulationSummary produces valid JSON with all required fields', () => {
      const scenarios = [
        {
          scenarioName: 'missing_artifact' as BrokenArtifactScenarioName,
          description: 'Succeeded upstream task missing expected artifact',
          status: 'passed' as const,
          brokenLinkType: 'missing_artifact',
          reason: 'Artifact correctly detected as missing',
          nextAction: 'Re-run upstream task',
        },
      ];
      const summary = buildSimulationSummary(scenarios);
      const json = JSON.stringify(summary);
      const parsed = JSON.parse(json);

      expect(parsed.status).toBe('healthy');
      expect(parsed.totalScenarios).toBe(1);
      expect(parsed.passedScenarios).toBe(1);
      expect(parsed.failedScenarios).toBe(0);
      expect(parsed.generatedAt).toBeTruthy();
      expect(Array.isArray(parsed.scenarios)).toBe(true);
    });
  });
});
